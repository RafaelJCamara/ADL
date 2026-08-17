import * as z from 'zod';

/**
 * A criterion identifier: `AC-1`, `AC-2`, … assigned positionally in document
 * order at parse time (D-01).
 *
 * The regex is linear with no nested quantifiers, so catastrophic backtracking
 * is not reachable (threat T-1-11, dispositioned `accept`).
 */
export const CriterionIdSchema = z
  .string()
  .regex(/^AC-\d+$/)
  .meta({
    id: 'CriterionId',
    description: 'Positional acceptance-criterion identifier, e.g. "AC-3"',
  });

export type CriterionId = z.infer<typeof CriterionIdSchema>;

/**
 * The buckets a finding may claim when it is genuinely not about one
 * acceptance criterion — a reviewer's code-quality note, a SARIF result from a
 * security harness, a build break.
 */
export const GlobalCategorySchema = z
  .enum(['code_quality', 'security', 'build', 'other'])
  .meta({
    id: 'GlobalCategory',
    description:
      'Category for a finding that is not tied to one acceptance criterion',
  });

export type GlobalCategory = z.infer<typeof GlobalCategorySchema>;

/**
 * What a finding — or a `pass` verdict's cited coverage — points at (D-03).
 *
 * This is a **required** discriminated union rather than an optional field
 * with a sentinel string. A gate that has a complaint not tied to a criterion
 * declares `{ kind: 'global', category }` and says which bucket, so the PR
 * coverage table can show an honest untied-findings section instead of hiding
 * one.
 *
 * Each member is individually `.meta({ id })`'d: naming only the outer union
 * still leaves the members emitted as positional `__schemaN` in `$defs`
 * (Pattern 2).
 */
export const CriterionRefSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({ kind: z.literal('criterion'), id: CriterionIdSchema })
      .meta({ id: 'CriterionRefCriterion' }),
    z
      .strictObject({
        kind: z.literal('global'),
        category: GlobalCategorySchema,
      })
      .meta({ id: 'CriterionRefGlobal' }),
  ])
  .meta({
    id: 'CriterionRef',
    description: 'Points at an acceptance criterion or a global category',
  });

export type CriterionRef = z.infer<typeof CriterionRefSchema>;
