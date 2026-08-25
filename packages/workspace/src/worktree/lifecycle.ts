/**
 * The git worktree lifecycle (WORK-01, WORK-04, D-13).
 *
 * The real `git` binary does the work, so worktree semantics here are exactly
 * git's. That is the reason a pure-JS git implementation is not used: a linked
 * worktree's `.git` is a *file* containing `gitdir: …/.git/worktrees/<name>`,
 * and `isomorphic-git` cannot resolve references through it (CLAUDE.md § What
 * NOT to Use).
 *
 * **The binary is reached through {@link adlGit} and nowhere else.** This module
 * used to hold a `simpleGit(mainRepo)` handle, and 02-REVIEW.md CR-01/CR-02 is
 * what that cost: `git branch --list` and `git worktree add` — the latter fires
 * the `post-checkout` hook — ran against the main repository with no
 * configuration neutralisation and with the daemon's entire environment,
 * credentials included. `adlGit` is the single chokepoint that carries both; see
 * its docblock for why a reminder at each call site was not an acceptable fix.
 *
 * Three properties in this module are load-bearing and none is a style choice:
 *
 * 1. **Teardown is two ordered steps.** `git worktree remove` does not delete
 *    the branch and `git worktree prune` does not either; `git branch -D`
 *    refuses while the worktree exists. Doing only the first leaves an
 *    `adl/*` branch behind for every feature the daemon ever ran.
 * 2. **Each step is independently idempotent.** The GC backstop in `gc.ts`
 *    re-runs teardown over worktrees a crashed worker left half torn down, so
 *    "already gone" must be a no-op rather than an error.
 * 3. **What teardown actually did is returned, not discarded.** `destroy()`
 *    cannot report `reclaimed` honestly without it (WR-04).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { isRepoRelativePath } from '@adl/core/config';
import { WorkspaceError } from '../errors.js';
import { adlGit, type AdlGitOutcome } from '../git/adl-git.js';

/**
 * The branch-name prefix that marks a branch as ADL's own.
 *
 * D-13, and a one-way decision: this prefix is how GC tells its own worktrees
 * apart from a developer's, so changing it later strands every worktree
 * created before the change. Phase 5's reconciliation (DETECT-05) also matches
 * open pull requests back to feature ids through it — this module stays
 * unaware of it, but the "feature id" a real dispatch passes down to
 * {@link branchNameFor} is itself a composed `<folderName>--<ulid>` string
 * (`@adl/manager`'s `branch-identity.ts`), because GC's own sweep
 * (`gc.ts`'s `sweepOrphans`) and DETECT-05's restart reconciliation need
 * different halves of the SAME branch back: GC needs the row's ULID, and
 * DETECT-05 needs the folder name for exactly the case the row is gone and
 * the ULID is the one thing lost with it.
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
 * Everything `git check-ref-format` forbids in a single refname component, plus
 * the glob metacharacters `git branch --list` would otherwise interpret.
 *
 * WR-08. A feature id becomes `adl/<id>` — a ref — either way, so validating it
 * against git's own refname rules is the durable form of this guard rather than
 * a list of characters someone thought of. Reproduced against git 2.49, each
 * alternative below is one of git's documented refusals:
 *
 * - `*?[` and `~^:` — refname metacharacters. `*` is the interesting one: it is
 *   legal in a *directory* name, so `featureId = '*'` passed the old guard, and
 *   `git branch --list 'adl/*'` (below) then matched every existing ADL branch
 *   and refused creation for a reason naming a branch nobody asked about.
 * - `\` and the ASCII control range and DEL — rejected by git, and by the
 *   separator check below for `\`.
 * - a leading `.` or `-`, `..` anywhere, a trailing `.` or `.lock`, and `@{` —
 *   git's refname rules verbatim. A leading `-` is separately why `.` and `-`
 *   are grouped: `featureId = '.'` resolved `worktreePath` to the scratch root
 *   ITSELF, so a teardown would have removed every feature's directory.
 * - whitespace — legal in a directory name, never in a refname.
 */
