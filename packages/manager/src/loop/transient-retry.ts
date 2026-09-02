/**
 * `checkTransientRetry` — the database half of LOOP-07 (M06 step 6.7).
 *
 * `@adl/core/loop`'s `planTransientRetry` is pure and decides from a
 * {@link StageErrorKind} and a count; it reads no database and no clock. This
 * module is what supplies the count: how many of a feature's most recent
 * finished stage attempts broke transiently, in a row.
 *
 * ## Why the count is derived, not stored
 *
 * There is no migration here and no `transient_failure_count` column, for the
 * reason 5.2, 5.6, 5.10 and 6.6 each landed on independently: **evaluate
 * recorded state, don't remember events.** `stage_attempts` has carried
 * `status` and `error_kind` since migration `0002`, and "the last N attempts
 * for this feature, newest first" is exactly the history the question is about.
 * A counter column would additionally have to be reset correctly on every
 * success — a second write that can be forgotten, and the specific bug class
 * `resetCrashCountOnSuccess` had to exist to fix for `crash_count`. A derived
 * count cannot drift from the rows it is derived from.
 *
 * ## Why the count is read after the error is recorded
 *
 * `round-runner.ts` calls `recordStageError` before it computes a `RoundStep`
 * — "evidence first, state second", the ordering `checkProtectedPaths` and
 * `checkStalemate` both already hold themselves to. So by the time this module
 * reads the history, the failure being decided is already the newest row in
 * it, and `planTransientRetry` needs no "+1 for this one" adjustment.
 *
 * ## What breaks a streak
 *
 * Any finished attempt that is not itself a transient error: an attempt that
 * judged, and an attempt that broke for a reason another try cannot fix. That
 * is what makes the count *consecutive* rather than cumulative — a feature
 * that hits one rate limit per round, forever, is making progress and must
 * never accumulate its way to an escalation.
 */
import type { Kysely } from 'kysely';
import { verdictsRepository, type Database } from '@adl/db';
import {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  planTransientRetry,
  transientBackoffMs,
  type TransientRetryDecision,
} from '@adl/core/loop';
import {
  isTransientStageErrorKind,
  STAGE_ERROR_KINDS,
  type StageErrorKind,
} from '@adl/core/stage';

/**
 * How many rows the history read needs.
 *
 * Derived from the ceiling rather than restated (rule 8): the decision is
 * settled once `MAX_CONSECUTIVE_TRANSIENT_FAILURES` consecutive failures have
 * been seen, so one more row than that is enough to distinguish "at the
 * ceiling" from "past it" and nothing beyond it is ever inspected.
 */
export const TRANSIENT_HISTORY_LOOKBACK =
  MAX_CONSECUTIVE_TRANSIENT_FAILURES + 1;

export type TransientRetryCheckResult =
  /** Wait `backoffMs`, then run the same stage again. Costs no round and no crash. */
  | {
      readonly kind: 'retry';
      readonly backoffMs: number;
      readonly consecutiveFailures: number;
    }
  /** The transient budget is spent — escalate to a human. */
  | {
      readonly kind: 'escalate';
      readonly reason: string;
      readonly consecutiveFailures: number;
    }
  /**
   * The check itself could not run — a database read failed. Never `retry`:
   * an infrastructure failure that silently granted an unbounded retry budget
   * would be the fail-open bug this check exists to prevent (CORE-06), the
   * same discipline `checkStalemate` and `checkProtectedPaths` hold themselves
   * to. The caller falls back to the crash-recovery ceiling, which is bounded.
   */
  | { readonly kind: 'error'; readonly detail: string };

export interface CheckTransientRetryDeps {
  readonly db: Kysely<Database>;
}

export interface CheckTransientRetryParams {
  readonly featureId: string;
  /** The kind the stage that just broke reported. */
  readonly kind: StageErrorKind;
}

