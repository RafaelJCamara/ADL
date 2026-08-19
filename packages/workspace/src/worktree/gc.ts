/**
 * The GC backstop: collect worktrees whose feature is finished or unknown.
 *
 * ===========================================================================
 * WHY THERE IS NO DATABASE IMPORT IN THIS FILE
 * ===========================================================================
 *
 * The state lookup arrives as a **function parameter**, and that is D-20 being
 * enforced rather than described. `@adl/workspace` is the swappable backend
 * layer: v2's container backend and v1's worktree backend implement the same
 * port, and a port that drags a SQLite driver into every implementation is not
 * a port. So this module knows that *something* can answer "what state is
 * feature X in" and knows nothing whatever about where that answer comes from.
 *
 * **What the manager owns, and why none of it is here (D-15, D-20):**
 *
 * - binding `lookupFeatureState` to `featuresRepository.findById`,
 * - running the periodic backstop schedule,
 * - exposing the manual trigger as a CLI verb.
 *
 * All three land in **Phase 3**, because neither a manager process nor a CLI
 * package exists yet. The join itself lives here rather than in the manager so
 * that Phase 2's success criterion — "many features created, then swept, leave
 * no worktree and no `adl/*` branch" — is testable at the end of Phase 2
 * instead of deferred along with the manager. A verifier reading D-20 literally
 * should read this paragraph before concluding the manager is missing work: it
 * never had this part.
 *
 * ===========================================================================
 * WHY FEATURE STATE IS THE ONLY SIGNAL
 * ===========================================================================
 *
 * D-16, and threat T-2-12. Directory mtime, filesystem age, and the presence
 * of a lock file each cannot tell a slow-running feature from an abandoned
 * one — and a wrong collection deletes an agent's uncommitted work. There is
 * deliberately no time input to this module at all: no clock is read, no
 * `maxAge` is accepted, and the only question asked about a worktree is what
 * its feature's state is.
 */
import { TERMINAL_STATES } from '@adl/core/state';
import { destroyScratchHome, listScratchHomes } from '../exec/scratch-home.js';
import {
  branchNameFor,
  destroyWorktree,
  featureIdFromBranch,
} from './lifecycle.js';
import { listManagedWorktrees } from './list.js';

/**
 * Answers "what state is this feature in", or `undefined` if it has never
 * heard of it.
 *
 * `undefined` is meaningful and is **not** an error: a worktree whose feature
 * has no row at all is an orphan by definition — nothing in the system is
 * going to come back for it — and is collected on exactly that basis.
 */
export type FeatureStateLookup = (
  featureId: string,
) => Promise<string | undefined>;

/** One worktree the sweep tried and failed to collect. */
export interface SweepFailure {
  readonly featureId: string;
  readonly worktreePath: string;
  readonly error: unknown;
}

/** Everything {@link sweepOrphans} needs. Note what is absent: a clock. */
export interface GcDeps {
  /** The repository whose linked worktrees are being swept. */
  readonly mainRepo: string;
  /** The source of truth for whether a feature is finished (D-16). */
  readonly lookupFeatureState: FeatureStateLookup;
  /**
   * Called once per worktree the sweep could not collect.
   *
   * Failures are reported rather than thrown because the pass continues past
   * them — see {@link sweepOrphans}. A caller that wants to log or alert binds
   * this; one that does not still gets a complete sweep.
   */
  readonly onFailure?: (failure: SweepFailure) => void;
}

/**
 * Collect every ADL worktree whose feature is terminal or unknown.
 *
 * Returns the feature ids actually removed, in inventory order.
 *
 * **`escalated` survives, automatically.** The terminal set is the frozen
 * `TERMINAL_STATES` value imported from `@adl/core/state`, not a list
 * transcribed into this file. That is deliberate: `escalated` is excluded from
 * `TERMINAL_STATES` because the lifecycle diagram draws a human-retry edge out
 * of it, and a human is going to look at that worktree. Importing the constant
 * means the exclusion holds without this module knowing why, and keeps holding
 * when Phase 3 extends the state machine. A transcribed list would be correct
 * today and silently wrong after the first edit somewhere else.
 *
 * **The pass continues past a per-entry failure.** A worktree that will not
 * die — an agent holding a file open, a permission problem — must not strand
 * every orphan after it in the inventory; that is threat T-2-13, and a sweep
 * that aborts on the first stuck entry is a sweep that stops working the first
 * time it is needed most.
 *
 * **Safe to run concurrently with itself and with worker teardown.** An entry
 * another pass already collected takes `destroyWorktree`'s "already gone"
 * no-op path rather than erroring, so a scheduled sweep overlapping a manual
 * one produces a smaller removal list, not a failure.
 */
export async function sweepOrphans(deps: GcDeps): Promise<readonly string[]> {
  const terminal = new Set<string>(TERMINAL_STATES);
  const removed: string[] = [];

  for (const entry of await listManagedWorktrees(deps.mainRepo)) {
    // The inventory is already scoped to ADL's branches; this re-derives the
    // id rather than trusting the path, because the branch is authoritative
    // and a directory can be renamed.
    const featureId = featureIdFromBranch(entry.branch);
    if (featureId === undefined) continue;

    try {
      const state = await deps.lookupFeatureState(featureId);

      // Known and still live — leave it completely alone. This is the branch
      // that spares `escalated`, `paused`, and everything mid-flight.
      if (state !== undefined && !terminal.has(state)) continue;

      // destroyWorktree, not a local remove-then-delete: the two-step order
      // and the per-step idempotency are properties of that function, and
      // reimplementing them here is how one of the two halves gets forgotten.
      await destroyWorktree(
        deps.mainRepo,
        entry.path,
        branchNameFor(featureId),
      );
      removed.push(featureId);
    } catch (error) {
      deps.onFailure?.({ featureId, worktreePath: entry.path, error });
    }
  }

  return removed;
}

