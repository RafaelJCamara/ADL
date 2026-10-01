/**
 * `ManagerGitClient.add` and `.commit` against a real repository (M08 step 8.6)
 * — the first time ADL itself commits anything.
 *
 * ADL commits on behalf of a gate: what the behaviour tester left under its
 * `owned_dir` is carried back into the developer's worktree and committed
 * there. Each case below is a property that commit has to have and that a
 * plausible-looking implementation would not:
 *
 * - it commits **only** the paths it was given, while the developer's agent
 *   may have left other changes staged in the same index;
 * - it is attributed to ADL, whatever `user.name` the shared configuration
 *   carries;
 * - a file a gate named `[ab].mjs` is that one file, not a glob;
 * - a deleted path is committed as a deletion; and
 * - a signing program planted in the shared configuration does not run.
 */
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managerGitClient } from '../../src/git/manager-git.js';
import { workspaceRegistry } from '../../src/registry.js';
import {
  withTempRepo,
  type TempRepo as TempRepoContext,
} from '../helpers/temp-repo.js';

const ADL = { name: 'ADL', email: 'adl@noreply.local' } as const;

async function hostClient(ctx: TempRepoContext, id: string) {
  const host = await workspaceRegistry({
    hostGit: { configHome: join(ctx.scratchRoot, '..', `adl-home-${id}`) },
  })
    .resolve('host-git')
    .create({
      featureId: id,
      mainRepo: ctx.mainRepo,
      scratchRoot: ctx.scratchRoot,
      baseRef: 'HEAD',
    });
  return { host, client: managerGitClient(host) };
}

async function filesIn(ctx: TempRepoContext, rev: string): Promise<string[]> {
  return (await ctx.git.raw(['show', '--name-status', '--format=', rev]))
    .trim()
    .split('\n')
    .filter((line) => line !== '');
}

describe('ManagerGitClient.add + commit (M08 step 8.6)', () => {
  it('commits exactly the given paths, as ADL, leaving the developer’s staged work staged', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-commit-only');
      try {
        // Something the developer's agent staged and never committed.
        await writeFile(
          join(ctx.mainRepo, 'tracked.txt'),
          'staged by the developer\n',
        );
        await ctx.git.add('tracked.txt');

        await mkdir(join(ctx.mainRepo, 'tests', 'own'), { recursive: true });
        await writeFile(
          join(ctx.mainRepo, 'tests', 'own', 'a.test.mjs'),
          'a\n',
        );
        await client.add(['tests/own/a.test.mjs']);
        await client.commit({
          paths: ['tests/own/a.test.mjs'],
          message: 'test(behaviour): carry back 1 file',
          identity: ADL,
        });

        expect(await filesIn(ctx, 'HEAD')).toEqual(['A\ttests/own/a.test.mjs']);
        const who = (
          await ctx.git.raw(['log', '-1', '--format=%an <%ae>|%cn <%ce>'])
        ).trim();
        // `withTempRepo` sets a local `user.name` of "ADL Tracer"; the commit
        // must not borrow it.
        expect(who).toBe('ADL <adl@noreply.local>|ADL <adl@noreply.local>');
        const status = await client.status();
        expect(status.map((entry) => entry.path)).toContain('tracked.txt');
      } finally {
        await host.destroy();
      }
    });
  });

  it('treats a gate-chosen file name as that file, never as a pathspec glob', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-commit-literal');
      try {
        // `[ab].mjs` is a character class to git's default pathspec matching.
        // Probed against git 2.49: while a file of exactly that name EXISTS,
        // git matches it literally anyway — so the glob only bites once the
        // file is gone, which is precisely carry-back's deletion case. A gate
        // that deletes its own `[ab].mjs` must not sweep `a.mjs` and `b.mjs`
        // (here, something the developer left lying around) into ADL's commit.
        await mkdir(join(ctx.mainRepo, 'tests'), { recursive: true });
        await writeFile(join(ctx.mainRepo, 'tests', '[ab].mjs'), 'class\n');
        await ctx.git.add('tests/[ab].mjs');
        await ctx.git.raw(['commit', '-m', 'a gate committed this earlier']);
        await rm(join(ctx.mainRepo, 'tests', '[ab].mjs'));
        await writeFile(join(ctx.mainRepo, 'tests', 'a.mjs'), 'not mine\n');
        await writeFile(join(ctx.mainRepo, 'tests', 'b.mjs'), 'not mine\n');

        await client.add(['tests/[ab].mjs']);
        await client.commit({
          paths: ['tests/[ab].mjs'],
          message: 'literal',
          identity: ADL,
        });

        expect(await filesIn(ctx, 'HEAD')).toEqual(['D\ttests/[ab].mjs']);
        // Neither was staged either: git knows nothing under tests/ now.
        expect((await ctx.git.raw(['ls-files', '--', 'tests'])).trim()).toBe(
          '',
        );
      } finally {
        await host.destroy();
      }
    });
  });

  it('commits a removed file as a deletion', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-commit-delete');
      try {
        await rm(join(ctx.mainRepo, 'tracked.txt'));
        await client.add(['tracked.txt']);
        await client.commit({
          paths: ['tracked.txt'],
          message: 'remove',
          identity: ADL,
        });
        expect(await filesIn(ctx, 'HEAD')).toEqual(['D\ttracked.txt']);
      } finally {
        await host.destroy();
      }
    });
  });

  it('adds a file a .gitignore hides, because the paths are ADL’s decision', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-commit-ignored');
      try {
        await writeFile(join(ctx.mainRepo, '.gitignore'), 'tests/\n');
        await ctx.git.add('.gitignore');
        await ctx.git.raw(['commit', '-m', 'ignore tests']);
        await mkdir(join(ctx.mainRepo, 'tests'), { recursive: true });
        await writeFile(join(ctx.mainRepo, 'tests', 'x.test.mjs'), 'x\n');

        await client.add(['tests/x.test.mjs']);
        await client.commit({
          paths: ['tests/x.test.mjs'],
          message: 'ignored',
          identity: ADL,
        });
        expect(await filesIn(ctx, 'HEAD')).toEqual(['A\ttests/x.test.mjs']);
      } finally {
        await host.destroy();
      }
    });
  });

  it('does not run a signing program planted in the shared configuration — and the control proves it would have', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-commit-gpg');
      try {
        const sentinel = join(ctx.scratchRoot, '..', 'gpg-ran');
        const program = join(ctx.scratchRoot, '..', 'fake-gpg.sh');
        await writeFile(
          program,
          `#!/bin/sh\necho fired > "${sentinel.split('\\').join('/')}"\nexit 1\n`,
          'utf8',
        );
        await chmod(program, 0o755);
        // Written straight into the shared configuration file — what an agent
        // in a linked worktree can do (`poisoned-config.test.ts` reproduces
        // that path), and what simple-git's own guard will not do for a test.
        await appendFile(
          join(ctx.mainRepo, '.git', 'config'),
          `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${program.split('\\').join('/')}\n`,
          'utf8',
        );

        // CONTROL: an ordinary commit in this repository runs the program, and
        // the program's failure fails the commit.
        await writeFile(join(ctx.mainRepo, 'control.txt'), 'control\n');
        await ctx.git.add('control.txt');
        await expect(
          ctx.git.raw(['commit', '-m', 'control']),
        ).rejects.toThrow();
        expect(await readFile(sentinel, 'utf8')).toContain('fired');
        await rm(sentinel);
        await ctx.git.raw(['reset', '-q', 'control.txt']);

        // ADL's commit: the program never runs, and the commit lands.
        await writeFile(join(ctx.mainRepo, 'carried.txt'), 'carried\n');
        await client.add(['carried.txt']);
        await client.commit({
          paths: ['carried.txt'],
          message: 'carried',
          identity: ADL,
        });
        await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await filesIn(ctx, 'HEAD')).toEqual(['A\tcarried.txt']);
      } finally {
        await host.destroy();
      }
    });
  });
});

