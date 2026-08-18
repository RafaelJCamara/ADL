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
import { dirname } from 'node:path';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  RestoreHandle,
  Workspace,
} from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';
import { run } from '../exec/run.js';
import { createScratchHome, destroyScratchHome } from '../exec/scratch-home.js';
import { assertWithinRoot } from '../paths.js';
import { createWorktree, destroyWorktree } from './lifecycle.js';

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** What the worktree backend needs in order to stand a workspace up. */
export interface WorktreeWorkspaceDeps {
  /** The repository ADL is running against. Worktrees are linked to this one. */
  readonly mainRepo: string;
  /** Directory the feature worktrees are created under. Must already exist. */
  readonly scratchRoot: string;
  /** The feature this workspace belongs to; also the workspace id and the directory name. */
  readonly featureId: string;
  /** The commit-ish the feature branches from. */
  readonly baseRef: string;
}

export async function worktreeWorkspace(
  deps: WorktreeWorkspaceDeps,
): Promise<Workspace> {
  const { worktreePath, branch } = await createWorktree(
    deps.mainRepo,
    deps.scratchRoot,
    deps.featureId,
    deps.baseRef,
  );
  const scratchHome = await createScratchHome();

  return {
    id: deps.featureId,
    root: worktreePath,
    scratchHome: scratchHome.path,

    exec(spec: ExecSpec, log: (chunk: LogChunk) => void): Promise<ExecResult> {
      // The instance's scratch home, always, as the second argument. The backend
      // never assembles an environment itself — the runner owns that, and is the
      // only caller of the builder, so the boundary has exactly one door.
      return run(spec, scratchHome.path, log);
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
          deps.featureId,
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
          deps.featureId,
        );
      }
    },

    // snapshot is declared and not yet implemented — the rest of plan `02-06`
    // owns it. The parameter list is empty rather than carrying underscore-
    // prefixed names: a method may declare fewer parameters than the interface
    // it satisfies, and an unused named parameter would need a lint exception
    // that would then also apply to the real implementation.
    snapshot(): Promise<RestoreHandle> {
      return Promise.reject(
        new WorkspaceError(
          'Workspace.snapshot is implemented in plan 02-06.',
          deps.featureId,
        ),
      );
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
     */
    async destroy(): Promise<void> {
      // Worktree first, then the scratch home: the worktree teardown is the step
      // that can fail loudly and is worth surfacing, and leaving a temp
      // directory behind is the cheaper of the two leaks.
      await destroyWorktree(deps.mainRepo, worktreePath, branch);
      await destroyScratchHome(scratchHome.path);
    },
  };
}
