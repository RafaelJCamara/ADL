import { describe, expect, it } from 'vitest';

import { LoadError } from '../../src/errors.js';
import {
  detectFormat,
  GHERKIN_EXTENSION,
  SPEC_ENTRY_FILENAME,
} from '../../src/spec/detect-format.js';
import {
  assignCriterionIds,
  criterionTextHash,
} from '../../src/spec/criterion-ids.js';
import type { CriterionBody } from '../../src/spec/criterion-ids.js';

/**
 * Detection and id assignment — the two places where "how many criteria does
 * this document have, and what are they called" is decided.
 *
 * Both are one-way doors (D-01, D-02, D-17): a criterion id is embedded in
 * every persisted finding, send-back brief, and coverage-table row, and a
 * mis-detected format produces silently wrong criteria that propagate into all
 * of them. So the assertions here are about refusal as much as about success.
 */

/** A statement body with a source span that really does address `text` in `raw`. */
function statement(raw: string, text: string): CriterionBody {
  const start = raw.indexOf(text);
  if (start < 0) throw new Error(`test fixture bug: ${text} not in raw`);
  return {
    kind: 'statement',
    text,
    source: { start, end: start + text.length },
  };
}

describe('detectFormat', () => {
  it('exposes the entry-file names it matches on, rather than burying them in a regex', () => {
    expect(SPEC_ENTRY_FILENAME).toBe('spec.md');
    expect(GHERKIN_EXTENSION).toBe('.feature');
  });

  it('resolves a lone spec.md to the ADL template', () => {
    expect(detectFormat(['spec.md'])).toEqual({
      sourceFormat: 'adl-template',
      entryFile: 'spec.md',
      contextFiles: [],
    });
  });

  it('resolves a lone .feature file to Gherkin, whatever it is called', () => {
    expect(detectFormat(['checkout.feature'])).toEqual({
      sourceFormat: 'gherkin',
      entryFile: 'checkout.feature',
      contextFiles: [],
    });
  });

  it('reports every non-entry file as a context ref, in the order given', () => {
    const result = detectFormat(['mockup.png', 'spec.md', 'payload.json']);
    expect(result.sourceFormat).toBe('adl-template');
    expect(result.entryFile).toBe('spec.md');
    expect(result.contextFiles).toEqual(['mockup.png', 'payload.json']);
  });

  it('refuses a listing with both entry-file kinds, naming both', () => {
    expect(() => detectFormat(['spec.md', 'checkout.feature'])).toThrow(
      LoadError,
    );
    try {
      detectFormat(['spec.md', 'checkout.feature']);
    } catch (error) {
      // Naming both is the whole point: the author has to be told which two
      // files are fighting, or the error is unactionable.
      expect((error as LoadError).message).toContain('spec.md');
      expect((error as LoadError).message).toContain('checkout.feature');
    }
  });

  it('refuses a listing with two Gherkin entry files — as ambiguous as one of each', () => {
    expect(() => detectFormat(['a.feature', 'b.feature'])).toThrow(LoadError);
    try {
      detectFormat(['a.feature', 'b.feature']);
    } catch (error) {
      expect((error as LoadError).message).toContain('a.feature');
      expect((error as LoadError).message).toContain('b.feature');
    }
  });

  it('refuses a listing with no entry file at all', () => {
    expect(() => detectFormat(['README.md', 'mockup.png'])).toThrow(LoadError);
    try {
      detectFormat(['README.md', 'mockup.png']);
    } catch (error) {
      expect((error as LoadError).message).toMatch(/spec\.md/);
      expect((error as LoadError).message).toMatch(/\.feature/);
    }
  });

  it('refuses an empty listing', () => {
    expect(() => detectFormat([])).toThrow(LoadError);
  });

  it('does not mistake a file merely containing the entry name for the entry file', () => {
    // `not-spec.md` and `spec.md.bak` are context files, not entry files. A
    // substring match here would silently pick the wrong document.
    expect(() => detectFormat(['not-spec.md', 'spec.md.bak'])).toThrow(
      LoadError,
    );
  });

  it('reads only the names it was given — the directory listing is the caller job', () => {
    // A path, not a bare name, is not an entry file: `@adl/core` does not know
    // what a directory is and must not start guessing at separators.
    expect(() => detectFormat(['features/x/spec.md'])).toThrow(LoadError);
  });
});

describe('assignCriterionIds', () => {
  const raw = 'alpha\nbravo\ncharlie\n';

  it('numbers criteria AC-1.. in the order given', () => {
    const assigned = assignCriterionIds(
      [
        statement(raw, 'alpha'),
        statement(raw, 'bravo'),
        statement(raw, 'charlie'),
      ],
      'spec.md',
    );
    expect(assigned.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(assigned.map((c) => c.text)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('yields exactly AC-1 for a single-criterion spec', () => {
    expect(
      assignCriterionIds([statement(raw, 'alpha')], 'spec.md').map((c) => c.id),
    ).toEqual(['AC-1']);
  });

  it('attaches the textHash of each criterion body', () => {
    const [only] = assignCriterionIds([statement(raw, 'alpha')], 'spec.md');
    expect(only?.textHash).toBe(criterionTextHash('alpha'));
  });

  it('refuses an empty criterion set, naming the source', () => {
    // This is the single choke point that stops a spec entering the loop with
    // zero criteria. A gate with nothing to check against cannot fail, so it
    // goes green — neither loader gets to decide that on its own.
    expect(() => assignCriterionIds([], 'checkout.feature')).toThrow(LoadError);
    try {
      assignCriterionIds([], 'checkout.feature');
    } catch (error) {
      expect((error as LoadError).message).toContain('checkout.feature');
      expect((error as LoadError).message).toContain('zero');
    }
  });

  it('preserves a scenario body kind, name, steps and examples untouched', () => {
    const src = 'Scenario Outline: totals';
    const [criterion] = assignCriterionIds(
      [
        {
          kind: 'scenario',
          text: src,
          name: 'totals',
          tags: ['@slow'],
          steps: [{ keyword: 'Given', text: '<n> items' }],
          examples: { headers: ['n'], rows: [['1'], ['2']] },
          source: { start: 0, end: src.length },
        },
      ],
      'outline.feature',
    );
    expect(criterion?.id).toBe('AC-1');
    expect(criterion?.kind).toBe('scenario');
    if (criterion?.kind === 'scenario') {
      expect(criterion.name).toBe('totals');
      expect(criterion.steps).toEqual([
        { keyword: 'Given', text: '<n> items' },
      ]);
      expect(criterion.examples?.rows).toHaveLength(2);
    }
  });
});

describe('criterionTextHash', () => {
  it('is stable across calls over the same string', () => {
    expect(criterionTextHash('a criterion')).toBe(
      criterionTextHash('a criterion'),
    );
    expect(criterionTextHash('a criterion')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes strings differing only by a trailing space — no whitespace collapsing', () => {
    expect(criterionTextHash('a criterion')).not.toBe(
      criterionTextHash('a criterion '),
    );
  });

  it('distinguishes a combining-character variant from its precomposed form — no NFKC', () => {
    // `café` written precomposed vs. with a combining acute. They render
    // identically and normalise to the same string, so a hash that normalised
    // would call them equal — and `textHash` would stop detecting a real edit.
    const precomposed = 'café';
    const combining = 'café';
    expect(precomposed.normalize('NFKC')).toBe(combining.normalize('NFKC'));
    expect(criterionTextHash(precomposed)).not.toBe(
      criterionTextHash(combining),
    );
  });
});