// ===========================================================================
// The second half of the backstop: scratch HOMEs (WR-06)
// ===========================================================================

/** One scratch home the sweep looked at and did not collect. */
export interface ScratchHomeSweepFailure {
  readonly path: string;
  /** Why, in an operator's words. Never a value from a child's environment. */
  readonly reason: string;
  /** Present when a thrown error was the cause. */
  readonly error?: unknown;
}

/**
 * Everything {@link sweepScratchHomes} needs. Note what is absent, again: a
 * clock.
 */
export interface ScratchHomeGcDeps {
  /**
   * Whether the process that created a home is still running.
   *
   * Injectable because the alternative — a test that forks a real process and
   * kills it — measures the operating system rather than this policy, and
   * because a pid probe is the one thing here that cannot be staged
   * deterministically. The default is
   * {@link processIsAlive}.
   */
  readonly isProcessAlive?: (pid: number) => boolean;
  /**
   * Called once per home the sweep did not collect, for a reason worth saying.
   *
   * The same contract `GcDeps.onFailure` has and for the same reason: a sweep
   * that throws is a sweep that stops, and a sweep that swallows is a leak
   * nobody can see. A skipped-because-live home is NOT reported here — that is
   * the sweep working, not failing.
   */
  readonly onFailure?: (failure: ScratchHomeSweepFailure) => void;
}

/**
 * Is there a process with this pid?
 *
 * `process.kill(pid, 0)` performs the permission and existence checks and
 * delivers nothing. Three outcomes, and the mapping of the third is the
 * load-bearing one:
 *
 * - it returns          → the process exists and is ours   → **alive**
 * - `ESRCH`             → no such process                  → **dead**
 * - `EPERM`             → it exists, and belongs to someone else → **alive**
 *
 * Treating `EPERM` as alive is the fail-safe direction, and so is the residual
 * risk of pid reuse: a recycled pid makes a genuinely orphaned home look live,
 * which leaks a directory. The opposite error — a live home judged dead — would
 * delete a running agent's `HOME` mid-round, and it cannot happen, because a
 * live process's pid is never absent from the process table.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return code !== 'ESRCH';
  }
}

/**
 * Collect every scratch `HOME` whose creating process is gone.
 *
 * Returns the paths actually removed.
 *
 * **Why this exists at all.** `Workspace.destroy()` was the only thing that ever
 * removed a scratch `HOME`, so a worker that died between `createScratchHome()`
 * and `destroy()` — the precise crash D-15 says the backstop exists for — leaked
 * one permanently. `sweepOrphans` could not help: it iterates
 * `listManagedWorktrees`, and a scratch home has no worktree entry to iterate.
 * On a long-running daemon that accumulates without bound, and on Linux each
 * leaked directory is group-owned by the shared worker group, so its contents —
 * a `.gitconfig` credential helper, an `.npmrc` token, an agent CLI's session
 * file — outlive the run that wrote them, which is the one thing D-07 promises
 * cannot happen.
 *
 * **Why the signal is process liveness and not age.** Same shape as D-16: a
 * clock cannot tell a slow feature from an abandoned one, and a wrong collection
 * here deletes the `HOME` of a *running* agent mid-round. "The process that
 * created this is no longer in the process table" is not an approximation of
 * that question, it is the question. See {@link processIsAlive} for which way
 * each ambiguous answer is resolved.
 *
 * **A home with no owner marker is left alone**, and is reported. It was created
 * by an older ADL, or by a failed marker write, or by something that is not ADL;
 * "I do not know who owns this" is not grounds for deleting it. That is the
 * opposite of `sweepOrphans`' treatment of an unknown *feature*, deliberately:
 * there, the absence of a database row proves nothing is coming back for the
 * worktree; here, absence proves nothing at all.
 *
 * **Failures are reported, never thrown**, and the pass continues past them —
 * `GcDeps.onFailure`'s contract, for `GcDeps.onFailure`'s reason (T-2-13).
 */
export async function sweepScratchHomes(
  deps: ScratchHomeGcDeps = {},
): Promise<readonly string[]> {
  const alive = deps.isProcessAlive ?? processIsAlive;
  const removed: string[] = [];

  let inventory;
  try {
    inventory = await listScratchHomes();
  } catch (error) {
    // The inventory itself failing is one event, not one per home, and it must
    // not throw out of a scheduled backstop.
    deps.onFailure?.({
      path: 'the scratch-home root',
      reason: 'the scratch-home inventory could not be read',
      error,
    });
    return removed;
  }

  for (const entry of inventory) {
    try {
      if (entry.owner === undefined) {
        deps.onFailure?.({
          path: entry.path,
          reason:
            'no readable owner marker beside this home, so there is nothing to prove it is collectable; left alone deliberately',
        });
        continue;
      }

      // Live — leave it completely alone. This is the branch that spares every
      // running feature, including this process's own homes.
      if (alive(entry.owner.pid)) continue;

      // destroyScratchHome, not a local `rm`: the retry loop, the
      // already-absent semantics and the never-throws contract are properties
      // of that function, and a second implementation is how one of them gets
      // forgotten.
      const teardown = await destroyScratchHome(entry.path);
      if (teardown.outcome === 'not-removed') {
        deps.onFailure?.({ path: entry.path, reason: teardown.reason });
        continue;
      }
      // `already-absent` counts as collected: a concurrent sweep or a late
      // `destroy()` got there first, and reporting that as a failure would make
      // overlapping passes look broken.
      removed.push(entry.path);
    } catch (error) {
      deps.onFailure?.({
        path: entry.path,
        reason: 'the sweep could not decide or collect this home',
        error,
      });
    }
  }

  return removed;
}
