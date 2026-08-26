import { dirname, join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { ulid } from 'ulid';
import {
  featuresRepository,
  nowIso,
  reposRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import {
  DEFAULT_CONFIG,
  mergeConfig,
  type AdlYml,
  type DaemonConfig,
  type EffectiveConfig,
} from '@adl/core/config';
import {
  transition,
  type FeatureState,
  type TransitionCtx,
} from '@adl/core/state';
import type { WorkspaceBackendId } from '@adl/workspace';
import type { AssignMessage } from '../ipc/protocol.js';
import { isDispatchPaused, type ControlState } from '../control/state.js';
import { openAttempt } from '../bookkeeping/attempt.js';
import { sendBackBriefFromClosedRound } from '../loop/send-back-brief.js';
import { resolveSnapshotPipeline } from '../pipeline.js';

/**
 * One dispatch attempt (D-15..17): pick the oldest admissible queued
 * feature, lease it, snapshot its effective configuration, transition it to
 * `leased`, and hand it to the supervisor to fork.
 *
 * The concurrency cap (D-15, D-16) is enforced here: a **global** number with
 * an optional **per-repository** override, checked as a conjunction of two
 * named predicates immediately before the lease is acquired — never after.
 * The ceiling is **inclusive**: a cap of 3 admits a 4th lease only when
 * in-flight is *below* 3, so exactly 3 leases are ever held at once, never 4.
 * In-flight is counted from `listLeased()` rather than an in-memory counter,
 * so a restarted daemon that has not yet seen a fork still counts correctly
 * (T-3-14). Lowering the cap mid-flight **drains**: it governs dispatch only,
 * never an existing lease, and this function never revokes one.
 *
 * Selection is the lowest queued `id`. ULIDs are lexicographically sortable,
 * so `ORDER BY id` (already `listQueued`'s own ordering) is FIFO for free
 * with no extra column, and their uniqueness makes the order total — there is
 * no tie to break. Round-robin across repositories is deferred (D-17): when
 * the lowest-id candidate is blocked (by the cap, or — 03-07 Task 2 — by a
 * pause), this function tries the next-lowest candidate rather than shedding
 * the tick entirely, but it never reorders past a `paused` scope to favour
 * one repository over another's fair share of the global cap.
 */

export interface SpawnCall {
  readonly feature: FeaturesTable;
  readonly leaseToken: string;
  readonly assign: AssignMessage;
}

export interface DispatchDecision {
  readonly dispatched: boolean;
  readonly featureId?: string;
  readonly leaseToken?: string;
  /**
   * The stage attempt `openAttempt` opened for this dispatch, present only
   * when `dispatched` is true (04-06). Added so a caller that needs the
   * transcript-addressing id synchronously — `POST /dev-run/:featureId`,
   * which calls `dispatchOnce` directly rather than waiting for the next
   * background tick — does not have to re-derive or re-open it.
   */
  readonly stageAttemptId?: string;
}

export interface DispatcherDeps {
  readonly db: Kysely<Database>;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly daemonConfig: DaemonConfig;
  /**
   * Resolves the watched repository's `adl.yml` for a feature. Feature
   * detection (parsing `adl.yml` off disk) is Phase 5's job — this plan
   * takes the parsed config as an injected dependency so `mergeConfig` can be
   * called without re-deriving how it gets there.
   */
  readonly resolveAdlYml: (feature: FeaturesTable) => AdlYml;
  /**
   * Absolute path to the repository ADL is running against (04-04). Received
   * as a resolved value rather than derived here, matching this file's
   * existing discipline for `resolveAdlYml`/`daemonConfig` — `daemon.ts` is
   * the one place that knows it, via `workerCwd ?? process.cwd()`.
   */
  readonly mainRepo: string;
  /**
   * The directory a workspace backend may create a per-feature workspace
   * under (04-04). Must already exist — `daemon.ts` creates it at startup.
   */
  readonly scratchRoot: string;
  /**
   * The directory transcripts live under (04-06) — `logsRootFor(dbFilePath)`,
   * threaded onto every assign message so the worker (which cannot import
   * `@adl/db` and therefore cannot see `dbFilePath` itself) resolves the
   * IDENTICAL root the manager's own `GET /stages/:id/logs` route reads
   * from. Optional so every earlier plan's tests keep constructing
   * `DispatcherDeps` without one — absent, it defaults to the same
   * `scratchRoot`-colocated path `daemon.ts` used before this field
   * existed, which is correct exactly when `scratchRoot` is colocated with
   * the database file (the common case, but not a guarantee — `daemon.ts`
   * itself always supplies the real value explicitly).
   */
  readonly logsRoot?: string;
  /**
   * Which registered workspace backend the assign message names. Optional so
   * every earlier plan's tests keep constructing `DispatcherDeps` without
   * one — absent, it defaults to `'worktree'`, matching v1's only real
   * backend.
   */
  readonly workspaceBackendId?: WorkspaceBackendId;
  readonly spawnWorker: (call: SpawnCall) => void;
  readonly actor?: string;
  readonly now?: () => string;
  /**
   * Optional so every earlier plan's tests keep constructing `DispatcherDeps`
   * without one — absent, `mergeConfig`'s clamp/discard report (WR-01) is
   * silently dropped exactly as it always was, matching this file's existing
   * "absent, dispatch is never paused" precedent for `controlState`.
   * `daemon.ts` wires its real logger here.
   */
  readonly logger?: Logger;
  /**
   * The dispatch brake (D-26, 03-07 Task 2). Consulted per candidate,
   * before the concurrency cap — a paused repository is simply never a
   * candidate, so dispatch still proceeds for other repositories'
   * unpaused, admissible work. Optional so every earlier plan's tests (and
   * the tracer, which exercises no pause path) keep constructing
   * `DispatcherDeps` with no brake at all — absent, dispatch is never
   * paused.
   */
  readonly controlState?: ControlState;
  /**
   * Mints a fresh, short-lived, already-credentialed push URL for this
   * dispatch (M05 step 5.10) — `daemon.ts` supplies this from
   * `StartDaemonOptions.forge.pushCredential` when configured. Optional so
   * every earlier plan's tests (and any caller with no forge configured)
   * keep constructing `DispatcherDeps` without one — absent, `assign` carries
   * no `pushUrl` and the worker pushes nothing, matching `resolveAdlYml`'s
   * own "injected, not derived here" discipline: this file decides *when* to
   * ask, never *how* a credential is built.
   */
  readonly forge?: {
    readonly pushCredential: () => Promise<string>;
  };
}

/**
 * `dispatchOnce(deps)` — select, lease, snapshot, transition, fork. Returns a
 * decision rather than throwing: "nothing to dispatch" and "lost the race for
 * the one queued row" are both ordinary outcomes, not errors.
 */
export async function dispatchOnce(
  deps: DispatcherDeps,
): Promise<DispatchDecision> {
  const repo = featuresRepository(deps.db);
  // M05 step 5.13: `queued` rows, plus features already inside the loop whose
  // previous stage finished and released its lease. The candidate filter,
  // concurrency cap and pause brake below are identical for both — a
  // continuation is an ordinary dispatch that happens to start partway
  // through a pipeline.
  const queued = await repo.listDispatchable();
  if (queued.length === 0) {
    return { dispatched: false };
  }

  // Snapshot in-flight once per tick, from the database rather than a
  // counter this process may not have seen every fork for (T-3-14).
  const leased = await repo.listLeased();
  const concurrency = deps.daemonConfig.concurrency;

  const feature = queued.find((candidate) => {
    if (
      deps.controlState !== undefined &&
      isDispatchPaused(deps.controlState, candidate.repo_id)
    ) {
      return false;
    }
    // The inclusive ceiling: in-flight >= cap blocks, never in-flight > cap
    // only. A cap reachable only by lowering it mid-flight (in-flight > cap)
    // falls into the same branch — dispatch nothing, revoke nothing.
    if (leased.length >= concurrency.global) {
      return false;
    }
    if (concurrency.per_repo !== undefined) {
      const repoLeasedCount = leased.filter(
        (row) => row.repo_id === candidate.repo_id,
      ).length;
      if (repoLeasedCount >= concurrency.per_repo) {
        return false;
      }
    }
    return true;
  });
  if (feature === undefined) {
    return { dispatched: false };
  }

  // The base ref a worker's workspace branches from comes from the
  // repository row's own `default_branch` — never a defaulted branch name.
  // A feature whose repo row is missing (D-35's reconciliation did not run,
  // or a config edit dropped it) fails the dispatch rather than guessing:
  // a wrong base ref would silently branch a feature off the wrong history,
  // which is worse than not dispatching (04-04 Task 1).
  const repoRow = await reposRepository(deps.db).findById(feature.repo_id);
  if (repoRow === undefined) {
    deps.logger?.error(
      { featureId: feature.id, repoId: feature.repo_id },
      'dispatch: no repos row for this feature repo_id — refusing to dispatch rather than guess a base ref',
    );
    return { dispatched: false };
  }
  const baseRef = repoRow.default_branch;

  const now = (deps.now ?? nowIso)();
  const leaseToken = ulid();
  const leaseExpiresAt = new Date(
    Date.parse(now) + deps.leaseTtlMs,
  ).toISOString();

  const acquired = await repo.acquireLease({
    id: feature.id,
    leaseOwner: deps.actor ?? 'manager',
    leaseToken,
    leaseExpiresAt,
    heartbeatAt: now,
  });
  if (!acquired) {
    // Lost the race — another dispatch already claimed this row. Ordinary,
    // not an error; the caller's own schedule decides when to try again.
    return { dispatched: false };
  }

  // A feature already inside the loop is being leased for its *next* stage,
  // not admitted for its first — so it keeps the configuration it was
  // admitted under. Versioning rule 3 (`@adl/core/state`'s `feature-state.ts`)
  // is exactly this: the effective configuration is snapshotted at lease time
  // so that editing `adl.yml` mid-flight cannot change a running feature's
  // pipeline. Re-merging here would do precisely what that rule forbids —
  // silently hand round 2 a different pipeline from round 1's.
  const isContinuation =
    feature.state !== 'queued' && feature.effective_config_json !== null;

  // Snapshot the effective configuration at lease time (Phase 1's versioning
  // rule 3). `mergeConfig` already produces exactly the frozen resolved
  // object this needs; this is the one place this plan calls it.
  const effectiveConfigJson = isContinuation
    ? (feature.effective_config_json as string)
    : (() => {
        const { config, report } = mergeConfig(
          DEFAULT_CONFIG,
          deps.daemonConfig,
          deps.resolveAdlYml(feature),
        );
        if (report.clamped.length > 0 || report.discarded.length > 0) {
          deps.logger?.warn(
            {
              featureId: feature.id,
              clamped: report.clamped,
              discarded: report.discarded,
            },
            'adl.yml requested fields outside its trust boundary',
          );
        }
        return JSON.stringify(config);
      })();
  const config = JSON.parse(effectiveConfigJson) as EffectiveConfig;

  // D-12's other half, made an explicit branch rather than left as an
  // always-derive expression: a feature with no `workspace_handle` yet is
  // leasing for the first time, so one is derived and *persisted* here — the
  // one and only place this row's handle is ever written. A feature that
  // already has one (recovered from a crash by the reaper, which never
  // clears `workspace_handle`) attaches to that exact value instead; nothing
  // here derives a fresh one or asks `@adl/workspace` to create anything.
  // The `assign` message built below is now sufficient on its own for a
  // worker to build its workspace (04-04) — creation happens in the worker,
  // never here; this function's contract is only that a recovered feature's
  // handle survives dispatch unchanged.
  const isFirstAttempt = feature.workspace_handle === null;
  const workspaceHandle = feature.workspace_handle ?? feature.path;

  if (isContinuation) {
    // Nothing to transition: the feature is already in the state its next
    // stage runs under, and `current_stage_index` already points at that
    // stage — the round loop wrote both when the previous stage finished.
    // Leasing it is the whole of this dispatch, so there is no CAS to lose
    // and no audit row to append for a state change that is not happening.
    return dispatchAssigned(deps, {
      feature,
      leaseToken,
      effectiveConfigJson,
      stageIndex: feature.current_stage_index,
      workspaceHandle,
      baseRef,
    });
  }

  const events = await repo.listEvents(feature.id);
  const lastEventSeq = events.reduce(
    (max, event) => Math.max(max, event.seq),
    0,
  );

  const ctx: TransitionCtx = {
    featureId: feature.id,
    stateVersion: feature.state_version,
    lastEventSeq,
    round: feature.round,
    maxRounds: config.limits.max_rounds,
    pipelineLength: config.pipeline.length,
    currentStageIndex: feature.current_stage_index,
    actor: deps.actor ?? 'manager',
    at: now,
  };

  const outcome = transition(
    feature.state as FeatureState,
    { t: 'lease_acquired', workerId: leaseToken },
    ctx,
  );
  if (!outcome.ok) {
    // Structurally shouldn't happen given acquireLease() just succeeded
    // against a row this function itself read as `queued` — transition() is
    // total, so this stays an ordinary decision rather than an assertion.
    return { dispatched: false };
  }

  const casApplied = await deps.db.transaction().execute(async (trx) => {
    const trxRepo = featuresRepository(trx);
    const applied = await trxRepo.compareAndSwapState({
      id: feature.id,
      expectedVersion: outcome.expectedStateVersion,
      state: outcome.next,
      round: feature.round + outcome.counters.round,
      currentStageIndex:
        feature.current_stage_index + outcome.counters.currentStageIndex,
      updatedAt: now,
    });
    if (!applied) {
      // Lost the race: a concurrent writer (pause/kill/another dispatch)
      // already moved this row's state_version past what we read. Do not
      // append an event, do not write the config snapshot, and do not
      // treat the acquired lease as ours to keep — the caller rolls it
      // back below.
      return false;
    }
    const [effect] = outcome.effects;
    if (effect !== undefined) {
      await trxRepo.appendEvent({
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
    await trx
      .updateTable('features')
      .set({
        effective_config_json: effectiveConfigJson,
        // Attach-if-present: only a first-ever lease writes the handle.
        // A recovery dispatch reads the same value it already had and
        // leaves this column exactly as it found it.
        ...(isFirstAttempt ? { workspace_handle: workspaceHandle } : {}),
      })
      .where('id', '=', feature.id)
      .execute();
    return true;
  });

  if (!casApplied) {
    // The CAS lost the race after acquireLease() already succeeded (which
    // never checks `state`, only `lease_token`/`lease_expires_at` — see
    // FeaturesRepository.acquireLease). Release the lease we just took so a
    // feature a concurrent pause/kill moved out of `queued` is not left
    // holding a stray lease until it times out.
    await repo.releaseLease({ id: feature.id, leaseToken });
    return { dispatched: false };
  }

  return dispatchAssigned(deps, {
    feature: {
      ...feature,
      state: outcome.next,
      round: feature.round + outcome.counters.round,
      current_stage_index:
        feature.current_stage_index + outcome.counters.currentStageIndex,
      effective_config_json: effectiveConfigJson,
      workspace_handle: workspaceHandle,
    },
    leaseToken,
    effectiveConfigJson,
    stageIndex:
      feature.current_stage_index + outcome.counters.currentStageIndex,
    workspaceHandle,
    baseRef,
  });
}

interface AssignedDispatch {
  /** The feature row as it now stands — already carrying this dispatch's state. */
  readonly feature: FeaturesTable;
  readonly leaseToken: string;
  readonly effectiveConfigJson: string;
  readonly stageIndex: number;
  readonly workspaceHandle: string;
  readonly baseRef: string;
}

/**
 * Everything a dispatch does once the lease is held and the row says what it
 * is going to say: name the stage, open its attempt, mint a push credential,
 * and fork.
 *
 * Factored out because there are now two ways to arrive here — admitting a
 * `queued` feature, and re-leasing one already inside the loop for its next
 * stage (M05 step 5.13) — and a second copy of this assembly is a second
 * `AssignMessage` shape that could drift from the first. `daemon.ts` already
 * refuses to build `DispatcherDeps` twice for exactly this reason.
 */
async function dispatchAssigned(
  deps: DispatcherDeps,
  params: AssignedDispatch,
): Promise<DispatchDecision> {
  const { feature, leaseToken, effectiveConfigJson, stageIndex } = params;

  // Every agent invocation gets a round and a stage attempt before it
  // starts (04-04 Task 2's must_have), so the transcript path and the spend
  // ledger have real join keys rather than synthesised ones. The stage id
  // comes from the pipeline this feature was admitted under, resolved through
  // `@adl/core/config`'s `resolvePipeline` (M05 step 5.13's first production
  // caller) rather than read as raw strings — so a pipeline naming a harness
  // this build has no loader for is refused *here*, before a worker is forked
  // to run a stage that does not exist.
  const pipeline = resolveSnapshotPipeline(effectiveConfigJson);
  if (!pipeline.ok) {
    deps.logger?.error(
      { featureId: feature.id, reason: pipeline.reason },
      'dispatch: the snapshotted pipeline could not be resolved — releasing the lease rather than forking a worker',
    );
    await featuresRepository(deps.db).releaseLease({
      id: feature.id,
      leaseToken,
    });
    return { dispatched: false };
  }

  const stage = pipeline.stages[stageIndex];
  if (stage === undefined) {
    // Structurally shouldn't happen: `ctx.pipelineLength` is this same
    // pipeline's length, and transition() only ever advances the index
    // within it. An invariant violation, not an ordinary dispatch outcome —
    // daemon.ts's tick() already wraps this whole call and logs it.
    throw new Error(
      `dispatch: resolved stage index ${String(stageIndex)} has no entry in the ` +
        `snapshotted pipeline (length ${String(pipeline.stages.length)}) for feature ${feature.id}`,
    );
  }

  // LOOP-02 (M05 step 5.15): read BEFORE `openAttempt` runs. Once a round's
  // developer dispatch has already opened round N's own row, `latestRound`
  // (not used here) would return that still-open row rather than round N-1's
  // closed `send_back` — `latestClosedRound` is immune to that ordering, but
  // reading it after `openAttempt` would still be reading it late for no
  // reason, and this keeps the two calls in the order they are conceptually
  // in: "what happened before this dispatch" before "open this dispatch's own
  // row". Only the developer's own slot (index 0) ever wants one.
  const sendBackBrief =
    stageIndex === 0
      ? sendBackBriefFromClosedRound(
          await featuresRepository(deps.db).latestClosedRound(feature.id),
        )
      : undefined;

  const attempt = await openAttempt(
    { db: deps.db, now: deps.now },
    { featureId: feature.id, stageId: stage.id, stageIndex },
  );

  // M05 step 5.10: mint a fresh push credential for this dispatch, when a
  // forge is configured. A mint failure (the forge unreachable, an expired
  // App installation, ...) degrades to dispatching with no `pushUrl` rather
  // than failing the whole dispatch — publishing is a bonus to a real
  // developer stage, never a precondition for one to run.
  let pushUrl: string | undefined;
  if (deps.forge !== undefined) {
    try {
      pushUrl = await deps.forge.pushCredential();
    } catch (error) {
      deps.logger?.warn(
        { err: error, featureId: feature.id },
        'dispatch: could not mint a push credential — dispatching without one',
      );
    }
  }

  const assign: AssignMessage = {
    t: 'assign',
    featureId: feature.id,
    leaseToken,
    workspaceHandle: params.workspaceHandle,
    effectiveConfigJson,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    mainRepo: deps.mainRepo,
    scratchRoot: deps.scratchRoot,
    baseRef: params.baseRef,
    workspaceBackendId: deps.workspaceBackendId ?? 'worktree',
    roundId: attempt.roundId,
    stageAttemptId: attempt.stageAttemptId,
    stageId: attempt.stageId,
    stageIndex: attempt.stageIndex,
    logsRoot: deps.logsRoot ?? join(dirname(deps.scratchRoot), 'logs'),
    ...(pushUrl !== undefined ? { pushUrl } : {}),
    ...(sendBackBrief !== undefined
      ? { sendBackBriefJson: JSON.stringify(sendBackBrief) }
      : {}),
  };

  deps.spawnWorker({ feature, leaseToken, assign });

  return {
    dispatched: true,
    featureId: feature.id,
    leaseToken,
    stageAttemptId: attempt.stageAttemptId,
  };
}
