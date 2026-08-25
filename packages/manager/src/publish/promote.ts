/**
 * `promoteChangeRequestToReady` — FORGE-05's second half (M05 step 5.13).
 *
 * Step 5.10 opened the draft at round 1 and deliberately stopped there:
 * "promoted to ready only when every gate is green" needed an aggregate
 * verdict, and nothing in production produced one until the round loop
 * existed. `ForgeAdapter.promoteToReady` has been built and uncalled since
 * 5.9 for this moment. `loop/round-runner.ts` is its one caller, reached only
 * through `RoundOutcome.kind === 'green'` — so the promise is structural: there
 * is no other path to a promotion, because there is no other producer of
 * `green`.
 *
 * **Which change request, and how it is found.** The same way 5.10 answers it,
 * through the same helper, for the same reason: ask the forge which change
 * requests are open and match the exact branch this feature's own dispatch
 * pushes (`branch-identity.ts`'s composed `<folderName>--<ulid>` identity).
 * No `features` column remembers a change-request number, and none should —
 * "evaluate state, don't remember events" is what makes this correct after a
 * daemon restart, a lost row, or a change request a human closed and reopened.
 *
 * Errors are caught and logged, never thrown: this runs off the same
 * fire-and-forget IPC hook `publish/draft-cr.ts` does, and a change request
 * that could not be promoted is a worse pull request, not a failed round.
 */
import type { ChangeRequest } from '@adl/core/forge';
import type { FeaturesTable } from '@adl/db';
import { changeRequestBranchFor } from './branch.js';
import type { PublishDraftChangeRequestDeps } from './draft-cr.js';

/**
 * Promote this feature's open change request to ready for review, and return
 * it — or `undefined` when there is none to promote, or the forge refused.
 *
 * An already-ready change request is promoted again rather than skipped. The
 * forge's own mutation is idempotent (GitHub's `markPullRequestReadyForReview`
 * on a non-draft pull request is a no-op that still returns it), and a
 * pre-check would be a second round trip buying a race rather than a
 * guarantee — the draft could be promoted by a human between the read and the
 * write either way.
 */
export async function promoteChangeRequestToReady(
  deps: PublishDraftChangeRequestDeps,
  params: { readonly feature: FeaturesTable },
): Promise<ChangeRequest | undefined> {
  const branch = changeRequestBranchFor(params.feature);

  try {
    const open = await deps.forge.listOpenChangeRequests(deps.forgeRepo);
    const existing = open.find((cr) => cr.head === branch);
    if (existing === undefined) {
      deps.logger.warn(
        { featureId: params.feature.id, branch },
        'publish: every gate passed, but no open change request matches this feature’s branch — nothing to promote',
      );
      return undefined;
    }

    const promoted = await deps.forge.promoteToReady({
      repo: deps.forgeRepo,
      number: existing.number,
    });

    deps.logger.info(
      {
        featureId: params.feature.id,
        branch,
        number: promoted.number,
        url: promoted.url,
      },
      'publish: promoted the change request to ready for review',
    );
    return promoted;
  } catch (error) {
    deps.logger.error(
      { err: error, featureId: params.feature.id, branch },
      'publish: could not promote the change request to ready',
    );
    return undefined;
  }
}
