/**
 * `publishStickyComment` — a role's presence on a change request, as exactly
 * one comment (FORGE-06, M05 step 5.11).
 *
 * The two halves of FORGE-06 already existed separately and never met:
 * `@adl/forge-github`'s `upsertComment` knows how to find its own prior comment
 * by a hidden marker and edit it in place, and `@adl/core/forge`'s
 * `renderStickyComment` knows what belongs in one. This is the production
 * caller that joins them — reading the role's whole round history back out of
 * ADL's own tables (`role-rounds.ts`), re-rendering it, and overwriting the
 * forge's copy.
 *
 * **Role-generic, with one caller today.** `params.role` carries the three
 * things that differ between roles — the `upsertComment` key, the heading a
 * human reads, and the `stage_attempts.stage_id` whose rows belong to it —
 * because the reviewer (M07), the tester (M08) and every third-party harness
 * (M13) need this exact function and must not each grow their own. The
 * developer is simply the only role that runs today.
 *
 * Errors are caught and logged, never thrown: this is reached from
 * `worker-supervisor/supervisor.ts`'s fire-and-forget `stage_result` hook,
 * which has no caller waiting on a rejection — and a change request that
 * failed to gain a comment is strictly better than a round that failed because
 * commenting did.
 */
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { renderStickyComment } from '@adl/core/forge';
import type {
  ChangeRequest,
  ForgeAdapter,
  ForgeRepoRef,
} from '@adl/core/forge';
import type { Database } from '@adl/db';
import { readRoleRounds, type RoundNote } from './role-rounds.js';

export interface StickyCommentDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

/** What distinguishes one role's sticky comment from another's. */
export interface StickyRole {
  /** The `upsertComment` key — stable across rounds, and the marker's own payload. */
  readonly key: string;
  /** The heading a human reads: `'Developer'`, `'Reviewer'`, a harness's name. */
  readonly title: string;
  /** The pipeline entry whose `stage_attempts` rows belong to this role. */
  readonly stageId: string;
}

export interface PublishStickyCommentParams {
  readonly featureId: string;
  readonly changeRequest: ChangeRequest;
  readonly role: StickyRole;
  readonly note?: RoundNote;
}

export async function publishStickyComment(
  deps: StickyCommentDeps,
  params: PublishStickyCommentParams,
): Promise<void> {
  try {
    const rounds = await readRoleRounds(deps.db, {
      featureId: params.featureId,
      stageId: params.role.stageId,
      ...(params.note !== undefined ? { note: params.note } : {}),
    });

    if (rounds.length === 0) {
      // This role has not run for this feature. Writing a "nothing yet"
      // comment would be a comment nobody asked for on a public change
      // request — the noise FORGE-06 is about removing.
      return;
    }

    await deps.forge.upsertComment({
      repo: deps.forgeRepo,
      number: params.changeRequest.number,
      key: params.role.key,
      body: renderStickyComment({ title: params.role.title, rounds }),
    });

    deps.logger.info(
      {
        featureId: params.featureId,
        role: params.role.key,
        number: params.changeRequest.number,
        rounds: rounds.length,
      },
      'publish: upserted a sticky role comment',
    );
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        featureId: params.featureId,
        role: params.role.key,
        number: params.changeRequest.number,
      },
      'publish: could not upsert a sticky role comment',
    );
  }
}
