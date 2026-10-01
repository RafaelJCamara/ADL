/**
 * `prepareOwnedDir` against a real worktree and a real composed copy (ROLE-09,
 * M08 step 8.6) — the whole carry-back, below the daemon.
 *
 * Every case is a way the obvious implementation is wrong: committing a file
 * the gate never wrote, crediting a test an earlier feature committed, making a
 * commit when nothing changed, deleting another feature's test, or losing a
 * commit because the push failed. The end-to-end proof — a real daemon, a real
 * tester, a real remote — is `scenario/tester-tests-committed.test.ts`; this
 * file is where each rule is pinned on its own.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '@adl/core/stage';
import {
  branchNameFor,
  composeVisibleWorkspace,
  managerGitClient,
  workspaceRegistry,
} from '@adl/workspace';
import {
  ADL_COMMIT_IDENTITY,
  prepareOwnedDir,
  type OwnedDirSession,
} from '../../src/worker-entry/owned-dir.js';
import {
  withTempRepo,
  type TempRepo,
} from '../../../workspace/test/helpers/temp-repo.js';

const DIR = 'tests/behaviour';
const EARLIER = `${DIR}/earlier-feature.test.mjs`;

interface Fixture {
  readonly ctx: TempRepo;
  readonly worktree: Workspace;
  readonly baseRef: string;
  /** Compose a fresh copy of the worktree and prepare a session over it. */
  session(featurePath?: string): Promise<{
    readonly composed: Workspace;
    readonly session: OwnedDirSession;
  }>;
  /** What git says about HEAD — the author, and the files the commit touched. */
  head(): Promise<{
    readonly sha: string;
    readonly author: string;
    readonly files: string[];
  }>;
}

async function withFixture(
  name: string,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await withTempRepo(async (ctx) => {
    // The base the feature branches from: one test an EARLIER feature's tester
    // committed into the owned directory, and one test outside it.
    await mkdir(join(ctx.mainRepo, DIR), { recursive: true });
    await writeFile(join(ctx.mainRepo, EARLIER), 'earlier feature\n');
    await writeFile(join(ctx.mainRepo, 'tests', 'other.test.mjs'), 'other\n');
    await ctx.git.add('.');
    await ctx.git.raw(['commit', '-m', 'an earlier feature']);
    const baseRef = (await ctx.git.raw(['branch', '--show-current'])).trim();

    const worktree = await workspaceRegistry({
      hostGit: { configHome: join(ctx.scratchRoot, '..', `home-${name}`) },
    })
      .resolve('worktree')
      .create({
        featureId: `owned-${name}`,
        mainRepo: ctx.mainRepo,
        scratchRoot: ctx.scratchRoot,
        baseRef,
      });
    const git = managerGitClient(worktree);
    let copies = 0;
    const composedAll: Workspace[] = [];

    try {
      await body({
        ctx,
        worktree,
        baseRef,
        async session(featurePath = 'features/x') {
          copies += 1;
          const composed = await composeVisibleWorkspace({
            id: `owned-${name}--behaviour`,
            source: worktree.root,
            root: join(
              ctx.scratchRoot,
              '..',
              `visible-${name}-${String(copies)}`,
            ),
            visiblePaths: ['tests/**'],
          });
          composedAll.push(composed);
          const prepared = await prepareOwnedDir({
            dir: DIR,
            featurePath,
            worktree,
            composed,
            changedOnBranch: await git.diffNameOnly(baseRef, 'HEAD'),
          });
          if (!prepared.ok) {
            throw new Error(`prepare refused: ${prepared.detail}`);
          }
          return { composed, session: prepared.session };
        },
        async head() {
          const sha = await git.revParse('HEAD');
          const author = (
            await ctx.git.raw([
              '-C',
              worktree.root,
              'log',
              '-1',
              '--format=%an <%ae>',
            ])
          ).trim();
          const files = (
            await ctx.git.raw([
              '-C',
              worktree.root,
              'show',
              '--name-status',
              '--format=',
              'HEAD',
            ])
          )
            .trim()
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.replace(/\t/g, ' '));
          return { sha, author, files };
        },
      });
    } finally {
      for (const composed of composedAll) await composed.destroy();
      await worktree.destroy();
    }
  });
}

const carry = (session: OwnedDirSession) =>
  session.carryBack({
    stageId: 'behaviour',
    pushUrl: undefined,
    branch: 'unused',
  });

