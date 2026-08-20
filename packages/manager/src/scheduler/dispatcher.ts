import type { Kysely } from 'kysely';
import { ulid } from 'ulid';
import {
  featuresRepository,
  nowIso,
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
import type { AssignMessage } from '../ipc/protocol.js';
import { isDispatchPaused, type ControlState } from '../control/state.js';

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
  readonly spawnWorker: (call: SpawnCall) => void;
  readonly actor?: string;
  readonly now?: () => string;
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
  const { config } = mergeConfig(
    DEFAULT_CONFIG,
    deps.daemonConfig,
    deps.resolveAdlYml(feature),
  );
  const effectiveConfigJson = JSON.stringify(config);

  // D-12's other half, made an explicit branch rather than left as an
  // always-derive expression: a feature with no `workspace_handle` yet is
  // leasing for the first time, so one is derived and *persisted* here — the
  // one and only place this row's handle is ever written. A feature that
  // already has one (recovered from a crash by the reaper, which never
  // clears `workspace_handle`) attaches to that exact value instead; nothing
  // here derives a fresh one or asks `@adl/workspace` to create anything.
  // Actual worktree creation is a later plan's job — this plan's contract is
  // only that a recovered feature's handle survives dispatch unchanged.
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

  await deps.db.transaction().execute(async (trx) => {
    const trxRepo = featuresRepository(trx);
    await trxRepo.compareAndSwapState({
      id: feature.id,
      expectedVersion: outcome.expectedStateVersion,
      state: outcome.next,
      round: feature.round + outcome.counters.round,
      currentStageIndex:
        feature.current_stage_index + outcome.counters.currentStageIndex,
      updatedAt: now,
    });
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
  });

  const assign: AssignMessage = {
    t: 'assign',
    featureId: feature.id,
    leaseToken,
    workspaceHandle,
    effectiveConfigJson,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
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
