import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import {
  featuresRepository,
  nowIso,
  verdictsRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import type {
  ChangeRequest,
  ForgeAdapter,
  ForgeRepoRef,
} from '@adl/core/forge';
import {
  planRoundStep,
  type CompleteStep,
  type RoundStep,
  type StageCompletion,
} from '@adl/core/loop';
import {
  transition,
  type FeatureEvent,
  type FeatureState,
  type TransitionCtx,
} from '@adl/core/state';
import type { Verdict } from '@adl/core/verdict';
import type { ManagerGitClient } from '@adl/workspace';
import { parseStageRunnerVerdict } from '../ipc/stage-verdict.js';
import { resolveSnapshotPipeline } from '../pipeline.js';
import { promoteChangeRequestToReady } from '../publish/promote.js';
import { reapOne, resetCrashCountOnSuccess } from '../scheduler/reaper.js';
import {
  checkProtectedPaths,
  type ProtectedPathCheckResult,
} from './protected-paths-check.js';

/**
 * `onStageCompleted` — the round loop's database half (LOOP-01, M05 step 5.13).
 *
 * A fence-matched `stage_result` has arrived. `@adl/core/loop`'s
 * `planRoundStep` decides what it means; this module is everything that has to
 * happen to the database and the forge as a result, and nothing else:
 *
 * 1. read the envelope back through `ipc/stage-verdict.ts`'s **validated**
 *    parser — the first real reader of what M04 left unread;
 * 2. record the evidence (a `verdicts` row and its findings for a gate, the
 *    `error_*` columns for a stage that broke) **before** any state write, so
 *    a lost CAS race costs a transition and never the judgement itself;
 * 3. apply the resulting lifecycle events through `transition()` — never a
 *    hand-written state string — each with its own version guard and audit
 *    row, in one transaction; and
 * 4. when the round ends, write `rounds.outcome`/`outcome_json`/`ended_at`
 *    and reset `crash_count` **in that same transaction**.
 *
 * ## Why the round close and the crash-count reset share a transaction
 *
 * D-11's rule for the crash counter is that "the increment and the decision
 * happen together" — `scheduler/reaper.ts` holds up its half by incrementing
 * inside the same transaction as the recovery write. `resetCrashCountOnSuccess`
 * is the other half, and it has had no caller since M03 (`docs/plan/DEBT.md`
 * § 5 names this step as its owner). A reset that landed in a separate
 * transaction from the round outcome would let a manager dying between the two
 * leave a completed round beside a crash count that still remembers crashes
 * the feature has since recovered from — and the next transient failure would
 * escalate a feature that had been running cleanly for rounds.
 *
 * **Every completed round resets it, not only a green one.** The counter
 * measures *consecutive crashes* (`planRecovery`'s own input), and a round that
 * reached a `RoundOutcome` at all is a broken streak — the worker reported, the
 * gates judged. A `send_back` is the loop working, not a failure.
 *
 * ## What this module deliberately does not do yet
 *
 * **It does not launch the next stage.** `planRoundStep` says which stage index
 * runs next and this module persists it, but nothing dispatches it: a gate
 * needs an implementation to run (M05 step 5.14) *and* a workspace carrying the
 * developer's commit, which does not survive today —
 * `createProductionStageRunner` destroys the worktree in its `finally` and
 * `createWorktree` refuses to attach to an existing one, so a second worker
 * would branch from `baseRef` and see none of the work. Closing that is the
 * step recorded beside this one in `docs/plan/milestones/m05-the-loop-closes.md`;
 * until it lands, the `advance` path writes the position and stops, exactly as
 * `promoteToReady` and `resetCrashCountOnSuccess` were built and left uncalled
 * before it.
 */

export interface RoundRunnerDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  /**
   * A `ManagerGitClient` rooted at `mainRepo` — protected-path enforcement's
   * own diff (ROLE-11, M05 step 5.16). Required, not optional: unlike `forge`
   * below, this is not a bonus feature the loop degrades gracefully without —
   * a daemon that cannot check what a round touched must not silently skip
   * the check, which is exactly what an optional field would let a caller do
   * by omission. `daemon.ts` builds one `hostGitWorkspace`-backed client for
   * the whole process lifetime; a test builds its own, often a stub.
   */
  readonly git: ManagerGitClient;
  /** Defaults to `nowIso`. Injectable so a test can control the timestamp. */
  readonly now?: () => string;
  readonly actor?: string;
  /**
   * The forge, when one is configured — used for exactly one thing here:
   * promoting the draft change request to ready once the round comes back
   * green (FORGE-05, the half M05 step 5.10 deferred because nothing produced
   * an aggregate "every gate passed" verdict until this step). Absent, the
   * round still completes and the feature still reaches `publishing`; nothing
   * is promoted and nothing fails, matching every other "absent means skip"
   * forge seam in this daemon.
   */
  readonly forge?: {
    readonly adapter: ForgeAdapter;
    readonly repo: ForgeRepoRef;
  };
}

