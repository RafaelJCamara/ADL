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
import { createWorktree, destroyWorktree } from './lifecycle.js';

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

    // read/write/snapshot are declared and not yet implemented. Plan `02-06`
    // owns them along with the D-02 containment guard they need, and filling
    // them in requires no change to anything above: the exec and lifecycle path
    // is real, and these are additions to it rather than a redesign of it.
    //
    // The parameters are omitted rather than named with a leading underscore: a
    // method may declare fewer parameters than the interface it satisfies, and
    // an unused named parameter would need a lint exception that would then also
    // apply to the real implementation.
    read(): Promise<string> {
      return Promise.reject(
        new WorkspaceError(
          'Workspace.read is implemented in plan 02-06, together with the D-02 containment guard.',
          deps.featureId,
        ),
      );
    },

    write(): Promise<void> {
      return Promise.reject(
        new WorkspaceError(
          'Workspace.write is implemented in plan 02-06, together with the D-02 containment guard.',
          deps.featureId,
        ),
      );
    },

    snapshot(): Promise<RestoreHandle> {
      return Promise.reject(
        new WorkspaceError(
          'Workspace.snapshot is implemented in plan 02-06.',
          deps.featureId,
        ),
      );
    },

    async destroy(): Promise<void> {
      // Worktree first, then the scratch home: the worktree teardown is the step
      // that can fail loudly and is worth surfacing, and leaving a temp
      // directory behind is the cheaper of the two leaks.
      await destroyWorktree(deps.mainRepo, worktreePath, branch);
      await destroyScratchHome(scratchHome.path);
    },
  };
}
