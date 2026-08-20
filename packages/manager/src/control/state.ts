import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import {
  featuresRepository,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import {
  transition,
  type FeatureEvent,
  type FeatureState,
  type TransitionCtx,
} from '@adl/core/state';

/**
 * `src/control/state.ts` — the dispatch brake (D-26), and the shared
 * transition-application helper every pause/resume/kill call site uses
 * (`api/routes/control.ts`, `api/routes/features.ts`, and the supervisor's
 * round-boundary hook).
 *
 * The pause flag is held **in memory only**. See 03-07-PLAN.md's flagged
 * OBS-03 assumption: a global pause does not survive a daemon restart — a
 * restart resumes dispatch. A persisted pause would be a `meta` row and a
 * boot-time read; not built here.
 */

/**
 * What a pause/resume mutation targets at the *dispatch-brake* level.
 * `'feature'` deliberately never reaches this module — a single feature's
 * pause/resume is a direct `applyControlEvent` call against that one row,
 * with no brake involved at all (see `api/routes/control.ts`).
 */
export type PauseScope = 'global' | 'repo';

export interface ControlState {
  readonly isGlobalPaused: () => boolean;
  readonly setGlobalPause: (paused: boolean) => void;
  readonly isRepoPaused: (repoId: string) => boolean;
  readonly setRepoPause: (repoId: string, paused: boolean) => void;
}

/** A fresh, unpaused brake — one per daemon process (`daemon.ts` owns the instance). */
export function createControlState(): ControlState {
  let globalPaused = false;
  const pausedRepos = new Set<string>();

  return {
    isGlobalPaused: () => globalPaused,
    setGlobalPause: (paused) => {
      globalPaused = paused;
    },
    isRepoPaused: (repoId) => pausedRepos.has(repoId),
    setRepoPause: (repoId, paused) => {
      if (paused) {
        pausedRepos.add(repoId);
      } else {
        pausedRepos.delete(repoId);
      }
    },
  };
}

/**
 * Whether dispatch is currently blocked for `repoId` — globally, or at repo
 * scope. `dispatchOnce` consults this before the concurrency cap check
 * (03-07 Task 1), for every queued candidate it considers.
 */
export function isDispatchPaused(state: ControlState, repoId: string): boolean {
  return state.isGlobalPaused() || state.isRepoPaused(repoId);
}

/**
 * Apply one lifecycle event (`pause` or `resume`) to a single feature row:
 * `transition()`, the version-guarded state write, the audit event, and —
 * because a paused/resumed feature is never simultaneously leased —
 * releasing the lease when one is held. The same pattern `dispatchOnce` and
 * `reapOne` already use for their own transactional writes.
 *
 * Returns `false` for a benign no-op — an already-paused feature receiving
 * another `pause`, a not-paused feature receiving a `resume`, or
 * `transition()` rejecting the pair for any other reason — rather than
 * throwing. The caller decides what to report, exactly as `dispatchOnce`'s
 * "lost the race" case already does. `InvalidTransition` is returned by
 * `transition()` precisely so the caller gets to make this judgement
 * (03-07-PLAN.md Task 2's action).
 */
export async function applyControlEvent(
  db: Kysely<Database>,
  feature: FeaturesTable,
  event: FeatureEvent,
  actor: string,
  now: string,
): Promise<boolean> {
  // `transition.ts`'s `pause` edge is a stateless brake drawn from *every*
  // non-terminal state (transition.ts's top-of-switch handling) — including
  // `paused` itself, where it would be an accepted self-loop (a redundant
  // audit write), not the `InvalidTransition` rejection a "no-op" caller
  // expects. Short-circuit here so re-pausing an already-paused feature is
  // silently a no-op, per 03-07-PLAN.md Task 2's acceptance criterion.
  if (event.t === 'pause' && feature.state === 'paused') {
    return false;
  }

  const repo = featuresRepository(db);
  const events = await repo.listEvents(feature.id);
  const lastEventSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);

  const ctx: TransitionCtx = {
    featureId: feature.id,
    stateVersion: feature.state_version,
    lastEventSeq,
    round: feature.round,
    // `pause`/`resume` are drawn from every non-terminal state without
    // consulting the pipeline shape (transition.ts's top-of-function
    // handling), so these two fields are inert here — the same placeholder
    // reaper.ts's own reapOne already uses for its state-independent edges.
    maxRounds: 0,
    pipelineLength: 0,
    currentStageIndex: feature.current_stage_index,
    actor,
    at: now,
  };

  const outcome = transition(feature.state as FeatureState, event, ctx);
  if (!outcome.ok) {
    return false;
  }

  await db.transaction().execute(async (trx) => {
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

    if (feature.lease_token !== null) {
      await trxRepo.releaseLease({
        id: feature.id,
        leaseToken: feature.lease_token,
      });
    }
  });

  return true;
}

/**
 * The round-boundary park (D-26): called from the supervisor's own
 * `onRoundBoundary` hook once an accepted `stage_result` means the
 * feature's current round is done. If dispatch is paused for this feature's
 * repository (globally or at repo scope) at that exact moment, the feature
 * is transitioned to `paused` right there — nothing paid for is discarded,
 * and the worktree is left at the coherent boundary the worker itself just
 * reported. If dispatch is not paused, this is a no-op: round/stage
 * bookkeeping past this point is Phase 4+'s pipeline (the same "no caller
 * yet" precedent `scheduler/reaper.ts`'s own `resetCrashCountOnSuccess`
 * documents).
 *
 * Reads the row fresh rather than trusting a caller-supplied snapshot — the
 * row may have moved between the fence-matched message arriving and this
 * function running.
 */
export async function parkOnRoundBoundary(
  db: Kysely<Database>,
  controlState: ControlState,
  featureId: string,
  repoId: string,
  actor: string,
): Promise<void> {
  if (!isDispatchPaused(controlState, repoId)) {
    return;
  }
  const feature = await featuresRepository(db).findById(featureId);
  if (feature === undefined) {
    return;
  }
  await applyControlEvent(
    db,
    feature,
    { t: 'pause', by: actor },
    actor,
    nowIso(),
  );
}