export interface StageCompletedParams {
  /** The feature row as the supervisor spawned it — re-read here before any write. */
  readonly feature: FeaturesTable;
  readonly leaseToken: string;
  readonly roundId: string;
  readonly stageAttemptId: string;
  readonly stageId: string;
  readonly stageIndex: number;
  readonly verdictJson: string;
}

/** A `StageError` this module synthesised because the worker's report could not be believed. */
function unparseable(detail: string): StageCompletion {
  return {
    kind: 'error',
    // `unparseable` rather than `provider_error`: another attempt at a worker
    // that reported nonsense is not plausibly different, and CORE-06 keeps it
    // off the developer's round count either way.
    error: { kind: 'unparseable', retryable: false, detail },
  };
}

/**
 * How many violated paths the escalation reason names verbatim before it
 * switches to "…and N more". A `Finding.detail`-style bound (`command-gate.ts`'s
 * `OUTPUT_TAIL_CHARS`) for the same reason: `RoundOutcome.reason` is a plain
 * string, persisted to `rounds.outcome_json` and rendered straight into a
 * **public** pull-request comment (threat T-1-21) — a round whose commit
 * touched thousands of paths must not turn that comment into the whole list.
 */
const MAX_VIOLATED_PATHS_SHOWN = 20;

/** The escalation reason for a round ROLE-11 hard-failed — bounded, never the whole diff. */
function describeProtectedPathViolation(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_VIOLATED_PATHS_SHOWN);
  const omitted = paths.length - shown.length;
  const list =
    shown.join(', ') + (omitted > 0 ? `, and ${String(omitted)} more` : '');
  return (
    'the developer touched a path ROLE-11 protects — the spec, adl.yml, and any ' +
    `configured protected_paths must never be edited by the developer agent: ${list}`
  );
}

/**
 * The round this developer stage produced, overridden into a hard fail
 * (ROLE-11). Shaped exactly like `planRoundStep`'s own `escalate()` helper —
 * `dev_committed` first, so the audit trail still records the real commit,
 * then `unrecoverable` — but built here rather than by that pure function,
 * since only this module knows the violation (`round-step.ts` sees no diff).
 */
function protectedPathViolationStep(
  sha: string,
  paths: readonly string[],
): CompleteStep {
  const reason = describeProtectedPathViolation(paths);
  return {
    kind: 'complete',
    events: [
      { t: 'dev_committed', sha },
      { t: 'unrecoverable', reason },
    ],
    outcome: { kind: 'escalate', reason },
  };
}

/**
 * Turn the wire envelope into the sequencer's input.
 *
 * The `developer_outcome`/`verdict` split is NOT re-derived from the stage
 * index here — `planRoundStep` owns that check, and owning it in one place is
 * what makes "a gate cannot report a developer outcome" a tested rule rather
 * than an assumption two modules each half-hold.
 */
function classify(verdictJson: string): StageCompletion {
  const parsed = parseStageRunnerVerdict(verdictJson);
  if (!parsed.ok) {
    return unparseable(
      `the worker's stage result could not be read: ${parsed.reason}`,
    );
  }
  const { verdict } = parsed;
  switch (verdict.kind) {
    case 'developer_outcome':
      return { kind: 'developer', outcome: verdict.outcome };
    case 'verdict':
      return { kind: 'gate', verdict: verdict.verdict };
    case 'stage_error':
      return { kind: 'error', error: verdict.error };
  }
}

