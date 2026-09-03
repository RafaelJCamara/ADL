import { describe, expect, it } from 'vitest';
import {
  citedCriterionIds,
  unknownCitedCriteria,
  VerdictSchema,
  type Verdict,
} from '../../src/verdict/index.js';

/**
 * ROLE-04's semantic half (M07 step 7.6).
 *
 * `PassVerdictSchema.checked` has been non-empty by schema since M01, so
 * "an approval citing nothing is malformed" is already enforced. What a schema
 * structurally cannot check is whether the thing cited **exists**:
 * `{ kind: 'criterion', id: 'AC-99' }` is a perfectly valid `CriterionRef`
 * against a spec with one criterion.
 *
 * Every verdict below is built through `VerdictSchema.parse`, not as a bare
 * object literal. That is not ceremony: a fixture that the published schema
 * would reject is a fixture testing a shape no gate can actually emit, and it
 * would let this file go green about a case that cannot occur.
 */

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

function verdict(value: unknown): Verdict {
  return VerdictSchema.parse(value);
}

describe('citedCriterionIds', () => {
  it("reads a pass's cited coverage, in the order it was cited", () => {
    expect(
      citedCriterionIds(
        verdict({
          outcome: 'pass',
          summary: 'all good',
          checked: [
            { kind: 'criterion', id: 'AC-2' },
            { kind: 'criterion', id: 'AC-1' },
          ],
        }),
      ),
    ).toEqual(['AC-2', 'AC-1']);
  });

  it('returns an empty list for a pass that cited only globals', () => {
    // The command gate's honest answer for a build that went green: it checked
    // no criterion, and says so. Valid, and visibly different from claiming
    // criterion coverage — which is exactly the distinction
    // `worker-entry/gates/reviewer-gate.ts` derives its own refusal from.
    expect(
      citedCriterionIds(
        verdict({
          outcome: 'pass',
          summary: 'build is green',
          checked: [{ kind: 'global', category: 'build' }],
        }),
      ),
    ).toEqual([]);
  });

  it("reads every finding's criterion reference from a send_back", () => {
    expect(
      citedCriterionIds(
        verdict({
          outcome: 'send_back',
          summary: 'two problems',
          findings: [
            {
              fingerprint: FINGERPRINT_A,
              severity: 'blocker',
              title: 'export is missing',
              detail: 'nothing writes the file',
              criterionRef: { kind: 'criterion', id: 'AC-1' },
            },
            {
              fingerprint: FINGERPRINT_B,
              severity: 'major',
              title: 'no test',
              detail: 'nothing covers it',
              criterionRef: { kind: 'global', category: 'code_quality' },
            },
          ],
        }),
      ),
    ).toEqual(['AC-1']);
  });

  it("reads a skip's waiver target when it names a criterion", () => {
    // A waiver is a HUMAN's recorded decision. A gate emitting one that names
    // a criterion the spec does not define is fabricating a human's answer,
    // not merely miscounting — which is why `skip` is checked at all.
    expect(
      citedCriterionIds(
        verdict({
          outcome: 'skip',
          reason: 'accepted for now',
          waiver: {
            target: { kind: 'criterion', id: 'AC-1' },
            reason: 'shipping without it',
            actor: 'maintainer',
            at: '2026-09-03T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual(['AC-1']);
  });

  it('returns nothing for a skip whose waiver targets a whole stage', () => {
    expect(
      citedCriterionIds(
        verdict({
          outcome: 'skip',
          reason: 'harness unavailable',
          waiver: {
            target: { kind: 'stage', stageId: 'review' },
            reason: 'no reviewer configured',
            actor: 'maintainer',
            at: '2026-09-03T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('returns nothing for the two outcomes that carry only a reason', () => {
    expect(
      citedCriterionIds(
        verdict({ outcome: 'fail', summary: 's', reason: 'unfixable' }),
      ),
    ).toEqual([]);
    expect(
      citedCriterionIds(
        verdict({ outcome: 'inconclusive', summary: 's', reason: 'could not' }),
      ),
    ).toEqual([]);
  });
});

describe('unknownCitedCriteria', () => {
  it('is empty when every cited criterion is one the spec defines', () => {
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'pass',
          summary: 'all good',
          checked: [
            { kind: 'criterion', id: 'AC-1' },
            { kind: 'criterion', id: 'AC-2' },
          ],
        }),
        knownCriterionIds: ['AC-1', 'AC-2', 'AC-3'],
      }),
    ).toEqual([]);
  });

  it('names a criterion the spec does not contain', () => {
    // The case ROLE-04 exists for. A schema cannot catch this — it has no spec
    // — and the row it would write to `verdict_checked_criteria` is what the
    // pull request's coverage section is drawn from.
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'pass',
          summary: 'looks fine',
          checked: [
            { kind: 'criterion', id: 'AC-1' },
            { kind: 'criterion', id: 'AC-99' },
          ],
        }),
        knownCriterionIds: ['AC-1'],
      }),
    ).toEqual(['AC-99']);
  });

  it('catches a send_back citing a criterion that does not exist', () => {
    // Not only a `pass`. A finding pointing at `AC-99` renders in the PR
    // against a criterion that is not there, and `fingerprintFinding` will
    // happily make it stable across every round that follows.
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'send_back',
          summary: 'one problem',
          findings: [
            {
              fingerprint: FINGERPRINT_A,
              severity: 'blocker',
              title: 'wrong',
              detail: 'it is wrong',
              criterionRef: { kind: 'criterion', id: 'AC-4' },
            },
          ],
        }),
        knownCriterionIds: ['AC-1', 'AC-2'],
      }),
    ).toEqual(['AC-4']);
  });

  it('preserves order and duplicates, leaving rendering to the caller', () => {
    // `violatedProtectedPaths`' own rule: the caller decides how to render the
    // list, and a criterion is not cited twice merely because two findings
    // happen to agree about it.
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'send_back',
          summary: 'three problems',
          findings: [
            {
              fingerprint: FINGERPRINT_A,
              severity: 'blocker',
              title: 'a',
              detail: 'a',
              criterionRef: { kind: 'criterion', id: 'AC-9' },
            },
            {
              fingerprint: FINGERPRINT_B,
              severity: 'minor',
              title: 'b',
              detail: 'b',
              criterionRef: { kind: 'criterion', id: 'AC-1' },
            },
            {
              fingerprint: 'c'.repeat(64),
              severity: 'minor',
              title: 'c',
              detail: 'c',
              criterionRef: { kind: 'criterion', id: 'AC-9' },
            },
          ],
        }),
        knownCriterionIds: ['AC-1'],
      }),
    ).toEqual(['AC-9', 'AC-9']);
  });

  it('rejects every citation when the spec defines no criteria at all', () => {
    // A spec that parsed to zero criteria is already refused upstream, but the
    // honest answer here is that nothing can be cited against it — not that
    // everything can.
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'pass',
          summary: 'fine',
          checked: [{ kind: 'criterion', id: 'AC-1' }],
        }),
        knownCriterionIds: [],
      }),
    ).toEqual(['AC-1']);
  });

  it('never flags a global category, which names no criterion to check', () => {
    expect(
      unknownCitedCriteria({
        verdict: verdict({
          outcome: 'pass',
          summary: 'build is green',
          checked: [{ kind: 'global', category: 'build' }],
        }),
        knownCriterionIds: [],
      }),
    ).toEqual([]);
  });
});
