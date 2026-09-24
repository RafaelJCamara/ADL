/**
 * `visible_paths` — what a gate's workspace contains, declared by the pipeline
 * entry rather than decided by ADL (ROLE-06, M08 step 8.1).
 *
 * ## Why this is a declaration and not a detection
 *
 * ROLE-06 asks that the behaviour tester *structurally cannot read the
 * implementation*. The obvious reading is subtractive — "remove the source" —
 * and it is not available, because **ADL does not know which files are
 * implementation source and has already decided never to guess.**
 * `adl.yml`'s own `protected_paths` settled that argument for the mirror case:
 *
 * > Auto-detecting which files "are tests" is exactly the non-deterministic
 * > guess this schema's `commands` already refuse to make, so this list is
 * > explicit by design too.
 *
 * A heuristic that is wrong in the safe direction hides a file the suite needed
 * and the tester reports a broken run; wrong in the unsafe direction it leaves
 * the implementation on disk and ROLE-06 is quietly false. So the repository
 * declares what its gate sees, the same way it declares what its developer may
 * not write.
 *
 * ## Why the key names the property and not the mechanism
 *
 * M08 step 8.0's spike changed how this is *built* before a line of it was
 * written: a second worktree with a sparse checkout looks code-blind — the
 * source really is off the disk, a full-tree scan finds nothing, and a
 * behaviour test runs from it — and is not, because a linked worktree shares
 * the main repository's object store. `git cat-file`, `git show` and a
 * one-command `git sparse-checkout disable` all read the source straight back.
 * The mechanism moved to a materialised copy with no `.git`; `visible_paths`
 * did not move with it, because it never described a mechanism. It says what
 * the gate can see. How that is made true is `@adl/workspace`'s problem, and
 * the v2 container backend will make it true a third way.
 *
 * ## Why it is a pipeline-entry key and not a `with:` block
 *
 * `with:` is passed through opaquely — ADL does not read it and must not
 * pretend to. A view the gate is *given* is ADL's to compose, so it sits beside
 * `on_send_back`, which is a pipeline-entry key for the same reason: both are
 * statements about how the pipeline treats this stage, not configuration of the
 * program behind it. That is also what keeps HARN-04 true. The tester declares
 * `visible_paths`; a third party's gate declares the identical key and gets the
 * identical treatment. There is no member here a reviewer could point at and
 * say the tester was special-cased.
 *
 * ## Absent is not empty
 *
 * Omitting the key means **the gate attaches to the workspace the previous
 * stage left**, which is every gate's behaviour before M08 and stays
 * byte-for-byte unchanged. Declaring one means a composed workspace containing
 * the matches and nothing else. The two are opposite ends, so an empty array is
 * refused at the schema rather than being made to mean one of them silently.
 */
import { matchesGlob } from '../loop/protected-paths.js';

/**
 * The two halves of a composition decision, both of them.
 *
 * {@link VisibleSelection.hidden} is not a diagnostic afterthought. ROLE-06's
 * claim is about what a gate *cannot* reach, and a function that returns only
 * what it kept leaves its caller unable to say what it withheld — so the proof
 * that the implementation was excluded would have to be re-derived by
 * subtracting two listings, at which point the subtraction is the thing under
 * test rather than the thing doing the testing.
 */
export interface VisibleSelection {
  /** Candidates a declared pattern matched, in the order they were given. */
  readonly visible: readonly string[];
  /** Candidates no declared pattern matched — what the gate will not see. */
  readonly hidden: readonly string[];
}

/**
 * Split a listing into what a gate declaring `visiblePaths` may see and what it
 * may not.
 *
 * Both arguments are repo-relative and stay repo-relative: this function does
 * no path resolution, touches no filesystem, and cannot be made to escape a
 * root, because it never holds one. Containment is `@adl/workspace`'s job at
 * the point the copy happens, where there is a real root to be contained to.
 *
 * Matching is {@link matchesGlob}, the matcher `protected_paths` already uses —
 * *derived, never restated* (convention 8). Two glob matchers in one codebase
 * would be one edit apart from disagreeing, and the disagreement would resolve
 * in favour of whichever one the tester's workspace happened to consult.
 */
export function selectVisiblePaths(
  candidates: readonly string[],
  visiblePaths: readonly string[],
): VisibleSelection {
  const visible: string[] = [];
  const hidden: string[] = [];

  for (const candidate of candidates) {
    if (visiblePaths.some((pattern) => matchesGlob(pattern, candidate))) {
      visible.push(candidate);
    } else {
      hidden.push(candidate);
    }
  }

  return { visible, hidden };
}