/** Every verdict already recorded in this round, oldest first — `aggregate`'s input. */
async function readRoundVerdicts(
  db: Kysely<Database>,
  roundId: string,
  excludeStageAttemptId: string,
): Promise<readonly Verdict[]> {
  const rows = await db
    .selectFrom('verdicts')
    .innerJoin(
      'stage_attempts',
      'stage_attempts.id',
      'verdicts.stage_attempt_id',
    )
    .select([
      'verdicts.id as id',
      'verdicts.outcome as outcome',
      'verdicts.summary as summary',
      'verdicts.reason as reason',
    ])
    .where('stage_attempts.round_id', '=', roundId)
    .where('verdicts.stage_attempt_id', '!=', excludeStageAttemptId)
    .orderBy('stage_attempts.stage_index')
    .orderBy('stage_attempts.attempt')
    .execute();

  if (rows.length === 0) return [];

  const findings = await db
    .selectFrom('findings')
    .selectAll()
    .where(
      'verdict_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('fingerprint')
    .execute();

  return rows.map((row): Verdict => {
    const own = findings
      .filter((finding) => finding.verdict_id === row.id)
      .map((finding) => ({
        fingerprint: finding.fingerprint,
        severity: finding.severity as 'blocker' | 'major' | 'minor' | 'nit',
        title: finding.title,
        detail: finding.detail,
        criterionRef:
          finding.criterion_ref_kind === 'criterion'
            ? ({ kind: 'criterion', id: finding.criterion_id ?? '' } as const)
            : ({
                kind: 'global',
                category: (finding.global_category ?? 'other') as 'other',
              } as const),
        ...(finding.path !== null
          ? {
              location: {
                path: finding.path,
                ...(finding.line !== null ? { line: finding.line } : {}),
                ...(finding.end_line !== null
                  ? { endLine: finding.end_line }
                  : {}),
              },
            }
          : {}),
        ...(finding.suggested_action !== null
          ? { suggestedAction: finding.suggested_action }
          : {}),
      }));

    // Rebuilt to the shape `aggregate` reads — the outcome, and the payload
    // that outcome's own precedence rule consults. `checked` is not read back:
    // `aggregate` never looks at a pass's cited coverage, and inventing a
    // citation here to satisfy the type would be fabricated evidence of
    // coverage (`reconcileCriterionRefs`'s own standard).
    switch (row.outcome) {
      case 'send_back':
        return {
          outcome: 'send_back',
          summary: row.summary ?? '',
          findings: own,
        } as Verdict;
      case 'warn':
        return {
          outcome: 'warn',
          summary: row.summary ?? '',
          findings: own,
        } as Verdict;
      case 'fail':
        return {
          outcome: 'fail',
          summary: row.summary ?? '',
          reason: row.reason ?? '',
        } as Verdict;
      case 'inconclusive':
        return {
          outcome: 'inconclusive',
          summary: row.summary ?? '',
          reason: row.reason ?? '',
        } as Verdict;
      case 'skip':
        return { outcome: 'skip', reason: row.reason ?? '' } as Verdict;
      default:
        return {
          outcome: 'pass',
          summary: row.summary ?? '',
          checked: [{ kind: 'global', category: 'other' }],
        } as Verdict;
    }
  });
}

/** Persist a gate's judgement and its findings — one transaction, via the one writer. */
async function recordGateVerdict(
  deps: RoundRunnerDeps,
  stageAttemptId: string,
  verdict: Verdict,
  at: string,
): Promise<void> {
  const verdictId = ulid();
  const findings =
    verdict.outcome === 'send_back' || verdict.outcome === 'warn'
      ? verdict.findings
      : [];

  await verdictsRepository(deps.db).recordVerdict({
    verdict: {
      id: verdictId,
      stage_attempt_id: stageAttemptId,
      outcome: verdict.outcome,
      summary: 'summary' in verdict ? verdict.summary : null,
      reason: 'reason' in verdict ? verdict.reason : null,
      waiver_id: null,
      created_at: at,
    },
    checked:
      verdict.outcome === 'pass'
        ? verdict.checked.map((ref, position) => ({
            id: ulid(),
            verdict_id: verdictId,
            position,
            ref_kind: ref.kind,
            criterion_id: ref.kind === 'criterion' ? ref.id : null,
            global_category: ref.kind === 'global' ? ref.category : null,
          }))
        : [],
    findings: findings.map((finding) => ({
      id: ulid(),
      verdict_id: verdictId,
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      criterion_ref_kind: finding.criterionRef.kind,
      criterion_id:
        finding.criterionRef.kind === 'criterion'
          ? finding.criterionRef.id
          : null,
      global_category:
        finding.criterionRef.kind === 'global'
          ? finding.criterionRef.category
          : null,
      path: finding.location?.path ?? null,
      line: finding.location?.line ?? null,
      end_line: finding.location?.endLine ?? null,
      suggested_action: finding.suggestedAction ?? null,
      created_at: at,
    })),
  });
}

/**
 * Record a stage that broke, on the attempt's own `error_*` columns, and close
 * it as `'error'` rather than `'verdict'`.
 *
 * `stage_attempts.status` is the difference between "this attempt judged" and
 * "this attempt broke", and it is the reason this runs before the supervisor's
 * own `closeAttempt` — see `SupervisorDeps.onStageCompleted`. Guarded by
 * `ended_at is null`, so a replay is a no-op exactly as `closeAttempt` is.
 */
async function recordStageError(
  deps: RoundRunnerDeps,
  stageAttemptId: string,
  error: { kind: string; retryable: boolean },
  at: string,
): Promise<void> {
  await deps.db
    .updateTable('stage_attempts')
    .set({
      status: 'error',
      error_kind: error.kind,
      error_retryable: error.retryable ? 1 : 0,
      ended_at: at,
    })
    .where('id', '=', stageAttemptId)
    .where('ended_at', 'is', null)
    .execute();
}

/**
 * Apply one lifecycle event: `transition()`, then the version-guarded CAS and
 * the audit row, inside `trx`.
 *
 * Returns the row as it now stands so a caller applying a sequence can build
 * the next event's context from it — `state_version` and `seq` both move, and
 * a second event built against the pre-write values would fail its own guard.
 */
async function applyEvent(
  deps: RoundRunnerDeps,
  trx: Kysely<Database>,
  feature: FeaturesTable,
  event: FeatureEvent,
  ctx: Omit<
    TransitionCtx,
    | 'featureId'
    | 'stateVersion'
    | 'lastEventSeq'
    | 'round'
    | 'currentStageIndex'
    | 'actor'
    | 'at'
  >,
  lastEventSeq: number,
  at: string,
): Promise<{ feature: FeaturesTable; lastEventSeq: number } | undefined> {
  const repo = featuresRepository(trx);
  const full: TransitionCtx = {
    featureId: feature.id,
    stateVersion: feature.state_version,
    lastEventSeq,
    round: feature.round,
    currentStageIndex: feature.current_stage_index,
    actor: deps.actor ?? 'round-loop',
    at,
    ...ctx,
  };

  const outcome = transition(feature.state as FeatureState, event, full);
  if (!outcome.ok) {
    deps.logger.warn(
      {
        featureId: feature.id,
        state: feature.state,
        event: event.t,
        reason: outcome.reason,
      },
      'round loop: transition rejected',
    );
    return undefined;
  }

  const nextRound = feature.round + outcome.counters.round;
  const nextStageIndex =
    feature.current_stage_index + outcome.counters.currentStageIndex;

  const applied = await repo.compareAndSwapState({
    id: feature.id,
    expectedVersion: outcome.expectedStateVersion,
    state: outcome.next,
    round: nextRound,
    currentStageIndex: nextStageIndex,
    updatedAt: at,
  });
  if (!applied) {
    deps.logger.warn(
      { featureId: feature.id, event: event.t },
      'round loop: compareAndSwapState lost the race — another writer moved this feature',
    );
    return undefined;
  }

  const [effect] = outcome.effects;
  if (effect !== undefined) {
    await repo.appendEvent({
      id: ulid(),
      feature_id: effect.featureId,
      seq: effect.seq,
      from_state: effect.fromState,
      to_state: effect.toState,
      event_json: JSON.stringify(effect.event),
      actor: effect.actor,
      at: effect.at,
    });
  }

  return {
    feature: {
      ...feature,
      state: outcome.next,
      state_version: outcome.expectedStateVersion + 1,
      round: nextRound,
      current_stage_index: nextStageIndex,
      updated_at: at,
    },
    lastEventSeq: lastEventSeq + 1,
  };
}

/**
 * `onStageCompleted(deps, params)` — one turn of the round loop.
 *
 * Never throws: every failure is logged and returns. This is called from the
 * supervisor's own message task, which has no caller waiting on a rejection,
 * and a round loop that could take the daemon down with an unhandled rejection
 * would be a worse failure than the one it was reporting.
 */
export async function onStageCompleted(
  deps: RoundRunnerDeps,
  params: StageCompletedParams,
): Promise<void> {
  try {
    await runStageCompleted(deps, params);
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        featureId: params.feature.id,
        roundId: params.roundId,
        stageId: params.stageId,
      },
      'round loop: failed to advance the round',
    );
  }
}

