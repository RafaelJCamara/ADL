/**
 * `publishOnEscalation` — everything that reaches the forge when ADL stops and
 * asks for a human (LOOP-08, M06 step 6.8).
 *
 * The mirror of `on-developer-committed.ts`, and deliberately built from the
 * same three pieces rather than a second publish path: `publishDraftChangeRequest`
 * resolves (or opens) the one change request this feature's work belongs on,
 * `renderEscalationComment` says what goes in the comment, and
 * `ForgeAdapter.upsertComment` finds the prior one by its marker and edits it
 * in place. Nothing here is a new mechanism; the gap 6.8 closes was that
 * nothing *called* the existing one except a commit.
 *
 * ## Why an escalation with no commit posts nothing
 *
 * A change request is opened from a **branch**, and the branch only exists on
 * the remote once a round has pushed a commit to it. So a feature that
 * escalates before it ever commits — a round-1 `blocked` or `dispute`, or an
 * `unrecoverable` on a feature that never got past `leased` — has nowhere on
 * the forge to post: there is no pull request, and there is no branch from
 * which one could be opened. The maintainer's call (2026-09-02) is that this
 * posts nothing and stays visible in the daemon log and `adl status` (whose
 * spend column landed in 6.3), rather than ADL manufacturing an empty commit
 * or an issue to have somewhere to write. Nothing was built, so there is
 * nothing to review — and making "every escalation reaches the forge"
 * structurally true belongs with M09's transactional outbox (9.1), not with a
 * second CR-open path here. Recorded in `docs/plan/DEBT.md`.
 *
 * The condition is read as "has any round recorded a `head_sha`", which is the
 * same column `role-rounds.ts` renders a prior round's commit line from. It is
 * a fact about the feature's whole history rather than about this escalation:
 * a feature that committed in round 1 and escalated in round 4 without
 * committing still has a change request, and that is exactly where the
 * escalation belongs.
 *
 * Never throws. Like every other publish in this directory it is reached from
 * a fire-and-forget path with no caller waiting on a rejection, and a change
 * request that failed to gain a comment is strictly better than a round — or a
 * dispatch tick — that failed because commenting did.
 */
import type { Kysely } from 'kysely';
import type { Database, FeaturesTable } from '@adl/db';
import { findAttempt } from '../bookkeeping/attempt.js';
import { readTranscriptTail } from '../store/ndjson-log-store.js';
import { transcriptPathFor } from '../store/transcript-path.js';
import {
  publishDraftChangeRequest,
  type PublishDraftChangeRequestDeps,
} from './draft-cr.js';
import {
  ESCALATION_COMMENT_KEY,
  TRANSCRIPT_TAIL_BYTES,
  renderEscalationComment,
  type TranscriptExcerpt,
} from './escalation-comment.js';
import { readEscalations } from './escalation-history.js';

export interface PublishOnEscalationDeps extends PublishDraftChangeRequestDeps {
  /** The directory transcripts live under — `logsRootFor(dbFilePath)`, computed once by `daemon.ts`. */
  readonly logsRoot: string;
}

export interface PublishOnEscalationParams {
  /** The feature row as it stands after the escalation was applied. */
  readonly feature: FeaturesTable;
}

/**
 * The commit some round of this feature produced, if any — the proof a branch
 * exists on the remote, and the `sha` `publishDraftChangeRequest` logs against.
 *
 * The newest is chosen rather than the first: it is the head the change
 * request actually points at, and a stale sha in a log line is a small lie
 * that costs someone a `git show` to disprove.
 */
async function latestHeadSha(
  db: Kysely<Database>,
  featureId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('rounds')
    .select('head_sha as headSha')
    .where('feature_id', '=', featureId)
    .where('head_sha', 'is not', null)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.headSha ?? undefined;
}

/**
 * The transcript of whatever ran most recently — "what the agent was doing
 * when this stopped".
 *
 * **Derived here rather than passed in by the caller**, and that is what lets
 * one publisher serve both producers unchanged (rule 8). The round loop knows
 * the attempt that escalated, and it is the newest one. The dispatcher's
 * budget escalation fires between rounds and knows no attempt at all, yet the
 * transcript a reviewer wants is the same thing — the last stage that ran and
 * spent the money. A `stageAttemptId` parameter would make those two callers
 * look different when they are not.
 *
 * The id is resolved through `findAttempt` rather than used to build a path
 * directly, so the address reaching `transcriptPathFor` is the DB-backed shape
 * its traversal guard requires (T-4-15) rather than a record assembled here.
 */
async function readExcerpt(
  deps: PublishOnEscalationDeps,
  featureId: string,
): Promise<TranscriptExcerpt | undefined> {
  const row = await deps.db
    .selectFrom('stage_attempts')
    .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
    .select('stage_attempts.id as id')
    .where('rounds.feature_id', '=', featureId)
    .orderBy('rounds.number', 'desc')
    .orderBy('stage_attempts.stage_index', 'desc')
    .orderBy('stage_attempts.attempt', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return undefined;

  const address = await findAttempt(deps.db, row.id);
  if (address === undefined) return undefined;

  const records = await readTranscriptTail(
    transcriptPathFor(deps.logsRoot, address),
    TRANSCRIPT_TAIL_BYTES,
  );
  return {
    records: records ?? [],
    stageAttemptId: row.id,
    absent: records === undefined,
  };
}

export async function publishOnEscalation(
  deps: PublishOnEscalationDeps,
  params: PublishOnEscalationParams,
): Promise<void> {
  const { feature } = params;
  try {
    const sha = await latestHeadSha(deps.db, feature.id);
    if (sha === undefined) {
      deps.logger.warn(
        { featureId: feature.id, state: feature.state },
        'publish: feature escalated before any round committed — there is no branch and no change request to post to; the escalation is visible in this log and in `adl status`',
      );
      return;
    }

    const escalations = await readEscalations(deps.db, feature.id);
    if (escalations.length === 0) {
      // Structurally shouldn't happen — a caller reaches this function because
      // it just applied an escalating event, which appended the row this
      // reads. Logged rather than assumed away: an empty read here means the
      // transition did not land, and silently upserting nothing would hide it.
      deps.logger.warn(
        { featureId: feature.id },
        'publish: asked to publish an escalation, but the audit trail records none for this feature',
      );
      return;
    }

    const changeRequest = await publishDraftChangeRequest(deps, {
      feature,
      sha,
    });
    if (changeRequest === undefined) return;

    const excerpt = await readExcerpt(deps, feature.id);
    const body = renderEscalationComment({
      escalations,
      featureId: feature.id,
      ...(excerpt !== undefined ? { excerpt } : {}),
    });
    if (body === undefined) return;

    await deps.forge.upsertComment({
      repo: deps.forgeRepo,
      number: changeRequest.number,
      key: ESCALATION_COMMENT_KEY,
      body,
    });

    deps.logger.info(
      {
        featureId: feature.id,
        number: changeRequest.number,
        escalations: escalations.length,
        transcriptEvents: excerpt?.records.length ?? 0,
      },
      'publish: upserted the escalation comment',
    );
  } catch (error) {
    deps.logger.error(
      { err: error, featureId: feature.id },
      'publish: could not publish the escalation',
    );
  }
}