describe('prepareOwnedDir — refusals before the gate runs', () => {
  it(
    'refuses an owned_dir overlapping the dispatched feature’s own folder',
    { timeout: 60_000 },
    async () => {
      await withFixture('overlap', async ({ worktree, ctx }) => {
        const composed = await composeVisibleWorkspace({
          id: 'owned-overlap--behaviour',
          source: worktree.root,
          root: join(ctx.scratchRoot, '..', 'visible-overlap'),
          visiblePaths: ['tests/**'],
        });
        try {
          const prepared = await prepareOwnedDir({
            dir: DIR,
            // The daemon's features_dir is `tests`, unlike adl.yml's — the case the
            // schema cannot see.
            featurePath: 'tests/behaviour/x',
            worktree,
            composed,
            changedOnBranch: [],
          });
          expect(prepared.ok).toBe(false);
          if (prepared.ok) return;
          expect(prepared.kind).toBe('binary_missing');
          expect(prepared.detail).toContain('overlaps this feature');
        } finally {
          await composed.destroy();
        }
      });
    },
  );

  it(
    'refuses a worktree with uncommitted changes in the owned directory, naming them',
    { timeout: 60_000 },
    async () => {
      await withFixture('dirty', async ({ worktree, ctx }) => {
        // Something the developer's agent left behind: only ADL writes here.
        await writeFile(
          join(worktree.root, DIR, 'planted.test.mjs'),
          'always passes\n',
        );
        const composed = await composeVisibleWorkspace({
          id: 'owned-dirty--behaviour',
          source: worktree.root,
          root: join(ctx.scratchRoot, '..', 'visible-dirty'),
          visiblePaths: ['tests/**'],
        });
        try {
          const prepared = await prepareOwnedDir({
            dir: DIR,
            featurePath: 'features/x',
            worktree,
            composed,
            changedOnBranch: [],
          });
          expect(prepared.ok).toBe(false);
          if (prepared.ok) return;
          expect(prepared.kind).toBe('unparseable');
          expect(prepared.detail).toContain(`${DIR}/planted.test.mjs`);
        } finally {
          await composed.destroy();
        }
      });
    },
  );
});