async function runStageCompleted(
  deps: RoundRunnerDeps,
  params: StageCompletedParams,
): Promise<void> {
  const at = (deps.now ?? nowIso)();
  const repo = featuresRepository(deps.db);

  // Re-read rather than trusting the row the supervisor captured at fork time:
  // a pause, a kill, or the reaper may have moved it since, and every write
  // below guards on `state_version` read HERE.
  const feature = await repo.findById(params.feature.id);
  if (feature === undefined) {
    deps.logger.warn(
      { featureId: params.feature.id },
      'round loop: the feature row is gone — nothing to advance',
    );
    return;
  }
  if (feature.lease_token !== params.leaseToken) {
    // D-06's fence, applied once more at the write site. The supervisor
    // already checked it against the message; this is the check against the
    // row as it stands at the instant of the write, which is the one that
    // matters.
    deps.logger.warn(
      { featureId: feature.id, presentedToken: params.leaseToken },
      'round loop: the presented lease token is no longer current — dropping this result',
    );
    return;
  }

  const completion = classify(params.verdictJson);

  // Evidence first, state second. A CAS that loses its race must not also
  // lose the judgement that a pull request is rendered from.
  let protectedPathResult: ProtectedPathCheckResult | undefined;
  let committedSha: string | undefined;
  if (completion.kind === 'gate') {
    await recordGateVerdict(
      deps,
      params.stageAttemptId,
      completion.verdict,
      at,
    );
  } else if (completion.kind === 'error') {
    await recordStageError(deps, params.stageAttemptId, completion.error, at);
  } else if (completion.outcome.kind === 'committed') {
    // M05 step 5.14, closing `docs/plan/DEBT.md` D-5-11-1. The sha exists only
    // on this event: it is what the worker read back out of the workspace, and
    // no table has held it until now. `publish/role-rounds.ts` reads this
    // column when it re-renders a *prior* round's fold, which is every round
    // after the first — before this write, round 1's fold silently lost its
    // sha the moment round 2 republished the comment.
    //
    // Written here, beside the other two evidence writes and before any state
    // change, for their reason: a CAS that loses its race must not also lose
    // the record of what the developer produced. It is deliberately not part
    // of the `complete` branch's transaction below — a developer stage in a
    // pipeline with any gate in it `advance`s rather than completing, so a
    // round-close-only write would never fire for exactly the pipelines this
    // milestone exists to run.
    committedSha = completion.outcome.sha;
    await repo.recordRoundHeadSha({
      id: params.roundId,
      headSha: committedSha,
    });

    // ROLE-11 (M05 step 5.16): unconditional on every commit, before
    // `planRoundStep` ever runs — see `protected-paths-check.ts`'s own
    // docblock for why this is not, and must not be, a pipeline entry
    // `adl.yml` has to remember to declare.
    protectedPathResult = await checkProtectedPaths(
      { db: deps.db, git: deps.git },
      {
        feature,
        protectedGlobs: protectedPathsOf(feature),
        headSha: committedSha,
      },
    );
  }

  const pipeline = resolveSnapshotPipeline(feature.effective_config_json);
  const step: RoundStep =
    protectedPathResult?.kind === 'violated' && committedSha !== undefined
      ? protectedPathViolationStep(committedSha, protectedPathResult.paths)
      : protectedPathResult?.kind === 'error'
        ? { kind: 'retry', reason: protectedPathResult.detail }
        : pipeline.ok
          ? planRoundStep({
              stageIndex: params.stageIndex,
              pipelineLength: pipeline.stages.length,
              stageId: params.stageId,
              completion,
              priorVerdicts: await readRoundVerdicts(
                deps.db,
                params.roundId,
                params.stageAttemptId,
              ),
            })
          : // A pipeline this build cannot resolve is not something another
            // round fixes — the configuration names a harness with no loader
            // (M13), and the feature would fail identically every time.
            planRoundStep({
              stageIndex: params.stageIndex,
              pipelineLength: 0,
              stageId: params.stageId,
              completion: unparseable(
                `the snapshotted pipeline could not be resolved: ${pipeline.reason}`,
              ),
              priorVerdicts: [],
            });

  if (step.kind === 'retry') {
    // The stage broke transiently. Routed through `reapOne` — the same
    // function a dead worker's exit and the lease-expiry tick both call — so
    // the consecutive-failure ceiling (D-11) applies here too and a provider
    // outage cannot retry forever. Nothing is recorded as a round: nothing
    // was judged (CORE-06).
    deps.logger.warn(
      { featureId: feature.id, stageId: params.stageId, reason: step.reason },
      'round loop: the stage broke retryably — recovering through the crash-recovery path',
    );
    await reapOne(
      {
        db: deps.db,
        logger: deps.logger,
        ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
      },
      feature,
      at,
      params.leaseToken,
    );
    return;
  }

  // `workspace_ready` has never had a production emitter: `dispatchOnce`
  // leaves a feature in `leased` and the worker builds its own workspace
  // without reporting it. A stage that ran at all is proof the workspace was
  // ready, so the edge is applied here — the audit trail records the state
  // the feature was actually in rather than skipping it, and `dev_committed`
  // (which only leaves `developing`) has a state to leave from.
  const events: FeatureEvent[] =
    feature.state === 'leased' && completion.kind !== 'error'
      ? [{ t: 'workspace_ready' }, ...step.events]
      : [...step.events];

  const priorEvents = await repo.listEvents(feature.id);
  const startingSeq = priorEvents.reduce(
    (max, event) => Math.max(max, event.seq),
    0,
  );
  const pipelineLength = pipeline.ok ? pipeline.stages.length : 0;

  const applied = await deps.db.transaction().execute(async (trx) => {
    let cursor: { feature: FeaturesTable; lastEventSeq: number } = {
      feature,
      lastEventSeq: startingSeq,
    };

    for (const event of events) {
      const next = await applyEvent(
        deps,
        trx,
        cursor.feature,
        event,
        {
          maxRounds: maxRoundsOf(cursor.feature),
          pipelineLength,
        },
        cursor.lastEventSeq,
        at,
      );
      if (next === undefined) return undefined;
      cursor = next;
    }

    if (step.kind === 'advance') {
      // The pipeline position is written from the sequencer's answer, in the
      // same transaction as the events that got here — for the same reason
      // `planRecovery`'s `resetStageIndexTo` is written outside
      // `transition()` (see `recovery/policy.ts`): `TransitionResult.counters`
      // expresses position as a **delta**, and the developer's step off index
      // 0 is not one. `dev_committed`'s edge *resets* the index (its job is to
      // undo a send-back's position, and `developing` always runs at 0), so a
      // committed round would otherwise re-dispatch the developer forever.
      // `gate_passed`'s own +1 delta lands on exactly this number for every
      // later stage, so the two agree rather than compete.
      await trx
        .updateTable('features')
        .set({ current_stage_index: step.nextStageIndex })
        .where('id', '=', feature.id)
        .execute();
      cursor = {
        ...cursor,
        feature: {
          ...cursor.feature,
          current_stage_index: step.nextStageIndex,
        },
      };
    }

    if (step.kind === 'complete') {
      // D-11: the round outcome and the crash-count reset land together or
      // not at all — see this module's own docblock.
      await featuresRepository(trx).closeRound({
        id: params.roundId,
        outcome: step.outcome.kind,
        outcomeJson: JSON.stringify(step.outcome),
        endedAt: at,
      });
      await resetCrashCountOnSuccess(trx, feature.id);
    }

    return cursor.feature;
  });

  if (applied === undefined) return;

  deps.logger.info(
    {
      featureId: feature.id,
      roundId: params.roundId,
      stageId: params.stageId,
      stageIndex: params.stageIndex,
      step: step.kind,
      ...(step.kind === 'complete' ? { outcome: step.outcome.kind } : {}),
      ...(step.kind === 'advance'
        ? { nextStageIndex: step.nextStageIndex }
        : {}),
      state: applied.state,
    },
    'round loop: stage completed',
  );

  // The worker that held this lease has reported and is exiting. Releasing it
  // here rather than letting it time out is what keeps the reaper honest: a
  // lease held by nobody is exactly what `listExpiredLeases` collects, and a
  // feature this loop has just escalated would be reaped over and over —
  // `escalated` accepts no `lease_expired` edge, so every tick would log a
  // rejected transition forever. `releaseLease`'s own token guard makes this a
  // no-op if the lease already moved.
  await repo.releaseLease({ id: feature.id, leaseToken: params.leaseToken });

  if (step.kind === 'complete' && step.outcome.kind === 'green') {
    await promoteOnGreen(deps, applied, at, startingSeq + events.length);
  }
}

