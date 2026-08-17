import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { criterionTextHash } from '../../src/spec/criterion-ids.js';
import { loadGherkinSpec } from '../../src/spec/gherkin.js';
import { loadAdlTemplateSpec } from '../../src/spec/markdown.js';
import type { NormalizedSpec } from '../../src/spec/types.js';

/**
 * The cross-format addressing invariant this plan's assumption-delta decision
 * commits to: every acceptance criterion, for every supported source format,
 * round-trips through the same `AC-n` addressing and carries a byte-exact
 * verbatim `text` slice.
 *
 * This test is meant to go red the instant a future phase reintroduces a
 * format-specific namespace (`SCN-n`) or a format-specific addressing rule —
 * which is the exact add-alongside regression D-02's decision rules out.
 */
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/spec/good/${name}`, import.meta.url)),
    'utf8',
  );
}

const SPECS: readonly {
  readonly label: string;
  readonly spec: NormalizedSpec;
}[] = [
  {
    label: 'spec.md',
    spec: loadAdlTemplateSpec(fixture('spec.md'), 'feature-branch-cleanup'),
  },
  {
    label: 'checkout.feature',
    spec: loadGherkinSpec(fixture('checkout.feature'), 'checkout'),
  },
  {
    label: 'rules.feature',
    spec: loadGherkinSpec(fixture('rules.feature'), 'withdrawal-limits'),
  },
  {
    label: 'outline.feature',
    spec: loadGherkinSpec(fixture('outline.feature'), 'cart-totals'),
  },
];

const CRITERION_ID_PATTERN = /^AC-\d+$/;

describe('the cross-format addressing invariant, over every fixture of both formats', () => {
  it.each(SPECS)(
    '$label: ids are AC-1..AC-n, no gaps, no duplicates',
    ({ spec }) => {
      const ids = spec.acceptanceCriteria.map((c) => c.id);
      expect(ids).toEqual(ids.map((_, i) => `AC-${i + 1}`));
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it.each(SPECS)(
    '$label: every id matches the CriterionId pattern',
    ({ spec }) => {
      for (const criterion of spec.acceptanceCriteria) {
        expect(criterion.id).toMatch(CRITERION_ID_PATTERN);
      }
    },
  );

  it('no criterion id carries a format-specific prefix', () => {
    // The invariant that would catch a reintroduced per-format namespace: a
    // Gherkin-sourced criterion id looks exactly like a template-sourced one.
    for (const { spec } of SPECS) {
      for (const criterion of spec.acceptanceCriteria) {
        expect(criterion.id).not.toMatch(/^SCN-/);
        expect(criterion.id).not.toMatch(/^GHK-/);
        expect(criterion.id.startsWith('AC-')).toBe(true);
      }
    }
  });

  it.each(SPECS)(
    '$label: every text is a verbatim source slice',
    ({ spec }) => {
      for (const criterion of spec.acceptanceCriteria) {
        expect(
          spec.raw.slice(criterion.source.start, criterion.source.end),
        ).toBe(criterion.text);
      }
    },
  );

  it.each(SPECS)(
    '$label: every textHash is stable across repeat parses',
    ({ label, spec }) => {
      for (const criterion of spec.acceptanceCriteria) {
        expect(criterion.textHash).toBe(criterionTextHash(criterion.text));
      }
      // A second parse of the same fixture produces the same hashes — this is
      // the id-generator determinism requirement, re-proven at this layer.
      const reparsed =
        label === 'spec.md'
          ? loadAdlTemplateSpec(fixture(label), spec.id)
          : loadGherkinSpec(fixture(label), spec.id);
      expect(reparsed.acceptanceCriteria.map((c) => c.textHash)).toEqual(
        spec.acceptanceCriteria.map((c) => c.textHash),
      );
    },
  );

  it('the two formats differ only in kind and sourceFormat — addressing itself is format-blind', () => {
    const template = SPECS.find((s) => s.label === 'spec.md');
    const gherkin = SPECS.find((s) => s.label === 'checkout.feature');
    expect(template?.spec.sourceFormat).toBe('adl-template');
    expect(gherkin?.spec.sourceFormat).toBe('gherkin');
    expect(
      template?.spec.acceptanceCriteria.every((c) => c.kind === 'statement'),
    ).toBe(true);
    expect(
      gherkin?.spec.acceptanceCriteria.every((c) => c.kind === 'scenario'),
    ).toBe(true);
    // Both id sequences follow the identical rule regardless of kind.
    expect(template?.spec.acceptanceCriteria.map((c) => c.id)).toEqual([
      'AC-1',
      'AC-2',
      'AC-3',
    ]);
    expect(gherkin?.spec.acceptanceCriteria.map((c) => c.id)).toEqual([
      'AC-1',
      'AC-2',
    ]);
  });
});

describe('Unicode fidelity in criterion text', () => {
  it('slices a multi-byte criterion correctly and hashes precomposed vs combining forms differently', () => {
    // "e with acute accent" written two ways: one precomposed codepoint
    // (U+00E9), one base letter plus a combining acute accent (U+0065
    // U+0301). They render identically and NFKC-normalise to the same
    // string, so a hash that normalised would call them equal.
    //
    // Built from explicit `\uXXXX` escapes rather than typed characters: a
    // typed accented character in a source file is at the mercy of whatever
    // normal form the editor or a "clean up whitespace" pass chooses, which
    // could silently collapse two intentionally-different literals into one
    // byte-identical string — and then this test would assert nothing.
    const precomposedE = 'é';
    const combiningE = 'é';
    expect(precomposedE).not.toBe(combiningE);
    expect(precomposedE.length).toBe(1);
    expect(combiningE.length).toBe(2);
    expect(precomposedE.normalize('NFKC')).toBe(combiningE.normalize('NFKC'));

    const precomposed = `# T\n\n## Acceptance Criteria\n\n- The caf${precomposedE} is open.\n`;
    const combining = `# T\n\n## Acceptance Criteria\n\n- The caf${combiningE} is open.\n`;
    expect(precomposed).not.toBe(combining);

    const specA = loadAdlTemplateSpec(precomposed, 'x');
    const specB = loadAdlTemplateSpec(combining, 'x');

    const [criterionA] = specA.acceptanceCriteria;
    const [criterionB] = specB.acceptanceCriteria;
    expect(criterionA).toBeDefined();
    expect(criterionB).toBeDefined();

    // Byte-exact slicing still holds for the multi-byte content.
    expect(
      precomposed.slice(criterionA?.source.start, criterionA?.source.end),
    ).toBe(criterionA?.text);

    // Visually identical, NFKC-equal, but the hash treats them as different —
    // no normalisation is silently applied.
    expect(criterionA?.text.normalize('NFKC')).toBe(
      criterionB?.text.normalize('NFKC'),
    );
    expect(criterionA?.textHash).not.toBe(criterionB?.textHash);
  });
});
