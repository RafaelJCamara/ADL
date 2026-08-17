import * as z from 'zod';
import { CriterionRefSchema } from './criterion-ref.js';
import { FindingSchema } from './finding.js';
import { WaiverSchema } from './waiver.js';

/**
 * The six outcomes a gate may return — the settled vocabulary CORE-01 exists
 * to fix in place.
 *
 * | Outcome        | Means                                          | Consumes a round |
 * |----------------|------------------------------------------------|------------------|
 * | `pass`         | The gate judged, and it is satisfied           | no               |
 * | `send_back`    | The gate judged, and the developer must fix it | **yes**          |
 * | `fail`         | The gate judged the work unfixable by looping  | no — escalates   |
 * | `inconclusive` | The gate **could not tell**                    | no — escalates   |
 * | `warn`         | Non-blocking observations                      | no               |
 * | `skip`         | The gate did not run                           | no               |
 *
 * `inconclusive` is the outcome the whole project turns on: "we could not
 * tell" must be structurally distinct from "it is fine", or an unverified
 * result renders as a verified one.
 *
 * Note what is **not** here: infrastructure failure. A gate that crashed,
 * timed out, or returned unparseable output yields a `StageError`, which sits
 * outside this union entirely (D-12, CORE-06). "The gate judged" and "the gate
 * broke" are different kinds of thing.
 */
export const OUTCOMES = Object.freeze([
  'pass',
  'send_back',
  'fail',
  'inconclusive',
  'warn',
  'skip',
] as const);

export type Outcome = (typeof OUTCOMES)[number];

/** A gate judged and is satisfied. Must cite what it checked (D-11). */
export const PassVerdictSchema = z
  .object({
    outcome: z.literal('pass'),
    summary: z.string().min(1),
    /**
     * Non-empty by schema, not by convention. ROLE-04's "an approval citing
     * none is malformed rather than an approval" is enforced here, in Phase 1,
     * because adding a required field after verdicts are persisted invalidates
     * every stored row. A command gate cites `{ kind: 'global' }` — honest, and
     * visibly different from claiming criterion coverage.
     */
    checked: z.array(CriterionRefSchema).min(1),
  })
  .meta({ id: 'PassVerdict' });

/** A gate judged and wants changes. The only outcome that consumes a round. */
export const SendBackVerdictSchema = z
  .object({
    outcome: z.literal('send_back'),
    summary: z.string().min(1),
    /** A send-back with nothing actionable in it is not a send-back. */
    findings: z.array(FindingSchema).min(1),
  })
  .meta({ id: 'SendBackVerdict' });

/** A gate judged the work not fixable by another round. Escalates. */
export const FailVerdictSchema = z
  .object({
    outcome: z.literal('fail'),
    summary: z.string().min(1),
    reason: z.string().min(1),
  })
  .meta({ id: 'FailVerdict' });

/** The gate could not tell. Never green. Escalates when nothing is actionable. */
export const InconclusiveVerdictSchema = z
  .object({
    outcome: z.literal('inconclusive'),
    summary: z.string().min(1),
    reason: z.string().min(1),
  })
  .meta({ id: 'InconclusiveVerdict' });

/** Non-blocking observations. `findings` may legitimately be empty. */
export const WarnVerdictSchema = z
  .object({
    outcome: z.literal('warn'),
    summary: z.string().min(1),
    findings: z.array(FindingSchema),
  })
  .meta({ id: 'WarnVerdict' });

/**
 * The gate did not run. A recorded absence of judgement — never coverage.
 *
 * The optional waiver is what makes the human-retry edge able to say *what
 * changed* (D-07).
 */
export const SkipVerdictSchema = z
  .object({
    outcome: z.literal('skip'),
    reason: z.string().min(1),
    waiver: WaiverSchema.optional(),
  })
  .meta({ id: 'SkipVerdict' });

/**
 * What a gate returns.
 *
 * A seventh outcome is not merely discouraged — it is unrepresentable. An
 * unknown `outcome` produces a Zod `invalid_union` issue whose `options` array
 * lists exactly these six, which is precisely what D-13's single repair
 * reprompt quotes back to the model.
 */
export const VerdictSchema = z
  .discriminatedUnion('outcome', [
    PassVerdictSchema,
    SendBackVerdictSchema,
    FailVerdictSchema,
    InconclusiveVerdictSchema,
    WarnVerdictSchema,
    SkipVerdictSchema,
  ])
  .meta({
    id: 'Verdict',
    description: 'The judgement a gate returns — one of exactly six outcomes',
  });

export type Verdict = z.infer<typeof VerdictSchema>;
export type PassVerdict = z.infer<typeof PassVerdictSchema>;
export type SendBackVerdict = z.infer<typeof SendBackVerdictSchema>;
export type FailVerdict = z.infer<typeof FailVerdictSchema>;
export type InconclusiveVerdict = z.infer<typeof InconclusiveVerdictSchema>;
export type WarnVerdict = z.infer<typeof WarnVerdictSchema>;
export type SkipVerdict = z.infer<typeof SkipVerdictSchema>;

/**
 * Does this verdict consume one of the feature's finite rounds?
 *
 * Only `send_back` does. This is a **derived predicate over the outcome**, not
 * a stored field, deliberately: a stored `consumesRound` boolean can disagree
 * with the outcome it accompanies, and the first time it does, a feature is
 * either charged for an honest exit or given a free retry. Deriving it makes
 * that disagreement unrepresentable.
 *
 * `fail` and `inconclusive` escalate rather than loop, so they consume nothing;
 * a dispute consumes nothing for the same reason (D-06) — charging for the
 * honest exit re-creates the exact pressure the honest exit removes.
 */
export function consumesRound(verdict: Verdict): boolean {
  return verdict.outcome === 'send_back';
}
