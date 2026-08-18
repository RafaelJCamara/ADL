import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listManagedWorktrees,
  parseWorktreeList,
} from '../../src/worktree/list.js';
import { createWorktree } from '../../src/worktree/lifecycle.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

/**
 * The porcelain inventory.
 *
 * Two halves, deliberately tested differently: `parseWorktreeList` against
 * literal strings, because it is pure and a git binary would only make the
 * cases slower and harder to read; `listManagedWorktrees` against a real
 * repository, because the thing it can get wrong is the argv it hands git and
 * whether git's real output survives the round trip.
 */

/** Build a porcelain `-z` payload from label lines, records already grouped. */
const porcelain = (records: readonly (readonly string[])[]): string =>
  records.map((lines) => `${lines.join('\0')}\0`).join('\0');

const HEAD_LINE = 'HEAD a264880d434dc3ec6fbe446fc6860799aa441fa3';

describe('parseWorktreeList', () => {
  it('returns an empty array for empty input', () => {
    // A repository can never actually report this — the main worktree is
    // always listed — but a parser that throws on it would turn an unexpected
    // empty read into a crash rather than an empty inventory.
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('')).toHaveLength(0);
  });

  it('parses a single record', () => {
    const text = porcelain([
      ['worktree /repo/main', HEAD_LINE, 'branch refs/heads/master'],
    ]);

    expect(parseWorktreeList(text)).toEqual([
      { path: '/repo/main', branch: 'refs/heads/master' },
    ]);
  });

  it('parses a record with no branch line', () => {
    // `--detach`: git emits a bare `detached` label and no `branch` line.
    const text = porcelain([
      ['worktree /repo/wt-detached', HEAD_LINE, 'detached'],
    ]);

    const [entry] = parseWorktreeList(text);
    expect(entry?.path).toBe('/repo/wt-detached');
    expect(entry?.branch).toBeUndefined();
  });

  it('carries git’s prunable reason verbatim', () => {
    const text = porcelain([
      [
        'worktree /repo/wt-gone',
        HEAD_LINE,
        'branch refs/heads/adl/feat-9',
        'prunable gitdir file points to non-existent location',
      ],
    ]);

    expect(parseWorktreeList(text)[0]?.prunable).toBe(
      'gitdir file points to non-existent location',
    );
  });

  it('ignores labels it does not know rather than rejecting them', () => {
    // The format grows by adding labels. A parser that throws on an unknown
    // one turns a git upgrade into an outage.
    const text = porcelain([
      [
        'worktree /repo/wt-locked',
        HEAD_LINE,
        'branch refs/heads/adl/feat-9',
        'locked',
        'some-future-label with a value',
      ],
    ]);

    expect(parseWorktreeList(text)).toEqual([
      { path: '/repo/wt-locked', branch: 'refs/heads/adl/feat-9' },
    ]);
  });

  it('keeps every record, in git’s order', () => {
    const text = porcelain([
      ['worktree /repo/main', HEAD_LINE, 'branch refs/heads/master'],
      ['worktree /repo/wt-1', HEAD_LINE, 'branch refs/heads/adl/feat-1'],
      ['worktree /repo/wt-1e', HEAD_LINE, 'branch refs/heads/adl/feat-1-evil'],
    ]);

    expect(parseWorktreeList(text).map((entry) => entry.path)).toEqual([
      '/repo/main',
      '/repo/wt-1',
      '/repo/wt-1e',
    ]);
  });
});

describe('listManagedWorktrees', () => {
  let repo: OpenedTempRepo;

  beforeAll(async () => {
    repo = await openTempRepo();
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('returns an empty array on a repository with no ADL worktrees', async () => {
    // The main worktree is listed by git and is not ADL's, so the correct
    // answer is an empty inventory rather than one entry — and certainly not
    // a throw.
    await expect(listManagedWorktrees(repo.mainRepo)).resolves.toEqual([]);
  });

  it('excludes a worktree whose branch is outside the adl/ prefix', async () => {
    await repo.git.raw([
      'worktree',
      'add',
      '-b',
      'someones-own-work',
      `${repo.scratchRoot}/human`,
      'HEAD',
    ]);

    const inventory = await listManagedWorktrees(repo.mainRepo);

    // Left out entirely, not included-and-skipped: a human's worktree is not
    // ADL's to inventory.
    expect(inventory).toEqual([]);
  });

  it('lists ADL worktrees in git’s emission order, stably', async () => {
    for (const featureId of ['feat-a', 'feat-b', 'feat-c']) {
      await createWorktree(repo.mainRepo, repo.scratchRoot, featureId, 'HEAD');
    }

    const first = await listManagedWorktrees(repo.mainRepo);
    expect(first).toHaveLength(3);
    expect(first.map((entry) => entry.branch)).toEqual([
      'refs/heads/adl/feat-a',
      'refs/heads/adl/feat-b',
      'refs/heads/adl/feat-c',
    ]);

    // Two consecutive calls over an unchanged repository agree exactly. The
    // sweep iterates this list and a caller diffing two inventories needs the
    // order to be a contract rather than an accident.
    const second = await listManagedWorktrees(repo.mainRepo);
    expect(second).toEqual(first);
  });

  it('keeps prefix-sharing feature ids apart', async () => {
    await createWorktree(repo.mainRepo, repo.scratchRoot, 'feat-1', 'HEAD');
    await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'feat-1-evil',
      'HEAD',
    );

    const branches = (await listManagedWorktrees(repo.mainRepo)).map(
      (entry) => entry.branch,
    );

    expect(branches).toContain('refs/heads/adl/feat-1');
    expect(branches).toContain('refs/heads/adl/feat-1-evil');
    // Two entries, two directories — not one entry that swallowed the other.
    expect(new Set(branches).size).toBe(branches.length);
  });
});
