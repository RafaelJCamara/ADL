import { basename } from 'node:path';
import { branchNameFor } from '@adl/workspace';
import type { FeaturesTable } from '@adl/db';
import { composeBranchFeatureId } from '../branch-identity.js';

/**
 * The branch a committed dispatch for this feature pushes.
 *
 * `worker-entry/stage-runner.ts` composes exactly this before handing the
 * workspace backend an identity (DETECT-05, 5.6), and every publish-side
 * question that starts with "which change request is this feature's?" is
 * answered by matching a change request's `head` against it — 5.10's draft-CR
 * idempotency check and 5.13's promote-to-ready both.
 *
 * Recomputed from the feature row's own two inputs (`path`'s basename and
 * `id`) rather than threaded through the verdict, so a caller needs nothing
 * but the row. It lives in its own module because there are now two callers:
 * a private copy in each would be two definitions of the one string the whole
 * publish side joins on, and the first time they disagreed ADL would open a
 * second change request beside a perfectly good one.
 */
export function changeRequestBranchFor(feature: FeaturesTable): string {
  return branchNameFor(
    composeBranchFeatureId(basename(feature.path), feature.id),
  );
}
