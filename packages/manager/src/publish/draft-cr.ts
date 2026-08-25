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
import { reposRepository, type Database, type FeaturesTable } from '@adl/db';
import type {
  ChangeRequest,
  ForgeAdapter,
  ForgeRepoRef,
} from '@adl/core/forge';
import { changeRequestBranchFor } from './branch.js';

export interface PublishDraftChangeRequestDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

/**
 * The change request this feature's work belongs on, or `undefined` if there
 * is none and none could be opened.
 *
 * Returning it rather than `void` is what lets M05 step 5.11 comment on the
 * change request in the same breath as opening it, without a second
 * `listOpenChangeRequests` round trip and — more importantly — without a
 * second, independently-derived answer to "which change request is this
 * feature's?". The idempotent path returns the *existing* one for exactly that
 * reason: from round 2 onwards, "already open" is the normal case, and a
 * caller that got `undefined` there would silently stop commenting after
 * round 1.
 */
export async function publishDraftChangeRequest(
  deps: PublishDraftChangeRequestDeps,
  params: { readonly feature: FeaturesTable; readonly sha: string },
): Promise<ChangeRequest | undefined> {
  const { feature } = params;
  const branch = changeRequestBranchFor(feature);

  try {
    const open = await deps.forge.listOpenChangeRequests(deps.forgeRepo);
    const existing = open.find((cr) => cr.head === branch);
    if (existing !== undefined) {
      // Idempotent: a previous round (or a retried publish) already opened one
      // for this exact branch. Handed back rather than swallowed — see above.
      return existing;
    }

    const repoRow = await reposRepository(deps.db).findById(feature.repo_id);
    if (repoRow === undefined) {
      deps.logger.warn(
        { featureId: feature.id, repoId: feature.repo_id },
        'publish: no repos row for this feature repo_id — refusing to open a change request rather than guess a base branch',
      );
      return undefined;
    }

    const folderName = basename(feature.path);
    const changeRequest = await deps.forge.openChangeRequest({
      repo: deps.forgeRepo,
      head: branch,
      base: repoRow.default_branch,
      title: `ADL: ${folderName}`,
      body:
        `Opened automatically by ADL from \`${folderName}\` at round 1.\n\n` +
        'Each role reports below in a single comment, edited in place each ' +
        'round with earlier rounds folded away (FORGE-06).',
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
    return changeRequest;
  } catch (error) {
    deps.logger.error(
      { err: error, featureId: feature.id, branch },
      'publish: could not open a draft change request',
    );
    return undefined;
  }
}
