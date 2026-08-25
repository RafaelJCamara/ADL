/**
 * `publishDraftChangeRequest` — the manager-side half of M05 step 5.10.
 *
 * Called from `daemon.ts`'s `SupervisorDeps.onDeveloperCommitted` wiring
 * whenever a fence-matched `stage_result` reports a real commit. By the
 * time this runs, the branch is already on the remote if a forge is
 * configured — `worker-entry/stage-runner.ts` reports a push failure as a
 * `stage_error` instead of `developer_outcome: committed`, so a call here
 * never races the push.
 *
 * **No new persistence.** Idempotency ("don't open a second draft CR for a
 * feature that already has one") is answered by asking the forge —
 * `ForgeAdapter.listOpenChangeRequests`, matched by the exact branch this
 * feature's own dispatch would have pushed — the same "evaluate state,
 * don't remember events" discipline `@adl/core/detect`'s `undevelopedFeatureFolders`
 * and DETECT-05's restart reconciliation (5.6) already established. No
 * `features` column or new table exists for a change-request reference.
 *
 * Errors are caught and logged, never thrown: this runs off a fire-and-forget
 * IPC hook (`worker-supervisor/supervisor.ts`'s `stage_result` branch), which
 * has no caller waiting on a rejection.
 */
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { basename } from 'node:path';
import { branchNameFor } from '@adl/workspace';
import { reposRepository, type Database, type FeaturesTable } from '@adl/db';
import type { ForgeAdapter, ForgeRepoRef } from '@adl/core/forge';
import { composeBranchFeatureId } from '../branch-identity.js';

export interface PublishDraftChangeRequestDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

/**
 * The real branch a committed dispatch for `feature` pushes —
 * `stage-runner.ts`'s own composition (DETECT-05, 5.6), recomputed here from
 * the same two inputs it started from (`feature.path`'s basename,
 * `feature.id`) rather than threaded through the verdict, so this function's
 * only required input beyond the feature row is the sha it already logs.
 */
function branchFor(feature: FeaturesTable): string {
  return branchNameFor(
    composeBranchFeatureId(basename(feature.path), feature.id),
  );
}

export async function publishDraftChangeRequest(
  deps: PublishDraftChangeRequestDeps,
  params: { readonly feature: FeaturesTable; readonly sha: string },
): Promise<void> {
  const { feature } = params;
  const branch = branchFor(feature);

  try {
    const open = await deps.forge.listOpenChangeRequests(deps.forgeRepo);
    if (open.some((cr) => cr.head === branch)) {
      // Idempotent no-op: a previous round (or a retried publish) already
      // opened one for this exact branch.
      return;
    }

    const repoRow = await reposRepository(deps.db).findById(feature.repo_id);
    if (repoRow === undefined) {
      deps.logger.warn(
        { featureId: feature.id, repoId: feature.repo_id },
        'publish: no repos row for this feature repo_id — refusing to open a change request rather than guess a base branch',
      );
      return;
    }

    const folderName = basename(feature.path);
    const changeRequest = await deps.forge.openChangeRequest({
      repo: deps.forgeRepo,
      head: branch,
      base: repoRow.default_branch,
      title: `ADL: ${folderName}`,
      body:
        `Opened automatically by ADL from \`${folderName}\` at round 1.\n\n` +
        'Per-role summaries land here once sticky comments are wired (M05 step 5.11).',
      draft: true,
    });

    deps.logger.info(
      {
        featureId: feature.id,
        branch,
        sha: params.sha,
        number: changeRequest.number,
        url: changeRequest.url,
      },
      'publish: opened a draft change request',
    );
  } catch (error) {
    deps.logger.error(
      { err: error, featureId: feature.id, branch },
      'publish: could not open a draft change request',
    );
  }
}
