import * as z from 'zod';
import { FindingSchema, sortFindings, type Finding } from './finding.js';
import { InconclusiveVerdictSchema, type Verdict } from './verdict.js';

/**
 * What the developer receives when a round sends work back: every actionable
 * finding every gate raised, in a deterministic order.
 */
export const SendBackBriefSchema = z
  .object({
    findings: z.array(FindingSchema).min(1),
  })
  .meta({
    id: 'SendBackBrief',
    description: 'The actionable findings a round is sending back to the developer',
  });

export type SendBackBrief = z.infer<typeof SendBackBriefSchema>;

/**
 * The result of a whole round of gates (D-09).
 *
 * Four kinds, because "the gates said no" and "we could not tell" are
 * genuinely different situations and the loop, the PR rollup, and the
 * escalation path each need to branch on one value rather than re-derive the
 * classification from the raw verdict list.
 *
 * There is no member meaning "green with caveats". That is the point.
 */
export const RoundOutcomeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('green') }).meta({ id: 'RoundOutcomeGreen' }),
    z
      .object({ kind: z.literal('send_back'), brief: SendBackBriefSchema })
      .meta({ id: 'RoundOutcomeSendBack' }),
    z
      .object({ kind: z.literal('escalate'), reason: z.string().min(1) })
      .meta({ id: 'RoundOutcomeEscalate' }),
    z
      .object({
        kind: z.literal('unverified'),
        inconclusive: z.array(InconclusiveVerdictSchema).min(1),
      })
      .meta({ id: 'RoundOutcomeUnverified' }),
  ])
  .meta({
    id: 'RoundOutcome',
    description: 'The aggregated result of one round of gates',
  });

export type RoundOutcome = z.infer<typeof RoundOutcomeSchema>;

/**
 * Reduce a round's verdicts to a single outcome. Pure, total, and the single
 * enforcement point for CORE-02.
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
 * absence of all three other classes. Plan 01-04 proves this exhaustively over
 * all 3,002 multisets for pipeline lengths 1–8; this function only has to be
 * correct and total.
 *
 * **Never throws.** An empty verdict list is not an error and it is not green —
 * see below.
 */
export function aggregate(verdicts: readonly Verdict[]): RoundOutcome {
  // No gate ran, so nothing was verified. Returning green here would be the
  // purest form of the failure this project exists to prevent: an empty
  // pipeline reporting success. It is a misconfiguration, so a human is the
  // right recipient.
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
    // "Every finding from every gate that raised one" — warn findings ride
    // along, because the developer is editing this code anyway and a
    // non-blocking observation is cheapest to act on now.
    const findings: Finding[] = [];
    for (const v of verdicts) {
      if (v.outcome === 'send_back' || v.outcome === 'warn') {
        findings.push(...v.findings);
      }
    }
    return { kind: 'send_back', brief: { findings: sortFindings(findings) } };
  }

  const inconclusive = verdicts.filter((v) => v.outcome === 'inconclusive');
  if (inconclusive.length > 0) {
    return { kind: 'unverified', inconclusive };
  }

  // Everything remaining is pass, warn, or skip. Note that this is reached
  // only after all three checks above found nothing — green is not a default,
  // it is a conclusion.
  return { kind: 'green' };
}
