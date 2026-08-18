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
