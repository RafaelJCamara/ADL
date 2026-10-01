/**
 * The parts of the MAIN repository's `.git` that a commit made from a linked
 * worktree writes to, and what must stay out of the worker's reach (D-6-CI-1).
 *
 * A linked worktree's objects and refs are not per-worktree
 * (`gitrepository-layout`(5)): `git commit` writes blobs, trees and the commit
 * into the shared `objects/`, moves `refs/heads/<branch>` there, and appends to
 * `logs/refs/heads/<branch>`. The per-worktree administrative directory holds
 * only the index and `HEAD`. Each of the three was reproduced as a distinct
 * failure on a Linux leg ("insufficient permission for adding an object to
 * repository database", then "cannot update the ref ... unable to append to
 * .git/logs/...").
 *
 * ── What is granted, and the shape of each grant ──────────────────────────────
 *
 * - **`objects/<xx>`, the 256 fan-out directories, and ONLY those** -- group
 *   `rwx` plus the sticky bit (`1775`), on each directory and not beneath it.
 *   The worker adds loose objects; the sticky bit means it cannot unlink,
 *   rename over, or replace one the daemon wrote. `objects/` itself,
 *   `objects/info` (where `alternates` lives) and `objects/pack` are NOT granted:
 *   a commit needs none of them, and each is a place the worker could otherwise
 *   plant an object store the daemon's git would read. Probed against git 2.43
 *   under both a 022 and a 002 daemon umask: a worker commit works, a worker
 *   re-add of a blob the daemon already wrote works (git sees it exists and
 *   writes nothing), the daemon reads and packs what the worker wrote, and a
 *   worker delete, `mv -f` replace, in-place append and `alternates` write all
 *   fail. `test/exec/privilege.test.ts` repeats each of those as a test.
 * - **`refs/heads/adl` and `logs/refs/heads/adl`** -- the whole `adl/*` branch
 *   namespace and its reflogs, recursively. This is wider than "this feature's
 *   branch": it includes every other feature's, finished and awaiting a human
 *   included, because one worker identity serves them all. See
 *   `worktree/ref-guard.ts` for the redirect this opens and the (partial) guard.
 *
 * ── What is deliberately NOT granted, each for a stated reason ───────────────
 *
 * - `.git/config` and `.git/hooks` -- `protect`ed instead, not merely left
 *   alone: group and world write come OFF both, and off every entry of the
 *   hooks directory. Config names programs git executes; a hook IS one, run on
 *   the DAEMON's later operations on this repository.
 * - `refs/` as a whole. `refs/replace/*` makes git substitute any object at read
 *   time, so a worker that could write one could make the daemon's own `git
 *   diff` (the protected-path check) see something other than the commit that
 *   is pushed. It also keeps the default branch, tags and remote-tracking refs
 *   out of reach.
 * - `packed-refs`, `shallow`, `info/`, `gc.log` -- the worker never writes them
 *   to commit (`update-ref` of a packed ref writes a LOOSE ref).
 *
 * ── The fan-out directories are created up front ──────────────────────────────
 *
 * A loose object lives in `objects/<first two hex digits>/`, created lazily by
 * whoever writes the first object with that prefix, with that identity's umask.
 * A directory the daemon creates after the grant is `0755` under the usual umask
 * 022 and cannot be written by the worker (measured: 2 of 300 worker writes
 * failed); one the worker creates is group-writable only because the
 * distribution's PAM happens to give the worker umask 002. With all 256 present
 * and granted, neither identity creates a directory in normal operation. `git
 * gc` prunes empty ones, and the next `open` restores them. They are created
 * only when absent -- `mkdir` answering `EEXIST` is the whole check, and it
 * cannot race a second creator.
 *
 * ── Residuals, accepted and written down ──────────────────────────────────────
 *
 * - **One object store for every feature.** A worker can add objects any
 *   feature's git will see, and can delete or rewrite objects it (any worker)
 *   made. It cannot touch the daemon's. Per-feature stores are the real fix
 *   (docs/plan/DEBT.md, D-6-CI-6).
 * - **`gc --auto`** after a worker commit is NOT neutralised, and cannot do
 *   anything: `git gc` run as the worker dies on its first step with
 *   `Unable to create '.git/gc.pid.lock': Permission denied` (the lock lives in
 *   the common git directory, which is not the worker's), so nothing is packed or
 *   pruned. The commit's own auto-gc swallows that failure and exits 0. Pinned
 *   by a test; the choice not to add `gc.auto=0` to the worker's scratch git
 *   config is DEBT D-6-CI-9.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { adlGit } from '../git/adl-git.js';
import { BRANCH_NAMESPACE } from './lifecycle.js';

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown error';
}

/**
 * The repository's common git directory -- where `objects/`, `refs/`, `config`
 * and `hooks/` live -- or `undefined` when git will not say.
 *
 * Asked of git (`rev-parse --git-common-dir`) rather than assembled as
 * `<mainRepo>/.git`: `mainRepo` may itself be a linked worktree or carry a
 * `.git` FILE, in which case the assembled path is not a directory and the
 * first `mkdir` under it throws `ENOTDIR`.
 */
