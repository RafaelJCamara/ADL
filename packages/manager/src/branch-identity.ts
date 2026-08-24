/**
 * `src/branch-identity.ts` — the DETECT-05 (5.6) branch-identity encoding.
 *
 * A worktree branch a real dispatch creates has to answer to two different
 * readers, and they want different halves of it:
 *
 * - `@adl/workspace`'s GC sweep (`sweepOrphans`, Phase 2) reads a branch back
 *   through `featureIdFromBranch` and calls `FeatureStateLookup` with the
 *   result (`gc-schedule.ts`'s `createFeatureStateLookup`, bound to
 *   `FeaturesRepository.findById`) — it needs the `features` row's own ULID
 *   primary key, the identity that is stable for as long as the row exists.
 * - DETECT-05's restart reconciliation (5.6, `detect/undeveloped.ts`) needs
 *   the OPPOSITE: a folder's identity recovered from an OPEN change request
 *   whose `features` row is gone. The ULID is exactly what was lost in that
 *   case — matching on it would be matching on the one thing reconciliation
 *   cannot have. Only something derived from the folder itself (freshly
 *   re-scanned off the repository, D-16) survives.
 *
 * Both are real requirements on the SAME branch string, so a real dispatch
 * encodes both: `<folderName>--<ulid>`. `@adl/workspace` stays unaware of
 * the compound shape — `branchNameFor`/`featureIdFromBranch` keep treating
 * whatever they are given as one opaque id, exactly as before (Phase 2's own
 * tests keep doing exactly that) — this module is the ONE place the manager
 * composes and later decodes it, at the two call sites that need one half
 * each: `worker-entry/stage-runner.ts` (compose, before `backend.create()`)
 * and `scheduler/gc-schedule.ts` / `detect/undeveloped.ts` (decode).
 *
 * A ULID never contains `-` (Crockford base32: digits and uppercase letters
 * only), so splitting on the LAST `--` is unambiguous no matter what the
 * folder name itself contains — the separator this module inserts can never
 * collide with the ULID suffix that follows it.
 */

const SEPARATOR = '--';

/**
 * Compose the identity a real dispatch hands `@adl/workspace` as a feature
 * id — the folder's basename and the `features` row's own ULID, joined so
 * both halves survive on the resulting branch (`adl/<folderName>--<ulid>`).
 *
 * `@adl/workspace`'s own git-refname/path-segment validation
 * (`assertUsableFeatureId`, `packages/workspace/src/worktree/lifecycle.ts`)
 * runs against the COMPOSED string when `createWorktree` is called with it —
 * this function does no validation of its own, deliberately: one guard, at
 * the one place a feature id actually becomes a directory name and a branch.
 */
export function composeBranchFeatureId(
  folderName: string,
  ulid: string,
): string {
  return `${folderName}${SEPARATOR}${ulid}`;
}

/** One decoded branch-feature-id — the folder's basename and the row's ULID. */
export interface DecodedBranchFeatureId {
  readonly folderName: string;
  readonly ulid: string;
}

/**
 * Split a composed identity back into its two halves.
 *
 * Returns `undefined` for a plain, single identity with no `--` in it —
 * every fixture and scenario test predating this encoding constructs
 * exactly that (a bare ULID, or a bare test-chosen id). Real ambiguity
 * would require the ULID half to contain `-`, which Crockford base32 makes
 * impossible, so `lastIndexOf` is safe even when the folder name itself
 * contains its own `-`/`--` runs: nothing after this module's own separator
 * is ever a `-`, so the rightmost `--` in the whole string is always the
 * separator {@link composeBranchFeatureId} inserted, never one the folder
 * name happens to contain.
 *
 * Callers almost never want this raw form directly — {@link ulidOf} and
 * {@link folderNameOf} below are the fallback-aware helpers every real call
 * site should use instead; see their own docblocks for why an inline
 * `decodeBranchFeatureId(x)?.half` at a call site is exactly the bug this
 * module exists to prevent a second occurrence of.
 */
export function decodeBranchFeatureId(
  featureId: string,
): DecodedBranchFeatureId | undefined {
  const index = featureId.lastIndexOf(SEPARATOR);
  if (index === -1) return undefined;

  const folderName = featureId.slice(0, index);
  const ulid = featureId.slice(index + SEPARATOR.length);
  if (folderName === '' || ulid === '') return undefined;

  return { folderName, ulid };
}

/**
 * The row's ULID half of a branch-derived id — GC's own reader
 * (`scheduler/gc-schedule.ts`'s `createFeatureStateLookup`).
 *
 * Falls back to `featureId` itself when it does not decode: a bare id with
 * no `--` is exactly what `featureIdFromBranch` always returned before this
 * encoding existed, and GC's `FeaturesRepository.findById` call has always
 * treated that whole value as the ULID — the fallback is what makes every
 * pre-5.6 branch keep resolving exactly as it did before.
 */
export function ulidOf(featureId: string): string {
  return decodeBranchFeatureId(featureId)?.ulid ?? featureId;
}

/**
 * The folder's basename half of a branch-derived id — DETECT-05's restart
 * reconciliation (`detect/undeveloped.ts`'s `undevelopedFeatures`).
 *
 * Falls back to `featureId` itself when it does not decode, for the
 * identical reason {@link ulidOf} does: a bare, pre-5.6-shaped branch (still
 * constructed by `test/tracer/detect-to-draft-cr-end-to-end.test.ts`, which
 * builds its own workspace directly rather than through
 * `stage-runner.ts`'s compose call) always had its WHOLE remainder treated
 * as the folder name, and dropping it instead of falling back would make a
 * real, currently-open change request invisible to reconciliation — the
 * exact double-dispatch DETECT-05 exists to prevent.
 */
export function folderNameOf(featureId: string): string {
  return decodeBranchFeatureId(featureId)?.folderName ?? featureId;
}
