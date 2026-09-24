/**
 * ROLE-06, measured rather than declared (M08 step 8.1).
 *
 * Every assertion here exists because M08 step 8.0's spike found a mechanism
 * that passed the obvious version of it. A sparse-checkout worktree satisfies
 * "the source is not on disk" completely — and `git cat-file` reads it straight
 * back. So the interesting tests in this file are not the ones that check what
 * the composed workspace contains; they are the ones that check what git can
 * still be persuaded to say from inside it.
 */
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adlGit } from '../../src/git/adl-git.js';
import { ContainmentError, VisibilityError } from '../../src/errors.js';
import {
  composeVisibleWorkspace,
  composeVisibleWorkspaceWithReport,
} from '../../src/visible/compose.js';
import { openTempRepo } from '../helpers/temp-repo.js';

/** The string that must never reach a composed workspace, by any route. */
const MARKER = 'SECRET_IMPLEMENTATION_MARKER';

/** Every file under `dir`, repo-relative, `.git` included — this is a leak scan. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(absolute, base)));
    } else {
      found.push(relative(base, absolute).split('\\').join('/'));
    }
  }
  return found;
}

async function seedRepo(): Promise<{
  repo: Awaited<ReturnType<typeof openTempRepo>>;
  head: string;
}> {
  const repo = await openTempRepo();
  await mkdir(join(repo.mainRepo, 'src'), { recursive: true });
  await mkdir(join(repo.mainRepo, 'tests'), { recursive: true });
  await writeFile(
    join(repo.mainRepo, 'src', 'impl.ts'),
    `export const ${MARKER} = 'the implementation';\n`,
    'utf8',
  );
  await writeFile(
    join(repo.mainRepo, 'tests', 'greet.test.mjs'),
    "import { test } from 'node:test';\ntest('AC-01', () => {});\n",
    'utf8',
  );
  await writeFile(
    join(repo.mainRepo, 'package.json'),
    '{ "name": "fixture", "type": "module" }\n',
    'utf8',
  );
  await repo.git.add('.');
  await repo.git.commit('seed');
  const head = (await repo.git.revparse(['HEAD'])).trim();
  return { repo, head };
}

describe('composeVisibleWorkspace', () => {
  it(
    'materialises the allowlist and nothing else, and reports what it withheld',
    { timeout: 30_000 },
    async () => {
      const { repo } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-1');
        const { workspace, visible, hidden } =
          await composeVisibleWorkspaceWithReport({
            id: 'feat--01',
            source: repo.mainRepo,
            root,
            visiblePaths: ['tests/**', 'package.json'],
          });

        expect(visible.sort()).toEqual([
          'package.json',
          'tests/greet.test.mjs',
        ]);
        // The evidence half. A caller that cannot say what was withheld cannot
        // make ROLE-06's claim without re-deriving it by subtraction.
        expect(hidden).toContain('src/impl.ts');

        expect(await walk(root)).toEqual(
          expect.arrayContaining(['package.json', 'tests/greet.test.mjs']),
        );
        expect(existsSync(join(root, 'src'))).toBe(false);

        // The direct reading of criterion 1: absent, not forbidden.
        for (const file of await walk(root)) {
          expect(await readFile(join(root, file), 'utf8')).not.toContain(
            MARKER,
          );
        }

        await workspace.destroy();
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'is blind to git history — the door a sparse checkout leaves open',
    { timeout: 30_000 },
    async () => {
      const { repo, head } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-2');
        const workspace = await composeVisibleWorkspace({
          id: 'feat--02',
          source: repo.mainRepo,
          root,
          visiblePaths: ['tests/**'],
        });

        // The control: the source really does have the implementation in its
        // object store, so the assertions below are about the composed
        // workspace rather than about a repository that never had the blob.
        const fromSource = await adlGit(repo.mainRepo).raw([
          'cat-file',
          '-p',
          `${head}:src/impl.ts`,
        ]);
        expect(fromSource.exitCode).toBe(0);
        expect(fromSource.stdout).toContain(MARKER);

        // And from the composed workspace, every spelling of the same door.
        for (const args of [
          ['rev-parse', '--show-toplevel'],
          ['cat-file', '-p', `${head}:src/impl.ts`],
          ['show', `${head}:src/impl.ts`],
          ['log', '--oneline', '-1'],
        ]) {
          const outcome = await adlGit(root).raw(args);
          expect(
            outcome.exitCode,
            `git ${args.join(' ')} must fail from a composed workspace`,
          ).not.toBe(0);
          expect(outcome.stdout).not.toContain(MARKER);
        }

        await workspace.destroy();
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'a glob broad enough to match everything still does not copy `.git`',
    { timeout: 30_000 },
    async () => {
      const { repo, head } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-greedy');
        // The careless declaration, and the one most likely to be written by
        // someone who has not read ROLE-06: "let the tester see everything".
        // It must still not hand over git, because a copied `.git` is the
        // sparse-checkout door reopened by a configuration typo rather than by
        // a design decision.
        const { workspace, visible } = await composeVisibleWorkspaceWithReport({
          id: 'feat--greedy',
          source: repo.mainRepo,
          root,
          visiblePaths: ['**'],
        });

        expect(visible).toContain('src/impl.ts');
        expect(visible.some((p) => p.startsWith('.git/'))).toBe(false);
        expect(existsSync(join(root, '.git'))).toBe(false);

        const outcome = await adlGit(root).raw([
          'cat-file',
          '-p',
          `${head}:src/impl.ts`,
        ]);
        expect(outcome.exitCode).not.toBe(0);

        await workspace.destroy();
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'refuses a root inside a repository, which is where ADL would put it by default',
    { timeout: 30_000 },
    async () => {
      const { repo } = await seedRepo();
      try {
        // `scratchRoot` defaults to `<repo>/.adl/scratch`, so this is not a
        // contrived path — it is the one an unconfigured daemon would choose,
        // and the spike measured that a `.git`-less copy there leaks anyway.
        const root = join(repo.mainRepo, '.adl', 'scratch', 'visible-3');
        await expect(
          composeVisibleWorkspace({
            id: 'feat--03',
            source: repo.mainRepo,
            root,
            visiblePaths: ['tests/**'],
          }),
        ).rejects.toBeInstanceOf(VisibilityError);

        // Refused BEFORE copying: a leak that exists for a moment is a leak.
        expect(existsSync(join(root, 'tests'))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'contains exec to its own root, not the worktree it was copied from',
    { timeout: 30_000 },
    async () => {
      const { repo } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-4');
        const workspace = await composeVisibleWorkspace({
          id: 'feat--04',
          source: repo.mainRepo,
          root,
          visiblePaths: ['tests/**'],
        });

        // The failure this rules out is specific: guarding the SOURCE root
        // would let a gate start a process in the tree it is meant to be blind
        // to, and every assertion above would still pass.
        await expect(
          workspace.exec(
            {
              argv: ['node', '--version'],
              cwd: repo.mainRepo,
              path: process.env['PATH'] ?? '',
              networkPolicy: 'full',
              resources: {},
            },
            () => {},
          ),
        ).rejects.toBeInstanceOf(ContainmentError);

        await workspace.destroy();
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'destroy() reclaims the composed root and is idempotent',
    { timeout: 30_000 },
    async () => {
      const { repo } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-5');
        const workspace = await composeVisibleWorkspace({
          id: 'feat--05',
          source: repo.mainRepo,
          root,
          visiblePaths: ['tests/**'],
        });
        expect(existsSync(root)).toBe(true);

        await workspace.destroy();
        expect(existsSync(root)).toBe(false);
        // A second teardown is what a crash-recovery path looks like.
        await expect(workspace.destroy()).resolves.toBeUndefined();
      } finally {
        await repo.cleanup();
      }
    },
  );

  it(
    'refuses a root that already exists, leaving reclamation to the GC sweep',
    { timeout: 30_000 },
    async () => {
      const { repo } = await seedRepo();
      try {
        const root = join(repo.scratchRoot, 'visible-6');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'stale.txt'), 'from a previous run', 'utf8');

        await expect(
          composeVisibleWorkspace({
            id: 'feat--06',
            source: repo.mainRepo,
            root,
            visiblePaths: ['tests/**'],
          }),
        ).rejects.toThrow(/GC sweep/);

        // Untouched — the decision to reclaim is made from feature state, not
        // from what happens to be on disk (WORK-04).
        expect(await readFile(join(root, 'stale.txt'), 'utf8')).toBe(
          'from a previous run',
        );
        await rm(root, { recursive: true, force: true });
      } finally {
        await repo.cleanup();
      }
    },
  );
});
