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
import { pipelineFromEffectiveConfig } from '../stage-name.js';

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
  const queued = await repo.listQueued();
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

  // Snapshot the effective configuration at lease time (Phase 1's versioning
  // rule 3). `mergeConfig` already produces exactly the frozen resolved
  // object this needs; this is the one place this plan calls it.
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
  const effectiveConfigJson = JSON.stringify(config);

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

  // Every agent invocation gets a round and a stage attempt before it
  // starts (04-04 Task 2's must_have), so the transcript path and the spend
  // ledger have real join keys rather than synthesised ones. The stage
  // index/id come from the pipeline this dispatch just snapshotted, not a
  // second read of it — a recovery dispatch (isFirstAttempt === false)
  // resolves to the same stage index it was already at, so openAttempt's
  // own ordinal logic makes that a second attempt in history (D-13), not a
  // fresh round.
  const stageIndex =
    feature.current_stage_index + outcome.counters.currentStageIndex;
  const pipeline = pipelineFromEffectiveConfig(effectiveConfigJson) ?? [];
  const stageId = pipeline[stageIndex];
  if (stageId === undefined) {
    // Structurally shouldn't happen: `ctx.pipelineLength` above is this same
    // pipeline's length, and transition() only ever advances the index
    // within it. An invariant violation, not an ordinary dispatch outcome —
    // daemon.ts's tick() already wraps this whole call and logs it.
    throw new Error(
      `dispatch: resolved stage index ${stageIndex} has no entry in the ` +
        `snapshotted pipeline (length ${pipeline.length}) for feature ${feature.id}`,
    );
  }

  const attempt = await openAttempt(
    { db: deps.db, now: deps.now },
    { featureId: feature.id, stageId, stageIndex },
  );

  const assign: AssignMessage = {
    t: 'assign',
    featureId: feature.id,
    leaseToken,
    workspaceHandle,
    effectiveConfigJson,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    mainRepo: deps.mainRepo,
    scratchRoot: deps.scratchRoot,
    baseRef,
    workspaceBackendId: deps.workspaceBackendId ?? 'worktree',
    roundId: attempt.roundId,
    stageAttemptId: attempt.stageAttemptId,
    stageId: attempt.stageId,
    stageIndex: attempt.stageIndex,
  };

  deps.spawnWorker({
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
    assign,
  });

  return { dispatched: true, featureId: feature.id, leaseToken };
}
