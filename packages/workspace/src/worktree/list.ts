/**
 * The disk inventory: what worktrees git currently knows about (D-20).
 *
 * Split the way `@adl/core`'s other foreign-format readers are split — a pure
 * parser that takes the already-captured text, plus a thin caller that does the
 * I/O. `parseWorktreeList` is therefore unit-testable against literal strings
 * with no git binary in the loop, which is the same reason the `adl.yml` and
 * spec loaders take file *contents* rather than a path (`eslint.config.js`
 * line 45).
 */
import { simpleGit } from 'simple-git';
import { featureIdFromBranch } from './lifecycle.js';

/**
 * One record of `git worktree list --porcelain`.
 *
 * Readonly, and every field is exactly what git reported — nothing here is
 * normalised, resolved, or defaulted. A consumer that wants a feature id calls
 * {@link featureIdFromBranch} on {@link WorktreeEntry.branch}.
 */
export interface WorktreeEntry {
  /** The worktree's path, as git reports it (already resolved). */
  readonly path: string;
  /** The full ref, e.g. `refs/heads/adl/feat-1`. Absent when detached. */
  readonly branch?: string;
  /**
   * Git's own reason string, present when git already considers the entry
   * orphaned — e.g. `gitdir file points to non-existent location`.
   *
   * A free orphan signal, and deliberately *not* the collection decision:
   * D-16 makes feature state the only thing that authorises destroying a
   * directory. This field is carried so a caller can report it, not act on it.
   */
  readonly prunable?: string;
}

/**
 * Parse the output of `git worktree list --porcelain -z`.
 *
 * Pure: no I/O, no git binary, no clock. The argument is the captured stdout.
 *
 * **The porcelain format, never the human-readable one.** Git documents the
 * porcelain output as stable across versions and independent of the user's
 * configuration, and documents `-z` as the form to use for scripting; it makes
 * no such promise about the default output, whose column layout shifts with
 * path lengths and which a user's config can change. Parsing the human format
 * would be a bug that appears on someone else's machine, months later, in a
 * repository nobody here can see.
 *
 * The shape (verified against git 2.49): each attribute is a `label value`
 * line — or a bare `label`, as `detached` and `bare` are — terminated by NUL,
 * and records are separated by an additional empty line, i.e. a second NUL.
 */
export function parseWorktreeList(
  porcelainZ: string,
): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];

  // A record begins at every `worktree` label and ends at the next one. Reading
  // it that way rather than by splitting on the record separator means a
  // trailing separator, a doubled one, or none at all all parse identically.
  let current: { path: string; branch?: string; prunable?: string } | undefined;

  const flush = (): void => {
    if (current !== undefined) entries.push(current);
    current = undefined;
  };

  for (const line of porcelainZ.split('\0')) {
    if (line === '') continue;

    const separator = line.indexOf(' ');
    const label = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);

    switch (label) {
      case 'worktree':
        flush();
        current = { path: value };
        break;
      case 'branch':
        if (current !== undefined) current.branch = value;
        break;
      case 'prunable':
        if (current !== undefined) current.prunable = value;
        break;
      default:
        // `HEAD`, `detached`, `bare`, `locked`, and whatever git adds next.
        // Ignored rather than rejected: the format grows by adding labels, and
        // a parser that throws on an unknown one breaks on a git upgrade.
        break;
    }
  }

  flush();
  return entries;
}

/**
 * The worktrees ADL owns, in the repository at `mainRepo`.
 *
 * This is D-20's named mechanism. It is the *inventory* half and nothing more:
 * it reports what exists, and says nothing about what should be collected.
 * The policy half — joining this against feature state — is `sweepOrphans`.
 *
 * A worktree whose branch is not an `adl/` branch is left out of the result
 * entirely rather than included and skipped later. A human's own worktree in
 * the same repository is not ADL's to inventory, and an inventory that carries
 * it invites a future caller to iterate the list without re-checking.
 *
 * **Order is a contract.** Entries come back in the order git emitted them:
 * not sorted, not deduplicated, not reordered to put `prunable` entries first.
 * The sweep iterates this list, and a caller comparing two inventories to see
 * what changed needs the comparison to be stable rather than incidentally so.
 */
export async function listManagedWorktrees(
  mainRepo: string,
): Promise<readonly WorktreeEntry[]> {
  const porcelainZ = await simpleGit(mainRepo).raw([
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);

  return parseWorktreeList(porcelainZ).filter(
    (entry) => featureIdFromBranch(entry.branch) !== undefined,
  );
}