export async function resolveCommonGitDir(
  cwd: string,
): Promise<string | undefined> {
  let outcome;
  try {
    outcome = await adlGit(cwd).raw(['rev-parse', '--git-common-dir']);
  } catch {
    return undefined;
  }
  const printed = outcome.stdout.trim();
  if (outcome.exitCode !== 0 || printed === '') return undefined;
  // Relative to the directory the command ran in, which is `cwd`.
  return resolve(cwd, printed);
}

/** The paths of the shared git directory, as the worker access grant wants them. */
export interface SharedGitPaths {
  /** The common git directory itself. */
  readonly gitDir: string;
  /** Granted recursively: the `adl/*` branch refs and their reflogs. */
  readonly trees: readonly string[];
  /** Granted non-recursively with the sticky bit: `objects/00` .. `objects/ff`. */
  readonly stickyDirs: readonly string[];
  /** Kept daemon-writable only: `config` and `hooks`. */
  readonly protect: readonly string[];
}

export type PreparedSharedGit =
  | ({ readonly ok: true } & SharedGitPaths)
  | { readonly ok: false; readonly reason: string };

/** `objects/00` .. `objects/ff`. */
export function fanOutDirectories(gitDir: string): readonly string[] {
  const objects = join(gitDir, 'objects');
  const dirs: string[] = [];
  for (let prefix = 0; prefix < 256; prefix += 1) {
    dirs.push(join(objects, prefix.toString(16).padStart(2, '0')));
  }
  return dirs;
}

/**
 * Resolve the common git directory and create what can be granted, or say why
 * not (convention 5: a classified result, not an exception).
 */
export async function prepareSharedGit(
  mainRepo: string,
): Promise<PreparedSharedGit> {
  const gitDir = await resolveCommonGitDir(mainRepo);
  if (gitDir === undefined) {
    return {
      ok: false,
      reason: `git would not report the common git directory of ${mainRepo} (rev-parse --git-common-dir), so the shared object store and branch refs cannot be granted and the worker will be unable to commit`,
    };
  }

  const refs = join(gitDir, 'refs', 'heads', BRANCH_NAMESPACE);
  const logs = join(gitDir, 'logs', 'refs', 'heads', BRANCH_NAMESPACE);
  const fanOut = fanOutDirectories(gitDir);

  try {
    await mkdir(refs, { recursive: true });
    await mkdir(logs, { recursive: true });
    for (const dir of fanOut) {
      try {
        await mkdir(dir);
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: `could not create the shared git directories under ${gitDir}: ${codeOf(error)}`,
    };
  }

  return {
    ok: true,
    gitDir,
    trees: [refs, logs],
    stickyDirs: fanOut,
    protect: [join(gitDir, 'config'), join(gitDir, 'hooks')],
  };
}
