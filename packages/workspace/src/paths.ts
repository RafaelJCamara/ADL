/**
 * The D-02 containment guard: a path a stage names is inside the workspace
 * root, or it does not exist as far as the interface is concerned.
 *
 * D-02 says paths outside the feature's worktree are "rejected at the
 * interface, not by convention", which mirrors D-27's make-the-wrong-thing-
 * unrepresentable philosophy. Concretely that means `Workspace.read` and
 * `Workspace.write` call this *before* they touch the filesystem, and every
 * backend calls the same one — a per-backend variant would have to be argued to
 * be equivalent instead of observed to be.
 *
 * **Scope is the worktree root and nothing else.** The scratch `HOME` is
 * reached by children through their environment at exec time (D-07) and is not
 * addressable here; widening this to "anything under the scratch root" is the
 * anti-pattern `02-RESEARCH.md § Anti-Patterns` names by hand.
 *
 * Four rejections, in this order, because each one only makes sense once the
 * previous has passed:
 *
 * 1. **The string is not a usable relative path.** Delegated wholesale to
 *    `isRepoRelativePath` from `@adl/core/config` — absolute paths, `..`
 *    *segments*, drive-letter and UNC prefixes, NUL bytes, and the empty
 *    string. Reusing Phase 1's guard is required rather than preferred: a
 *    second implementation drifts from the first, and that schema is already
 *    what `FindingLocation.path` and the feature-id guard adopt. Its own
 *    docblock says whether a path *exists* is "Phase 2's question" — this
 *    module is that answer.
 * 2. **It resolves to the root itself.** Reading or writing a directory is not
 *    a legitimate call; succeeding quietly would turn a caller's bug into a
 *    confusing EISDIR three frames away, or into a truncation.
 * 3. **It resolves outside the root, lexically.** With a *separator guard*, not
 *    a bare prefix test: `/scratch/feat-1-evil` starts with `/scratch/feat-1`
 *    (T-2-25, `§ Pitfall 12`).
 * 4. **It resolves outside the root once symlinks are followed.** See
 *    {@link assertWithinRoot} for why the walk is written the way it is.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isRepoRelativePath } from '@adl/core/config';
import { ContainmentError, WorkspaceError } from './errors.js';

/**
 * Windows filesystems are case-insensitive, POSIX ones are not.
 *
 * A case-sensitive comparison on Windows rejects `C:\Temp\x` against a root of
 * `C:\temp` — two spellings of one directory — and a case-insensitive one on
 * Linux would accept `/root/Secret` for a root of `/root/secret`, which are two
 * different directories. So the fold is platform-dependent on purpose; it is
 * not a shortcut around getting the comparison right.
 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

function fold(value: string): string {
  return CASE_INSENSITIVE_PATHS ? value.toLowerCase() : value;
}

/**
 * Whether `target` is the same path as `root` or lies underneath it.
 *
 * Exported so the sibling-prefix case can be asserted directly and
 * unmistakably. It cannot be reached through {@link resolveWithinRoot} with a
 * lexical candidate — `isRepoRelativePath` has already excluded every string
 * that could resolve upward — so without this export the only coverage would be
 * the symlink test, and a reader could not tell whether the separator guard or
 * the realpath step was the thing doing the work.
 *
 * `target === root` counts as inside. The *root is not addressable* rule is a
 * separate rejection with its own message, made by the caller, because "you
 * addressed a directory" and "you escaped the sandbox" are different mistakes
 * and want different messages.
 */
export function isWithinRoot(root: string, target: string): boolean {
  const foldedRoot = fold(root);
  const foldedTarget = fold(target);
  return (
    foldedTarget === foldedRoot || foldedTarget.startsWith(foldedRoot + sep)
  );
}

