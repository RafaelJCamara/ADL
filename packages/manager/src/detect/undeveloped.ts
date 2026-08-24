/**
 * `undevelopedFeatures` — the I/O half of the *undeveloped* predicate
 * (DETECT-01, M05 step 5.2).
 *
 * `@adl/core/detect`'s `undevelopedFeatureFolders` is pure: given three
 * plain folder-name lists, it decides which scanned folders are new. This
 * module supplies those lists by reading the two things DETECT-01 requires —
 * the `features` table, through `FeaturesRepository.findByPath` (`path` is
 * `<featuresDir>/<folder>`, D-16), and every open ADL change request,
 * through `ForgeAdapter.listOpenChangeRequests`, matched back to a folder
 * name via `@adl/workspace`'s `featureIdFromBranch` — never anything the
 * manager remembers from a prior detection pass.
 */
import type { ForgeAdapter, ForgeRepoRef } from '@adl/core/forge';
import { undevelopedFeatureFolders } from '@adl/core/detect';
import type { FeaturesRepository } from '@adl/db';
import { featureIdFromBranch } from '@adl/workspace';

export interface UndevelopedFeaturesInput {
  /** `listFeatureFolders`'s output — every feature folder committed on the default branch right now. */
  readonly scannedFolders: readonly string[];
  readonly featuresDir: string;
  readonly repoId: string;
  readonly featuresRepo: FeaturesRepository;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

/**
 * The scanned folders neither claimed by a `features` row nor covered by a
 * currently-open change request — safe to enqueue.
 */
export async function undevelopedFeatures(
  input: UndevelopedFeaturesInput,
): Promise<readonly string[]> {
  const prefix = input.featuresDir.endsWith('/')
    ? input.featuresDir
    : `${input.featuresDir}/`;

  const knownFolders = (
    await Promise.all(
      input.scannedFolders.map(async (folder) => {
        const row = await input.featuresRepo.findByPath(
          input.repoId,
          `${prefix}${folder}`,
        );
        return row === undefined ? undefined : folder;
      }),
    )
  ).filter((folder): folder is string => folder !== undefined);

  const openChangeRequests = await input.forge.listOpenChangeRequests(
    input.forgeRepo,
  );
  const openChangeRequestFolders = openChangeRequests
    .map((cr) => featureIdFromBranch(cr.head))
    .filter((folder): folder is string => folder !== undefined);

  return undevelopedFeatureFolders({
    scannedFolders: input.scannedFolders,
    knownFolders,
    openChangeRequestFolders,
  });
}
