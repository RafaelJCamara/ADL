/**
 * The *undeveloped* predicate (DETECT-01, M05 step 5.2) — deciding which
 * scanned feature folders ADL has not already started.
 *
 * `scanFeatureFolders` (5.1, `scan.ts`) answers "what feature folders exist
 * right now"; this module answers DETECT-01's other half: "which of those
 * has ADL never started." A folder is undeveloped only when NEITHER a
 * `features` row NOR a currently-open change request already accounts for
 * it — a folder is not re-admitted merely because its `features` row was
 * lost, so long as a change request for it is still open. That is what
 * keeps this the same predicate DETECT-05's restart reconciliation (5.6)
 * reuses, rather than a second, narrower one.
 *
 * Pure, matching `scan.ts`'s own split: the caller resolves both
 * cross-references — a `features` table lookup and a `listOpenChangeRequests`
 * call, each already translated to the folder's identity (D-16, the folder's
 * basename under `featuresDir`) — and hands in plain string lists. See
 * `packages/manager/src/detect/undeveloped.ts` for the I/O half.
 */

export interface UndevelopedInput {
  /** `scanFeatureFolders`'s output — every feature folder on the default branch right now. */
  readonly scannedFolders: readonly string[];
  /** Folder names for which a `features` row already exists in this repo. */
  readonly knownFolders: readonly string[];
  /** Folder names with a currently-open ADL change request. */
  readonly openChangeRequestFolders: readonly string[];
}

/**
 * The folders in `scannedFolders` that are neither a known `features` row
 * nor behind a currently-open change request.
 *
 * Order and de-duplication are inherited from `scannedFolders` — this
 * function only filters, trusting `scanFeatureFolders`'s own contract rather
 * than re-imposing it.
 */
export function undevelopedFeatureFolders(
  input: UndevelopedInput,
): readonly string[] {
  const known = new Set(input.knownFolders);
  const openChangeRequest = new Set(input.openChangeRequestFolders);

  return input.scannedFolders.filter(
    (folder) => !known.has(folder) && !openChangeRequest.has(folder),
  );
}
