import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 Plan 09, Task 2 — the discipline `packages/manager/test/helpers/
 * platform.ts` and `packages/workspace/test/helpers/platform.ts` both
 * document but neither one *enforces*: a platform-gated case skips through
 * `requirePlatform`/`windowsOnly`/`posixOnly` (or workspace's own
 * `linuxOnly`/`posixOnly`), never through a bare `process.platform` check or
 * an untested `it.skipIf`/`describe.skipIf`/`test.skipIf`.
 *
 * T-3-17's threat is specific: a `skipIf` reads as a dot in a summary line
 * and as nothing at all in a scrolled CI log, which makes a suite where the
 * load-bearing assertions never ran indistinguishable, at a glance, from one
 * where they passed. Both are green. The helper's own stated-reason stderr
 * line (`SKIP_PREFIX`) is what makes a skip greppable and attributed — but
 * only for a case that actually goes through the helper. This test is the
 * guard that a bare conditional cannot silently reintroduce the vacuous-skip
 * shape the helper exists to prevent — the same class of guard `test/lint/`
 * already applies to the architecture rules, for the identical reason: a
 * discipline nobody has watched fail is a discipline that quietly stops
 * applying.
 *
 * Scope is exactly `03-09-PLAN.md`'s Task 2 text: every test file under
 * `packages/manager/test/` and `packages/cli/test/`. The helper
 * implementation files themselves (`platform.ts`) are the one legitimate
 * place `process.platform` is read — they are excluded from the scan by
 * name, not by directory, so a second helper file added later still gets
 * scanned unless it is *also* named `platform.ts`.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Directories this test walks, repository-relative. */
const SCANNED_ROOTS = ['packages/manager/test', 'packages/cli/test'];

/** The one legitimate implementation of the platform-gate discipline per package. */
const ALLOWED_BASENAMES = new Set(['platform.ts']);

/**
 * A bare platform conditional: a direct `process.platform` read, Node's
 * `os.platform()`, or a Vitest `skipIf`/`todoIf`/`runIf` modifier — every one
 * of these is a way to make a case's execution depend on the runtime
 * platform WITHOUT going through the helper's stated-reason stderr line.
 */
const BARE_CONDITIONAL_PATTERN =
  /process\.platform|os\.platform\(\)|\.(skipIf|todoIf|runIf)\(/;

async function walkTestFiles(rootRelative: string): Promise<string[]> {
  const rootAbsolute = path.join(REPO_ROOT, rootRelative);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.ts')) {
        results.push(full);
      }
    }
  }

  await walk(rootAbsolute);
  return results;
}

describe('platform-gate discipline (T-3-17): no bare platform conditional outside the helper', () => {
  it('packages/manager/test/ and packages/cli/test/ contain no bare process.platform / os.platform() / skipIf-family check outside platform.ts', async () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];

    for (const root of SCANNED_ROOTS) {
      const files = await walkTestFiles(root);
      for (const file of files) {
        if (ALLOWED_BASENAMES.has(path.basename(file))) continue;

        const text = await readFile(file, 'utf8');
        const lines = text.split('\n');
        lines.forEach((line, index) => {
          if (BARE_CONDITIONAL_PATTERN.test(line)) {
            offenders.push({
              file: path.relative(REPO_ROOT, file),
              line: index + 1,
              snippet: line.trim(),
            });
          }
        });
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Found ${offenders.length} bare platform conditional(s) outside the platform-gate helper:\n` +
            offenders
              .map((o) => `  ${o.file}:${o.line}: ${o.snippet}`)
              .join('\n') +
            '\nRoute these through requirePlatform/windowsOnly/posixOnly ' +
            '(packages/manager/test/helpers/platform.ts) instead — a bare ' +
            'check skips silently and leaves no greppable reason in a green log.'
        : undefined,
    ).toEqual([]);
  });

  it('scanned at least one file per root — a passing scan with zero files would be a vacuous pass, not a proof', async () => {
    for (const root of SCANNED_ROOTS) {
      const files = await walkTestFiles(root);
      expect(files.length, `expected test files under ${root}`).toBeGreaterThan(
        0,
      );
    }
  });
});
