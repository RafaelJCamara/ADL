import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database, FeaturesTable } from '@adl/db';
import type { Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import { closeAttempt, openAttempt } from '../../src/bookkeeping/attempt.js';
import { publishStickyComment } from '../../src/publish/sticky-comment.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import {
  startMockGithubServer,
  type MockGithubServer,
} from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * FORGE-06 end to end on the manager side (M05 step 5.11): a role's whole
 * round history is re-derived from ADL's own tables and overwritten onto ONE
 * comment, no matter how many rounds run.
 */

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };
const DEVELOPER = { key: 'developer', title: 'Developer', stageId: 'develop' };

let server: MockGithubServer;
let forge: ReturnType<typeof githubForgeAdapter>;

beforeEach(async () => {
  server = await startMockGithubServer();
  forge = githubForgeAdapter({
    appId: 'adl-test-app',
    privateKey: throwawayPrivateKeyPem(),
    installationId: 1,
    baseUrl: server.url,
    disablePacingForTests: true,
  });
});

afterEach(async () => {
  await server.close();
});

async function seedFeature(db: Kysely<Database>): Promise<FeaturesTable> {
  const now = nowIso();
  const repoId = ulid();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/adl-test-org/demo-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const id = ulid();
  await db
    .insertInto('features')
    .values({
      id,
      repo_id: repoId,
      path: 'features/dark-mode',
      state: 'developing',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: 'manager',
      lease_token: ulid(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await featuresRepository(db).findById(id))!;
}

async function openChangeRequest(): Promise<{ number: number }> {
  return forge.openChangeRequest({
    repo: FORGE_REPO,
    head: 'adl/dark-mode',
    base: 'main',
    title: 'Dark mode',
    body: 'body',
    draft: true,
  });
}

/** Run one developer round to completion, returning its round id. */
async function runRound(
  db: Kysely<Database>,
  featureId: string,
  { close }: { close?: string } = {},
): Promise<string> {
  const attempt = await openAttempt(
    { db },
    { featureId, stageId: DEVELOPER.stageId, stageIndex: 0 },
  );
  await closeAttempt(
    { db },
    { stageAttemptId: attempt.stageAttemptId, status: 'verdict' },
  );
  if (close !== undefined) {
    await db
      .updateTable('rounds')
      .set({ outcome: close, ended_at: nowIso() })
      .where('id', '=', attempt.roundId)
      .execute();
  }
  return attempt.roundId;
}

describe('publishStickyComment', () => {
  it('creates one comment carrying the role heading and the round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      const changeRequest = await openChangeRequest();
      const roundId = await runRound(db, feature.id);
      const { logger } = createCapturingLogger();

      await publishStickyComment(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        {
          featureId: feature.id,
          changeRequest: (await forge.listOpenChangeRequests(FORGE_REPO))[0]!,
          role: DEVELOPER,
          note: {
            roundId,
            line: 'Committed `abc1234`.',
            headline: 'committed `abc1234`',
          },
        },
      );

      const comments =
        server.state.commentsByIssue.get(changeRequest.number) ?? [];
      expect(comments).toHaveLength(1);
      const body = comments[0]?.body ?? '';
      expect(body).toContain('<!-- adl:role=developer -->');
      expect(body).toContain('### Developer');
      expect(body).toContain('**Round 1 — committed `abc1234`**');
      expect(body).toContain('Committed `abc1234`.');
      expect(body).not.toContain('<details>');
    });
  });

  it('edits the SAME comment on a second round and folds the first away', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      const changeRequest = await openChangeRequest();
      const { logger } = createCapturingLogger();
      const cr = (await forge.listOpenChangeRequests(FORGE_REPO))[0]!;

      const firstRound = await runRound(db, feature.id, { close: 'send_back' });
      await publishStickyComment(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        {
          featureId: feature.id,
          changeRequest: cr,
          role: DEVELOPER,
          note: {
            roundId: firstRound,
            line: 'Committed `1111111`.',
            headline: 'committed `1111111`',
          },
        },
      );

      const secondRound = await runRound(db, feature.id);
      await publishStickyComment(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        {
          featureId: feature.id,
          changeRequest: cr,
          role: DEVELOPER,
          note: {
            roundId: secondRound,
            line: 'Committed `2222222`.',
            headline: 'committed `2222222`',
          },
        },
      );

      const comments =
        server.state.commentsByIssue.get(changeRequest.number) ?? [];
      // One comment after two rounds — this is the whole of FORGE-06.
      expect(comments).toHaveLength(1);
      const body = comments[0]?.body ?? '';
      expect(body).toContain('**Round 2 — committed `2222222`**');
      expect(body).toContain('<summary>Round 1 — send_back</summary>');
      expect(body).toContain('- Attempt 1 — completed');

      // Round 1 is re-derived from the database, NOT carried over from the
      // comment it was previously rendered into: its headline is the outcome
      // `rounds` recorded, and the note it carried while it was the newest
      // round — the commit sha — is gone.
      //
      // M05 step 5.13 answered half of the question this assertion was left
      // here to force (`docs/plan/DEBT.md` D-5-11-1). The round loop writes
      // real outcomes now, so a finished round says what it decided rather
      // than degrading — see the `renders a finished round's outcome` case
      // below. The sha specifically is still absent, and that is now a
      // *diagnosed* gap rather than an open question: `RoundOutcome` has no
      // field for a commit, so no amount of writing `outcome_json` was ever
      // going to carry one. Its home is a `rounds.head_sha` column.
      expect(body).not.toContain('Round 1 — committed `1111111`');
      expect(body).not.toContain('Committed `1111111`.');
    });
  });

  it('writes no comment at all for a role that has not run', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      const changeRequest = await openChangeRequest();
      await runRound(db, feature.id);
      const { logger } = createCapturingLogger();

      await publishStickyComment(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        {
          featureId: feature.id,
          changeRequest: (await forge.listOpenChangeRequests(FORGE_REPO))[0]!,
          role: { key: 'reviewer', title: 'Reviewer', stageId: 'review' },
        },
      );

      expect(
        server.state.commentsByIssue.get(changeRequest.number) ?? [],
      ).toHaveLength(0);
    });
  });

  it('keeps each role on its own comment', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      const changeRequest = await openChangeRequest();
      const cr = (await forge.listOpenChangeRequests(FORGE_REPO))[0]!;
      const { logger } = createCapturingLogger();

      await runRound(db, feature.id);
      const gate = await openAttempt(
        { db },
        { featureId: feature.id, stageId: 'test', stageIndex: 1 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: gate.stageAttemptId, status: 'verdict' },
      );

      const deps = { db, logger, forge, forgeRepo: FORGE_REPO };
      await publishStickyComment(deps, {
        featureId: feature.id,
        changeRequest: cr,
        role: DEVELOPER,
      });
      await publishStickyComment(deps, {
        featureId: feature.id,
        changeRequest: cr,
        role: { key: 'test', title: 'Command gate', stageId: 'test' },
      });

      const comments =
        server.state.commentsByIssue.get(changeRequest.number) ?? [];
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.body.includes('### Developer'))).toContain(
        true,
      );
      expect(
        comments.map((c) => c.body.includes('### Command gate')),
      ).toContain(true);
    });
  });

  it('logs and returns cleanly rather than throwing when the forge call fails', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      await runRound(db, feature.id);
      const { logger, logs } = createCapturingLogger();

      // A real connection failure against an address nothing is listening on,
      // not a simulated one — matching `draft-cr.test.ts`'s own precedent.
      const deadServer = await startMockGithubServer();
      await deadServer.close();
      const deadForge = githubForgeAdapter({
        appId: 'adl-test-app',
        privateKey: throwawayPrivateKeyPem(),
        installationId: 1,
        baseUrl: deadServer.url,
        disablePacingForTests: true,
      });

      await expect(
        publishStickyComment(
          { db, logger, forge: deadForge, forgeRepo: FORGE_REPO },
          {
            featureId: feature.id,
            changeRequest: {
              id: 'PR_1',
              number: 1,
              url: 'https://example.invalid/pull/1',
              state: 'draft',
              draft: true,
              head: 'adl/dark-mode',
            },
            role: DEVELOPER,
          },
        ),
      ).resolves.toBeUndefined();

      expect(
        logs.some((l) =>
          l.msg?.includes('could not upsert a sticky role comment'),
        ),
      ).toBe(true);
    });
  });
});