/**
 * The lexical half of the guard: validate, resolve, and prove containment
 * without touching the filesystem.
 *
 * Synchronous and pure, so it is unit-testable with no temp directory and so
 * the expensive half ({@link assertWithinRoot}'s realpath walk) is never
 * reached by a candidate that was already wrong. Returns the resolved absolute
 * path.
 *
 * **This is not sufficient on its own.** A symlink planted inside the root
 * defeats every check here (T-2-24), which is why nothing outside this module
 * calls it directly.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
  if (!isRepoRelativePath(candidate)) {
    throw new ContainmentError(
      candidate,
      'it is not a usable path relative to the workspace root — an absolute path, a `..` segment, a drive-letter or UNC prefix, a NUL byte, and the empty string are all refused',
    );
  }

  const base = resolve(root);
  const resolved = resolve(base, candidate);

  if (fold(resolved) === fold(base)) {
    throw new ContainmentError(
      candidate,
      'it resolves to the workspace root itself, which is a directory rather than a file',
    );
  }

  if (!isWithinRoot(base, resolved)) {
    throw new ContainmentError(
      candidate,
      'it resolves outside the workspace root',
    );
  }

  return resolved;
}

/**
 * Realpath the deepest part of `target` that actually exists, and report what
 * had to be left unresolved.
 *
 * The walk is the whole trick. Realpathing the *leaf* alone would make `write`
 * to a not-yet-existing file impossible — `realpath` throws `ENOENT` — and
 * realpathing only the *parent*, which is what `§ Pitfall 12` literally
 * suggests, misses the case where the leaf itself is the symlink: with
 * `root/link -> /etc`, `realpath(dirname(root/link))` is `root`, the guard
 * passes, and the subsequent `open()` follows the link anyway.
 *
 * So: resolve the leaf when it exists, and climb one segment at a time until
 * something does. Both cases are covered by one rule, and the segments climbed
 * past are re-attached afterwards — they contain no `..` (step 1 already
 * refused those), so they cannot walk back out of whatever the existing
 * ancestor resolved to.
 */
async function realpathDeepestExisting(target: string): Promise<string> {
  const climbed: string[] = [];
  let current = target;

  for (;;) {
    try {
      return join(await realpath(current), ...climbed);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything resolvable. Not
        // reachable in practice — a root that does not exist is rejected by the
        // caller before this runs — but returning the unresolved path keeps the
        // containment test below meaningful rather than throwing something the
        // caller cannot interpret.
        return target;
      }
      climbed.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * The full guard. Returns the absolute path the candidate names, having proven
 * it is inside `root` both lexically and after symlink resolution.
 *
 * **It returns the path rather than only asserting** so a caller does not
 * resolve a second time. Two resolutions of the same candidate is two chances
 * to disagree, and the one the guard blessed would not necessarily be the one
 * that gets opened. The stub backend keys its in-memory store by this value for
 * the same reason.
 *
 * **The root must exist.** A root with no filesystem presence would make the
 * realpath step climb past the intended boundary to some unrelated real
 * ancestor — the OS temp directory, or the drive root — and the containment
 * test would quietly stop testing containment while still passing. That is
 * worse than an error, so it is one.
 */
export async function assertWithinRoot(
  root: string,
  candidate: string,
): Promise<string> {
  const resolved = resolveWithinRoot(root, candidate);

  let realRoot: string;
  try {
    realRoot = await realpath(resolve(root));
  } catch {
    throw new WorkspaceError(
      'The workspace root does not exist on disk, so containment cannot be verified. A backend must own a real directory as its root — see `assertWithinRoot`.',
    );
  }

  const realTarget = await realpathDeepestExisting(resolved);

  if (fold(realTarget) === fold(realRoot)) {
    throw new ContainmentError(
      candidate,
      'it resolves to the workspace root itself once symlinks are followed',
    );
  }

  if (!isWithinRoot(realRoot, realTarget)) {
    throw new ContainmentError(
      candidate,
      'it escapes the workspace root through a symbolic link',
    );
  }

  return resolved;
}