describe('prepareOwnedDir — which files are the gate’s', () => {
  it(
    'prunes a file git ignores from the copy, so it is never run or committed',
    { timeout: 60_000 },
    async () => {
      await withFixture('ignored', async ({ worktree, ctx, session }) => {
        // The developer commits a .gitignore hiding a file under the owned
        // directory, then leaves that file there — invisible to `git status`.
        await writeFile(
          join(worktree.root, '.gitignore'),
          `${DIR}/planted.test.mjs\n`,
        );
        await ctx.git.raw(['-C', worktree.root, 'add', '.gitignore']);
        await ctx.git.raw([
          '-C',
          worktree.root,
          'commit',
          '-m',
          'developer: ignore it',
        ]);
        await writeFile(
          join(worktree.root, DIR, 'planted.test.mjs'),
          'always passes\n',
        );

        const { composed, session: owned } = await session();
        await expect(
          readFile(join(composed.root, DIR, 'planted.test.mjs'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        // And the earlier feature's test is in the copy, but is not this feature's.
        await expect(
          readFile(join(composed.root, EARLIER), 'utf8'),
        ).resolves.toBe('earlier feature\n');
        expect(await owned.host.freeze()).toEqual({ ok: true, files: [] });
      });
    },
  );

  it(
    'counts this feature’s committed tests and new ones, never an earlier feature’s — even edited',
    { timeout: 60_000 },
    async () => {
      await withFixture('which', async (fixture) => {
        const first = await fixture.session();
        await writeFile(
          join(first.composed.root, DIR, 'mine.test.mjs'),
          'mine\n',
        );
        expect((await carry(first.session)).ok).toBe(true);

        const second = await fixture.session();
        await writeFile(
          join(second.composed.root, DIR, 'new.test.mjs'),
          'new\n',
        );
        await writeFile(
          join(second.composed.root, EARLIER),
          'rewritten by this tester\n',
        );
        expect(await second.session.host.freeze()).toEqual({
          ok: true,
          files: [`${DIR}/mine.test.mjs`, `${DIR}/new.test.mjs`],
        });
      });
    },
  );
});

describe('carryBack — what lands on the branch', () => {
  it(
    'commits what the gate wrote as ADL, on top of the developer’s commit',
    { timeout: 60_000 },
    async () => {
      await withFixture('commit', async ({ session, head }) => {
        const before = await head();
        const { composed, session: owned } = await session();
        await mkdir(join(composed.root, DIR, 'deep'), { recursive: true });
        await writeFile(
          join(composed.root, DIR, 'health.test.mjs'),
          'health\n',
        );
        await writeFile(join(composed.root, DIR, 'deep', 'b.test.mjs'), 'b\n');
        // Written outside the owned directory: discarded, never committed.
        await writeFile(
          join(composed.root, 'tests', 'stray.test.mjs'),
          'stray\n',
        );

        const carried = await carry(owned);
        const after = await head();
        // ADL's commit and nothing else, from its parent — the range the
        // round loop vouches for.
        expect(carried).toEqual({
          ok: true,
          committed: [`${DIR}/deep/b.test.mjs`, `${DIR}/health.test.mjs`],
          head: { before: before.sha, after: after.sha },
        });
        expect(after.author).toBe(
          `${ADL_COMMIT_IDENTITY.name} <${ADL_COMMIT_IDENTITY.email}>`,
        );
        expect(after.files.sort()).toEqual([
          `A ${DIR}/deep/b.test.mjs`,
          `A ${DIR}/health.test.mjs`,
        ]);
        expect(after.sha).not.toBe(before.sha);
      });
    },
  );

  it(
    'makes no commit when nothing the gate left differs from the branch',
    { timeout: 60_000 },
    async () => {
      await withFixture('noop', async ({ session, head }) => {
        const first = await session();
        await writeFile(
          join(first.composed.root, DIR, 'health.test.mjs'),
          'health\n',
        );
        await carry(first.session);
        const committed = await head();

        // Round 2: the tester re-writes the same test byte for byte.
        const second = await session();
        await writeFile(
          join(second.composed.root, DIR, 'health.test.mjs'),
          'health\n',
        );
        expect(await carry(second.session)).toEqual({
          ok: true,
          committed: [],
        });
        expect((await head()).sha).toBe(committed.sha);
      });
    },
  );

  it(
    'deletes this feature’s test the gate removed, and never an earlier feature’s',
    { timeout: 60_000 },
    async () => {
      await withFixture('delete', async ({ session, head }) => {
        const first = await session();
        await writeFile(
          join(first.composed.root, DIR, 'stale.test.mjs'),
          'stale\n',
        );
        await writeFile(
          join(first.composed.root, DIR, 'kept.test.mjs'),
          'kept\n',
        );
        await carry(first.session);

        const second = await session();
        await rm(join(second.composed.root, DIR, 'stale.test.mjs'));
        await rm(join(second.composed.root, EARLIER));
        expect(await carry(second.session)).toMatchObject({ ok: true });

        const after = await head();
        expect(after.files).toEqual([`D ${DIR}/stale.test.mjs`]);
      });
    },
  );

  it(
    'reports a failed push as retryable, with the commit already made',
    { timeout: 60_000 },
    async () => {
      await withFixture('push', async ({ session, head, ctx, worktree }) => {
        const before = await head();
        const { composed, session: owned } = await session();
        await writeFile(
          join(composed.root, DIR, 'health.test.mjs'),
          'health\n',
        );

        const result = await owned.carryBack({
          stageId: 'behaviour',
          pushUrl: join(ctx.scratchRoot, '..', 'no-such-remote.git'),
          branch: branchNameFor(worktree.id),
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('provider_error');
        expect(result.detail).toContain('pushing the branch failed');
        // The commit exists, and the refusal still names it — so the round
        // loop vouches for it although the stage errored.
        const committed = await head();
        expect(committed.sha).not.toBe(before.sha);
        expect(result.head).toEqual({
          before: before.sha,
          after: committed.sha,
        });

        // The retry: the tester re-writes the same file, so there is nothing
        // new to commit — and the branch is pushed anyway, because the push
        // that failed is the one that has not happened yet.
        const remote = join(ctx.scratchRoot, '..', 'retry-remote.git');
        await mkdir(remote, { recursive: true });
        await ctx.git.raw(['-C', remote, 'init', '--bare']);
        const retry = await session();
        await writeFile(
          join(retry.composed.root, DIR, 'health.test.mjs'),
          'health\n',
        );
        const retried = await retry.session.carryBack({
          stageId: 'behaviour',
          pushUrl: remote,
          branch: branchNameFor(worktree.id),
        });
        expect(retried).toEqual({ ok: true, committed: [] });
        expect(
          (
            await ctx.git.raw([
              '-C',
              remote,
              'rev-parse',
              `refs/heads/${branchNameFor(worktree.id)}`,
            ])
          ).trim(),
        ).toBe(committed.sha);
      });
    },
  );
});

describe('what was judged is what lands (the adversarial review’s findings)', () => {
  it(
    'refuses files whose index flags blind git status — a test weakened without a commit',
    { timeout: 60_000 },
    async () => {
      await withFixture('flags', async ({ worktree, ctx, session }) => {
        const first = await session();
        await writeFile(
          join(first.composed.root, DIR, 'mine.test.mjs'),
          'strict\n',
        );
        expect((await carry(first.session)).ok).toBe(true);

        // The developer weakens the committed test and hides the edit from
        // `git status` rather than committing it.
        await ctx.git.raw([
          '-C',
          worktree.root,
          'update-index',
          '--assume-unchanged',
          `${DIR}/mine.test.mjs`,
        ]);
        await writeFile(
          join(worktree.root, DIR, 'mine.test.mjs'),
          'weakened\n',
        );

        await expect(session()).rejects.toThrow(
          /assume-unchanged or skip-worktree/,
        );
      });
    },
  );

  it(
    'removes what the gate wrote outside its directory before ADL’s run, so the run cannot lean on it',
    { timeout: 60_000 },
    async () => {
      await withFixture('outside', async ({ session }) => {
        const { composed, session: owned } = await session();
        await writeFile(
          join(composed.root, DIR, 'a.test.mjs'),
          'imports ../helper.mjs\n',
        );
        await writeFile(
          join(composed.root, 'tests', 'helper.mjs'),
          'never committed\n',
        );
        await writeFile(
          join(composed.root, 'tests', 'other.test.mjs'),
          'changed by the gate\n',
        );

        expect(await owned.host.freeze()).toEqual({
          ok: true,
          files: [`${DIR}/a.test.mjs`],
        });
        await expect(
          readFile(join(composed.root, 'tests', 'helper.mjs'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          readFile(join(composed.root, 'tests', 'other.test.mjs'), 'utf8'),
        ).resolves.toBe('other\n');
      });
    },
  );

  it(
    'commits the bytes that were frozen for the run, not what the run wrote afterwards',
    { timeout: 60_000 },
    async () => {
      await withFixture('frozen', async ({ session, head }) => {
        const { composed, session: owned } = await session();
        await writeFile(join(composed.root, DIR, 'a.test.mjs'), 'as run\n');
        await owned.host.freeze();
        // The suite runs here, and writes into the directory as it goes.
        await writeFile(
          join(composed.root, DIR, 'a.test.mjs'),
          'rewritten by the run\n',
        );
        await writeFile(join(composed.root, DIR, '.cache.json'), '{}');

        expect(await carry(owned)).toMatchObject({
          ok: true,
          committed: [`${DIR}/a.test.mjs`],
        });
        expect((await head()).files).toEqual([`A ${DIR}/a.test.mjs`]);
      });
    },
  );

  it(
    'undoes a carry-back git refuses, leaving the directory clean for the retry',
    { timeout: 60_000 },
    async () => {
      await withFixture('undo', async ({ session, head, worktree, ctx }) => {
        const before = await head();
        const { composed, session: owned } = await session();
        await writeFile(join(composed.root, DIR, 'a.test.mjs'), 'a\n');
        // A path git will not add: a `.git` directory inside the tree.
        await mkdir(join(composed.root, DIR, '.git'), { recursive: true });
        await writeFile(join(composed.root, DIR, '.git', 'x'), 'x\n');

        const result = await carry(owned);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('provider_error');
        expect(result.head).toBeUndefined();

        // Nothing landed, and nothing was left behind for the next attempt to
        // mistake for the developer's work.
        expect((await head()).sha).toBe(before.sha);
        expect(
          (
            await ctx.git.raw([
              '-C',
              worktree.root,
              'status',
              '--porcelain',
              '--',
              DIR,
            ])
          ).trim(),
        ).toBe('');
        await expect(session()).resolves.toBeDefined();
      });
    },
  );
});
