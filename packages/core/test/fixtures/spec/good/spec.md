# Feature Branch Cleanup

## Intent

When ADL finishes a feature — merged, closed, or abandoned — the git worktree
it created is still on disk holding a full checkout. Nobody notices until the
disk fills, which happens on the machine running the daemon rather than on
anyone's laptop.

## Acceptance Criteria

- A worktree whose feature reached a terminal state is removed within one
  garbage-collection pass.
- Garbage collection never removes a worktree belonging to a feature that is
  still running, even if the lease is expired.
  - An expired lease means the worker died, not that the feature is finished.
  - Recovery re-attaches to the existing worktree, so removing it would turn a
    recoverable crash into a lost round.
- `adl gc --dry-run` prints exactly what would be removed and removes nothing.

## Non-Goals

- Reclaiming space inside the git object store.
- Any scheduling policy beyond "run on daemon startup and every hour".

## Constraints

- Removal goes through `git worktree remove`, never `rm -rf`, so git's own
  bookkeeping stays consistent.

## Context Files

- docs/workspace-lifecycle.md — the state machine the terminal states come from
- src/workspace/worktree.ts
