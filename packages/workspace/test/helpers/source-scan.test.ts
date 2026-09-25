/**
 * The comment stripper the contract guards read source through — `DEBT.md`'s
 * **D-8-01-1**, fixed by M08 step 8.2.
 *
 * The debt named exactly what would make the fix believable: *"a fixture module
 * with an unguarded `run()` and a `/**`-bearing line comment is observed going
 * red."* The predicate moved out of `workspace-contract.test.ts` into
 * `source-scan.ts` so that fixture can be a **string**, which is the only way to
 * write it — a real module under `packages/workspace` with an unguarded `run()`
 * would make the live guard red forever.
 *
 * Every case below was watched failing against the old two-regex stripper
 * (block rule first, line rule second) before this file was committed. The
 * observations are recorded in the step's commit message and in the milestone.
 */
import { describe, expect, it } from 'vitest';
import {
  callsCwdGuard,
  importStatements,
  withoutComments,
} from './source-scan.js';

/**
 * The three characters that open a docblock, assembled rather than written.
 *
 * Written literally, this file could not contain the very case it is testing: a
 * `//` line carrying them is what the bug is about, and a docblock above would
 * have swallowed the rest of the file under the old stripper — including these
 * assertions. Assembling it is also what lets the strings below be *exactly* the
 * defect rather than an approximation of it.
 *
 * **It has to END the line, and the first injection is what taught that.** The
 * old block regex was lazy, so a line comment containing the closing form as well
 * — `.git/**` followed by a `/`, say — matched that four-character run and closed
 * immediately, blinding nothing. A fixture written that way passed against the
 * defect it was supposed to reproduce. Every fixture below therefore ends its
 * line on the opener, which is exactly the shape M08 step 8.1's real comment had.
 */
const DOCBLOCK_OPENER = `/${'*'.repeat(2)}`;

/** The fixture the debt asked for: a module that reaches run() with NO cwd guard. */
const UNGUARDED_MODULE = [
  "import { run } from '../exec/run.js';",
  '',
  `// Matches everything the sweep skips, such as .git${DOCBLOCK_OPENER}`,
  'export async function exec(spec, log) {',
  '  return run(spec, scratchHome, log);',
  '}',
  '',
  '/**',
  ' * A later docblock — where the old stripper thought the comment above ended.',
  ' */',
  'export const trailer = 1;',
].join('\n');

/** The same module with the guard genuinely present. */
const GUARDED_MODULE = [
  "import { run } from '../exec/run.js';",
  '',
  `// Matches everything the sweep skips, such as .git${DOCBLOCK_OPENER}`,
  'export async function exec(spec, log) {',
  '  await assertCwdWithinRoot(root, spec.cwd);',
  '  return run(spec, scratchHome, log);',
  '}',
  '',
  '/**',
  ' * A later docblock.',
  ' */',
  'export const trailer = 1;',
].join('\n');

describe('a line comment containing a docblock-opener blinds nothing', () => {
  it('keeps the code that follows it', () => {
    // The whole of D-8-01-1 in one assertion. Under the old stripper the block
    // regex matched from the docblock-opener inside the LINE comment to the `*/`
    // of the docblock further down, and everything between — the export, the
    // guard call, the `run()` call — was deleted before any rule looked at it.
    const stripped = withoutComments(GUARDED_MODULE);
    expect(stripped).toContain('export async function exec');
    expect(stripped).toContain('assertCwdWithinRoot');
    expect(stripped).toContain('export const trailer');
  });

  it('still hides the comment itself', () => {
    // The stripper has to keep doing its actual job: the words these guards
    // forbid appear in this package's own prose, and a guard that reported on a
    // docblock would be untrustworthy in both directions.
    const stripped = withoutComments(GUARDED_MODULE);
    expect(stripped).not.toContain('Matches everything under');
    expect(stripped).not.toContain('A later docblock');
  });

  it('reports an unguarded module as unguarded — the inverse failure', () => {
    // The direction that matters, and the one that was SILENT. A module reaching
    // `run()` with no cwd guard, carrying an innocent docblock-opener in a line
    // comment above it, passed: the comment deleted the region the rule searched,
    // so "no `assertCwdWithinRoot` here" and "nothing here at all" were the same
    // observation.
    expect(callsCwdGuard(UNGUARDED_MODULE)).toBe(false);
    expect(callsCwdGuard(GUARDED_MODULE)).toBe(true);
  });
});

describe('the cases a reordered pair of regexes would still have got wrong', () => {
  it('handles a TRAILING line comment carrying a docblock-opener', () => {
    // The old line rule was anchored with `^[ \t]*//`, so a comment after code on
    // the same line was never a line comment at all — the block rule got it.
    // Reordering the two would have fixed the reported case and left this one.
    const source = [
      `const pattern = 1; // like ${DOCBLOCK_OPENER}`,
      'export const kept = 2;',
      '/**',
      ' * closing docblock',
      ' */',
    ].join('\n');
    expect(withoutComments(source)).toContain('export const kept');
  });

  it('does not read a comment opener inside a string literal', () => {
    const source = [
      `const glob = '.git${DOCBLOCK_OPENER}';`,
      'export const kept = 3;',
      '/**',
      ' * A closing docblock. Without one the old lazy block regex found no',
      ' * terminator and so matched nothing, and this case would not have',
      ' * discriminated between the two strippers at all.',
      ' */',
    ].join('\n');
    const stripped = withoutComments(source);
    expect(stripped).toContain('export const kept');
    expect(stripped).toContain('const glob');
  });

  it('does not read a double slash inside a string literal as a comment', () => {
    // A URL in a string is the everyday form of this, and the old line rule was
    // safe from it only by accident — it required the `//` to start the line.
    const source =
      "const url = 'https://example.invalid/x'; export const k = 4;";
    expect(withoutComments(source)).toContain('example.invalid');
  });
});

describe('line structure survives', () => {
  it('keeps the newlines a block comment contained', () => {
    // The old stripper replaced a whole docblock with the empty string, which
    // joined the line after it to the line before. `importStatements` is anchored
    // with `^`, so a docblock between two imports could hide the second one.
    const source = [
      "import { a } from './a.js';",
      '/**',
      ' * a docblock between two imports',
      ' */',
      "import { b } from './b.js';",
    ].join('\n');
    // The trailing semicolon is outside the pattern, which ends at the quoted
    // specifier — unchanged from the inline version this replaced.
    expect(importStatements(source)).toEqual([
      "import { a } from './a.js'",
      "import { b } from './b.js'",
    ]);
  });
});
