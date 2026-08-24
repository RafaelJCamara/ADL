/**
 * The `features/` scanner (DETECT-01, M05 step 5.1) — turning a flat list of
 * repo-relative paths into the feature folders that exist at some point in
 * history, with no memory of what ADL has already seen.
 *
 * DETECT-01's whole point is "evaluate repository state, not remembered
 * events": a feature folder is undeveloped because the *repository* says so
 * right now, never because a webhook once fired. This module is the
 * "evaluate state" half — pure, so the fact it produces is reproducible from
 * the same input every time. The *undeveloped* half (cross-referencing
 * against the `features` table and open change requests, 5.2) is a separate,
 * database-touching step layered on top, deliberately not here.
 *
 * `@adl/core` is pure and does no I/O: this module never reads a filesystem
 * or runs git. The caller does the I/O — walking a real tree at a real ref
 * through `ManagerGitClient.listFiles` (`packages/manager/src/detect/scanner.ts`)
 * — and hands the resulting path list in, matching `pipeline.ts`'s and
 * `context-cascade.ts`'s own "policy here, I/O at the call site" split.
 */

/**
 * The feature folder names directly under `featuresDir`, deduplicated and
 * sorted for a deterministic result.
 *
 * D-16: a feature's identity is its folder's *basename* — `features/<id>/` —
 * so a file sitting directly in `featuresDir` with no enclosing folder names
 * no feature and is ignored, and only the first path segment past the prefix
 * is taken as the id, however deep the folder's own contents go.
 *
 * `featuresDir` is matched as an exact, case-sensitive path-segment prefix.
 * A path that merely starts with the same characters but at a different
 * segment boundary (`featuresDir` = `"features"`, path =
 * `"features-legacy/x/y"`) does not match — the trailing `/` in the
 * constructed prefix is what makes that a segment boundary rather than a
 * string prefix.
 */
export function scanFeatureFolders(
  paths: readonly string[],
  featuresDir: string,
): readonly string[] {
  const prefix = featuresDir.endsWith('/') ? featuresDir : `${featuresDir}/`;
  const found = new Set<string>();

  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const boundary = rest.indexOf('/');
    // A file directly under featuresDir (no `/` in what remains, or an empty
    // remainder from a literal `featuresDir/` entry) names no folder and is
    // ignored — D-16 requires an enclosing directory, not a bare file.
    if (boundary <= 0) continue;
    found.add(rest.slice(0, boundary));
  }

  return [...found].sort();
}
