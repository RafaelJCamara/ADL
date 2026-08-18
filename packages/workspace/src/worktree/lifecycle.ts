/**
 * The git worktree lifecycle (WORK-01, WORK-04, D-13).
 *
 * `simple-git` shells out to the real `git` binary, so worktree semantics here
 * are exactly git's. That is the reason it is used rather than a pure-JS git
 * implementation: a linked worktree's `.git` is a *file* containing
 * `gitdir: …/.git/worktrees/<name>`, and `isomorphic-git` cannot resolve
 * references through it (CLAUDE.md § What NOT to Use).
 *
 * Two properties in this module are load-bearing and neither is a style choice:
 *
 * 1. **Teardown is two ordered steps.** `git worktree remove` does not delete
 *    the branch and `git worktree prune` does not either; `git branch -D`
 *    refuses while the worktree exists. Doing only the first leaves an
 *    `adl/*` branch behind for every feature the daemon ever ran.
 * 2. **Each step is independently idempotent.** The GC backstop in `gc.ts`
 *    re-runs teardown over worktrees a crashed worker left half torn down, so
 *    "already gone" must be a no-op rather than an error.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { isRepoRelativePath } from '@adl/core/config';
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
import { WorkspaceError } from '../errors.js';

/**
 * The branch-name prefix that marks a branch as ADL's own.
 *
 * D-13, and a one-way decision: this prefix is how GC tells its own worktrees
 * apart from a developer's, so changing it later strands every worktree
 * created before the change. Phase 5's reconciliation (DETECT-05) also matches
 * open pull requests back to feature ids through it.
 */
const BRANCH_PREFIX = 'adl/';

/** The same prefix as git reports it in `worktree list --porcelain`. */
const REF_PREFIX = `refs/heads/${BRANCH_PREFIX}`;

/**
 * The branch a feature's work lives on.
 *
 * D-13. See {@link BRANCH_PREFIX} for why the prefix is not negotiable.
 */
export function branchNameFor(featureId: string): string {
  return `${BRANCH_PREFIX}${featureId}`;
}

/**
 * The feature id behind a branch ref, or `undefined` if the ref is not ADL's.
 *
 * Accepts either the full ref git reports (`refs/heads/adl/<id>`) or the short
 * name (`adl/<id>`), because the porcelain inventory carries the former and
 * `branch --list` the latter.
 *
 * **The prefix is matched exactly and the remainder is taken whole.** That is
 * the entire point of this function: a `startsWith('adl/feat-1')` test would
 * map `adl/feat-1-evil` to `feat-1`, and the sweep would then destroy one
 * feature's worktree while reporting it had collected another (T-2-14). A
 * feature id is whatever follows the prefix, separators and all — this
 * function never re-splits it.
 */
export function featureIdFromBranch(
  ref: string | undefined,
): string | undefined {
  if (ref === undefined) return undefined;

  const remainder = ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : ref.startsWith(BRANCH_PREFIX)
      ? ref.slice(BRANCH_PREFIX.length)
      : undefined;

  // An empty remainder means the ref *is* the bare prefix, which is not a
  // feature. Returning '' would make the sweep look up a feature with no id.
  return remainder === undefined || remainder === '' ? undefined : remainder;
}

/** Where a feature's worktree lives, and what branch is checked out in it. */
export interface CreatedWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Reject a feature id that must never reach the filesystem or a branch name.
 *
 * A feature id originates in a directory name under the watched repository's
 * `/features`, which D-22 records as untrusted input: anyone who can push can
 * choose it. Here it becomes both a path segment under the scratch root and a
 * git ref, so the guard runs *before* git is touched at all.
 *
 * `isRepoRelativePath` from `@adl/core/config` is reused rather than
 * reimplemented — a second path guard is a second thing to keep correct, and
 * the two would drift. It contributes the `..`-segment, drive-letter, UNC and
 * NUL rejections; the separator check below is the additional constraint a
 * *single path segment* has over a relative path.
 */
function assertUsableFeatureId(featureId: string): void {
  if (featureId.trim() === '') {
    throw new WorkspaceError(
      `Feature id ${JSON.stringify(featureId)} is empty or whitespace-only; a feature id becomes a directory name and a branch name, and neither can be blank.`,
      featureId,
    );
  }

  if (/[/\\\0]/.test(featureId)) {
    throw new WorkspaceError(
      `Feature id ${JSON.stringify(featureId)} contains a path separator or a NUL byte; a feature id is one directory name under the scratch root, not a path.`,
      featureId,
    );
  }

  if (!isRepoRelativePath(featureId)) {
    throw new WorkspaceError(
      `Feature id ${JSON.stringify(featureId)} is not a usable repo-relative path segment.`,
      featureId,
    );
  }
}

