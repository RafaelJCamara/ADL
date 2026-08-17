// DELIBERATE VIOLATION FIXTURE — owned by plan 01-03.
// Trips: `no-restricted-syntax` (the ban on .refine()/.superRefine() under
// packages/core/src/verdict/ — z.toJSONSchema() drops refinements silently,
// so the published contract would be weaker than the enforced one).
// Never compiled, never executed, never imported.
import * as z from 'zod';

export const RefinedSchema = z
  .object({ id: z.string() })
  .refine((value) => value.id.length > 0);
