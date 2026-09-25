/**
 * Turning one app-lifecycle failure into what the loop acts on (ROLE-07, M08
 * step 8.3).
 *
 * `@adl/core/stage`'s `answerForAppFailure` is the **table** — which channel each
 * failure rides, and why. This is the thin layer that turns a channel plus the
 * failure's own words into something the caller can return, and it is separate for the
 * reason `@adl/core` is pure: the table is policy, and the words are facts
 * observed at the exec boundary. A `Finding`'s `detail` names the command that
 * failed and the exit code it returned, which `@adl/core` has no way to know.
 *
 * ## Why `send_back` is built here and not by the gate
 *
 * The gate never ran. `build-failed` and `app-exited-before-ready` both happen
 * *before* `withAppUnderTest` calls its body, so there is no verdict to amend —
 * ADL is reporting on the app rather than relaying a judgement. That makes the
 * attribution explicit and the summary honest: the finding says the build failed,
 * not that some gate decided the build failed.
 *
 * ## The fingerprint carries nothing that varies between runs
 *
 * `command-gate.ts`'s rule, for its reason: `limits.repeat_finding_threshold`'s
 * stall detection (M06 step 6.6) recognises the same failure recurring across
 * rounds by fingerprint, so the title carries the stage, the failure kind and the
 * exit code — and never a duration, a port, or any of the output. A port changes
 * every attempt, so a fingerprint including one would make every round look like a
 * fresh problem and stalemate detection would never fire.
 */
import { answerForAppFailure } from '@adl/core/stage';
import { fingerprintFinding, type Verdict } from '@adl/core/verdict';
import type { StageErrorKind } from '@adl/core/stage';
import type { AppFailure } from './lifecycle.js';

/** What {@link appFailureOutcome} answers. */
export type AppFailureOutcome =
  /** Report it as this stage's verdict — a `send_back`, never a `pass`. */
  | { readonly kind: 'verdict'; readonly verdict: Verdict }
  /**
   * Report it as a `StageError` of this kind. The caller builds the envelope so
   * `retryable` keeps coming from `stageErrorPolicy` in exactly one place.
   */
  | { readonly kind: 'stage_error'; readonly errorKind: StageErrorKind };

/**
 * The stable half of a finding's identity — see the module docblock.
 *
 * `exitCode` is included because it is stable for a given defect and genuinely
 * distinguishes one build failure from another; `null` is rendered as a word
 * rather than omitted, so "killed" and "exited 0" cannot collide.
 */
function titleFor(stageId: string, failure: AppFailure): string {
  const exitCode =
    'exitCode' in failure
      ? failure.exitCode === null
        ? ' (no exit code)'
        : ` (exit ${String(failure.exitCode)})`
      : '';
  return `the app under test could not be brought up for the ${stageId} gate: ${failure.kind}${exitCode}`;
}

/**
 * Decide what one app failure means.
 *
 * Total over {@link AppFailure} without a `switch`, because the decision is
 * `answerForAppFailure`'s and this function only dresses it. A `report_only`
 * channel cannot arrive: the one failure classified that way —
 * `teardown-failed` — is deliberately not an {@link AppFailure} at all, and
 * `lifecycle.ts` carries the compile-time assertion that says so. It is handled
 * rather than asserted because `answerForAppFailure`'s return type admits it and a
 * non-null assertion here would be the one place the compiler was overruled.
 */
export function appFailureOutcome(
  stageId: string,
  failure: AppFailure,
): AppFailureOutcome {
  const answer = answerForAppFailure(failure.kind);

  if (answer.channel === 'stage_error') {
    return { kind: 'stage_error', errorKind: answer.errorKind };
  }

  if (answer.channel === 'report_only') {
    // Unreachable through `AppFailure`; see the docblock. `provider_error` rather
    // than a thrown error, because a should-not-happen that retries once is
    // strictly better than one that crashes a worker.
    return { kind: 'stage_error', errorKind: 'provider_error' };
  }

  const title = titleFor(stageId, failure);
  const verdict: Verdict = {
    outcome: 'send_back',
    summary: `the ${stageId} gate never ran: ${failure.kind}`,
    findings: [
      {
        fingerprint: fingerprintFinding({ stageId, title }),
        severity: answer.severity,
        title,
        detail: failure.detail,
        criterionRef: { kind: 'global', category: answer.category },
      },
    ],
  };
  return { kind: 'verdict', verdict };
}
