/**
 * A guard before a write to a ref the worker can reach.
 *
 * ── The hole ───────────────────────────────────────────────────────────────
 *
 * `refs/heads/adl` is group-writable so the worker can move its own branch
 * (`worktree/shared-git.ts`). Git's files backend treats a **symlink** whose
 * text starts with `refs/` as a symbolic ref, so a worker can replace
 * `refs/heads/adl/<id>` with a link to another ref. Every write made *through*
 * that branch then lands on the target. The worktree's own `HEAD` (in the
 * granted administrative directory) offers the same redirect more simply -- a
 * worker can write `ref: refs/heads/main` into it.
 *
 * ── Whose write it is, which decides how bad it is ─────────────────────────
 *
 * **Reproduced** against git 2.43: a *daemon-identity* `git commit` in a
 * worktree whose branch ref is a link to `main` moves `main`, and so does
 * `update-ref` of the branch. That reproduction is why this exists.
 *
 * **Not reachable from ADL's code today**, and that was probed, not assumed.
 * `ManagerGitClient` (the carry-back commit, the add, the push) goes through
 * `Workspace.exec()`, so under the drop it runs AS THE WORKER, which cannot
 * write `refs/heads/main`: its commit through such a link fails with
 * `Permission denied` on `main.lock` and moves nothing. The daemon-identity
 * writers (`adlGit`) are `worktree add -b` -- which refuses a branch name
 * that is already a link ("a branch named ... already exists") -- and `branch
 * -D`, which deletes the link and not its target. So against `main`, tags and
 * `refs/replace` the boundary is the OS permission, and this guard is not what
 * holds it.
 *
 * What it does hold, today: **a worker-run commit landing on the wrong
 * `adl/*` branch.** A link from this feature's branch to another feature's
 * (which the one worker identity CAN write) or a repointed `HEAD`, would put
 * ADL's own carry-back commit on that other feature's branch -- and then push
 * it. And it is the guard a daemon-identity writer must pass through the day one
 * exists (the detached-HEAD redesign below makes the daemon the only writer of
 * these refs).
 *
 * ── What this does, and what it does not ────────────────────────────────────
 *
 * Before the write: (1) `HEAD` must name exactly the branch ADL created for this
 * feature; (2) every entry under `refs/heads/adl` and `logs/refs/heads/adl`
 * must be a regular file or a directory -- anything else (a link, a fifo) is
 * **unlinked**, and the caller is told it was there.
 *
 * **It is not race-free.** The check and the write are two operations, and the
 * worker is a live process that can plant a link between them. It closes the
 * reproduced attack (a link planted during the agent run, found by the sweep
 * after the agent has exited) and not a worker that plants one during the
 * commit itself. The structural fix -- worktrees on a DETACHED HEAD, so the
 * worker never holds a ref directory and the daemon alone creates and advances
 * `refs/heads/adl/<id>` -- changes how every consumer of the branch finds its
 * worktree (the inventory in `list.ts`, GC, `attach`, the lifecycle contract
 * and its tests) and does not by itself remove the `HEAD` redirect. It is
 * recorded in `docs/plan/DEBT.md` as D-6-CI-7, with the reasons it was not done
 * here. Until then this is a mitigation and is documented as one.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { adlGit } from '../git/adl-git.js';
import { resolveCommonGitDir } from './shared-git.js';
import { BRANCH_NAMESPACE } from './lifecycle.js';

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown error';
}

/** Remove every entry under `dir` that is neither a regular file nor a directory. */
async function sweep(
  dir: string,
  base: string,
  removed: string[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    // lstat, so a link to a directory is a link here and not a directory.
    if (info.isDirectory()) {
      await sweep(path, base, removed);
    } else if (!info.isFile()) {
      // `unlink`, never `rm`: removes the link and cannot follow it.
      await unlink(path);
      removed.push(relative(base, path).replaceAll('\\', '/'));
    }
  }
}

/**
 * Unlink every non-regular entry in the `adl/*` branch refs and reflogs of the
 * repository, returning what was removed (relative to its git directory).
 *
 * A repository git will not describe, or directories that are absent, are
 * nothing to sweep.
 */
export async function sweepAdlRefs(cwd: string): Promise<readonly string[]> {
  const gitDir = await resolveCommonGitDir(cwd);
  if (gitDir === undefined) return [];
  const removed: string[] = [];
  for (const dir of [
    join(gitDir, 'refs', 'heads', BRANCH_NAMESPACE),
    join(gitDir, 'logs', 'refs', 'heads', BRANCH_NAMESPACE),
  ]) {
    await sweep(dir, gitDir, removed);
  }
  return removed;
}

export type RefWriteGuard =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Check that a daemon-side write to the feature's branch in `worktree` lands
 * where ADL thinks it does, sweeping the namespace first.
 *
 * Refuses (with a `detail` fit for a stage error) if `HEAD` does not name
 * `refs/heads/<branch>`, or if anything had to be unlinked: a branch ref that
 * was a link is a branch ref that is now missing, and carrying on to commit onto
 * an unborn branch would publish an orphan commit as the feature's work.
 */
export async function guardRefWrite(
  worktree: string,
  branch: string,
): Promise<RefWriteGuard> {
  const removed = await sweepAdlRefs(worktree);
  if (removed.length > 0) {
    return {
      ok: false,
      detail: `refusing to write to ${branch}: ${String(removed.length)} entr${removed.length === 1 ? 'y' : 'ies'} in the branch namespace (${removed.slice(0, 5).join(', ')}) ${removed.length === 1 ? 'was' : 'were'} not a regular ref file -- a symbolic link there redirects a write to any other ref -- and ${removed.length === 1 ? 'was' : 'were'} removed`,
    };
  }

  const head = await adlGit(worktree).raw(['symbolic-ref', '-q', 'HEAD']);
  const expected = `refs/heads/${branch}`;
  if (head.exitCode !== 0 || head.stdout.trim() !== expected) {
    return {
      ok: false,
      detail: `refusing to write to ${branch}: the worktree's HEAD names ${head.exitCode === 0 ? JSON.stringify(head.stdout.trim()) : 'no branch (detached or unreadable)'}, not ${JSON.stringify(expected)} -- something other than ADL repointed it, and a commit would land there instead`,
    };
  }
  return { ok: true };
}
