/**
 * `evaluateFeatureTrust` — the I/O half of the trusted-path filter
 * (SPEC-06, M05 step 5.3).
 *
 * `@adl/core/detect`'s `evaluateSpecTrust` is pure: given the branch/fork
 * facts and an author's permission level, it decides whether a folder is
 * trusted. This module supplies the permission half by calling
 * `ForgeAdapter.authorPermission` against `<featuresDir>/<folder>` — never
 * anything read from a developer's own session, matching ROLE-03's
 * discipline for gate context.
 *
 * The branch/fork facts are NOT read here: 5.1's scanner only ever reads
 * `defaultBranch`, so within M05 there is no live path that could produce a
 * ref other than the default branch or a fork-originated one. `ref` is
 * passed in as `defaultBranch` and `isFork`/`allowForkPRs` as `false` at
 * every M05 call site — real values for those two are M10's webhook path to
 * supply, reusing this same function rather than a second one.
 */
import { evaluateSpecTrust, type TrustDecision } from '@adl/core/detect';
import type { ForgeAdapter, ForgeRepoRef } from '@adl/core/forge';

export interface EvaluateFeatureTrustInput {
  /** `undevelopedFeatures`'s output — feature folders about to be enqueued. */
  readonly folders: readonly string[];
  readonly featuresDir: string;
  readonly defaultBranch: string;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

export interface FolderTrustResult {
  readonly folder: string;
  readonly decision: TrustDecision;
}

/**
 * A trust decision for every folder in `input.folders`, in the same order —
 * the full decision, not just the trusted subset, so a caller can log why a
 * folder was rejected rather than silently dropping it.
 */
export async function evaluateFeatureTrust(
  input: EvaluateFeatureTrustInput,
): Promise<readonly FolderTrustResult[]> {
  const prefix = input.featuresDir.endsWith('/')
    ? input.featuresDir
    : `${input.featuresDir}/`;

  return Promise.all(
    input.folders.map(async (folder) => {
      const authorPermission = await input.forge.authorPermission({
        repo: input.forgeRepo,
        ref: input.defaultBranch,
        path: `${prefix}${folder}`,
      });

      const decision = evaluateSpecTrust({
        ref: input.defaultBranch,
        defaultBranch: input.defaultBranch,
        isFork: false,
        allowForkPRs: false,
        authorPermission,
      });

      return { folder, decision };
    }),
  );
}
