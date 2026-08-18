/**
 * The host git-worktree `Workspace` backend — v1's only real one.
 *
 * Interface plus factory function returning an object literal, following
 * `packages/db/src/repository/features.ts`. This repository has no service
 * classes, and dependencies arrive as parameters rather than through a
 * constructor.
 *
 * The instance owns two things that outlive a single `exec()`: the worktree and
 * the scratch `HOME`. Both are created here and destroyed by `destroy()`, which
 * is what makes D-07's guarantee structural — no caller is in a position to opt
 * a child out of the scratch home, because no caller ever sees the seam.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  RestoreHandle,
  Workspace,
  WorkspaceSpec,
} from '@adl/core/stage';
import { simpleGit } from 'simple-git';
import { WorkspaceError } from '../errors.js';
import {
  applyWorkerAccess,
  privilegeLauncher,
  reportWorkerAccess,
  workerIdentityFromEnv,
  type WorkerIdentity,
} from '../exec/privilege.js';
import { run } from '../exec/run.js';
import { createScratchHome, destroyScratchHome } from '../exec/scratch-home.js';
import { assertWithinRoot } from '../paths.js';
import { report, reportScratchHomeTeardown } from '../teardown.js';
import { createWorktree, destroyWorktree } from './lifecycle.js';

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Where a snapshot's commit object is anchored while the handle is live.
 *
 * `git stash create` produces a **dangling** commit — it writes no ref at all,
 * which is exactly why it does not disturb the working tree. Dangling is also
 * why it needs anchoring: an unreferenced object is a `git gc` away from
 * disappearing, and a restore handle whose object was collected is a restore
 * that fails at the worst possible moment. `release()` deletes the ref, which
 * is the whole of what release means here.
 *
 * Deliberately NOT under `refs/heads/` — a snapshot is not a branch, and one
 * that appeared in `git branch` output would be indistinguishable from ADL's
 * `adl/<featureId>` branches to both the GC sweep and a human.
 */
const SNAPSHOT_REF_PREFIX = 'refs/adl-snapshots/';

/** What a daemon may configure about this backend beyond the spec. */
export interface WorktreeWorkspaceOptions {
  /**
   * The pre-provisioned worker identity children are dropped to (WORK-05, D-06).
   *
   * Defaults to `ADL_WORKER_USER` / `ADL_WORKER_GROUP` from the DAEMON's own
   * environment. This is the one place ADL legitimately reads its own process
   * environment, and what it reads is two non-secret names — never a
   * credential. It lives here rather than on `WorkspaceSpec` because a spec is
   * per feature and an OS identity is per deployment.
   */
  readonly worker?: WorkerIdentity;
}

/**
 * The administrative directory git keeps for a linked worktree.
 *
 * Read from the worktree's own `.git` — which is a FILE containing
 * `gitdir: <path>` — rather than assembled from `<mainRepo>/.git/worktrees/` +
 * a guessed name. Git dedupes colliding worktree names with a numeric suffix,
 * so the guessed form is right until the day two features share a basename, and
 * then the worker silently cannot commit.
 */
