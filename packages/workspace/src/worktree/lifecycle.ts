/**
 * The git worktree lifecycle (WORK-01, D-13).
 *
 * `simple-git` shells out to the real `git` binary, so worktree semantics here
 * are exactly git's. That is the reason it is used rather than a pure-JS git
 * implementation: a linked worktree's `.git` is a *file* containing
 * `gitdir: …/.git/worktrees/<name>`, and `isomorphic-git` cannot resolve
 * references through it (CLAUDE.md § What NOT to Use).
 *
 * Scope note: full idempotency (teardown of an already-gone worktree) and the
 * `git worktree prune` fallback land in plan `02-04`, which owns the GC backstop.
 * This module ships the create/destroy pair the loop needs.
 */
import { join } from 'node:path';
// Named import, NOT the default import CLAUDE.md's ESM/CJS row suggests for CJS
// packages. `simple-git@3.36.0` ships a real ESM build (`exports.import` ->
// `dist/esm/index.js`) alongside the CJS one, but its `.d.ts` is classified as
// CommonJS by `nodenext` (no `"type"` in its package.json). With
// `esModuleInterop` off — which this repo's `tsconfig.base.json` leaves off —
// a default import of a CJS-classified module yields the module NAMESPACE, and
// `simpleGit(repo)` then fails to typecheck with "has no call signatures".
// `simpleGit` is a genuine named export of the same module, so this form is
// correct at both the type level and runtime.
import { simpleGit } from 'simple-git';

/**
 * The branch a feature's work lives on.
 *
 * D-13, and a one-way decision: the `adl/` prefix is how GC tells its own
 * worktrees apart from a developer's, so changing it later strands every
 * worktree created before the change.
 */
export function branchNameFor(featureId: string): string {
  return `adl/${featureId}`;
}

/** Where a feature's worktree lives, and what branch is checked out in it. */
export interface CreatedWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Create the feature's worktree at `<scratchRoot>/<featureId>` on a new branch.
 *
 * There is no `.worktree()` helper on `simple-git` — `raw` with the argv is the
 * supported form (CLAUDE.md § Git, forge, and workspace).
 */
export async function createWorktree(
  mainRepo: string,
  scratchRoot: string,
  featureId: string,
  baseRef: string,
): Promise<CreatedWorktree> {
  const worktreePath = join(scratchRoot, featureId);
  const branch = branchNameFor(featureId);

  await simpleGit(mainRepo).raw([
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    baseRef,
  ]);

  return { worktreePath, branch };
}

/**
 * Remove the worktree and then delete its branch — in that order, always.
 *
 * The order is not a style preference. `git branch -D` fails with "cannot delete
 * branch 'X' used by worktree at …" while the worktree exists, and
 * `git worktree remove` does **not** delete the branch. Doing only the first
 * satisfies "no worktree" and silently leaves the branch behind, which is
 * exactly half of this phase's success criterion. Both behaviours were
 * reproduced against git 2.49 (02-RESEARCH.md § Pattern 1).
 *
 * `--force` is unconditional. A feature at a terminal state has nothing left
 * worth preserving — its work is on the branch and pushed by then — and making
 * the flag conditional on a cleanliness probe would race whatever process the
 * agent leaked.
 */
export async function destroyWorktree(
  mainRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(mainRepo);

  await git.raw(['worktree', 'remove', '--force', worktreePath]);
  await git.raw(['branch', '-D', branch]);
}
