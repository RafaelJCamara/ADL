/**
 * Which acceptance criteria a verdict claims to be about — and which of those
 * the spec does not actually contain (ROLE-04, M07 step 7.6).
 *
 * `PassVerdictSchema.checked` is already non-empty **by schema**, so "an
 * approval citing nothing is malformed rather than an approval" has been
 * enforced since M01. What a schema structurally cannot check is whether the
 * thing cited *exists*: `{ kind: 'criterion', id: 'AC-99' }` is a perfectly
 * valid `CriterionRef` against a spec with three criteria, because the schema
 * has no spec. Only something holding both does.
 *
 * ── Why this is not the reviewer's private rule ───────────────────────────
 *
 * M07's step sketch put this check inside the reviewer gate, on the grounds
 * that the reviewer is the thing that holds the spec. Writing it turned up the
 * reason it belongs one level out instead: **any** gate may cite a criterion.
 * A plain-command gate running in `emits: verdict` mode (HARN-02, 7.3) can
 * print `{"outcome":"pass","checked":[{"kind":"criterion","id":"AC-99"}]}` just
 * as easily as an agent can, and the row it would write to
 * `verdict_checked_criteria` — the table the pull request's coverage section is
 * drawn from — is exactly as false. Enforcing it once, for every gate, is
 * therefore both stricter and *less* special-casing than enforcing it for the
 * reviewer alone, which is what HARN-04 asks for.
 *
 * So this module is the pure half: given a verdict and the criterion ids the
 * spec actually defines, which citations name nothing. `@adl/manager`'s
 * `worker-entry/stage-runner.ts` is the impure half that holds both and turns
 * a non-empty answer into a `StageError`.
 *
 * ── Every citation, not only a `pass`'s ───────────────────────────────────
 *
 * A `send_back` finding pointing at `AC-99` is as wrong as a `pass` claiming
 * it: it renders in the PR against a criterion that does not exist, and
 * `fingerprintFinding` will happily make it stable across rounds. A `skip`'s
 * waiver target is included for the same reason and one more — a waiver is a
 * *human's* recorded decision, so a gate emitting one that names a
 * non-existent criterion is fabricating a human's answer, not merely
 * miscounting.
 *
 * This module does no I/O and holds no spec: `knownCriterionIds` is supplied
 * by the caller, matching `loop/protected-paths.ts`'s own split between the
 * pure predicate here and the database-and-git half in `@adl/manager`.
 */
import type { CriterionRef } from './criterion-ref.js';
import type { Verdict } from './verdict.js';

/** Every `{ kind: 'criterion' }` reference a citation list names, in order. */
function criterionIdsOf(refs: readonly CriterionRef[]): readonly string[] {
  return refs.flatMap((ref) => (ref.kind === 'criterion' ? [ref.id] : []));
}

/**
 * Every acceptance-criterion id this verdict cites, in the order it cites
 * them, duplicates preserved.
 *
 * Order- and duplicate-preserving for `violatedProtectedPaths`' reason: the
 * caller decides how to render the list, and a criterion is not cited twice
 * merely because two findings agree about it.
 *
 * **A `pass` for which this returns an empty list cited only globals** — which
 * is the command gate's honest answer for a build that went green, and is not
 * an honest answer from a gate whose job is to judge implementation against
 * the spec. That distinction is the gate's own to make (the reviewer refuses
 * it; see `worker-entry/gates/reviewer-gate.ts`), and it is *derived* from
 * this function rather than restated beside it (convention 8).
 */
export function citedCriterionIds(verdict: Verdict): readonly string[] {
  switch (verdict.outcome) {
    case 'pass':
      return criterionIdsOf(verdict.checked);
    case 'send_back':
    case 'warn':
      return criterionIdsOf(
        verdict.findings.map((finding) => finding.criterionRef),
      );
    case 'skip': {
      const target = verdict.waiver?.target;
      // `WaiverTarget` is a `CriterionRef` OR `{ kind: 'stage' }`; only the
      // first names a criterion.
      return target === undefined || target.kind === 'stage'
        ? []
        : criterionIdsOf([target]);
    }
    case 'fail':
    case 'inconclusive':
      // Both carry a `reason` and nothing pointing at a criterion.
      return [];
    default: {
      // A seventh outcome is unrepresentable (`VerdictSchema`'s own note); if
      // one is ever added, this fails the build rather than silently returning
      // nothing for it, which would read as "cites no criteria" (convention 7).
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export interface CitedCriteriaInput {
  /** The verdict a gate produced. */
  readonly verdict: Verdict;
  /** The criterion ids the spec this gate was given actually defines — `NormalizedSpec.acceptanceCriteria`'s ids. */
  readonly knownCriterionIds: readonly string[];
}

/**
 * Which of the verdict's cited criteria the spec does not contain.
 *
 * Empty means clean. Order- and duplicate-preserving, per
 * {@link citedCriterionIds}.
 */
export function unknownCitedCriteria(
  input: CitedCriteriaInput,
): readonly string[] {
  const known = new Set(input.knownCriterionIds);
  return citedCriterionIds(input.verdict).filter((id) => !known.has(id));
}