async function worktreeAdminDir(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const pointer = await readFile(join(worktreePath, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export async function worktreeWorkspace(
  spec: WorkspaceSpec,
  options: WorktreeWorkspaceOptions = {},
): Promise<Workspace> {
  const worker = options.worker ?? workerIdentityFromEnv();

  const { worktreePath, branch } = await createWorktree(
    spec.mainRepo,
    spec.scratchRoot,
    spec.featureId,
    spec.baseRef,
  );
  const scratchHome = await createScratchHome();

  // Resolved against the DAEMON's PATH here, and again against the child's
  // `ExecSpec.path` inside `run()`. Two resolutions rather than one because the
  // two questions are genuinely different: this one asks "will a drop happen,
  // and therefore does the worker need access to these directories?", and
  // `run()`'s asks "can execa resolve the launcher from the environment this
  // particular child gets?" (02-RESEARCH.md § Pitfall 7).
  const privilege = await privilegeLauncher({
    worker,
    path: process.env.PATH ?? '',
  });

  const adminDir = await worktreeAdminDir(worktreePath);

  reportWorkerAccess(
    await applyWorkerAccess(
      [
        scratchHome.path,
        worktreePath,
        // The worker writes an index and a HEAD here in order to commit.
        ...(adminDir === undefined ? [] : [adminDir]),
      ],
      {
        mode: privilege.mode,
        group: worker.group,
        // Emphatically NOT in the granted set. A linked worktree shares the
        // main repository's config, and git config names programs git executes
        // (02-RESEARCH.md § Pitfall 5, T-2-31). Group and world write come OFF
        // it, which is the structural half of that defence and precisely what a
        // dedicated OS user buys.
        protect: [join(spec.mainRepo, '.git', 'config')],
      },
    ),
  );

  return {
    id: spec.featureId,
    root: worktreePath,
    scratchHome: scratchHome.path,

    exec(
      execSpec: ExecSpec,
      log: (chunk: LogChunk) => void,
    ): Promise<ExecResult> {
      // The instance's scratch home, always, as the second argument. The backend
      // never assembles an environment itself — the runner owns that, and is the
      // only caller of the builder, so the boundary has exactly one door.
      //
      // The worker identity travels the same way and for the same reason: no
      // caller of `exec()` is in a position to opt a child out of the privilege
      // drop, because no caller of `exec()` ever sees the seam (WORK-05).
      return run(execSpec, scratchHome.path, log, worker);
    },

    /**
     * Read a file inside the worktree.
     *
     * The guard runs first and unconditionally (D-02). Everything after it is
     * ordinary I/O, and its failures are re-raised as {@link WorkspaceError} so
     * that "the path was refused" and "the file was not there" stay two
     * distinguishable events for the caller — a raw `ENOENT` from `readFile`
     * and a `ContainmentError` would otherwise both arrive as "read failed".
     *
     * The message names the caller's own relative path and the OS error code,
     * never the resolved absolute path: the same reasoning as
     * {@link ContainmentError}'s (T-2-28).
     */
    async read(relPath: string): Promise<string> {
      const absolute = await assertWithinRoot(worktreePath, relPath);
      try {
        return await readFile(absolute, 'utf8');
      } catch (error) {
        throw new WorkspaceError(
          `Cannot read ${JSON.stringify(relPath)} from the workspace: ${codeOf(error) ?? 'unknown error'}.`,
          spec.featureId,
        );
      }
    },

    /**
     * Write a file inside the worktree, creating intermediate directories.
     *
     * The directories are created *after* the guard has passed, so a rejected
     * path never leaves a directory tree behind as a side effect of being
     * refused. They are inside the root by construction: every ancestor of a
     * contained path is itself contained.
     */
    async write(relPath: string, contents: string): Promise<void> {
      const absolute = await assertWithinRoot(worktreePath, relPath);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents, 'utf8');
      } catch (error) {
        throw new WorkspaceError(
          `Cannot write ${JSON.stringify(relPath)} into the workspace: ${codeOf(error) ?? 'unknown error'}.`,
          spec.featureId,
        );
      }
    },

    /**
     * Capture the worktree with `git stash create`.
     *
     * `stash create` is the right primitive because it writes a commit object
     * and **does not touch the working tree, the index, or the stash list** —
     * a snapshot taken before a mutating stage must not perturb the thing it is
     * about to observe. Verified against git 2.49: it prints the new sha on a
     * dirty tree and prints *nothing at all* on a clean one.
     *
     * **Untracked files are a refusal, not a partial capture.** `stash create`
     * has no `--include-untracked`, so a workspace carrying untracked files
     * would yield a handle that silently omits them — and a `restore()` that
     * quietly loses an agent's new source file is worse in every way than a
     * `snapshot()` that declined. The paths are named so the caller can act.
     *
     * Two honest limits, stated because a reader will otherwise assume
     * otherwise:
     *
     * - A clean tree captures `HEAD` instead. There is nothing to stash, and
     *   the commit that IS the current state is the correct capture.
     * - `restore()` puts the captured contents back; it does not delete files
     *   created *after* the capture. Deleting them would mean `git clean`
     *   inside a directory an agent is working in, which is a data-loss
     *   primitive this backend deliberately does not hold.
     */
    async snapshot(): Promise<RestoreHandle> {
      const git = simpleGit(worktreePath);

      const untracked = (await git.raw(['status', '--porcelain']))
        .split('\n')
        .filter((line) => line.startsWith('??'))
        .map((line) => line.slice(3).trim());

      if (untracked.length > 0) {
        throw new WorkspaceError(
          `Cannot snapshot the workspace: git stash cannot capture untracked files, and refusing is better than capturing a partial state. Untracked: ${untracked.join(', ')}.`,
          spec.featureId,
        );
      }

      const created = (await git.raw(['stash', 'create'])).trim();
      const sha =
        created === ''
          ? (await git.raw(['rev-parse', 'HEAD'])).trim()
          : created;

      // Anchor the object before handing out the handle. See
      // SNAPSHOT_REF_PREFIX for why a dangling commit is not good enough.
      const ref = `${SNAPSHOT_REF_PREFIX}${spec.featureId}/${sha}`;
      await git.raw(['update-ref', ref, sha]);

      let released = false;

      return {
        id: sha,

        async restore(): Promise<void> {
          if (released) {
            throw new WorkspaceError(
              `Cannot restore snapshot ${sha}: it has been released. release() is not a hint — it deletes the ref that was keeping the captured commit alive.`,
              spec.featureId,
            );
          }
          // `checkout <commit> -- .` rather than `stash apply`: apply computes
          // a diff and CONFLICTS when the working tree has moved on, which is
          // precisely the situation a restore exists for. Checking the tree out
          // by path overwrites unconditionally, which is what "return to the
          // captured state" means.
          await git.raw(['checkout', sha, '--', '.']);
        },

        async release(): Promise<void> {
          // Idempotent: a caller that restores, releases, and then releases
          // again on a cleanup path is doing nothing wrong.
          if (released) return;
          released = true;
          await git.raw(['update-ref', '-d', ref]);
        },
      };
    },

    /**
     * Reclaim everything this workspace owns: the worktree, its branch, and the
     * scratch home.
     *
     * **This is the primary reclamation path, not a hint (D-14).** The worker
     * calls `destroy()` the moment it sees the feature reach a terminal state,
     * so reclamation is true *continuously* rather than only in the moments
     * after a GC pass. The sweep in `worktree/gc.ts` is the backstop for what a
     * crash skipped (D-15) — it exists because a worker can die between the
     * terminal transition and this call, not because teardown is optional here.
     *
     * Said explicitly because the simplification is tempting and wrong: dropping
     * this call "since the sweep would catch it eventually" turns success
     * criterion 1 from a continuous property into a periodic one, and every
     * window between sweeps accumulates worktrees and `adl/*` branches.
     *
     * The two-step order lives inside {@link destroyWorktree} rather than here,
     * so no call site — this one included — is in a position to get it wrong.
     *
     * **What was reclaimed is reported, not discarded.** `spec.onTeardown`
     * receives one entry per resource. Plan `02-05` left this open: teardown
     * knew whether the scratch home survived and nothing carried the answer out,
     * so a leaked directory was invisible to the operator paying for it.
     */
    async destroy(): Promise<void> {
      // Worktree first, then the scratch home: the worktree teardown is the step
      // that can fail loudly and is worth surfacing, and leaving a temp
      // directory behind is the cheaper of the two leaks.
      await destroyWorktree(spec.mainRepo, worktreePath, branch);
      // Only reachable when the two-step teardown did not throw, so `reclaimed`
      // is a statement about both the worktree and its branch.
      report(spec.onTeardown, {
        workspaceId: spec.featureId,
        resource: 'worktree',
        outcome: 'reclaimed',
      });

      reportScratchHomeTeardown(
        spec.onTeardown,
        spec.featureId,
        await destroyScratchHome(scratchHome.path),
      );
    },
  };
}
