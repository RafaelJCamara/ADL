/**
 * Reading this package's own source as text, for the guards that back up lint
 * (`DEBT.md`'s **D-8-01-1**, fixed by M08 step 8.2).
 *
 * ## The defect this file exists to remove
 *
 * `workspace-contract.test.ts` carried its comment stripper inline, twice, as a
 * pair of regexes applied in this order:
 *
 * ```
 * source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT_AT_LINE_START, '')
 * ```
 *
 * Blocks first. So a LINE comment containing the three characters that open a
 * docblock — entirely natural when documenting a glob, a regex, or a comment
 * convention — opened a block comment as far as the first regex was concerned,
 * and it closed at the next docblock terminator somewhere further down the file.
 * **Everything in between was deleted before any rule looked at it.**
 *
 * It was reproduced twice, and the second time by accident. M08 step 8.1 added
 * `visible/compose.ts`, whose `exec` calls `assertCwdWithinRoot` on its own line;
 * the suite reported it as an unguarded `run()` caller, and stripping the file by
 * hand showed 5223 of 15066 characters surviving with `async exec` gone entirely.
 * Rewording a comment fixed it — **which is the problem**: the guard was restored
 * by editing prose. The failure mode that matters is the inverse, and it is
 * silent: a module that reaches `run()` with **no** cwd guard, carrying an
 * innocent docblock-opener in a line comment above it, passes.
 *
 * ## Why a scanner and not a reordered pair of regexes
 *
 * Reordering (line comments first) fixes the reported case and leaves two others:
 * a trailing `// …` after code on the same line still opens a block, and a `/*`
 * inside a string literal always did. A left-to-right scanner costs about thirty
 * lines, handles every form, and — the reason it is worth the thirty lines — its
 * behaviour can be *stated* rather than deduced from regex interaction order.
 *
 * Newlines are **preserved**, which the old pair did not do for block comments.
 * Every consumer here is a line-anchored or identifier match, and
 * {@link importStatements}' own pattern is anchored with `^`, so collapsing a
 * docblock into nothing silently joined the line after it to the line before.
 *
 * ## The one residual, stated rather than hidden
 *
 * A regular-expression literal containing an unescaped `//` or `/*` — as opposed
 * to the escaped forms, which the backslash skip below handles — is not
 * distinguished from a comment, because telling a regex literal from a division
 * operator requires a real tokenizer with the preceding token in hand. No module
 * in this package contains one; if one is ever added, the effect is that the rest
 * of that line is dropped, which makes a guard *stricter* rather than blinder
 * only when the identifier it is hunting for is on that same line. That is a
 * narrower hole than the one this replaced, and it is written down.
 */

/** What the scanner is currently inside. */
type ScanState = 'code' | 'line-comment' | 'block-comment' | 'string';

/**
 * Everything outside a comment, with line structure intact.
 *
 * Comment bodies are replaced by the newlines they contained, so line numbers and
 * `^`-anchored patterns survive.
 */
export function withoutComments(source: string): string {
  let state: ScanState = 'code';
  /** Which quote character opened the current string. */
  let quote = '';
  let out = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = index + 1 < source.length ? (source[index + 1] as string) : '';

    switch (state) {
      case 'code': {
        // An escape outside a string only occurs inside a regular-expression
        // literal, and skipping the escaped character is what stops `/\/\//`
        // from being read as a line comment. See the module docblock's residual.
        if (char === '\\') {
          out += char + next;
          index += 1;
          break;
        }
        if (char === '/' && next === '/') {
          state = 'line-comment';
          index += 1;
          break;
        }
        if (char === '/' && next === '*') {
          state = 'block-comment';
          index += 1;
          break;
        }
        if (char === "'" || char === '"' || char === '`') {
          state = 'string';
          quote = char;
        }
        out += char;
        break;
      }

      case 'line-comment': {
        // The newline is kept and ends the comment; the body — docblock-openers
        // and all — is gone. This single case is D-8-01-1's whole fix.
        if (char === '\n') {
          state = 'code';
          out += char;
        }
        break;
      }

      case 'block-comment': {
        if (char === '*' && next === '/') {
          state = 'code';
          index += 1;
          break;
        }
        // Newlines survive so the lines either side of a docblock do not merge.
        if (char === '\n') out += char;
        break;
      }

      case 'string': {
        if (char === '\\') {
          out += char + next;
          index += 1;
          break;
        }
        out += char;
        if (char === quote) {
          state = 'code';
          quote = '';
        }
        break;
      }
    }
  }

  return out;
}

/**
 * Every `import … from '…'` statement in `source`, comments removed first.
 *
 * Comments are stripped because this package's own prose names the specifiers
 * these guards forbid, and a guard that reported on a docblock would be
 * untrustworthy in both directions.
 */
export function importStatements(source: string): readonly string[] {
  return [
    ...withoutComments(source).matchAll(
      /^[ \t]*import\s[\s\S]*?from\s*['"][^'"]+['"]/gm,
    ),
  ].map((match) => match[0]);
}

/**
 * Does this module call the cwd containment guard (WR-01)?
 *
 * Extracted from the contract suite so the rule and its own unit test run the
 * *same* predicate. `DEBT.md`'s D-8-01-1 asked for exactly this: the fix is only
 * believable if a synthetic module with an unguarded `run()` and a
 * docblock-opener in a line comment is observed going red, and that is not
 * expressible while the predicate is an inline regex over the real source tree.
 */
export function callsCwdGuard(source: string): boolean {
  return /\bassertCwdWithinRoot\s*\(/.test(withoutComments(source));
}