/** Whether `path` exists, without distinguishing why it does not. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the feature's worktree at `<scratchRoot>/<featureId>` on a new branch.
 *
 * There is no `.worktree()` helper on `simple-git` — `raw` with the argv is the
 * supported form (CLAUDE.md § Git, forge, and workspace).
 *
 * **A live feature is never reused or clobbered.** If the target directory or
 * the `adl/` branch already exists this throws, rather than attaching to what
 * is there. A second worker sharing one worktree with a running agent is a
 * data-loss path, not a convenience, and "clean up and retry" would be a
 * reclamation decision made from the filesystem — exactly the signal WORK-04
 * forbids. Reclaiming a stale worktree is the sweep's job, and the sweep asks
 * feature state.
 */
export async function createWorktree(
  mainRepo: string,
  scratchRoot: string,
  featureId: string,
  baseRef: string,
): Promise<CreatedWorktree> {
  assertUsableFeatureId(featureId);

  const worktreePath = join(scratchRoot, featureId);
  const branch = branchNameFor(featureId);
  const git = simpleGit(mainRepo);

  if (await exists(worktreePath)) {
    throw new WorkspaceError(
      `Refusing to create a worktree for feature ${JSON.stringify(featureId)}: ${worktreePath} already exists. Reclaiming it is the GC sweep's decision, and the sweep asks feature state.`,
      featureId,
    );
  }

  // `branch --list` rather than `rev-parse --verify`: it reports absence as
  // empty output instead of a non-zero exit, so a missing branch — the normal
  // case — does not travel as an exception.
  const existingBranch = await git.raw(['branch', '--list', branch]);
  if (existingBranch.trim() !== '') {
    throw new WorkspaceError(
      `Refusing to create a worktree for feature ${JSON.stringify(featureId)}: branch ${branch} already exists.`,
      featureId,
    );
  }

  await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseRef]);

  return { worktreePath, branch };
}

/**
 * Whether a `git worktree remove` failure means the worktree was already gone.
 *
 * Keyed on git's message rather than on a pre-flight filesystem check, which
 * would race a concurrent sweep between the check and the removal.
 *
 * It is keyed on the message *only*, and not also on an exit status, because
 * `simple-git@3.36.0`'s `GitError` carries exactly two own properties — `task`
 * and `message` — and no exit code at all (verified against the installed
 * package: `e.exitCode`, `e.code` and `e.status` are all `undefined` for a
 * failed `raw`). Git's own exit code for this case is 128, but it never
 * reaches us.
 *
 * Note what does *not* need handling here: a worktree whose directory a crash
 * deleted while the administrative entry survived. `worktree remove --force`
 * exits 0 on that and cleans the entry itself (verified against git 2.49).
 */
function isWorktreeAlreadyGone(error: unknown): boolean {
  return error instanceof Error && /is not a working tree/i.test(error.message);
}

/** Whether a `git branch -D` failure means the branch was already deleted. */
function isBranchAlreadyGone(error: unknown): boolean {
  return error instanceof Error && /branch .* not found/i.test(error.message);
}

/**
 * Remove the worktree and then delete its branch — in that order, always, and
 * safely more than once.
 *
 * The order is not a style preference. `git branch -D` fails with "cannot
 * delete branch 'X' used by worktree at …" while the worktree exists, and
 * `git worktree remove` does **not** delete the branch. Doing only the first
 * satisfies "no worktree" and silently leaves the branch behind, which is
 * exactly half of this phase's success criterion. Both behaviours were
 * reproduced against git 2.49 (02-RESEARCH.md § Pattern 1), and plan `02-03`
 * reproduced the half-satisfied assertion against this repository's own test.
 *
 * `--force` is unconditional. A feature at a terminal state has nothing left
 * worth preserving — its work is on the branch and pushed by then — and making
 * the flag conditional on a cleanliness probe would race whatever process the
 * agent leaked (T-2-13).
 *
 * Each step swallows only its own "already gone" failure and rethrows anything
 * else. That per-step idempotency is what lets the GC backstop re-run over a
 * feature whose teardown died between the two steps and still finish the job.
 */
export async function destroyWorktree(
  mainRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(mainRepo);

  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    if (!isWorktreeAlreadyGone(error)) throw error;
    // The worktree is gone but a stale administrative entry may remain — from
    // a directory deleted out from under git, say. Prune clears it so the
    // inventory in `list.ts` stops reporting a worktree that is not there.
    await git.raw(['worktree', 'prune']);
  }

  // Only now can the branch go.
  try {
    await git.raw(['branch', '-D', branch]);
  } catch (error) {
    if (!isBranchAlreadyGone(error)) throw error;
  }
}
