/**
 * `@adl/workspace` — the exec boundary.
 *
 * Every process ADL starts goes through this package (WORK-02). That is enforced
 * by the `adl/no-direct-spawn` lint rule in `eslint.config.js`, whose single
 * exemption is `packages/workspace/**`, rather than by review: a direct spawn
 * reaching the OS process table bypasses the zero-inherit environment, the
 * scratch `HOME`, the privilege drop, and the git-config neutralisation all at
 * once.
 *
 * `@adl/core` declares the {@link Workspace} interface and nothing else; the
 * implementations live here, because core is pure and I/O-free.
 */

// Errors — the workspace layer's own failure type.
export { WorkspaceError } from './errors.js';

// The exec boundary — the only process launch in the repository, and the per-run
// scratch HOME it points every child's `HOME` at (D-07, D-10).
//
// The child-environment builder in `exec/env.ts` is deliberately NOT
// re-exported. It is an implementation detail of `run`, which is its only
// caller; publishing it would invite a second one, and a second place where a
// child environment is assembled is a second door into the boundary this
// package exists to be.
export { run } from './exec/run.js';
export {
  createScratchHome,
  destroyScratchHome,
  type ScratchHome,
} from './exec/scratch-home.js';

// The git worktree lifecycle — one worktree and one adl/<featureId> branch per
// feature, torn down in the order git requires (WORK-01, D-13).
export {
  branchNameFor,
  createWorktree,
  destroyWorktree,
  featureIdFromBranch,
  type CreatedWorktree,
} from './worktree/lifecycle.js';

// Backends — implementations of the Workspace interface @adl/core declares.
export {
  worktreeWorkspace,
  type WorktreeWorkspaceDeps,
} from './worktree/backend.js';
