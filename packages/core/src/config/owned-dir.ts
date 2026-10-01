import * as z from 'zod';

/**
 * `owned_dir` — the directory a gate owns (M08 step 8.6, ROLE-09).
 *
 * A pipeline entry that declares one is saying: **what this gate leaves under
 * this directory is committed to the feature's branch by ADL, and nothing else
 * may change it.** The behaviour tester is the first declarer — it is how the
 * tests a code-blind tester writes outlive the throwaway copy it wrote them in
 * — and a third party's gate declares the identical key and gets the identical
 * treatment, on `visible_paths`' and `needs_app`'s precedent (HARN-04).
 *
 * ## Why a single directory and not a glob
 *
 * Three things have to be decidable about this value, and a glob makes each one
 * a guess:
 *
 * 1. **It must not overlap the feature folder.** `features/<id>/` is always
 *    protected, and a carry-back that could write there could rewrite the spec
 *    the tester was judging against. Whether two directories overlap is a
 *    segment comparison; whether a glob like `** /*.test.ts` overlaps one is not
 *    answerable without enumerating a filesystem.
 * 2. **It is an always-on protection.** A `./`-prefixed pattern silently never
 *    matches a diff name under `matchesGlob` — a pre-existing property of
 *    `protected_paths` an always-on protection must not inherit.
 * 3. **ADL mirrors it.** Carry-back adds, changes AND deletes files under it so
 *    that what lands on the branch is exactly what was judged; "everything
 *    under one directory" is a set with a boundary, and a glob's set has holes
 *    a deletion could fall through.
 *
 * So the shape is stricter than {@link import('./path-guard.js').RepoRelativePathSchema}:
 * forward slashes only, no empty, `.` or `..` segment, no trailing slash, no
 * glob metacharacter, and nothing under `.git` or `.adl`, which are ADL's and
 * git's own.
 *
 * Pure and I/O-free (rule 2): every function here compares strings.
 */

/**
 * One path segment: no separator, no glob metacharacter, no NUL — and no `:`,
 * which is how a drive letter (`C:/tests`) or an NTFS stream would get in.
 */
const SEGMENT = String.raw`[^/\\*?\[\]{}:\u0000]+`;

/** `tests/behaviour` — segments joined by single forward slashes. */
const OWNED_DIR_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, 'u');

/** Directories ADL and git own, which no gate may claim. */
const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.adl']);

function segmentsOf(path: string): readonly string[] {
  return path.split('/');
}

/** Is `value` an acceptable `owned_dir`? The schema's whole rule, as a predicate. */
export function isOwnedDir(value: string): boolean {
  if (!OWNED_DIR_PATTERN.test(value)) return false;
  const segments = segmentsOf(value);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  if (segments.includes('.git')) return false;
  return !RESERVED_FIRST_SEGMENTS.has(segments[0] ?? '');
}

export const OwnedDirSchema = z
  .string()
  .refine(isOwnedDir, {
    message:
      'owned_dir must be one repo-relative directory: forward slashes, no empty, "." or ".." ' +
      'segment, no trailing slash, no glob characters, and nothing under .git or .adl',
  })
  .meta({
    id: 'OwnedDir',
    description:
      'One repo-relative directory a gate owns: what the gate leaves under it is committed by ADL, ' +
      'and nothing else may change it.',
  });

/**
 * Is `path` the directory `dir` or anything under it? Segment-wise, so
 * `tests/behaviour-old/x` is not under `tests/behaviour`.
 */
export function isWithinDirectory(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * `path` as plain segments: separators of either kind, no empty or `.`
 * segment, lowercased. The empty string is the repository root.
 */
function comparable(path: string): string {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
    .toLowerCase();
}

/**
 * Does either directory contain the other (or are they the same one)?
 *
 * Deliberately looser than {@link isWithinDirectory}, because it answers a
 * REFUSAL question and a false "yes" only refuses a configuration: both sides
 * are normalised (`./features`, `features/` and `features` are one directory —
 * `RepoRelativePathSchema` admits all three for `features_dir`) and compared
 * case-insensitively, because on Windows and macOS `Features/x` and
 * `features/x` are the same folder. The repository root contains everything.
 */
export function directoriesOverlap(a: string, b: string): boolean {
  const left = comparable(a);
  const right = comparable(b);
  if (left === '' || right === '') return true;
  return isWithinDirectory(left, right) || isWithinDirectory(right, left);
}

/**
 * Does `visiblePaths` copy EVERY file under `dir` into a composed workspace?
 *
 * The rule is deliberately syntactic: a pattern of `**`, or `<prefix>/**`
 * where `<prefix>` is `dir` itself or one of its ancestors. A narrower pattern
 * — `tests/behaviour/*.mjs` — matches some of the directory and not the rest,
 * and the files it misses would not be in the copy next round, so carry-back's
 * mirror would DELETE them from the branch. Covering the directory is what
 * makes a committed test re-run in the next round, which is what makes the
 * tester's `deterministic` judgement kind honest (M08 audit finding 8).
 */
export function visiblePathsCoverDirectory(
  visiblePaths: readonly string[],
  dir: string,
): boolean {
  return visiblePaths.some((pattern) => {
    if (pattern === '**') return true;
    if (!pattern.endsWith('/**')) return false;
    const prefix = pattern.slice(0, -'/**'.length);
    return isWithinDirectory(dir, prefix);
  });
}
