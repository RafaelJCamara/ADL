import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SimpleGit } from 'simple-git';
import { WorkspaceError } from '../../src/errors.js';
import {
  branchNameFor,
  createWorktree,
  destroyWorktree,
  featureIdFromBranch,
} from '../../src/worktree/lifecycle.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

/**
 * The worktree lifecycle, against a real git repository.
 *
 * A real repository rather than a mock: every property under test here — that
 * a branch survives `worktree remove`, that `branch -D` refuses while a
 * worktree holds the branch, that `--force` beats a dirty tree — is a property
 * of the git binary, and a mock would assert only that this file agrees with
 * itself.
 *
 * One repository for the whole file, created in `beforeAll`. The git
 * integration tests dominate this package's runtime budget, and a fresh
 * `git init` plus commit per test buys isolation these cases do not need:
 * each one uses its own feature ids.
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * The `adl/*` branches git currently knows about, one per entry.
 *
 * The leading marker column has to be stripped, and it is not always `*`:
 * git marks a branch checked out in a *linked worktree* with `+`, which is
 * every branch this suite creates.
 */
const adlBranches = async (git: SimpleGit): Promise<string[]> =>
  (await git.raw(['branch', '--list', 'adl/*']))
    .split('\n')
    .map((line) => line.replace(/^[*+]/, '').trim())
    .filter((line) => line !== '');

describe('featureIdFromBranch', () => {
  it('maps ADL refs back to a bare feature id, in both spellings', () => {
    expect(featureIdFromBranch('refs/heads/adl/feat-1')).toBe('feat-1');
    expect(featureIdFromBranch('adl/feat-1')).toBe('feat-1');
  });

  it('takes the remainder whole, so a prefix-sharing id is not truncated', () => {
    // The defect this function exists to prevent (T-2-14): a `startsWith`
    // test against `adl/feat-1` would match this ref and yield `feat-1`, and
    // the sweep would then destroy the wrong feature while reporting the right
    // one.
    expect(featureIdFromBranch('refs/heads/adl/feat-1-evil')).toBe(
      'feat-1-evil',
    );
  });

  it('returns undefined for refs that are not ADL’s', () => {
    expect(featureIdFromBranch(undefined)).toBeUndefined();
    expect(featureIdFromBranch('refs/heads/master')).toBeUndefined();
    expect(featureIdFromBranch('refs/heads/feature/adl/x')).toBeUndefined();
    // A branch that merely *starts* with the letters, without the separator.
    expect(featureIdFromBranch('refs/heads/adlx')).toBeUndefined();
    // The bare prefix is not a feature.
    expect(featureIdFromBranch('refs/heads/adl/')).toBeUndefined();
  });
});

describe('createWorktree: the feature-id guard', () => {
  let repo: OpenedTempRepo;

  beforeAll(async () => {
    repo = await openTempRepo();
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  // Each of these becomes a directory name and a git ref. The guard runs
  // before git is touched at all, so none of them can reach the filesystem.
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['an empty id', ''],
    ['a whitespace-only id', '   '],
    ['a forward slash', 'feat/one'],
    ['a backslash', 'feat\\one'],
    ['a NUL byte', 'feat\0one'],
    ['a parent-directory segment', '..'],
  ];

  for (const [label, featureId] of rejected) {
    it(`rejects ${label} with a WorkspaceError naming the id`, async () => {
      const attempt = createWorktree(
        repo.mainRepo,
        repo.scratchRoot,
        featureId,
        'HEAD',
      );

      await expect(attempt).rejects.toBeInstanceOf(WorkspaceError);
      await expect(attempt).rejects.toThrow(
        // JSON.stringify so the empty and whitespace cases are legible in the
        // message rather than vanishing into it.
        new RegExp(
          JSON.stringify(featureId).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'),
        ),
      );
    });
  }

  it('refuses to reuse a live feature’s worktree', async () => {
    const created = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'already-live',
      'HEAD',
    );

    // Reusing rather than refusing would attach a second worker to a running
    // agent's working tree. That is a data-loss path, not a convenience.
    await expect(
      createWorktree(repo.mainRepo, repo.scratchRoot, 'already-live', 'HEAD'),
    ).rejects.toBeInstanceOf(WorkspaceError);

    await destroyWorktree(repo.mainRepo, created.worktreePath, created.branch);
  });

  it('refuses when the branch exists even though the directory does not', async () => {
    // The half-torn-down shape: `worktree remove` ran, `branch -D` did not.
    // Creating over it would silently resume someone else's branch.
    const created = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'branch-survivor',
      'HEAD',
    );
    await repo.git.raw(['worktree', 'remove', '--force', created.worktreePath]);
    expect(await exists(created.worktreePath)).toBe(false);

    await expect(
      createWorktree(
        repo.mainRepo,
        repo.scratchRoot,
        'branch-survivor',
        'HEAD',
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);

    await repo.git.raw(['branch', '-D', created.branch]);
  });
});

