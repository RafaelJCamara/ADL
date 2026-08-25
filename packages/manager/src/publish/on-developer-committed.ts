/**
 * `publishOnDeveloperCommitted` — everything that reaches the forge when a
 * round produces a real commit (M05 steps 5.10 and 5.11).
 *
 * `daemon.ts` wires this to `SupervisorDeps.onDeveloperCommitted`, which fires
 * only for a fence-matched `stage_result` carrying
 * `developer_outcome: committed`. Two things follow, in order and for a
 * reason: the change request has to exist before anything can be commented on
 * it, and the comment is published against the change request the first step
 * just resolved rather than one this step looks up again — one answer to
 * "which change request is this feature's?", not two that can disagree.
 *
 * The order also means the ordinary round-2 path costs nothing extra:
 * `publishDraftChangeRequest` finds the already-open change request and hands
 * it straight back, so the second call is the comment and nothing else.
 *
 * Neither step throws; each logs its own failure. A change request that opened
 * but could not be commented on is a worse pull request, not a failed round.
 */
import type { FeaturesTable } from '@adl/db';
import {
  publishDraftChangeRequest,
  type PublishDraftChangeRequestDeps,
} from './draft-cr.js';
import { publishStickyComment } from './sticky-comment.js';

/**
 * The developer's `upsertComment` key and heading.
 *
 * The key is the marker's payload and must never change once a comment
 * carrying it exists on a real change request — a renamed key orphans every
 * prior comment and starts a second one beside it. Its `stage_id` is
 * deliberately *not* here: that comes from the dispatch that ran, so the
 * pipeline gets to name its own first stage.
 */
const DEVELOPER_COMMENT_KEY = 'developer';
const DEVELOPER_COMMENT_TITLE = 'Developer';

/**
 * A commit as a human reads it. Abbreviated to git's own conventional 7, with
 * anything shorter passed through untouched — `CommittedOutcomeSchema` admits
 * an abbreviated sha (7–64 hex), so this must not assume a full one.
 */
function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export interface PublishOnDeveloperCommittedParams {
  readonly feature: FeaturesTable;
  /**
   * The round the committing worker was assigned — from the supervisor's own
   * `assign` closure, never reported by the worker (the identity discipline
   * `recordUsage` established, T-4-38). "The feature's latest round" would be
   * a guess, and a wrong one the moment a late result arrives.
   */
  readonly roundId: string;
  /** The pipeline entry that ran — the developer role's `stage_attempts.stage_id`. */
  readonly stageId: string;
  readonly sha: string;
}

export async function publishOnDeveloperCommitted(
  deps: PublishDraftChangeRequestDeps,
  params: PublishOnDeveloperCommittedParams,
): Promise<void> {
  const changeRequest = await publishDraftChangeRequest(deps, {
    feature: params.feature,
    sha: params.sha,
  });
  if (changeRequest === undefined) return;

  const short = shortSha(params.sha);
  await publishStickyComment(deps, {
    featureId: params.feature.id,
    changeRequest,
    role: {
      key: DEVELOPER_COMMENT_KEY,
      title: DEVELOPER_COMMENT_TITLE,
      stageId: params.stageId,
    },
    note: {
      roundId: params.roundId,
      line: `Committed \`${short}\`.`,
      headline: `committed \`${short}\``,
    },
  });
}