const REFNAME_UNSAFE = /[*?[\]~^:\\\x00-\x1f\x7f\s]|^[.-]|\.\.|\.lock$|\.$|@\{/;

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
 * *single path segment* has over a relative path, and
 * {@link REFNAME_UNSAFE} is the additional constraint a *git ref* has over
 * both (WR-08).
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

  if (REFNAME_UNSAFE.test(featureId)) {
    throw new WorkspaceError(
      `Feature id ${JSON.stringify(featureId)} is not a usable git refname component: it becomes the branch ${JSON.stringify(branchNameFor(featureId))}, and git rejects (or globs) it. See git check-ref-format.`,
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
  const git = adlGit(mainRepo);

  if (await exists(worktreePath)) {
    throw new WorkspaceError(
      `Refusing to create a worktree for feature ${JSON.stringify(featureId)}: ${worktreePath} already exists. Reclaiming it is the GC sweep's decision, and the sweep asks feature state.`,
      featureId,
    );
  }

  // `branch --list` rather than `rev-parse --verify`: it reports absence as
  // empty output instead of a non-zero exit, so a missing branch — the normal
  // case — does not travel as an exception. `--end-of-options` because the
  // branch name is derived from an untrusted feature id (D-22); the id is
  // separately barred from carrying a glob by `assertUsableFeatureId`, since
  // `branch --list` takes a PATTERN and no terminator makes a pattern literal.
  const existingBranch = await git.rawOk([
    'branch',
    '--list',
    '--end-of-options',
    branch,
  ]);
  if (existingBranch.trim() !== '') {
    throw new WorkspaceError(
      `Refusing to create a worktree for feature ${JSON.stringify(featureId)}: branch ${branch} already exists.`,
      featureId,
    );
  }

  // `--end-of-options` so a `baseRef` beginning with `-` is a revision and not
  // a flag (WR-08). `baseRef` reaches here from `WorkspaceSpec` — configuration
  // or feature metadata, which D-22 records as untrusted — and git accepts
  // `--detach`, `--no-checkout`, `--lock` and `--reason=<x>` in that position.
  // `manager-git.ts` already carries the same guard on `revParse` and
  // `effectiveConfig`; the worktree lifecycle did not get it until WR-08.
  // Verified against git 2.49: with the terminator, `--detach` in the ref slot
  // fails with `fatal: invalid reference: --detach` rather than being obeyed.
  await git.rawOk([
    'worktree',
    'add',
    '-b',
    branch,
    '--end-of-options',
    worktreePath,
    baseRef,
  ]);

  return { worktreePath, branch };
}

/**
 * Re-open the worktree a previous stage created, or report that there is none.
 *
 * The counterpart to {@link createWorktree}, and the reason
 * {@link createWorktree}'s refusal can stay as absolute as it is: "attach to
 * what is already there" is now a *different call*, made deliberately, rather
 * than a clean-up-and-retry decision `createWorktree` would have had to make
 * from the filesystem (WORK-04 forbids exactly that). One worker holds one
 * lease and one lease holds one feature, so the exclusion this function relaxes
 * is enforced a layer up, by the lease, not by hoping the directory is free.
 *
 * **Three answers, and the middle one is the whole point.**
 *
 * - Neither the directory nor the branch exists → `undefined`. Nothing is here;
 *   this is the ordinary round-1-index-0 case and not a failure.
 * - Both exist, and git agrees the directory is a worktree with that branch
 *   checked out → the same {@link CreatedWorktree} `createWorktree` returns.
 * - **Anything else → throws.** A directory with no branch, a branch with no
 *   directory, a path git does not recognise, a worktree sitting on some other
 *   branch: reporting any of those as "nothing here" would send the caller to
 *   `createWorktree`, which would either refuse with a message about the wrong
 *   thing or — in the case git had lost track of the directory — succeed and
 *   silently replace an agent's committed work. The distinction between "there
 *   is nothing here" and "there is something here I will not attach to" is the
 *   one this function exists to make.
 *
 * The last check is asked of the **worktree itself** (`rev-parse --abbrev-ref
 * HEAD` run inside it) rather than of the main repository's inventory, because
 * that is the fact that actually matters: every later `git` the stage runs —
 * `revParse`, `push`, a gate's `diff` — runs in that directory, and a directory
 * git will not answer for is one none of them can use. It also costs one
 * command instead of a porcelain parse, and avoids an import cycle with
 * `list.ts` (which reads {@link featureIdFromBranch} from here).
 */
export async function attachWorktree(
  mainRepo: string,
  scratchRoot: string,
  featureId: string,
): Promise<CreatedWorktree | undefined> {
  assertUsableFeatureId(featureId);

  const worktreePath = join(scratchRoot, featureId);
  const branch = branchNameFor(featureId);

  const onDisk = await exists(worktreePath);
  // The same `branch --list --end-of-options` form and the same reasoning as
  // `createWorktree`'s: absence is empty output rather than a non-zero exit,
  // and the terminator is required because the pattern is derived from an
  // untrusted feature id (D-22).
  const branchListed = await adlGit(mainRepo).rawOk([
    'branch',
    '--list',
    '--end-of-options',
    branch,
  ]);
  const branchExists = branchListed.trim() !== '';

  if (!onDisk && !branchExists) return undefined;

  if (!onDisk || !branchExists) {
    throw new WorkspaceError(
      `Refusing to attach to the workspace for feature ${JSON.stringify(featureId)}: it is half present — ` +
        `${onDisk ? `${worktreePath} exists but branch ${branch} does not` : `branch ${branch} exists but ${worktreePath} does not`}. ` +
        'Reclaiming what is left is the GC sweep’s decision, and the sweep asks feature state.',
      featureId,
    );
  }

  // `symbolic-ref --short`, NOT `rev-parse --abbrev-ref`. Verified against git
  // 2.49 (house convention 15, and this probe earned its keep — the first
  // implementation used `rev-parse` and the contract suite caught it):
  //
  // - `git rev-parse --abbrev-ref --end-of-options HEAD` prints TWO lines,
  //   `--end-of-options` and then the branch. `rev-parse` echoes an argument it
  //   does not recognise instead of honouring the terminator, so the guard this
  //   file applies everywhere else silently corrupts the answer here.
  //   `symbolic-ref` honours it.
  // - `symbolic-ref` exits 128 on a **detached** HEAD, where `rev-parse
  //   --abbrev-ref` prints the string `HEAD` and exits 0. Detached is a
  //   worktree ADL must refuse rather than one it must string-compare its way
  //   out of, so the failure lands on the exit code where it belongs.
  // - It exits 128 on a directory that is not a working tree at all, which is
  //   the other half of what this check is for.
  const head = await adlGit(worktreePath).raw([
    'symbolic-ref',
    '--short',
    '--end-of-options',
    'HEAD',
  ]);
  if (head.exitCode !== 0) {
    throw new WorkspaceError(
      `Refusing to attach to the workspace for feature ${JSON.stringify(featureId)}: ${worktreePath} exists but git will not report a branch checked out in it (detached, or not a working tree): ${head.stderr.trim() || '(no stderr)'}.`,
      featureId,
    );
  }
  if (head.stdout.trim() !== branch) {
    throw new WorkspaceError(
      `Refusing to attach to the workspace for feature ${JSON.stringify(featureId)}: ${worktreePath} has ${JSON.stringify(head.stdout.trim())} checked out, not ${JSON.stringify(branch)}.`,
      featureId,
    );
  }

  return { worktreePath, branch };
}

/**
 * Whether a `git worktree remove` failure means the worktree was already gone.
 *
 * Keyed on git's message rather than on a pre-flight filesystem check, which
 * would race a concurrent sweep between the check and the removal — **and the
 * message is a constant here rather than a setting**, which it was not until
 * WR-08's sibling finding WR-03 was fixed.
 *
 * Git localises its messages through gettext. The old implementation matched
 * `/is not a working tree/i` against a `simple-git` child that inherited the
 * daemon's `LANG`/`LC_ALL` (CR-02), so on a French or Japanese deployment the
 * regex missed, `destroyWorktree` rethrew, and the property this module calls
 * load-bearing at the top — "already gone must be a no-op" — was gone. The GC
 * backstop then reported every already-collected worktree as a permanent
 * failure, on exactly the crash-recovery path it exists for. Every ADL-side git
 * child now runs under `LC_ALL=C` / `LANG=C`, set at the {@link adlGit}
 * chokepoint and asserted in `test/git/adl-git.test.ts`, so this text is git's
 * source string and nothing else.
 *
 * The exit code is checked as well, and that is new too: `simple-git`'s
 * `GitError` carries exactly `task` and `message` and no status, which is why
 * the old code *could* only match prose. Git's own code for this case is 128,
 * and `AdlGitOutcome` now carries it.
 *
 * Note what does *not* need handling here: a worktree whose directory a crash
 * deleted while the administrative entry survived. `worktree remove --force`
 * exits 0 on that and cleans the entry itself (verified against git 2.49).
 */
function isWorktreeAlreadyGone(outcome: AdlGitOutcome): boolean {
  return (
    outcome.exitCode !== 0 && /is not a working tree/i.test(outcome.stderr)
  );
}

/** Whether a `git branch -D` failure means the branch was already deleted. */
function isBranchAlreadyGone(outcome: AdlGitOutcome): boolean {
  return outcome.exitCode !== 0 && /branch .* not found/i.test(outcome.stderr);
}

/** A failed step that was not one of the two idempotent no-ops. */
function gitFailed(what: string, outcome: AdlGitOutcome): WorkspaceError {
  return new WorkspaceError(
    `git ${what} failed with exit code ${String(outcome.exitCode)}: ${outcome.stderr.trim() || '(no stderr)'}`,
  );
}

/**
 * What a teardown actually did to the worktree.
 *
 * WR-04: `destroyWorktree` used to swallow both "already gone" cases and return
 * `void`, so `Workspace.destroy()` could not tell "I removed a worktree" from
 * "there was nothing there" and reported `reclaimed` either way. That is a
 * false statement to the operator on every second teardown — and `teardown.ts`
 * justifies the whole reporting sink on the grounds that "an operator can
 * believe what it says".
 */
export type WorktreeTeardown = 'removed' | 'already-absent';

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
 * Each step swallows only its own "already gone" failure and raises anything
 * else. That per-step idempotency is what lets the GC backstop re-run over a
 * feature whose teardown died between the two steps and still finish the job.
 *
 * The return value describes the **worktree**, not the branch. The two can
 * disagree — the half-torn-down shape is exactly a missing worktree with a
 * surviving branch — and the caller reports one resource, so reporting the more
 * conservative half would say `already-absent` about a teardown that had just
 * deleted a branch.
 */
export async function destroyWorktree(
  mainRepo: string,
  worktreePath: string,
  branch: string,
): Promise<WorktreeTeardown> {
  const git = adlGit(mainRepo);
  let outcome: WorktreeTeardown = 'removed';

  const removed = await git.raw([
    'worktree',
    'remove',
    '--force',
    '--end-of-options',
    worktreePath,
  ]);
  if (removed.exitCode !== 0) {
    if (!isWorktreeAlreadyGone(removed)) {
      throw gitFailed(`worktree remove --force ${worktreePath}`, removed);
    }
    outcome = 'already-absent';
    // The worktree is gone but a stale administrative entry may remain — from
    // a directory deleted out from under git, say. Prune clears it so the
    // inventory in `list.ts` stops reporting a worktree that is not there.
    const pruned = await git.raw(['worktree', 'prune']);
    if (pruned.exitCode !== 0) throw gitFailed('worktree prune', pruned);
  }

  // Only now can the branch go.
  const deleted = await git.raw(['branch', '-D', '--end-of-options', branch]);
  if (deleted.exitCode !== 0 && !isBranchAlreadyGone(deleted)) {
    throw gitFailed(`branch -D ${branch}`, deleted);
  }

  return outcome;
}
