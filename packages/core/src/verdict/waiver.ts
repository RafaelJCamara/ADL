import * as z from 'zod';
import { CriterionRefSchema } from './criterion-ref.js';

/**
 * What a waiver covers: either a specific acceptance criterion / global
 * category, or a whole stage by id.
 */
export const WaiverTargetSchema = z
  .union([
    CriterionRefSchema,
    z.object({ kind: z.literal('stage'), stageId: z.string().min(1) }).meta({
      id: 'WaiverTargetStage',
    }),
  ])
  .meta({
    id: 'WaiverTarget',
    description: 'A criterion, a global category, or an entire stage',
  });

export type WaiverTarget = z.infer<typeof WaiverTargetSchema>;

/**
 * A human's recorded decision to accept a gate not being satisfied (D-07).
 *
 * This exists in Phase 1 because the `escalated → queued` human-retry edge
 * otherwise has no way to express *what changed*, so the same gate fails
 * identically on the next round. Phase 1 defines the shape and persists it;
 * Phase 6 enforces it.
 *
 * A waiver is **not** evidence that a criterion was checked. A `skip` carrying
 * a waiver is a recorded absence of judgement, and the PR renders it as such.
 */
export const WaiverSchema = z
  .object({
    target: WaiverTargetSchema,
    /** Why the human accepted it. Free prose, but never empty. */
    reason: z.string().min(1),
    /** Who granted it — a human identity, never an agent. */
    actor: z.string().min(1),
    /** ISO-8601 instant the waiver was granted. */
    at: z.iso.datetime(),
  })
  .meta({
    id: 'Waiver',
    description: 'A human-granted, recorded acceptance that a gate was not satisfied',
  });

export type Waiver = z.infer<typeof WaiverSchema>;
