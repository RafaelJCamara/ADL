import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `README.md`'s entry-points table is drift-asserted against `package.json`'s
 * own `exports` map.
 *
 * ── Why this test exists, and why a README needed one ─────────────────────
 *
 * `.claude/CLAUDE.md` convention 18: *documentation can be load-bearing.*
 * `packages/workspace/README.md`'s neutralisation table already has an
 * assertion of its own, because that table is the stated justification for an
 * accepted risk. This one is load-bearing for a different reason: `@adl/core`
 * has **no `src/index.ts` by design** — every subsystem is reached through a
 * subpath export, so the README table is the only place a reader can see the
 * package's shape at a glance. There is no barrel to skim instead.
 *
 * And it had rotted, which is why this is a test and not a note. Three whole
 * subpaths — `loop` (M05 5.13), `detect` (5.1–5.3) and `forge` (5.8) — shipped
 * with no row in that table at all. A table listing five of eight subsystems
 * does not read as incomplete; it reads as *"these are the five subsystems"*,
 * to exactly the reader it exists for.
 *
 * ── What is asserted, in both directions ──────────────────────────────────
 *
 * Both directions matter and they fail for different reasons. A subpath with no
 * row is the rot above. A row with no subpath is the opposite failure — a
 * documented import path that does not resolve — which is worse, because a
 * reader following it gets an error from Node rather than a missing entry they
 * might have gone looking for.
 *
 * The bare `.` export is excluded deliberately: the README documents it in the
 * prose underneath the table ("points at `./verdict` for convenience; prefer
 * the explicit subpath") rather than as a row, because a row would present it
 * as a subsystem when it is a convenience alias for one that is already listed.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function readJson(relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(PACKAGE_ROOT + relative, 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Every subpath in `exports`, minus the bare `.` alias. See the module docblock. */
async function declaredSubpaths(): Promise<readonly string[]> {
  const manifest = await readJson('package.json');
  const exports = manifest['exports'] as Record<string, unknown>;
  return Object.keys(exports)
    .filter((key) => key !== '.')
    .map((key) => key.replace(/^\.\//, ''))
    .sort();
}

/**
 * Every subpath the README's table names, read out of the first column.
 *
 * Deliberately parsed from the rendered table rather than from a list the
 * README and this test could share: the thing under test is what a human
 * reading that table actually sees. A shared constant would make the assertion
 * pass while the table itself said something else.
 */
async function documentedSubpaths(): Promise<readonly string[]> {
  const readme = await readFile(PACKAGE_ROOT + 'README.md', 'utf8');
  const rows = [...readme.matchAll(/^\|\s*`@adl\/core\/([a-z-]+)`\s*\|/gm)];
  return rows.map((match) => match[1] ?? '').sort();
}

describe('README.md documents every @adl/core subpath', () => {
  it('names a row for every entry in package.json exports', async () => {
    const declared = await declaredSubpaths();
    const documented = await documentedSubpaths();

    const undocumented = declared.filter(
      (subpath) => !documented.includes(subpath),
    );

    expect(
      undocumented,
      `these subpaths are exported but absent from README.md's entry-points table: ${undocumented.join(', ')}. @adl/core has no src/index.ts by design, so that table is the only place the package's shape is visible at a glance — a subsystem missing from it is a subsystem a reader has no way to discover.`,
    ).toEqual([]);
  });

  it('names no row that does not resolve', async () => {
    const declared = await declaredSubpaths();
    const documented = await documentedSubpaths();

    const phantom = documented.filter((subpath) => !declared.includes(subpath));

    expect(
      phantom,
      `README.md documents these import paths, and package.json exports none of them: ${phantom.join(', ')}. A documented path that does not resolve is worse than a missing row — the reader following it gets a module-resolution error rather than a gap they might have gone looking for.`,
    ).toEqual([]);
  });

  it('reads a non-empty table — a comparison of two empty lists proves nothing', async () => {
    // The vacuity control. If the row regex ever stops matching — a table
    // reformatted, the backticks dropped, the column reordered — both
    // assertions above would pass by comparing `[]` with `[]` while the table
    // said anything at all. Same construction, same reason, as
    // `never-merge.test.ts`'s own list-length control.
    const documented = await documentedSubpaths();
    expect(documented.length).toBeGreaterThanOrEqual(8);
    expect(documented).toContain('stage');
  });
});
