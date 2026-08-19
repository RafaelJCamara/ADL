import type { FeatureState } from '@adl/core/state';

/**
 * The crash-recovery policy (D-10, D-11, D-12) — a pure decision, deliberately
 * separated from the database write that applies it.
 *
 * `planRecovery` is injected-dependency-free and imports nothing from
 * `@adl/db` or `node:fs`: it is a decision about a crash's *shape* (which
 * state, how many prior consecutive crashes), never about how that decision
 * gets persisted. That mirrors Phase 1's `01-CONTEXT.md` D-15 — the
 * consecutive-error escalation counter this plan's `crash_count` restates for
 * a different failure class — same concept, same shape, no new vocabulary.
 * Being pure also means the whole truth table is a fast unit test rather than
 * a scenario requiring a database (`test/recovery/crash-recovery.test.ts`).
 *
 * What this module does NOT decide: whether *this* crash counts as one more
 * against the ceiling is the caller's job (it increments `crash_count` in the
 * same transaction as the state write, per D-11's "increment and decision
 * happen together" requirement) — `planRecovery` only answers "given the
 * count already on the row, is there still a recovery to grant".
 */

/**
 * The consecutive-crash ceiling (D-11). A feature that crashes this many
 * times in a row is escalated on the next crash rather than recovered a
 * fourth time — without a ceiling a reproducibly-crashing feature recovers
 * forever and burns budget silently.
 */
export const MAX_CONSECUTIVE_CRASHES = 3;

/**
 * Recover: resume at the same round (preserved automatically — every
 * `lease_expired` edge `transition()` draws has a zero round delta, so there
 * is nothing for this decision to carry about it), replaying the pipeline
 * from stage 0 (D-10). The stage-index reset is carried here, rather than
 * inside `transition()`, because it is an **absolute** reset to zero, not a
 * counter delta `TransitionResult.counters` can express, and `transition.ts`
 * is checksum-guarded against exactly this kind of addition (Plan 01-08).
 */
export interface RecoverDecision {
  readonly kind: 'recover';
  readonly resetStageIndexTo: 0;
}

/**
 * Escalate: the ceiling was already reached before this crash. `reason` is
 * carried into the `unrecoverable` event's own `reason` field, so the audit
 * trail says why without a human having to infer it from a bare crash count.
 */
export interface EscalateDecision {
  readonly kind: 'escalate';
  readonly reason: string;
}

export type RecoveryDecision = RecoverDecision | EscalateDecision;

/**
 * Everything `planRecovery` is allowed to know about the crash it is
 * deciding on. `round` and `currentStageIndex` are accepted — the plan's own
 * words are "a pure function taking the feature row's state, round, stage
 * index, and crash count" — but are not inspected by the decision itself:
 * `crashCount` alone determines recover vs. escalate. They are named on this
 * type so a call site can pass the row's own crash shape as one object
 * rather than filtering it down first, and so a reader sees exactly what
 * "resumes at the same round, stage 0" is a decision about.
 */
export interface RecoveryInput {
  readonly state: FeatureState;
  readonly round: number;
  readonly currentStageIndex: number;
  /** `features.crash_count` as read — prior consecutive crashes, before this one. */
  readonly crashCount: number;
}

/**
 * `planRecovery(input)` — recover, or escalate at the ceiling.
 *
 * A feature whose `crashCount` has already reached {@link MAX_CONSECUTIVE_CRASHES}
 * escalates on this crash rather than being granted a fourth automatic
 * recovery. Every count below the ceiling recovers.
 */
export function planRecovery(input: RecoveryInput): RecoveryDecision {
  if (input.crashCount >= MAX_CONSECUTIVE_CRASHES) {
    return {
      kind: 'escalate',
      reason:
        `feature crashed ${String(input.crashCount)} consecutive times, ` +
        `reaching the ceiling of ${String(MAX_CONSECUTIVE_CRASHES)}`,
    };
  }
  return { kind: 'recover', resetStageIndexTo: 0 };
}
