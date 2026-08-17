import { sortFindings, type Finding } from './finding.js';
import type { RoundOutcome } from './round-outcome.js';
import type { InconclusiveVerdict, Verdict } from './verdict.js';

/**
 * Reduce a round's verdicts to a single {@link RoundOutcome}. Pure, total, and
 * the single enforcement point for CORE-02.
 *
 * Precedence (D-10): **`fail` → `send_back` → `inconclusive` → `warn`/`skip`/`pass`**
 *
 * 1. Any `fail` short-circuits to `escalate`. A gate that judged the work
 *    unfixable by looping is not something another round fixes.
 * 2. Otherwise, any `send_back` produces `send_back`, carrying every finding
 *    every gate raised. This deliberately outranks `inconclusive`: an
 *    inconclusive sitting alongside real findings usually resolves once the
 *    code changes — the app failed to start *because* of the bug.
 * 3. An `inconclusive` with **no `send_back` anywhere** produces `unverified`.
 *    Nothing actionable came back, so there is nothing for the developer to do
 *    and a human has to look.
 * 4. Only when every verdict is `pass`, `warn`, or `skip` is the result green.
 *
 * The ordering of steps 1–4 is what makes green unreachable in the presence of
 * `inconclusive`: `green` is returned from exactly one place, guarded by the
 * absence of all three other classes. `test/verdict/aggregate.exhaustive.test.ts`
 * proves that over all **3,002** multisets for pipeline lengths 1–8, and proves
 * the result is permutation-invariant so ordering cannot smuggle a different
 * answer past the guards.
 *
 * Green is not encoded at the type level, deliberately (D-08): TypeScript can
 * prove this function's branches, but it cannot also prove the verdict list it
 * was handed covers every configured stage — so a type-level green would be a
 * guarantee about the wrong thing. The runtime function is the single
 * enforcement point.
 *
 * **Never throws, reads no clock, touches no I/O.** An empty verdict list is
 * not an error and it is not green — see below.
 */
export function aggregate(verdicts: readonly Verdict[]): RoundOutcome {
  // No gate ran, so nothing was verified. Returning green here would be the
  // purest form of the failure this project exists to prevent: an empty
  // pipeline reporting success. `unverified` would be wrong too — its payload
  // is the inconclusive verdicts that caused it, and there are none. It is a
  // misconfiguration, so a human is the right recipient.
  if (verdicts.length === 0) {
    return {
      kind: 'escalate',
      reason: 'No verdicts were produced — the pipeline ran zero gates, so nothing was verified.',
    };
  }

  const fails = verdicts.filter((v) => v.outcome === 'fail');
  if (fails.length > 0) {
    return {
      kind: 'escalate',
      reason: fails.map((v) => v.reason).join('; '),
    };
  }

  const sendBacks = verdicts.filter((v) => v.outcome === 'send_back');
  if (sendBacks.length > 0) {
    // "Every finding from every gate that raised one" — `warn` findings ride
    // along, because the developer is editing this code anyway and a
    // non-blocking observation is cheapest to act on now. `sortFindings` makes
    // the brief byte-identical across rounds that found the same things, which
    // is what keeps LOOP-06's stall detection meaningful.
    const findings: Finding[] = [];
    for (const v of verdicts) {
      if (v.outcome === 'send_back' || v.outcome === 'warn') {
        findings.push(...v.findings);
      }
    }
    return { kind: 'send_back', brief: { findings: sortFindings(findings) } };
  }

  const inconclusive: InconclusiveVerdict[] = verdicts.filter((v) => v.outcome === 'inconclusive');
  if (inconclusive.length > 0) {
    return { kind: 'unverified', inconclusive };
  }

  // Everything remaining is pass, warn, or skip. Note that this is reached
  // only after all three checks above found nothing — green is not a default,
  // it is a conclusion.
  return { kind: 'green' };
}
