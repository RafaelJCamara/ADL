import { LoadError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { AcceptanceCriterion } from './types.js';

/**
 * The one place `AC-n` is assigned, for every spec format.
 *
 * D-02 says both formats share **one flat sequence**. That is a decision with
 * exactly one honest implementation: a single function both loaders route
 * through. Assigning ids inside each loader would make "one sequence" a
 * convention repeated in two files, and conventions repeated in two files
 * diverge — at which point a Gherkin-sourced criterion and a template-sourced
 * one could no longer be addressed by the same coverage row.
 *
 * The same reasoning covers the empty case. Refusing zero criteria here means
 * neither loader gets to decide independently that an empty spec is
 * acceptable.
 */

/**
 * A criterion as a loader produces it: everything except the two fields that
 * are not a loader's to choose.
 *
 * `id` is positional across the whole document and `textHash` is derived, so
 * both belong to {@link assignCriterionIds}.
 */
export type CriterionBody =
  | Omit<Extract<AcceptanceCriterion, { kind: 'statement' }>, 'id' | 'textHash'>
  | Omit<Extract<AcceptanceCriterion, { kind: 'scenario' }>, 'id' | 'textHash'>;

/**
 * The digest of a criterion's text, over the author's **exact bytes**.
 *
 * No Unicode normalisation. No lowercasing. No whitespace collapsing. This is
 * deliberate and it is the opposite of what `fingerprintFinding` in
 * `verdict/finding.ts` does — and the contrast is load-bearing, so the two must
 * not be unified into one "hash a string" helper:
 *
 * - `criterionTextHash` is about **fidelity**. Its job is to notice that the
 *   author edited a criterion between spec revisions, so a stale cross-revision
 *   join can be invalidated instead of silently mis-joining (D-01). Normalising
 *   here would make an edit that changed only spacing or only a combining
 *   character invisible, and `textHash` would stop detecting real edits.
 *
 * - `fingerprintFinding` is about **matching**. Its job is to recognise that two
 *   differently-worded complaints from two agent turns are the same complaint,
 *   so it applies NFKC, lowercasing, and whitespace collapsing on purpose.
 *   Applying this function's exactness there would make stall detection never
 *   fire, because a model rarely phrases the same finding byte-identically
 *   twice.
 *
 * One is a fidelity check, the other is a similarity check. Swapping them
 * breaks both.
 */
export function criterionTextHash(text: string): string {
  return sha256Hex(text);
}

/**
 * Assign `AC-1`, `AC-2`, … positionally in document order and attach each
 * criterion's `textHash` (D-01, D-02).
 *
 * Ids are format-blind on purpose: nothing here reads `kind`, so a scenario
 * and a bullet are numbered by the same rule and cited by the same reference
 * without translation. There is no `SCN-n` namespace, and adding one later
 * would mean a criterion could be stored but never addressed by the coverage
 * row that a template-sourced criterion uses.
 *
 * @param bodies The criteria a loader extracted, already in document order.
 * @param sourceLabel The entry filename, so a refusal names the author's file.
 * @throws {LoadError} when `bodies` is empty. A spec must never enter the loop
 *   with zero acceptance criteria: a gate with nothing to check against cannot
 *   fail, so it goes green — coverage mapping degrading to vibes, arriving
 *   through the front door. This function is the only place it can be stopped
 *   for both formats at once.
 */
export function assignCriterionIds(
  bodies: readonly CriterionBody[],
  sourceLabel: string,
): AcceptanceCriterion[] {
  if (bodies.length === 0) {
    throw new LoadError(
      `"${sourceLabel}" yields zero acceptance criteria; a spec cannot enter the loop with nothing to check against.`,
    );
  }

  return bodies.map((body, index) => ({
    ...body,
    id: `AC-${index + 1}`,
    textHash: criterionTextHash(body.text),
  }));
}