/** The round ceiling this feature was leased under, from its own snapshot. */
function maxRoundsOf(feature: FeaturesTable): number {
  if (feature.effective_config_json === null) return 0;
  try {
    const parsed = JSON.parse(feature.effective_config_json) as {
      limits?: { max_rounds?: unknown };
    };
    const value = parsed.limits?.max_rounds;
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * The maintainer-declared protected-path globs this feature was leased
 * under, from its own snapshot — `maxRoundsOf`'s exact degrade-on-malformed
 * shape (rule 5, CORE-06's spirit): a snapshot this build cannot read narrows
 * `checkProtectedPaths` to its two structural, always-on protections rather
 * than throwing. It never widens what is protected — an empty list here only
 * ever means "nothing configured or nothing readable", never "read and empty
 * on purpose vs. read and unreadable" collapsed into a false negative wider
 * than the two unconditional protections `violatedProtectedPaths` still
 * applies regardless.
 */
function protectedPathsOf(feature: FeaturesTable): readonly string[] {
  if (feature.effective_config_json === null) return [];
  try {
    const parsed = JSON.parse(feature.effective_config_json) as {
      protected_paths?: unknown;
    };
    const value = parsed.protected_paths;
    return Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

/**
 * FORGE-05's second half: the draft becomes ready for review, and only then
 * (M05 step 5.10 built `promoteToReady` and left it uncalled for exactly this
 * step). A green round is the *only* caller — there is no other path to
 * `all_gates_passed`, which is what makes "promoted only when every gate is
 * green" a property of the code rather than a claim.
 *
 * A promotion failure leaves the feature in `publishing` rather than moving it
 * to `pr_open`: the change request is still a draft, so saying otherwise would
 * make the lifecycle disagree with the forge. The next round's completion
 * retries it — `promoteToReady` is idempotent on an already-ready change
 * request.
 */
async function promoteOnGreen(
  deps: RoundRunnerDeps,
  feature: FeaturesTable,
  at: string,
  lastEventSeq: number,
): Promise<void> {
  if (deps.forge === undefined) {
    deps.logger.info(
      { featureId: feature.id },
      'round loop: every gate passed, but no forge is configured — nothing to promote',
    );
    return;
  }

  const promoted: ChangeRequest | undefined = await promoteChangeRequestToReady(
    {
      db: deps.db,
      logger: deps.logger,
      forge: deps.forge.adapter,
      forgeRepo: deps.forge.repo,
    },
    { feature },
  );
  if (promoted === undefined) return;

  await deps.db.transaction().execute(async (trx) => {
    await applyEvent(
      deps,
      trx,
      feature,
      {
        t: 'cr_opened',
        ref: {
          forge: deps.forge?.adapter.id ?? 'unknown',
          number: promoted.number,
          url: promoted.url,
        },
      },
      { maxRounds: maxRoundsOf(feature), pipelineLength: 0 },
      lastEventSeq,
      at,
    );
  });
}
