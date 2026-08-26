/**
 * Protected-path enforcement (ROLE-11, M05 step 5.16) — the pure predicate.
 *
 * The developer agent commits inside its own worktree, so nothing about what
 * it touched can be trusted by asking it —
 * `.planning/research/PITFALLS.md`'s own finding is that Claude-family models
 * specifically prefer *editing the tests* over reporting a broken gate. This
 * module answers the one question that survives that: given the paths a
 * round's commit actually changed, did it touch something it must never
 * touch? Detected by diffing, never by asking.
 *
 * Three protections apply, and only the third is configurable:
 *
 * 1. **The feature's own spec folder** — every path under it, unconditionally.
 *    A developer editing the spec that defines what it must build is editing
 *    its own grading criteria.
 * 2. **{@link GATE_CONFIG_PATH}** (`adl.yml`) — the gate configuration itself,
 *    unconditionally. A developer that cannot pass `commands.test` can
 *    otherwise edit it to point at something that exits 0.
 * 3. **`AdlYml.protected_paths`** — repo-relative glob patterns the
 *    maintainer declares explicitly, typically the tests that judge a gate.
 *    Empty unless the maintainer sets it: ADL has no way to know which files
 *    in an arbitrary repository "are tests" without being told, and
 *    `adl-yml.ts`'s own governing rule is that commands — and now protected
 *    paths — are explicit by design and never auto-detected.
 *
 * This module does no I/O and reads no git history itself: `changedPaths` is
 * supplied by the caller, which is the database-and-git half in
 * `@adl/manager`'s `loop/protected-paths-check.ts`.
 */

/** Where the gate configuration lives, relative to the repository root. Not configurable. */
export const GATE_CONFIG_PATH = 'adl.yml';

/**
 * Translate one `/`-free glob segment into a matcher.
 *
 * A segment with no `*` at all is compared verbatim rather than run through a
 * regex — the common case (most protected-path segments are literal
 * directory names) never pays for pattern compilation. `*` inside a segment
 * matches any run of characters other than `/`, translated to `[^/]*`; every
 * other character is escaped, so a segment containing regex metacharacters
 * (e.g. `a+b.ts`) matches only that literal name.
 */
function segmentMatcher(segment: string): (value: string) => boolean {
  if (!segment.includes('*')) {
    return (value) => value === segment;
  }
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  const regex = new RegExp(`^${escaped}$`);
  return (value) => regex.test(value);
}

/**
 * Does `path` match `pattern`?
 *
 * A small, deliberately narrow glob dialect — not a general-purpose library —
 * because this is the one place a maintainer-declared pattern is matched
 * against a developer-authored diff, and a narrower feature set is a smaller
 * correctness surface to get wrong. Two wildcards only, each a whole
 * `/`-separated segment or part of one:
 *
 * - `**` as a whole path segment matches zero or more path segments.
 * - `*` inside a segment matches any run of characters other than `/`.
 *
 * Matched by memoized recursion over the two segment lists — O(pattern
 * segments × path segments) states, each doing O(1) work beyond the segment
 * match itself — rather than naive backtracking. A pattern with more than one
 * `**` matched naively against a long path is exactly the shape that goes
 * exponential, and the path side of this match is a developer-chosen diff
 * (the same "no catastrophic backtracking" discipline `path-guard.ts`'s own
 * regex holds itself to, applied here to the algorithm rather than a regex).
 */
export function matchesGlob(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const matchers = patternSegments.map((segment) =>
    segment === '**' ? undefined : segmentMatcher(segment),
  );

  const memo = new Map<string, boolean>();

  function match(pi: number, si: number): boolean {
    const key = `${String(pi)}:${String(si)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (pi >= patternSegments.length) {
      result = si >= pathSegments.length;
    } else {
      const matcher = matchers[pi];
      if (matcher === undefined) {
        // A `**` segment: skip it entirely, or consume one path segment and
        // stay on it — the two branches together are "zero or more".
        result =
          match(pi + 1, si) || (si < pathSegments.length && match(pi, si + 1));
      } else {
        const value = pathSegments[si];
        result = value !== undefined && matcher(value) && match(pi + 1, si + 1);
      }
    }

    memo.set(key, result);
    return result;
  }

  return match(0, 0);
}

/** Is `path` the feature's own spec folder, or something inside it? */
function isWithinFeatureFolder(path: string, featurePath: string): boolean {
  return path === featurePath || path.startsWith(`${featurePath}/`);
}

export interface ProtectedPathsInput {
  /** Every repo-relative path this round's commit added, modified, or deleted. */
  readonly changedPaths: readonly string[];
  /** The feature's own spec folder, e.g. `features/export-widgets` (`FeaturesTable.path`). */
  readonly featurePath: string;
  /** `EffectiveConfig.protected_paths` — the maintainer-declared glob list. */
  readonly protectedGlobs: readonly string[];
}

/**
 * Which of `changedPaths` this round's commit was never allowed to touch.
 *
 * Empty means clean. Order-preserving and duplicate-preserving — the caller
 * decides how to render the list, and a path is not evidence of two
 * violations because two protections happen to name it.
 */
export function violatedProtectedPaths(
  input: ProtectedPathsInput,
): readonly string[] {
  const { changedPaths, featurePath, protectedGlobs } = input;
  return changedPaths.filter(
    (path) =>
      path === GATE_CONFIG_PATH ||
      isWithinFeatureFolder(path, featurePath) ||
      protectedGlobs.some((pattern) => matchesGlob(pattern, path)),
  );
}
