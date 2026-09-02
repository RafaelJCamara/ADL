import { describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  TRANSIENT_BACKOFF_BASE_MS,
  TRANSIENT_BACKOFF_CEILING_MS,
  planTransientRetry,
  transientBackoffMs,
} from '../../src/loop/transient-retry.js';
import {
  STAGE_ERROR_KINDS,
  isTransientStageErrorKind,
} from '../../src/stage/stage-error.js';

/**
 * The provider-failure backoff policy (LOOP-07, M06 step 6.7).
 *
 * `stage-error.ts` shipped the classification in M01 and said what it left
 * undone — *"the backoff loop and the wall-clock deadline that `retryable`
 * feeds are Phase 6 runtime"*. This is that loop's decision, and being pure is
 * what makes the whole schedule a fast test rather than a scenario that has to
 * wait one out.
 */

describe('transientBackoffMs', () => {
  it('starts at the base wait and doubles', () => {
    expect(transientBackoffMs(1)).toBe(TRANSIENT_BACKOFF_BASE_MS);
    expect(transientBackoffMs(2)).toBe(TRANSIENT_BACKOFF_BASE_MS * 2);
    expect(transientBackoffMs(3)).toBe(TRANSIENT_BACKOFF_BASE_MS * 4);
    expect(transientBackoffMs(4)).toBe(TRANSIENT_BACKOFF_BASE_MS * 8);
  });

  it('never exceeds the ceiling, however many failures are on record', () => {
    for (const n of [10, 50, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(transientBackoffMs(n)).toBe(TRANSIENT_BACKOFF_CEILING_MS);
    }
  });

  it('is monotonic and always a finite, positive duration', () => {
    let previous = 0;
    for (let n = 1; n <= 40; n += 1) {
      const wait = transientBackoffMs(n);
      expect(Number.isFinite(wait)).toBe(true);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeGreaterThanOrEqual(previous);
      previous = wait;
    }
  });

  it('floors a miscounted input at the base wait rather than returning a nonsense duration', () => {
    // A caller that manages to pass zero, a negative, or a fraction gets the
    // shortest *real* wait — never a zero-length or negative one, which would
    // turn the backoff into a hot loop, and never `NaN`.
    for (const n of [0, -1, -1_000, 0.5]) {
      expect(transientBackoffMs(n)).toBe(TRANSIENT_BACKOFF_BASE_MS);
    }
  });
});

describe('planTransientRetry', () => {
  it('retries every count below the ceiling, with that count’s backoff', () => {
    for (let n = 1; n < MAX_CONSECUTIVE_TRANSIENT_FAILURES; n += 1) {
      expect(
        planTransientRetry({ kind: 'provider_error', consecutiveFailures: n }),
      ).toEqual({ kind: 'retry', backoffMs: transientBackoffMs(n) });
    }
  });

  it('escalates at the ceiling, and stays escalated past it', () => {
    for (const n of [
      MAX_CONSECUTIVE_TRANSIENT_FAILURES,
      MAX_CONSECUTIVE_TRANSIENT_FAILURES + 1,
      MAX_CONSECUTIVE_TRANSIENT_FAILURES + 100,
    ]) {
      const decision = planTransientRetry({
        kind: 'timeout',
        consecutiveFailures: n,
      });
      expect(decision.kind).toBe('escalate');
      // The reason is rendered into a public pull-request comment by LOOP-08,
      // so it has to say what was tried without a reader re-deriving it.
      if (decision.kind === 'escalate') {
        expect(decision.reason).toContain(String(n));
        expect(decision.reason).toContain(
          String(MAX_CONSECUTIVE_TRANSIENT_FAILURES),
        );
        expect(decision.reason).toContain('timeout');
      }
    }
  });

  it('both transient kinds get the budget, and no other kind does', () => {
    for (const kind of STAGE_ERROR_KINDS) {
      const decision = planTransientRetry({ kind, consecutiveFailures: 1 });
      // Derived from the classification rather than restated as a list here:
      // a sixth kind added to `STAGE_ERROR_KINDS` is covered by this loop the
      // day it exists, and is covered *correctly* whichever way it is
      // classified.
      expect(decision.kind).toBe(
        isTransientStageErrorKind(kind) ? 'retry' : 'escalate',
      );
    }
  });

  it('escalates a non-transient kind rather than granting it a budget it does not have', () => {
    // A caller bug — `round-runner.ts` only calls this for a transient kind —
    // and the honest answer is the classification's, not a retry. Total over
    // the enum, never a throw, matching `planRoundStep`'s own discipline.
    const decision = planTransientRetry({
      kind: 'auth',
      consecutiveFailures: 1,
    });
    expect(decision).toEqual({
      kind: 'escalate',
      reason: expect.stringContaining('not transient') as unknown as string,
    });
  });

  it('gives the provider a longer run than a crashing feature gets', () => {
    // The reason the two budgets are separate at all: a crash is evidence
    // about the feature and should give up early; a provider outage is
    // evidence about the provider and is worth waiting out. `@adl/manager`'s
    // `MAX_CONSECUTIVE_CRASHES` is 3 and cannot be imported here (core depends
    // on nothing), so this asserts the direction the two must never swap.
    expect(MAX_CONSECUTIVE_TRANSIENT_FAILURES).toBeGreaterThan(3);
  });
});
