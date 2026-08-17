import * as z from 'zod';
import { FindingSchema } from './finding.js';
import { InconclusiveVerdictSchema } from './verdict.js';

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
 * The round reached the end of the pipeline with nothing outstanding.
 *
 * It carries no payload beyond its discriminant, deliberately. There is no
 * "green with caveats" member, and green carries no list of things it decided
 * to overlook, because a caveat attached to an approval is an approval that
 * renders as green and reads as green.
 */
export const GreenOutcomeSchema = z
  .object({ kind: z.literal('green') })
  .meta({ id: 'GreenOutcome', description: 'Every gate judged, and nothing is outstanding' });

/** The round produced actionable findings. The only outcome that loops. */
export const SendBackOutcomeSchema = z
  .object({ kind: z.literal('send_back'), brief: SendBackBriefSchema })
  .meta({ id: 'SendBackOutcome', description: 'The developer gets a brief and another round' });

/** The round cannot be resolved by looping. A human is the right recipient. */
export const EscalateOutcomeSchema = z
  .object({ kind: z.literal('escalate'), reason: z.string().min(1) })
  .meta({ id: 'EscalateOutcome', description: 'Looping cannot resolve this; escalate to a human' });

/**
 * A gate could not tell, and nothing actionable came back.
 *
 * The inconclusive verdicts travel with the outcome rather than being
 * re-derived from the raw verdict list, so the escalation path and the PR
 * rollup can say *which* gate could not tell and why without re-running the
 * classification.
 */
export const UnverifiedOutcomeSchema = z
  .object({
    kind: z.literal('unverified'),
    inconclusive: z.array(InconclusiveVerdictSchema).min(1),
  })
  .meta({ id: 'UnverifiedOutcome', description: 'A gate could not tell, and nothing is actionable' });

/**
 * The result of a whole round of gates (D-09).
 *
 * Four kinds, because "the gates said no" and "we could not tell" are
 * genuinely different situations, and the loop, the PR rollup, and the
 * escalation path each need to branch on one value rather than re-derive the
 * classification from the raw verdict list.
 *
 * This lives in its own module rather than beside {@link aggregate} because
 * those three consumers import the *shape* without importing the function that
 * produces it — and because each union member carries its own `.meta({ id })`,
 * which is what keeps emitted `$defs` names stable rather than positional
 * (01-RESEARCH.md § Pattern 2).
 *
 * There is no member meaning "green with caveats". That is the point.
 */
export const RoundOutcomeSchema = z
  .discriminatedUnion('kind', [
    GreenOutcomeSchema,
    SendBackOutcomeSchema,
    EscalateOutcomeSchema,
    UnverifiedOutcomeSchema,
  ])
  .meta({
    id: 'RoundOutcome',
    description: 'The aggregated result of one round of gates',
  });

export type RoundOutcome = z.infer<typeof RoundOutcomeSchema>;
export type GreenOutcome = z.infer<typeof GreenOutcomeSchema>;
export type SendBackOutcome = z.infer<typeof SendBackOutcomeSchema>;
export type EscalateOutcome = z.infer<typeof EscalateOutcomeSchema>;
export type UnverifiedOutcome = z.infer<typeof UnverifiedOutcomeSchema>;
