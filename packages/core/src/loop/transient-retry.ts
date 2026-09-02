import {
  isTransientStageErrorKind,
  type StageErrorKind,
} from '../stage/stage-error.js';

/**
 * Provider-failure backoff, decoupled from the crash-count ceiling (LOOP-07,
 * M06 step 6.7) — the pure half, sibling to {@link detectStalemate} and
 * {@link violatedProtectedPaths}.
 *
 * `stage-error.ts` has carried the classification since M01 and says outright
 * what it deliberately left undone: *"The backoff loop and the wall-clock
 * deadline that `retryable` feeds are Phase 6 runtime. This module ships the
 * classification and the threshold, not the loop."* This module is that loop's
 * decision.
 *
 * ## What was actually wrong
 *
 * `stageErrorPolicy` already promises a broken stage costs no round
 * (`consumesRound` is `false` for every kind, which is CORE-06's whole point)
 * and `provider_error`/`timeout` are already `retryable`. But every retryable
 * failure was routed through `reapOne` → `planRecovery`, which decides purely
 * from `features.crash_count` against {@link MAX_CONSECUTIVE_CRASHES} — a
 * counter **shared with real worker crashes**. Two consequences, and the second
 * is the worse one:
 *
 * 1. A sustained provider outage escalated a feature that was never broken,
 *    after three attempts with no delay between them.
 * 2. A provider blip and an actual crash spent the *same* budget, so two real
 *    crashes plus one rate limit escalated a feature whose only genuine problem
 *    was two crashes.
 *
 * ## Why the two budgets are separate rather than one bigger one
 *
 * They measure different things. `crash_count` measures *this feature is
 * failing* — a worker that died is evidence about the feature, and D-11's
 * ceiling exists so a reproducibly-crashing feature cannot recover forever. A
 * provider outage is evidence about **the provider**, and is very likely
 * affecting every other feature on the daemon identically. Escalating a
 * feature for the provider's downtime tells a human something untrue about
 * their code.
 *
 * ## Why this is a separate module from `planRecovery`
 *
 * `planRecovery` lives in `@adl/manager` because it decides from a database
 * column. This decides from a {@link StageErrorKind} and a count, so it belongs
 * in `@adl/core` beside the classification it reads — and being pure means the
 * whole schedule is a fast unit test rather than a scenario that has to wait
 * out a real backoff.
 *
 * This module reads no clock. `backoffMs` is a *duration*, and the caller
 * compares it against its own instant — the same discipline `ReaperDeps`
 * holds itself to with its deliberate absence of a clock member.
 */

/**
 * How many consecutive transient failures a feature may accumulate before ADL
 * stops retrying and asks a human (LOOP-08's channel).
 *
 * Deliberately larger than {@link MAX_CONSECUTIVE_CRASHES}' 3: a crash is
 * evidence about the feature and should give up early, while a provider outage
 * is evidence about the provider and is worth waiting out. Paired with the
 * schedule below this is roughly ten minutes of sustained provider failure
 * before a human is told, rather than three immediate attempts.
 */
export const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 8;

/** The first wait, and the base the schedule doubles from. */
export const TRANSIENT_BACKOFF_BASE_MS = 5_000;

/**
 * The longest single wait. Without a ceiling, doubling reaches hours by the
 * eighth attempt and the feature would look wedged rather than retrying.
 */
export const TRANSIENT_BACKOFF_CEILING_MS = 300_000;

/**
 * How long to wait before re-dispatching, given how many consecutive transient
 * failures are now on record.
 *
 * Exponential from {@link TRANSIENT_BACKOFF_BASE_MS}, capped at
 * {@link TRANSIENT_BACKOFF_CEILING_MS}. Total and monotonic over every integer:
 * a count at or below one yields the base wait rather than a fractional or
 * negative duration, so a caller that miscounts gets the shortest real wait
 * instead of an undefined one.
 *
 * **Deliberately deterministic — no jitter.** Jitter answers thundering-herd
 * contention between independent clients, and `dispatchOnce` is a single
 * writer holding one lease at a time (`concurrency.global` defaults to 1). A
 * random component here would buy nothing and would make the schedule
 * untestable without injecting a second source of nondeterminism.
 */
export function transientBackoffMs(consecutiveFailures: number): number {
  const attempt = Math.max(1, Math.floor(consecutiveFailures));
  // `2 ** 30` is already far past the ceiling, so clamping the exponent keeps
  // the arithmetic finite for an absurd input without changing any real answer.
  const doublings = Math.min(attempt - 1, 30);
  return Math.min(
    TRANSIENT_BACKOFF_BASE_MS * 2 ** doublings,
    TRANSIENT_BACKOFF_CEILING_MS,
  );
}

export interface TransientRetryInput {
  /** The kind the stage reported. A non-transient kind never reaches a retry. */
  readonly kind: StageErrorKind;
  /**
   * How many consecutive transient failures this feature now has on record,
   * **including the one being decided**.
   *
   * `round-runner.ts` records the stage error before it computes a
   * `RoundStep` — "evidence first, state second" — so by the time the caller
   * reads this count the current failure is already in it, exactly as
   * `detectStalemate`'s own occurrence count already includes the current
   * round. No separate "+1 for this one" adjustment exists, or should.
   */
  readonly consecutiveFailures: number;
}

export type TransientRetryDecision =
  /** Hand the lease back and re-dispatch the same stage, no sooner than `backoffMs` from now. */
  | { readonly kind: 'retry'; readonly backoffMs: number }
  /** The transient budget is spent. Escalate to a human, naming what was tried. */
  | { readonly kind: 'escalate'; readonly reason: string };

/**
 * `planTransientRetry(input)` — wait and try the same stage again, or give up
 * and tell a human.
 *
 * Total over every input, and never throws: a non-transient kind arriving here
 * is a caller bug, and the honest answer is to escalate naming the kind rather
 * than to grant a retry budget the classification says does not exist. That
 * mirrors `planRoundStep`'s own totality — a malformed report is classified,
 * not trusted and not dropped.
 *
 * Nothing here decides whether the failure cost a round or any budget. It did
 * not, for either: `stageErrorPolicy` already answers both with `false` for
 * every kind, and restating that here would be the second definition rule 8
 * exists to prevent.
 */
export function planTransientRetry(
  input: TransientRetryInput,
): TransientRetryDecision {
  const { kind, consecutiveFailures } = input;

  if (!isTransientStageErrorKind(kind)) {
    return {
      kind: 'escalate',
      reason:
        `stage error kind "${kind}" is not transient, so it has no retry ` +
        'budget to spend — another attempt cannot fix it',
    };
  }

  if (consecutiveFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
    return {
      kind: 'escalate',
      reason:
        `the provider failed ${String(consecutiveFailures)} consecutive times ` +
        `(${kind}), reaching the transient-failure ceiling of ` +
        `${String(MAX_CONSECUTIVE_TRANSIENT_FAILURES)}`,
    };
  }

  return { kind: 'retry', backoffMs: transientBackoffMs(consecutiveFailures) };
}