describe('ManagerGitClient.flaggedIndexEntries + unstage (M08 step 8.6)', () => {
  it('names files whose index flags blind git status, which status itself cannot', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-flags');
      try {
        await mkdir(join(ctx.mainRepo, 'tests', 'own'), { recursive: true });
        for (const name of ['a', 'b', 'c']) {
          await writeFile(
            join(ctx.mainRepo, 'tests', 'own', `${name}.mjs`),
            name,
          );
        }
        await ctx.git.add('tests');
        await ctx.git.raw(['commit', '-m', 'three tests']);
        await ctx.git.raw([
          'update-index',
          '--assume-unchanged',
          'tests/own/a.mjs',
        ]);
        await ctx.git.raw([
          'update-index',
          '--skip-worktree',
          'tests/own/b.mjs',
        ]);
        await writeFile(
          join(ctx.mainRepo, 'tests', 'own', 'a.mjs'),
          'weakened',
        );
        await writeFile(
          join(ctx.mainRepo, 'tests', 'own', 'b.mjs'),
          'weakened',
        );

        // The control: status really is blind to both edits.
        expect(await client.status()).toEqual([]);
        expect(await client.flaggedIndexEntries('tests/own')).toEqual([
          'tests/own/a.mjs',
          'tests/own/b.mjs',
        ]);
        expect(await client.flaggedIndexEntries('src')).toEqual([]);
      } finally {
        await host.destroy();
      }
    });
  });

  it('unstages exactly the given paths, leaving the working tree as it is', async () => {
    await withTempRepo(async (ctx) => {
      const { host, client } = await hostClient(ctx, 'adl-unstage');
      try {
        await writeFile(join(ctx.mainRepo, 'tracked.txt'), 'staged by ADL\n');
        await writeFile(join(ctx.mainRepo, 'new.txt'), 'new\n');
        await client.add(['tracked.txt', 'new.txt']);
        await client.unstage(['tracked.txt', 'new.txt']);

        const codes = Object.fromEntries(
          (await client.status()).map((entry) => [entry.path, entry.code]),
        );
        expect(codes).toEqual({ 'tracked.txt': ' M', 'new.txt': '??' });
        await expect(
          readFile(join(ctx.mainRepo, 'tracked.txt'), 'utf8'),
        ).resolves.toBe('staged by ADL\n');
      } finally {
        await host.destroy();
      }
    });
  });
});
