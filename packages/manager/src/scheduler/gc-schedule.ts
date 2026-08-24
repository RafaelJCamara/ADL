import { Cron } from 'croner';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { featuresRepository, type Database } from '@adl/db';
import {
  processIsAlive,
  sweepOrphans,
  sweepScratchHomes,
  type FeatureStateLookup,
  type ScratchHomeSweepFailure,
  type SweepFailure,
} from '@adl/workspace';
import { ulidOf } from '../branch-identity.js';

/**
 * `src/scheduler/gc-schedule.ts` — discharging Phase 2's deferred D-15: a
 * schedule and a manual trigger for `sweepOrphans` and `sweepScratchHomes`
 * (D-34).
 *
 * `@adl/workspace` owns the mechanism (`listManagedWorktrees`, the two
 * sweeps' own policy) — this module's entire job is the two things Phase 2's
 * own barrel comment named as Phase 3's: binding `lookupFeatureState` to the
 * real `featuresRepository`, and running the trigger, on a timer and on
 * demand. Neither sweep is redefined here.
 */

/**
 * Resolve a feature id to its persisted state through the real repository —
 * the {@link FeatureStateLookup} `sweepOrphans` needs, exported separately so
 * a test can drive it directly against a temp database without going through
 * a full `runGcOnce` call.
 *
 * `sweepOrphans` hands this whatever `featureIdFromBranch` extracted from a
 * managed worktree's branch — for a real dispatch (DETECT-05, 5.6) that is
 * the composed `<folderName>--<ulid>` identity `stage-runner.ts` builds
 * (`../branch-identity.js`), not the bare row id. `ulidOf` recovers the
 * ULID half, falling back to the whole value for a plain id with no `--`
 * (every pre-5.6 fixture, and any branch this encoding never touched) —
 * exactly what this lookup always did before 5.6.
 */
export function createFeatureStateLookup(
  db: Kysely<Database>,
): FeatureStateLookup {
  const repo = featuresRepository(db);
  return async (featureId) => {
    const feature = await repo.findById(ulidOf(featureId));
    return feature?.state;
  };
}

/** Everything one GC pass needs. Carries no clock — neither sweep needs one (D-16). */
export interface GcRunDeps {
  /** The repository whose linked worktrees `sweepOrphans` inventories. */
  readonly mainRepo: string;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

/** {@link GcRunDeps} plus the schedule's own cadence — `startGcSchedule`'s input. */
export interface GcScheduleDeps extends GcRunDeps {
  /** The schedule's cadence, in milliseconds (`daemonConfig.gc.interval_ms`, D-34). */
  readonly intervalMs: number;
}

/** What one `runGcOnce` pass reclaimed, and what it could not. */
export interface GcRunSummary {
  readonly worktreesRemoved: readonly string[];
  readonly scratchHomesRemoved: readonly string[];
  readonly worktreeFailures: readonly SweepFailure[];
  readonly scratchHomeFailures: readonly ScratchHomeSweepFailure[];
}

/**
 * Run one sweep of a fallible pass, logging (rather than propagating) a
 * thrown failure so the other sweep still runs. Per-entry failures inside a
 * sweep are already reported through its own `onFailure` — this catch is for
 * the sweep call itself failing outright (an inventory read that throws, a
 * test double standing in for one), which is a different, coarser event.
 */
async function runSweep<T>(
  name: string,
  fn: () => Promise<readonly T[]>,
  logger: Logger,
): Promise<readonly T[]> {
  try {
    return await fn();
  } catch (error) {
    logger.warn({ err: error }, `GC: the ${name} sweep threw and was skipped`);
    return [];
  }
}

/**
 * One GC pass: both sweeps, always — `sweepScratchHomes` beside
 * `sweepOrphans`, per `@adl/workspace`'s own barrel comment naming this the
 * manager's job. A failure in one sweep does not prevent the other from
 * running.
 */
export async function runGcOnce(deps: GcRunDeps): Promise<GcRunSummary> {
  const lookupFeatureState = createFeatureStateLookup(deps.db);

  const worktreeFailures: SweepFailure[] = [];
  const scratchHomeFailures: ScratchHomeSweepFailure[] = [];

  const worktreesRemoved = await runSweep(
    'orphan-worktree',
    () =>
      sweepOrphans({
        mainRepo: deps.mainRepo,
        lookupFeatureState,
        onFailure: (failure) => {
          worktreeFailures.push(failure);
          deps.logger.warn(
            {
              featureId: failure.featureId,
              worktreePath: failure.worktreePath,
              err: failure.error,
            },
            'GC: failed to collect an orphaned worktree',
          );
        },
      }),
    deps.logger,
  );

  const scratchHomesRemoved = await runSweep(
    'scratch-home',
    () =>
      sweepScratchHomes({
        // The same liveness probe `@adl/workspace` exports, never a second
        // one — this module binds it, it does not redefine it.
        isProcessAlive: processIsAlive,
        onFailure: (failure) => {
          scratchHomeFailures.push(failure);
          deps.logger.warn(
            { path: failure.path, reason: failure.reason, err: failure.error },
            'GC: failed to collect a scratch home',
          );
        },
      }),
    deps.logger,
  );

  return {
    worktreesRemoved,
    scratchHomesRemoved,
    worktreeFailures,
    scratchHomeFailures,
  };
}

export interface GcScheduleHandle {
  stop(): void;
}

/**
 * Start the GC schedule: `runGcOnce` on `deps.intervalMs`'s cadence, via
 * `croner` rather than the reaper's own `setInterval` (`scheduler/reaper.ts`
 * explains the split: the reaper is driven to ~50ms in tests where
 * cron-expression scheduling is not the right tool; the GC cadence is
 * minutes-to-hours, where it is).
 *
 * `croner` has no native "every N milliseconds" pattern below one-second
 * resolution, so the interval is expressed as `pattern: '* * * * * *'`
 * (matches every second) paired with `options.interval` — croner's own
 * "minimum interval between executions, in seconds" — rounded up from
 * `intervalMs` to the nearest whole second, floored at 1. That is exactly
 * right for this schedule's cadence (D-34's default is 30 minutes; the
 * two-orders-of-magnitude-over-the-heartbeat acceptance criterion is stated
 * in whole seconds-or-larger terms) and is never asked to resolve
 * sub-second, which is the reaper's job.
 *
 * `protect: true` guards this job against **re-entering itself** — a slow
 * pass still running when the next tick fires waits rather than overlapping.
 * It says nothing about the reaper's own `setInterval` loop, which is a
 * completely separate timer; the two sweeps share a scheduling mechanism
 * (croner) here, never a cadence, and `sweepOrphans` is documented safe
 * under concurrent overlapping passes with itself, which is what makes
 * `protect` sufficient rather than something needing a cross-timer mutex.
 */
export function startGcSchedule(deps: GcScheduleDeps): GcScheduleHandle {
  const intervalSeconds = Math.max(1, Math.round(deps.intervalMs / 1000));

  const job = new Cron(
    '* * * * * *',
    {
      interval: intervalSeconds,
      protect: true,
      catch: (error: unknown) => {
        deps.logger.error({ err: error }, 'GC schedule tick failed');
      },
    },
    async () => {
      await runGcOnce(deps);
    },
  );

  return {
    stop: () => job.stop(),
  };
}
