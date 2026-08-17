import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LoadError } from '../../src/errors.js';
import { collectScenarios, isOutline, loadGherkinSpec } from '../../src/spec/gherkin.js';

/**
 * The Gherkin half of the intake surface (SPEC-02).
 *
 * The organising fact of this file: **parser success is necessary and never
 * sufficient.** Six of the nine degenerate inputs below are accepted by
 * `@cucumber/gherkin` without complaint, and a loader that took acceptance as
 * proof would hand the loop a feature with zero acceptance criteria. Every gate
 * downstream would then have nothing to check against, could not fail, and
 * would go green.
 *
 * `node:fs` appears here and nowhere under `packages/core/src/` — reading the
 * file is the caller's job, which is the boundary these tests exercise.
 */
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/spec/good/${name}`, import.meta.url)),
    'utf8',
  );
}

const CHECKOUT = fixture('checkout.feature');
const RULES = fixture('rules.feature');
const OUTLINE = fixture('outline.feature');

interface DegenerateInput {
  /** The row of `01-RESEARCH.md § Pitfall 2` this reproduces. */
  readonly row: number;
  readonly label: string;
  readonly source: string;
  /** Whether `@cucumber/gherkin` accepts it. Verified by execution, not assumed. */
  readonly parserAccepts: boolean;
  /** What the loader's refusal must say. */
  readonly message: RegExp;
}

/**
 * The nine inputs from `01-RESEARCH.md § Pitfall 2`, inline rather than as
 * files — several are empty or whitespace-only, and a file containing nothing
 * is invisible in a diff and trivially lost. See `test/fixtures/spec/bad/README.md`.
 *
 * Correction on record: that section's prose says "five parse, four throw". Its
 * own table, and re-running the parser here, both give **six parse, three
 * throw**. These entries follow the verified behaviour.
 */
const DEGENERATE_INPUTS: readonly DegenerateInput[] = [
  {
    row: 1,
    label: 'empty file',
    source: '',
    parserAccepts: true,
    message: /is empty/i,
  },
  {
    row: 2,
    label: 'whitespace only',
    source: '   \n\t\n  \n',
    parserAccepts: true,
    message: /only whitespace/i,
  },
  {
    row: 3,
    label: 'comment only',
    source: '# TODO: write this up properly\n',
    parserAccepts: true,
    message: /only comments/i,
  },
  {
    row: 4,
    label: 'feature with no scenarios',
    source: 'Feature: Bare\n',
    parserAccepts: true,
    message: /zero scenarios/i,
  },
  {
    row: 5,
    label: 'scenario with no steps',
    source: 'Feature: A\n\n  Scenario: nothing happens here\n',
    parserAccepts: true,
    message: /nothing happens here/,
  },
  {
    row: 6,
    label: 'scenario outline with no examples',
    source: 'Feature: A\n\n  Scenario Outline: totals without a table\n    Given <n> items\n',
    parserAccepts: true,
    message: /totals without a table/,
  },
  {
    row: 7,
    label: 'two feature blocks',
    // Separated by real content on purpose: two adjacent `Feature:` lines parse
    // fine, because the second is absorbed as the first one's description.
    source: 'Feature: A\n\n  Scenario: s\n    Given x\n\nFeature: B\n\n  Scenario: t\n    Given y\n',
    parserAccepts: false,
    message: /\(\d+:\d+\)/,
  },
  {
    row: 8,
    label: 'ragged examples table',
    source:
      'Feature: A\n\n  Scenario Outline: x\n    Given a <thing>\n\n    Examples:\n      | a | b |\n      | 1 |\n',
    parserAccepts: false,
    message: /\(\d+:\d+\)/,
  },
  {
    row: 9,
    label: 'free text at top level',
    source: 'this is free text\nFeature: A\n\n  Scenario: s\n    Given x\n',
    parserAccepts: false,
    message: /\(\d+:\d+\)/,
  },
];

describe('the nine degenerate inputs from 01-RESEARCH.md Pitfall 2', () => {
  it('covers every row, so a case cannot be quietly dropped', () => {
    expect(DEGENERATE_INPUTS).toHaveLength(9);
    expect(DEGENERATE_INPUTS.map((c) => c.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it.each(DEGENERATE_INPUTS)('row $row — $label is refused', (input) => {
    expect(() => loadGherkinSpec(input.source, 'demo')).toThrow(LoadError);
    try {
      loadGherkinSpec(input.source, 'demo');
      expect.unreachable('expected a LoadError');
    } catch (error) {
      expect(error).toBeInstanceOf(LoadError);
      expect((error as LoadError).message).toMatch(input.message);
    }
  });

  it('gives the six parser-accepted inputs six distinct messages', () => {
    // Distinctness is the point. "Something is wrong with your feature file" is
    // not actionable; the author has to be told which of six different mistakes
    // they made.
    const messages = DEGENERATE_INPUTS.filter((c) => c.parserAccepts).map((c) => {
      try {
        loadGherkinSpec(c.source, 'demo');
        return 'NO ERROR';
      } catch (error) {
        return (error as LoadError).message;
      }
    });
    expect(messages).toHaveLength(6);
    expect(new Set(messages).size).toBe(6);
  });

  it('surfaces every parser exception with its line and column', () => {
    const thrown = DEGENERATE_INPUTS.filter((c) => !c.parserAccepts);
    expect(thrown).toHaveLength(3);
    for (const input of thrown) {
      try {
        loadGherkinSpec(input.source, 'demo');
        expect.unreachable('expected a LoadError');
      } catch (error) {
        expect((error as LoadError).message).toMatch(/\(\d+:\d+\)/);
        // The position is structured too, not only embedded in prose, so a
        // caller can point an editor at it.
        expect((error as LoadError).position?.line).toBeGreaterThan(0);
      }
    }
  });
});

describe('orphan steps (01-RESEARCH.md Pitfall 3)', () => {
  it('refuses a step written outside any scenario rather than discarding it', () => {
    // Verified: this parses successfully with `children.length === 0`, and the
    // author's step vanishes with no error anywhere. Nothing downstream can
    // detect the omission, because nothing downstream knows it was written.
    const source = 'Feature: A\n\n  Given an orphan step\n\n  Scenario: s\n    Given x\n';
    expect(() => loadGherkinSpec(source, 'demo')).toThrow(LoadError);
    try {
      loadGherkinSpec(source, 'demo');
    } catch (error) {
      expect((error as LoadError).message).toMatch(/step/i);
    }
  });

  it('does not mistake docstring content for an orphan step', () => {
    // A docstring can contain anything, including a line that reads exactly
    // like a step. Counting it would make a valid feature fail to load.
    const source =
      'Feature: A\n\n  Scenario: s\n    Given a payload\n      """\n      Given this is prose, not a step\n      When neither is this\n      """\n    Then it is accepted\n';
    const spec = loadGherkinSpec(source, 'demo');
    expect(spec.acceptanceCriteria).toHaveLength(1);
  });
});

describe('loadGherkinSpec over checkout.feature', () => {
  it('excludes Background from the criteria and numbers the first scenario AC-1', () => {
    const spec = loadGherkinSpec(CHECKOUT, 'checkout', 'checkout.feature');

    expect(spec.sourceFormat).toBe('gherkin');
    expect(spec.title).toBe('Checkout');
    expect(spec.id).toBe('checkout');
    expect(spec.acceptanceCriteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);

    const [ac1] = spec.acceptanceCriteria;
    expect(ac1?.kind).toBe('scenario');
    if (ac1?.kind === 'scenario') expect(ac1.name).toBe('Paying with a valid card');

    // The background is preamble on the document, never a criterion. Were it
    // treated as one it would become AC-1 and shift every subsequent id.
    expect(spec.background?.steps).toEqual([
      { keyword: 'Given', text: 'the cart contains at least one item' },
    ]);
    for (const criterion of spec.acceptanceCriteria) {
      expect(criterion.text).not.toContain('the cart contains at least one item');
    }
  });

  it('keeps each scenario steps with trimmed keywords', () => {
    const [, ac2] = loadGherkinSpec(CHECKOUT, 'checkout').acceptanceCriteria;
    expect(ac2?.kind).toBe('scenario');
    if (ac2?.kind !== 'scenario') return;

    // The parser hands keywords over with a trailing space ("Given ", "But ").
    // Carrying that through would put a stray space into every prompt.
    expect(ac2.steps).toEqual([
      { keyword: 'Given', text: 'a card that expired last month' },
      { keyword: 'When', text: 'the customer confirms payment' },
      { keyword: 'Then', text: 'the payment is refused' },
      { keyword: 'But', text: 'the cart is left untouched' },
    ]);
    expect(ac2.tags).toEqual(['@slow']);
  });

  it('produces identical ids, text and hashes on a repeat parse', () => {
    // The AST builder must use an incrementing id generator, not a random one:
    // with uuid() two parses of identical source differ, and every hash over
    // the result differs with them.
    const first = loadGherkinSpec(CHECKOUT, 'checkout');
    const second = loadGherkinSpec(CHECKOUT, 'checkout');
    expect(second.acceptanceCriteria).toEqual(first.acceptanceCriteria);
    expect(second.specHash).toBe(first.specHash);
  });

  it('retains raw byte-identically and every criterion as a verbatim slice', () => {
    const spec = loadGherkinSpec(CHECKOUT, 'checkout');
    expect(spec.raw).toBe(CHECKOUT);
    for (const criterion of spec.acceptanceCriteria) {
      expect(CHECKOUT.slice(criterion.source.start, criterion.source.end)).toBe(criterion.text);
    }
  });
});

describe('loadGherkinSpec over rules.feature', () => {
  it('includes Rule-nested scenarios in document order', () => {
    const spec = loadGherkinSpec(RULES, 'withdrawal-limits');

    // A naive `feature.children.map(c => c.scenario)` drops both Rule-scoped
    // scenarios, which would silently lose two thirds of this spec.
    expect(spec.acceptanceCriteria).toHaveLength(3);
    expect(spec.acceptanceCriteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(
      spec.acceptanceCriteria.map((c) => (c.kind === 'scenario' ? c.name : c.text)),
    ).toEqual([
      'Withdrawing within the daily limit',
      'Withdrawing above the daily limit',
      'Withdrawing exactly the daily limit',
    ]);
  });

  it('slices each nested scenario verbatim without bleeding into its neighbour', () => {
    const spec = loadGherkinSpec(RULES, 'withdrawal-limits');
    const [ac1, ac2, ac3] = spec.acceptanceCriteria;

    expect(ac1?.text).toContain('withdraws 200');
    expect(ac1?.text).not.toContain('withdraws 900');
    expect(ac2?.text).toContain('withdraws 900');
    expect(ac2?.text).not.toContain('withdraws 500\n');
    expect(ac3?.text).toContain('withdraws 500');

    // The Rule: heading is not part of the scenario that precedes it.
    expect(ac1?.text).not.toContain('Rule:');
    for (const criterion of spec.acceptanceCriteria) {
      expect(RULES.slice(criterion.source.start, criterion.source.end)).toBe(criterion.text);
    }
  });

  it('collectScenarios recurses into rules and isOutline says these are not outlines', () => {
    const spec = loadGherkinSpec(RULES, 'withdrawal-limits');
    expect(spec.acceptanceCriteria.every((c) => c.kind === 'scenario')).toBe(true);
    for (const criterion of spec.acceptanceCriteria) {
      if (criterion.kind === 'scenario') expect(criterion.examples).toBeUndefined();
    }
  });
});

describe('loadGherkinSpec over outline.feature', () => {
  it('yields exactly one criterion, never one per example row', () => {
    // Assumption A6, decided by the human at plan 01-01 gate: an outline is ONE
    // criterion. Expanding it would make this spec three criteria instead of
    // one, coupling AC-n to test data — and D-01 makes numbering a one-way door.
    const spec = loadGherkinSpec(OUTLINE, 'cart-totals');
    expect(spec.acceptanceCriteria).toHaveLength(1);
    expect(spec.acceptanceCriteria[0]?.id).toBe('AC-1');
  });

  it('retains the Examples table verbatim beside unexpanded step placeholders', () => {
    const [criterion] = loadGherkinSpec(OUTLINE, 'cart-totals').acceptanceCriteria;
    expect(criterion?.kind).toBe('scenario');
    if (criterion?.kind !== 'scenario') return;

    expect(criterion.examples?.headers).toEqual(['quantity', 'total']);
    expect(criterion.examples?.rows).toEqual([
      ['1', '10'],
      ['2', '20'],
      ['3', '30'],
    ]);

    // The placeholders stay as the author wrote them.
    expect(criterion.steps).toEqual([
      { keyword: 'Given', text: 'a cart holding <quantity> items priced at 10 each' },
      { keyword: 'Then', text: 'the cart total is <total>' },
    ]);

    // And the verbatim slice covers the table, not just the steps.
    expect(criterion.text).toContain('| quantity | total |');
    expect(criterion.text).toContain('| 3        | 30    |');
    expect(OUTLINE.slice(criterion.source.start, criterion.source.end)).toBe(criterion.text);
  });
});

describe('collectScenarios and isOutline', () => {
  it('are exported as the walk the loader itself uses', () => {
    expect(typeof collectScenarios).toBe('function');
    expect(typeof isOutline).toBe('function');
  });
});

describe('input limits', () => {
  it('rejects a source above the 1 MB cap before the parser runs', () => {
    // Repo-supplied and therefore untrusted (threat T-1-05): anyone who can
    // write a file into a watched repository controls this string.
    const huge = `Feature: Big\n\n  Scenario: s\n    Given ${'x'.repeat(1_100_000)}\n`;
    expect(() => loadGherkinSpec(huge, 'big')).toThrow(/exceeds/i);
  });

  it('measures the cap in UTF-8 bytes, not UTF-16 code units', () => {
    // A multi-byte character costs more than one byte. Measuring `.length`
    // would let a spec through at roughly three times the intended ceiling.
    const multibyte = `Feature: Big\n\n  Scenario: s\n    Given ${'é'.repeat(600_000)}\n`;
    expect(multibyte.length).toBeLessThan(1_048_576);
    expect(() => loadGherkinSpec(multibyte, 'big')).toThrow(/exceeds/i);
  });

  it('rejects an empty feature id', () => {
    expect(() => loadGherkinSpec(CHECKOUT, '   ')).toThrow(LoadError);
  });
});
