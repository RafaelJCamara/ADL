import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
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
    //
    // `force` alone is not enough, and M05 step 5.14 is what proved it: since a
    // workspace now outlives the stage that created it (`Workspace.detach`),
    // this fixture is the thing that removes a real worktree a real forked
    // worker was using seconds earlier, where before the stage's own
    // `destroy()` had already done it through `git worktree remove`. Windows
    // then failed the whole suite with `EBUSY: resource busy or locked, rmdir`
    // in `test/usage/recording.test.ts` — reproduced on the first full run
    // after the lifecycle change.
    //
    // `maxRetries`/`retryDelay` are Node's own answer to exactly this: it
    // retries `EBUSY`/`EPERM`/`ENOTEMPTY`/`EMFILE` with a linear backoff. The
    // set is the same one `src/exec/scratch-home.ts`'s `TRANSIENT_CODES`
    // already retries by hand, and for the same stated reason — the handle is
    // usually released within milliseconds.
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  };

  try {
    // `mkdtemp` creates the root `0700`, which is right for a temp directory and
    // wrong for this fixture the moment WORK-05's privilege drop is active: the
    // worker is a DIFFERENT OS user, and without traverse permission on this
    // one directory it cannot reach the worktree it is supposed to be working
    // in — every exec-based case would then fail for a reason that has nothing
    // to do with the code under test.
    //
    // `0711` and not `0755`: traverse, deliberately without list. A real
    // deployment's repository and scratch root are ordinary `0755` directories
    // and need nothing done to them; this line exists because `mkdtemp` is
    // stricter than the world the code actually runs in. Skipped on Windows,
    // where the mode bits mean nothing.
    if (process.platform !== 'win32') await chmod(dir, 0o711);

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
