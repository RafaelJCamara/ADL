/**
 * `listFeatureFolders` — the I/O half of the M05 detection scanner
 * (DETECT-01, step 5.1).
 *
 * `@adl/core/detect`'s `scanFeatureFolders` is pure: given a path list, it
 * decides which are feature folders. This module supplies that path list by
 * reading the ONE state DETECT-01 requires — the default branch's committed
 * tree, through `ManagerGitClient.listFiles` — never a worktree, never an
 * agent's own checkout, and never anything the manager remembers from a
 * prior scan. Re-running this function twice in a row against an unchanged
 * repository returns the identical answer, which is the whole of "evaluate
 * repository state, not remembered events".
 *
 * Cross-referencing the result against the `features` table and open change
 * requests (the *undeveloped* predicate, DETECT-01's other half) is 5.2's
 * job, deliberately not this module's — a scanner that also decided what to
 * do about what it found would need a database connection to be tested at
 * all, where this needs only a `ManagerGitClient`.
 */
import { scanFeatureFolders } from '@adl/core/detect';
import type { ManagerGitClient } from '@adl/workspace';

/**
 * Every feature folder that exists in `defaultBranch`'s committed tree,
 * under `featuresDir`, sorted and deduplicated.
 */
export async function listFeatureFolders(
  git: ManagerGitClient,
  defaultBranch: string,
  featuresDir: string,
): Promise<readonly string[]> {
  const paths = await git.listFiles(defaultBranch, featuresDir);
  return scanFeatureFolders(paths, featuresDir);
}