/** Is this recorded attempt a transient failure, as `@adl/core` classifies it? */
function isTransientAttempt(attempt: {
  status: string;
  error_kind: string | null;
}): boolean {
  if (attempt.status !== 'error' || attempt.error_kind === null) return false;
  // The column is a bare string, so it is narrowed against the closed enum
  // before being classified — a value no `StageErrorKind` covers (a row
  // written by an older build, or by hand) is not transient, which fails
  // closed onto the bounded crash ceiling rather than open onto an
  // unbounded retry budget.
  const kind = STAGE_ERROR_KINDS.find(
    (candidate) => candidate === attempt.error_kind,
  );
  return kind !== undefined && isTransientStageErrorKind(kind);
}

/**
 * How many of a feature's most recent finished attempts broke transiently, in
 * an unbroken run ending at the newest one.
 *
 * Exported for its own unit test: the counting rule is the load-bearing half
 * of this module, and it is a pure function over rows.
 */
export function countConsecutiveTransientFailures(
  newestFirst: readonly { status: string; error_kind: string | null }[],
): number {
  let count = 0;
  for (const attempt of newestFirst) {
    if (!isTransientAttempt(attempt)) break;
    count += 1;
  }
  return count;
}

/**
 * Should this transient stage failure wait and try the same stage again, or
 * has the provider failed often enough that a human should be told?
 *
 * Never throws. A failure to read the history is reported as `'error'` so the
 * caller can fall back to the bounded crash-recovery path rather than either
 * retrying forever or spending one of the feature's finite rounds on an
 * infrastructure problem it did not cause (CORE-06).
 */
export async function checkTransientRetry(
  deps: CheckTransientRetryDeps,
  params: CheckTransientRetryParams,
): Promise<TransientRetryCheckResult> {
  let recent: readonly { status: string; error_kind: string | null }[];
  try {
    recent = await verdictsRepository(deps.db).recentStageAttemptsForFeature(
      params.featureId,
      TRANSIENT_HISTORY_LOOKBACK,
    );
  } catch (error) {
    return {
      kind: 'error',
      detail: `could not read this feature's stage-attempt history: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // At least one, always: `recordStageError` wrote the failure being decided
  // before this read, so a zero here means the write did not land — and
  // deciding a retry against a count of zero would hand out the base backoff
  // forever. Flooring at one spends the budget honestly instead.
  const consecutiveFailures = Math.max(
    1,
    countConsecutiveTransientFailures(recent),
  );

  const decision: TransientRetryDecision = planTransientRetry({
    kind: params.kind,
    consecutiveFailures,
  });

  return decision.kind === 'retry'
    ? { kind: 'retry', backoffMs: decision.backoffMs, consecutiveFailures }
    : { kind: 'escalate', reason: decision.reason, consecutiveFailures };
}

/**
 * How long a feature must still wait before it may be dispatched again, given
 * the transient failures already on its record (LOOP-07's backoff, enforced at
 * the one place a feature is picked up).
 *
 * `undefined` means "not waiting" — no transient failure ended its run, or the
 * window has already passed. Returns `undefined` on a read failure too: a
 * backoff that cannot be computed must not become an indefinite hold on a
 * feature, and the retry budget itself is already bounded, so the conservative
 * direction here is to let the dispatch proceed rather than to stall forever.
 */
export async function transientBackoffRemainingMs(
  deps: CheckTransientRetryDeps,
  featureId: string,
  now: string,
): Promise<number | undefined> {
  let recent: readonly {
    status: string;
    error_kind: string | null;
    ended_at: string | null;
  }[];
  try {
    recent = await verdictsRepository(deps.db).recentStageAttemptsForFeature(
      featureId,
      TRANSIENT_HISTORY_LOOKBACK,
    );
  } catch {
    return undefined;
  }

  const consecutiveFailures = countConsecutiveTransientFailures(recent);
  if (consecutiveFailures === 0) return undefined;

  const newest = recent[0];
  if (newest?.ended_at === null || newest?.ended_at === undefined) {
    return undefined;
  }

  const readyAt =
    Date.parse(newest.ended_at) + transientBackoffMs(consecutiveFailures);
  const remaining = readyAt - Date.parse(now);
  return remaining > 0 ? remaining : undefined;
}
