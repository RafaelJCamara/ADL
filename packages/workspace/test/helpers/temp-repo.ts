import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Named import for the reason `src/worktree/lifecycle.ts` documents at length:
// a default import of this CJS-classified module resolves to the namespace under
// `nodenext` without `esModuleInterop`.
import { simpleGit, type SimpleGit } from 'simple-git';

export interface TempRepo {
  /** The main repository ADL is running against. */
  readonly mainRepo: string;
  /** The directory feature worktrees are created under, a sibling of the repo. */
  readonly scratchRoot: string;
  /** A `simple-git` handle on `mainRepo`, so a test can assert against real git state. */
  readonly git: SimpleGit;
}

/**
 * Run `fn` against a freshly initialised git repository with one commit, plus an
 * empty scratch root beside it, then delete both.
 *
 * A real repository rather than a mock, for the same reason `withTempDb` insists
 * on a real file rather than `:memory:`: worktree semantics — the `.git` *file*
 * a linked worktree gets, the refusal to delete a branch that is checked out
 * somewhere, the survival of a branch past `worktree remove` — are the entire
 * subject under test, and every one of them is a property of the git binary.
 *
 * Teardown is in a `finally` so a failing assertion cannot leak a repository.
 * That matters more than it sounds: a leaked directory is invisible locally and
 * accumulates on the machine running CI.
 */
export async function withTempRepo<T>(
  fn: (ctx: TempRepo) => Promise<T>,
): Promise<T> {
  const repo = await openTempRepo();
  try {
    return await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

/** A {@link TempRepo} whose lifetime the caller manages. */
export interface OpenedTempRepo extends TempRepo {
  /** Delete the repository and its scratch root. Safe to call once. */
  cleanup(): Promise<void>;
}

/**
 * The same fixture as {@link withTempRepo}, opened and closed explicitly.
 *
 * This exists for the `beforeAll` / `afterAll` shape. The git integration
 * tests dominate this package's runtime budget, and a suite whose cases each
 * use their own feature ids does not need a fresh `git init` plus commit per
 * case. Prefer `withTempRepo` when one test wants a repository to itself —
 * its `finally` cannot be forgotten, which is why it stays the default.
 */
export async function openTempRepo(): Promise<OpenedTempRepo> {
  // realpath, not the raw mkdtemp result: on macOS `os.tmpdir()` is a symlink
  // into /private, and git reports worktree paths already resolved. Without this
  // an assertion against `git worktree list` compares two spellings of the same
  // directory and fails for a reason that has nothing to do with the code.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'adl-repo-')));
  const mainRepo = join(dir, 'main');
  const scratchRoot = join(dir, 'scratch');

  const cleanup = async (): Promise<void> => {
    // On Windows an open handle makes the unlink fail, which would turn a
    // passing test into a confusing teardown error. That applies doubly here: a
    // child process that has only just exited can still hold one.
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await mkdir(mainRepo);
    // `git worktree add` creates the leaf directory but not its parent.
    await mkdir(scratchRoot);

    const git = simpleGit(mainRepo);
    await git.init();
    // Local, not global: the scratch HOME the workspace hands children is not in
    // play for the test's own git calls, and a machine with no committer
    // identity configured would otherwise fail here rather than in the code.
    await git.addConfig('user.email', 'tracer@adl.invalid');
    await git.addConfig('user.name', 'ADL Tracer');
    // A tracked file, so a test can make a worktree dirty by modifying one.
    await writeFile(join(mainRepo, 'tracked.txt'), 'original\n');
    await git.add('tracked.txt');
    // A base ref has to exist before a worktree can branch from one.
    await git.raw(['commit', '-m', 'initial']);

    return { mainRepo, scratchRoot, git, cleanup };
  } catch (error) {
    // A failure during setup must not leak the directory it already created.
    await cleanup();
    throw error;
  }
}
