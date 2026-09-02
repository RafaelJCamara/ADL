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
import { planRecovery, type RecoveryDecision } from '../recovery/policy.js';

/**
 * The lease-expiry backstop (D-03), the child-exit fast path's shared
 * implementation (D-04), and the crash-recovery policy applied wherever
 * either one detects a dead or wedged worker (D-10, D-11, D-12). `reapOne`
 * is the one function both the periodic tick and the supervisor's
 * `child.on('exit')` handler call, so the two paths cannot diverge in
 * behaviour — one route is fast (milliseconds, via the fork's own `exit`
 * event), the other is the backstop for what `exit` structurally cannot
 * cover: a restarted manager with no `ChildProcess` handle, and a worker
 * that is wedged but still alive.
 */

/** One feature `reapOne` acted on. */
export interface ReapedFeature {
  readonly featureId: string;
  readonly fromState: FeatureState;
  /** `'recovered'` — back to `queued`, stage 0, same round. `'escalated'` — the crash ceiling was already reached (D-11). */
  readonly decision: 'recovered' | 'escalated';
}

export interface ReapOutcome {
  readonly reaped: readonly ReapedFeature[];
}

/**
 * Supply the recovery decision instead of computing it from `crash_count`,
 * and say whether this failure is a crash at all (LOOP-07, M06 step 6.7).
 *
 * The one caller is the round loop's transient-provider-failure path. A
 * provider outage is evidence about the *provider*, not about the feature, so
 * it must spend neither the crash ceiling that `planRecovery` reads nor the
 * counter that feeds it — otherwise two real crashes plus one rate limit
 * escalate a feature whose only genuine problem was two crashes.
 *
 * It is deliberately an override on {@link reapOne} rather than a second
 * recovery function: this module's whole reason for existing is that the
 * lease-expiry tick and the fast path "cannot diverge in behaviour", and a
 * parallel copy of the transition-plus-CAS-plus-audit write is exactly the
 * divergence that warning is about.
 */
export interface RecoveryOverride {
  /** What to do, decided by the caller's own policy rather than by `planRecovery`. */
  readonly decision: RecoveryDecision;
  /** `false` leaves `crash_count` untouched — this failure was not the feature crashing. */
  readonly countsAsCrash: boolean;
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
 * Recover — or, at the crash ceiling, escalate — one feature row whose
 * worker is gone: an expired lease found by the tick, or an unexpected
 * `child.on('exit')` from the fast path.
 *
 * `expectedLeaseToken`, when supplied, guards the fast path against a
 * worker's late exit racing a lease the reaper (or a fresh dispatch) already
 * reassigned: if the row's current token no longer matches, this is a
 * no-op — the row belongs to someone else now, and this exit has nothing to
 * say about it.
 *
 * `planRecovery` decides recover-vs-escalate purely from `feature.crash_count`
 * (D-11); this function is what turns that decision into the write. A
 * recover applies the `lease_expired` transition and resets
 * `current_stage_index` to 0 (D-10 — `transition()`'s own `lease_expired`
 * edges never touch the stage index, so the reset happens here, in the same
 * transaction, rather than by editing the checksum-guarded `transition.ts`).
 * An escalate applies `unrecoverable` instead, landing the feature in
 * `escalated`. Either way `crash_count` is incremented in the same
 * transaction as the state write, per D-11's "increment and decision happen
 * together" requirement — a manager that dies mid-recovery cannot
 * double-count. `workspace_handle` is never touched by either branch: D-12's
 * "recovery re-attaches, never rebuilds" is true because nothing here
 * deletes or overwrites it, not because a restore step ran.
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
  override?: RecoveryOverride,
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

  const decision =
    override?.decision ??
    planRecovery({
      state: feature.state as FeatureState,
      round: feature.round,
      currentStageIndex: feature.current_stage_index,
      crashCount: feature.crash_count,
    });

  const event =
    decision.kind === 'recover'
      ? ({ t: 'lease_expired' } as const)
      : ({ t: 'unrecoverable', reason: decision.reason } as const);

  const ctx: TransitionCtx = {
    featureId: feature.id,
    stateVersion: feature.state_version,
    lastEventSeq,
    round: feature.round,
    // Neither `lease_expired` nor `unrecoverable` consults these two fields
    // — both are state-independent of the pipeline shape — so a placeholder
    // here is inert, never load-bearing.
    maxRounds: 0,
    pipelineLength: 0,
    currentStageIndex: feature.current_stage_index,
    actor: deps.actor ?? 'reaper',
    at: now,
  };

  const outcome = transition(feature.state as FeatureState, event, ctx);
  if (!outcome.ok) {
    deps.logger.warn(
      {
        featureId: feature.id,
        state: feature.state,
        event: event.t,
        reason: outcome.reason,
      },
      'reaper: transition rejected',
    );
    return undefined;
  }

  const nextCurrentStageIndex =
    decision.kind === 'recover'
      ? decision.resetStageIndexTo
      : feature.current_stage_index + outcome.counters.currentStageIndex;

  const casApplied = await deps.db.transaction().execute(async (trx) => {
    const trxRepo = featuresRepository(trx);
    const applied = await trxRepo.compareAndSwapState({
      id: feature.id,
      expectedVersion: outcome.expectedStateVersion,
      state: outcome.next,
      round: feature.round + outcome.counters.round,
      currentStageIndex: nextCurrentStageIndex,
      updatedAt: now,
    });
    if (!applied) {
      // Lost the race — a concurrent writer already moved this row past the
      // version this reap attempt read. Do not increment crash_count for a
      // recovery that never actually applied, do not append an event, and
      // do not clear a lease that may no longer be the one this call read.
      return false;
    }

    // D-11: increment in the same transaction as the state write, so a
    // manager that dies between the two cannot double-count this crash.
    // LOOP-07's transient path opts out (`countsAsCrash: false`) — a provider
    // outage is not the feature crashing, and spending the crash ceiling on
    // one is what that step exists to stop.
    if (override?.countsAsCrash !== false) {
      await trx
        .updateTable('features')
        .set({ crash_count: feature.crash_count + 1 })
        .where('id', '=', feature.id)
        .execute();
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

    if (feature.lease_token !== null) {
      await trxRepo.expireLease({
        id: feature.id,
        leaseToken: feature.lease_token,
      });
    }
    return true;
  });

  if (!casApplied) {
    deps.logger.warn(
      { featureId: feature.id, state: feature.state },
      'reaper: compareAndSwapState lost the race, skipping recovery write',
    );
    return undefined;
  }

  return {
    featureId: feature.id,
    fromState: outcome.from,
    decision: decision.kind === 'recover' ? 'recovered' : 'escalated',
  };
}

/**
 * D-11's other half: reset `crash_count` to zero wherever a round completes
 * successfully. No caller exists yet in this phase — the gate pipeline this
 * would fire from is Phase 4+ — so this is exercised directly by a unit test
 * today (`test/recovery/crash-recovery.test.ts`) and wired at the real
 * round-completion write site once that pipeline lands, in the same
 * transaction as the round outcome, for the same "increment and decision
 * happen together" reason the crash counter's own increment does.
 */
export async function resetCrashCountOnSuccess(
  db: Kysely<Database>,
  featureId: string,
): Promise<void> {
  await db
    .updateTable('features')
    .set({ crash_count: 0 })
    .where('id', '=', featureId)
    .execute();
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
