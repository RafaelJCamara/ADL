import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import {
  featuresRepository,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import {
  transition,
  type FeatureState,
  type TransitionCtx,
} from '@adl/core/state';

/**
 * The lease-expiry backstop (D-03) and the child-exit fast path's shared
 * implementation (D-04). `reapOne` is the one function both the periodic
 * tick and the supervisor's `child.on('exit')` handler call, so the two
 * paths that detect a dead or wedged worker cannot diverge in behaviour —
 * one route is fast (milliseconds, via the fork's own `exit` event), the
 * other is the backstop for what `exit` structurally cannot cover: a
 * restarted manager with no `ChildProcess` handle, and a worker that is
 * wedged but still alive.
 */

/** One feature `reapOne` moved back to `queued`. */
export interface ReapedFeature {
  readonly featureId: string;
  readonly fromState: FeatureState;
}

export interface ReapOutcome {
  readonly reaped: readonly ReapedFeature[];
}

/**
 * Everything one reap needs. Deliberately **no clock member** — `now` is
 * always the caller's explicit instant, never a value this module reads for
 * itself, so a tick judges every row it compares against the exact same
 * `now` (see {@link startReaper}).
 */
export interface ReaperDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly actor?: string;
}

/**
 * Recover one feature row whose worker is gone — an expired lease found by
 * the tick, or an unexpected `child.on('exit')` from the fast path.
 *
 * `expectedLeaseToken`, when supplied, guards the fast path against a
 * worker's late exit racing a lease the reaper (or a fresh dispatch) already
 * reassigned: if the row's current token no longer matches, this is a
 * no-op — the row belongs to someone else now, and this exit has nothing to
 * say about it.
 *
 * Returns `undefined` when there was nothing to do (the token guard failed)
 * or when `transition()` rejected the pair — logged at `warn` and treated as
 * an ordinary, non-fatal outcome, exactly like `dispatchOnce`'s own
 * structurally-shouldn't-happen case.
 */
export async function reapOne(
  deps: ReaperDeps,
  feature: FeaturesTable,
  now: string,
  expectedLeaseToken?: string,
): Promise<ReapedFeature | undefined> {
  if (
    expectedLeaseToken !== undefined &&
    feature.lease_token !== expectedLeaseToken
  ) {
    return undefined;
  }

  const repo = featuresRepository(deps.db);
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
    // `lease_expired`'s edges never consult these two fields — they are
    // state-independent of the pipeline shape — so a placeholder here is
    // inert, never load-bearing.
    maxRounds: 0,
    pipelineLength: 0,
    currentStageIndex: feature.current_stage_index,
    actor: deps.actor ?? 'reaper',
    at: now,
  };

  const outcome = transition(
    feature.state as FeatureState,
    { t: 'lease_expired' },
    ctx,
  );
  if (!outcome.ok) {
    deps.logger.warn(
      { featureId: feature.id, state: feature.state, reason: outcome.reason },
      'reaper: lease_expired rejected by transition()',
    );
    return undefined;
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

    if (feature.lease_token !== null) {
      await trxRepo.expireLease({
        id: feature.id,
        leaseToken: feature.lease_token,
      });
    }
  });

  return { featureId: feature.id, fromState: outcome.from };
}

/**
 * One reap tick: read `now` once (via {@link startReaper}), list every row
 * whose lease has expired as of that instant, and reap each in turn. Every
 * row in the tick is judged against the one supplied `now` — this function
 * never reads a clock, so two rows expiring either side of the real instant
 * this call happens to run at are still compared against the same value.
 */
export async function reapExpiredLeases(
  deps: ReaperDeps,
  now: string,
): Promise<ReapOutcome> {
  const repo = featuresRepository(deps.db);
  const expired = await repo.listExpiredLeases(now);
  const reaped: ReapedFeature[] = [];

  for (const feature of expired) {
    const result = await reapOne(deps, feature, now);
    if (result !== undefined) reaped.push(result);
  }

  return { reaped };
}

/**
 * The fast-path wiring `child.on('exit')` needs: read the row fresh (it may
 * have moved since the worker was forked) and hand it to {@link reapOne}
 * with the exited worker's own lease token as the guard. `daemon.ts` binds
 * this to its own `db`/`logger`; a test exercising the supervisor directly
 * binds it the same way, so the two invocations of "what does an unexpected
 * exit do" cannot drift apart.
 */
export function createFastPathRecovery(
  deps: ReaperDeps,
): (featureId: string, leaseToken: string) => void {
  return (featureId, leaseToken) => {
    void (async () => {
      try {
        const row = await featuresRepository(deps.db).findById(featureId);
        if (row === undefined) return;
        await reapOne(deps, row, nowIso(), leaseToken);
      } catch (error) {
        deps.logger.error({ err: error, featureId }, 'fast-path reap failed');
      }
    })();
  };
}

export interface StartReaperDeps extends ReaperDeps {
  /** The tick cadence — driven to ~50ms in tests, read from `heartbeat_interval_ms` in production. */
  readonly intervalMs: number;
}

export interface ReaperHandle {
  stop(): void;
}

/**
 * Start the periodic reaper tick.
 *
 * `setInterval`, unref'd so it never holds the process open during
 * shutdown — not `croner`. The interval is driven to ~50-200ms in tests, and
 * `croner`'s sub-100ms resolution is unverified (03-RESEARCH.md assumption
 * A2); `croner` is the right tool for the GC sweep's much longer cadence
 * (`03-08`).
 *
 * The clock is read exactly once per tick, here — never inside
 * {@link reapExpiredLeases} or {@link reapOne} — which is what makes "one
 * tick, one `now`" true rather than aspirational.
 */
export function startReaper(deps: StartReaperDeps): ReaperHandle {
  const timer = setInterval(() => {
    void reapExpiredLeases(deps, nowIso()).catch((error: unknown) => {
      deps.logger.error({ err: error }, 'reaper tick failed');
    });
  }, deps.intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
