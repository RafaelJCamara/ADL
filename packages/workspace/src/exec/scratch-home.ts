/**
 * The per-run scratch `HOME` (D-07).
 *
 * Every child of a workspace runs with `HOME` pointed at a directory that did
 * not exist before the run and does not exist after it. That is what stops an
 * agent's `git config --global`, its `~/.npmrc`, and its credential helper from
 * outliving the round that wrote them.
 *
 * **The security property comes from `mkdtemp`, not from the deletion.**
 * `mkdtemp` is the only race-free way to obtain a directory whose name nothing
 * else can predict, so "the agent's configuration did not reach the next run"
 * holds even if a teardown is interrupted, crashes, or loses a race with a
 * still-open file handle (T-2-20). Deletion is hygiene on top of that. Reading
 * it the other way round — treating the delete as the control — is what leads to
 * a teardown that throws mid-cleanup and takes the rest of the teardown with it.
 *
 * **The mode this directory ends up with is not decided here.** `mkdtemp`
 * creates it `0700`, owned by the daemon user, which is correct whenever the
 * privilege drop did not happen. When it did, the worker user is a different
 * identity and needs to write its own `HOME` — so `exec/privilege.ts`'s
 * `applyWorkerAccess` widens the directory to the shared group (group rwx, no
 * world bit, T-2-35) after the worktree backend has created both. Kept there
 * rather than here so that this module has no opinion about OS identity and
 * stays the same on every platform.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A private `HOME` belonging to one `Workspace` instance. */
export interface ScratchHome {
  /** Absolute path to the directory. Handed to children as `HOME`, never as a readable/writable workspace path. */
  readonly path: string;
}

/**
 * What teardown actually did — returned rather than thrown or swallowed.
 *
 * A discriminated union rather than a boolean, because the three outcomes want
 * different things from the caller: `removed` is the happy path, `already-absent`
 * is what idempotency looks like from the inside, and `not-removed` is a real
 * event an operator may want to see (a leaked temp directory on a long-running
 * daemon) without it being a failure that aborts anything.
 */
export type ScratchHomeTeardown =
  | {
      readonly outcome: 'removed';
      readonly path: string;
      /** How many attempts it took. >1 means the Windows handle race was hit and lost, then won. */
      readonly attempts: number;
    }
  | {
      /** The directory was not there to begin with. Teardown is safe to call twice. */
      readonly outcome: 'already-absent';
      readonly path: string;
    }
  | {
      readonly outcome: 'not-removed';
      readonly path: string;
      readonly attempts: number;
      /** The OS error code and message. Never a value from the child's environment. */
      readonly reason: string;
    };

/**
 * Create a fresh, unpredictably named home directory under the OS temp root.
 *
 * Deliberately NOT configurable, and deliberately never reused. A configurable
 * root invites a shared one; a reused directory replaces D-07's "the
 * configuration does not survive because the directory stops existing" with a
 * wipe step that has to run correctly on every single run, and a wipe step that
 * misses one file is indistinguishable from one that works.
 */
export async function createScratchHome(): Promise<ScratchHome> {
  return { path: await mkdtemp(join(tmpdir(), 'adl-home-')) };
}

/**
 * Errors that mean "something still has this directory open", as opposed to
 * "this cannot work".
 *
 * On Windows a directory that a *just-exited* child still holds a handle on
 * fails removal with `EBUSY` or `EPERM`, and the handle is usually released
 * within milliseconds — so these are worth a short retry. `ENOTEMPTY` is the
 * same story one level down: a concurrent write landed between the recursive
 * walk and the final `rmdir`. Anything not on this list (`EACCES` on a
 * directory ADL does not own, for instance) will not improve by being retried.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE']);

/** Bounded: ~4 retries over roughly 250ms total. Teardown must not become a stall. */
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 25;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Remove a scratch home and everything the run left in it — best effort.
 *
 * Three deliberate choices:
 *
 * 1. **It does not throw.** Teardown runs after the interesting work, often
 *    alongside other teardown steps, and a throw here would abort them. The
 *    outcome is returned so a caller can log it, and `mkdtemp` means a leaked
 *    directory is a disk-space problem rather than a security one.
 * 2. **An already-absent directory is a success.** `Workspace.destroy()` and any
 *    later GC backstop can both reach this, and a teardown that must run exactly
 *    once is a teardown nobody can safely add a backstop to.
 * 3. **`force` is off, on purpose.** `rm(dir, { force: true })` swallows
 *    `ENOENT`, which is the very thing that distinguishes `already-absent` from
 *    `removed`. Letting the error surface is what makes idempotency observable
 *    instead of merely true.
 */
export async function destroyScratchHome(
  dir: string,
): Promise<ScratchHomeTeardown> {
  let lastReason = 'unknown';
  let used = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    used = attempt;
    try {
      await rm(dir, { recursive: true });
      return { outcome: 'removed', path: dir, attempts: attempt };
    } catch (error) {
      const code = codeOf(error);

      if (code === 'ENOENT') {
        return { outcome: 'already-absent', path: dir };
      }

      lastReason = `${code ?? 'unknown'}: ${(error as Error).message}`;

      if (code === undefined || !TRANSIENT_CODES.has(code)) break;

      if (attempt < MAX_ATTEMPTS) {
        // Linear backoff. The handle-release window this is waiting on is
        // milliseconds; exponential backoff would mostly be spent sleeping past
        // it.
        await new Promise((resolve) =>
          setTimeout(resolve, BACKOFF_MS * attempt),
        );
      }
    }
  }

  return {
    outcome: 'not-removed',
    path: dir,
    // The attempts ACTUALLY made, not the cap: a non-transient error breaks out
    // after one, and reporting five would send whoever reads the log looking
    // for a retry loop that never ran.
    attempts: used,
    reason: lastReason,
  };
}