describe('destroyWorktree: both halves, in order, more than once', () => {
  let repo: OpenedTempRepo;

  beforeAll(async () => {
    repo = await openTempRepo();
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('removes the worktree AND the branch', async () => {
    const { worktreePath, branch } = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'clean-1',
      'HEAD',
    );

    expect(await exists(worktreePath)).toBe(true);
    expect(await adlBranches(repo.git)).toContain(branch);

    await destroyWorktree(repo.mainRepo, worktreePath, branch);

    // Both halves, asserted independently. This is the whole point of the
    // test: plan 02-03 watched the worktree assertion PASS while the branch
    // survived, so a single check here is the exact silent half-failure
    // WORK-04 exists to prevent (02-RESEARCH.md § Pitfall 3).
    expect(await worktreeListRaw(repo.git)).not.toContain(worktreePath);
    expect(await exists(worktreePath)).toBe(false);
    expect(await adlBranches(repo.git)).not.toContain(branch);
  });

  it('succeeds on a worktree carrying modified and untracked files', async () => {
    const { worktreePath, branch } = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'dirty-1',
      'HEAD',
    );

    // A modified tracked file and an untracked one. Without `--force` git
    // refuses both (02-RESEARCH.md § Pitfall 9), and an agent that crashed
    // mid-edit leaves exactly this state behind.
    await writeFile(join(worktreePath, 'tracked.txt'), 'modified\n');
    await mkdir(join(worktreePath, 'junk'), { recursive: true });
    await writeFile(join(worktreePath, 'junk', 'untracked.txt'), 'left over\n');

    await destroyWorktree(repo.mainRepo, worktreePath, branch);

    expect(await exists(worktreePath)).toBe(false);
    expect(await adlBranches(repo.git)).not.toContain(branch);
  });

  it('is a no-op the second time', async () => {
    const { worktreePath, branch } = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'twice-1',
      'HEAD',
    );

    await destroyWorktree(repo.mainRepo, worktreePath, branch);
    // The GC backstop re-runs teardown over whatever a crash left behind, so
    // "already gone" must resolve rather than throw.
    await expect(
      destroyWorktree(repo.mainRepo, worktreePath, branch),
    ).resolves.toBeUndefined();

    expect(await adlBranches(repo.git)).not.toContain(branch);
  });

  it('finishes a teardown that died between the two steps', async () => {
    const { worktreePath, branch } = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'half-done',
      'HEAD',
    );

    // Simulate the crash window: worktree gone, branch still there.
    await repo.git.raw(['worktree', 'remove', '--force', worktreePath]);
    expect(await adlBranches(repo.git)).toContain(branch);

    await destroyWorktree(repo.mainRepo, worktreePath, branch);

    expect(await adlBranches(repo.git)).not.toContain(branch);
  });

  it('does not confuse two features whose ids share a prefix', async () => {
    const one = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'feat-1',
      'HEAD',
    );
    const evil = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'feat-1-evil',
      'HEAD',
    );

    expect(one.worktreePath).not.toBe(evil.worktreePath);
    expect(one.branch).toBe(branchNameFor('feat-1'));
    expect(evil.branch).toBe(branchNameFor('feat-1-evil'));

    await destroyWorktree(repo.mainRepo, one.worktreePath, one.branch);

    // The neighbour survives, both halves.
    expect(await exists(evil.worktreePath)).toBe(true);
    expect(await adlBranches(repo.git)).toContain(evil.branch);
    expect(await adlBranches(repo.git)).not.toContain(one.branch);

    await destroyWorktree(repo.mainRepo, evil.worktreePath, evil.branch);
  });

  it('rethrows a failure that is not "already gone"', async () => {
    // `mainRepo` is a real path but not a linked worktree, so removing it is a
    // genuine error rather than an idempotent no-op. A blanket catch would
    // swallow this and report a successful teardown that removed nothing.
    await expect(
      destroyWorktree(repo.mainRepo, repo.mainRepo, 'adl/never-existed'),
    ).rejects.toThrow();
  });
});

/** `git worktree list` as one string, for a substring assertion. */
async function worktreeListRaw(git: SimpleGit): Promise<string> {
  return git.raw(['worktree', 'list']);
}
