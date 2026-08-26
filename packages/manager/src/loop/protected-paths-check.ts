/**
 * `checkProtectedPaths` — the database-and-git half of ROLE-11 (M05 step 5.16).
 *
 * `@adl/core/loop`'s `violatedProtectedPaths` is pure and classifies a diff it
 * is handed; it reads no git history and no database. This module is what
 * hands it one: given the round that just committed, find the commit range to
 * diff and run it — entirely inside the manager, never a worker.
 *
 * ## Why this runs in the manager, not as a pipeline stage
 *
 * ROLE-11 has to be unconditional — a maintainer's `adl.yml` that simply
 * forgets to declare a gate does not get to silently drop the one check that
 * exists to catch the developer editing that same file. Making it a pipeline
 * entry `adl.yml` must list would be exactly that shape of gap (and no more
 * subvertible for it: `adl.yml` is itself a protected path, so a round that
 * edited its own pipeline to remove this check would already have been
 * caught by the *other* protection, for the round that tried it — but no v1
 * feature should depend on that chain holding). So this call happens from
 * `round-runner.ts`, unconditionally, for every round whose developer stage
 * reports `committed` — the identical trigger `recordRoundHeadSha` already
 * uses, before `planRoundStep` ever runs.
 *
 * ## Why a diff, not a checkout
 *
 * The manager never touches the feature's own worktree for this. A git
 * worktree shares its parent repository's object database and (for an
 * ordinary branch) its refs, so both commits this module diffs — the base and
 * the round's own head — are already reachable from `mainRepo` alone: no
 * second workspace, no worker round-trip, no new `AssignMessage` field.
 *
 * ## The diff base
 *
 * Round 1 has no prior closed round, so its base is the watched repository's
 * own `default_branch` (`ReposTable.default_branch`) — the same field
 * `dispatcher.ts` reads to compute `AssignMessage.baseRef` for the very same
 * feature, just re-read here rather than threaded through. Every later round
 * diffs against the *previous* round's `head_sha` (`FeaturesRepository
 * .latestClosedRound`, the same method 5.15's send-back brief already reads
 * for an adjacent reason) — this round's own delta, not the feature's whole
 * history, so a repo-wide `default_branch` that has moved on for unrelated
 * reasons can never widen what a round is judged against.
 * `ManagerGitClient.diffNameOnly`'s own docblock explains why one `A...B`
 * expression is correct for both cases without branching on which one this is.
 */
import type { Kysely } from 'kysely';
import {
  featuresRepository,
  reposRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import { violatedProtectedPaths } from '@adl/core/loop';
import type { ManagerGitClient } from '@adl/workspace';

export type ProtectedPathCheckResult =
  /** Nothing this round touched is off-limits. */
  | { readonly kind: 'clean' }
  /** The round's commit touched at least one path it must never touch. */
  | { readonly kind: 'violated'; readonly paths: readonly string[] }
  /**
   * The check itself could not run — a database read or the diff failed.
   * Never "clean": an infrastructure failure that silently passed as "no
   * violation" would be the exact fail-open bug ROLE-11 exists to prevent.
   */
  | { readonly kind: 'error'; readonly detail: string };

export interface CheckProtectedPathsDeps {
  readonly db: Kysely<Database>;
  /** Rooted at `mainRepo` — a host-git workspace's client, never a feature's. */
  readonly git: ManagerGitClient;
}

export interface CheckProtectedPathsParams {
  readonly feature: FeaturesTable;
  /** `EffectiveConfig.protected_paths` — the maintainer-declared glob list, already resolved. */
  readonly protectedGlobs: readonly string[];
  /** The sha this round's developer stage just reported as `committed`. */
  readonly headSha: string;
}

/**
 * Did this round's commit touch a path ROLE-11 protects?
 *
 * Never throws — a failure to even compute the diff is reported as `'error'`
 * so the caller can route it through the same retry path a transient stage
 * failure already takes, rather than either silently passing the round or
 * spending one of its finite rounds on an infrastructure problem (CORE-06).
 */
export async function checkProtectedPaths(
  deps: CheckProtectedPathsDeps,
  params: CheckProtectedPathsParams,
): Promise<ProtectedPathCheckResult> {
  let base: string;
  try {
    const priorRound = await featuresRepository(deps.db).latestClosedRound(
      params.feature.id,
    );
    if (priorRound?.head_sha !== null && priorRound?.head_sha !== undefined) {
      base = priorRound.head_sha;
    } else {
      const repoRow = await reposRepository(deps.db).findById(
        params.feature.repo_id,
      );
      if (repoRow === undefined) {
        return {
          kind: 'error',
          detail: `could not find the repos row ${params.feature.repo_id} — needed as this round's diff base`,
        };
      }
      base = repoRow.default_branch;
    }
  } catch (error) {
    return {
      kind: 'error',
      detail: `could not resolve this round's diff base: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let changedPaths: readonly string[];
  try {
    changedPaths = await deps.git.diffNameOnly(base, params.headSha);
  } catch (error) {
    return {
      kind: 'error',
      detail: `could not diff ${base}...${params.headSha}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const violated = violatedProtectedPaths({
    changedPaths,
    featurePath: params.feature.path,
    protectedGlobs: params.protectedGlobs,
  });

  return violated.length === 0
    ? { kind: 'clean' }
    : { kind: 'violated', paths: violated };
}
