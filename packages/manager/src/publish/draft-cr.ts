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
import {
  createKeyedSerialiser,
  type ChangeRequest,
  type ForgeAdapter,
  type ForgeRepoRef,
  type KeyedSerialiser,
} from '@adl/core/forge';
import { changeRequestBranchFor } from './branch.js';

/**
 * One serialiser per `ForgeAdapter` instance (D-7-05-2). The scope of the
 * guarantee is then exactly "callers publishing through this forge connection",
 * which is every caller there is: forge writes are manager-side and the manager
 * is one process holding one adapter. Keyed off the adapter rather than module
 * state so two daemons in one process (the test suite starts many) never
 * serialise against each other for no reason.
 */
const serialisers = new WeakMap<ForgeAdapter, KeyedSerialiser>();

function serialiserFor(forge: ForgeAdapter): KeyedSerialiser {
  let serialise = serialisers.get(forge);
  if (serialise === undefined) {
    serialise = createKeyedSerialiser();
    serialisers.set(forge, serialise);
  }
  return serialise;
}

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
 *
 * **Serialised per (repository, branch)** (D-7-05-2). "List, find none, open"
 * is a read-then-create, and two callers genuinely overlap on a first-round
 * escalation: `onDeveloperCommitted` and the round loop's `publishOnEscalation`
 * both publish from the same `stage_result`. Without the chain both listed
 * nothing and both opened -- two draft change requests against a lenient forge,
 * and against GitHub (which rejects a second pull request for one head/base
 * with a 422) a logged failure that cost the escalation its comment. The second
 * caller now lists after the first has finished opening, and finds it. Covers
 * callers sharing one adapter instance, i.e. the single manager process; see
 * `createKeyedSerialiser`.
 */
export function publishDraftChangeRequest(
  deps: PublishDraftChangeRequestDeps,
  params: { readonly feature: FeaturesTable; readonly sha: string },
): Promise<ChangeRequest | undefined> {
  const branch = changeRequestBranchFor(params.feature);
  return serialiserFor(deps.forge)(
    JSON.stringify([deps.forgeRepo.owner, deps.forgeRepo.repo, branch]),
    () => publishDraftChangeRequestUnserialised(deps, params, branch),
  );
}

async function publishDraftChangeRequestUnserialised(
  deps: PublishDraftChangeRequestDeps,
  params: { readonly feature: FeaturesTable; readonly sha: string },
  branch: string,
): Promise<ChangeRequest | undefined> {
  const { feature } = params;

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
