import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database, FeaturesTable } from '@adl/db';
import type { Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import { closeAttempt, openAttempt } from '../../src/bookkeeping/attempt.js';
import { changeRequestBranchFor } from '../../src/publish/branch.js';
import { ESCALATION_COMMENT_KEY } from '../../src/publish/escalation-comment.js';
import { publishOnEscalation } from '../../src/publish/on-escalation.js';
import { openTranscriptWriter } from '../../src/store/ndjson-log-store.js';
import { transcriptPathFor } from '../../src/store/transcript-path.js';
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
 * LOOP-08 end to end on the manager side (M06 step 6.8): a feature that stops
 * and asks for a human says so on the change request, with the disagreement
 * and a bounded transcript excerpt — and says nothing at all when there is no
 * change request to say it on.
 *
 * The four properties this file is here for:
 *
 * 1. **An escalation with no commit posts nothing.** A change request is
 *    opened from a branch, and the branch does not exist on the remote until a
 *    round has pushed to it. This is the maintainer's call (2026-09-02): the
 *    escalation stays in the daemon log and `adl status` rather than ADL
 *    manufacturing a commit or an issue to have somewhere to write.
 * 2. **An escalation after a commit posts to the existing change request**,
 *    without opening a second one.
 * 3. **The comment is sticky.** A second escalation edits the first comment in
 *    place rather than adding another — FORGE-06, and the reason the key is
 *    fixed forever.
 * 4. **The transcript excerpt is real**, read off the disk the worker wrote to,
 *    through the same `transcriptPathFor` the `adl logs` route resolves.
 */

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };
const DEVELOP = 'develop';

let server: MockGithubServer;
let forge: ReturnType<typeof githubForgeAdapter>;
let logsRoot: string;

beforeEach(async () => {
  logsRoot = await mkdtemp(join(tmpdir(), 'adl-escalation-logs-'));
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
  await rm(logsRoot, { recursive: true, force: true });
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
      state: 'escalated',
      state_version: 1,
      round: 1,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await featuresRepository(db).findById(id))!;
}

let seq = 0;

async function escalate(
  db: Kysely<Database>,
  featureId: string,
  reason: string,
): Promise<void> {
  seq += 1;
  await featuresRepository(db).appendEvent({
    id: ulid(),
    feature_id: featureId,
    seq,
    from_state: 'gating',
    to_state: 'escalated',
    event_json: JSON.stringify({ t: 'unrecoverable', reason }),
    actor: 'round-loop',
    at: nowIso(),
  });
}

/**
 * One round that ran the developer and, optionally, recorded the commit it
 * produced. Written through `recordRoundHeadSha` rather than a raw UPDATE so
 * the fixture exercises the same writer production uses.
 */
async function runRound(
  db: Kysely<Database>,
  featureId: string,
  sha?: string,
): Promise<{ roundId: string; stageAttemptId: string }> {
  const attempt = await openAttempt(
    { db },
    { featureId, stageId: DEVELOP, stageIndex: 0 },
  );
  await closeAttempt(
    { db },
    { stageAttemptId: attempt.stageAttemptId, status: 'verdict' },
  );
  if (sha !== undefined) {
    await featuresRepository(db).recordRoundHeadSha({
      id: attempt.roundId,
      headSha: sha,
    });
  }
  await db
    .updateTable('rounds')
    .set({ outcome: 'escalate', ended_at: nowIso() })
    .where('id', '=', attempt.roundId)
    .execute();
  return attempt;
}

function deps(db: Kysely<Database>) {
  const { logger, logs } = createCapturingLogger();
  return {
    inner: { db, logger, forge, forgeRepo: FORGE_REPO, logsRoot },
    logs,
  };
}

function commentsOn(number: number): readonly { body: string }[] {
  return server.state.commentsByIssue.get(number) ?? [];
}

describe('publishOnEscalation (M06 step 6.8)', () => {
  it('posts nothing when the feature escalated before any round committed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      // A round ran and the developer reported `blocked` — so there is an
      // attempt, and a closed round, but no commit and therefore no branch.
      await runRound(db, feature.id);
      await escalate(db, feature.id, 'the developer reported it is blocked');

      const { inner, logs } = deps(db);
      await publishOnEscalation(inner, { feature });

      // No change request was opened, and none was commented on. The
      // alternative — an empty commit, or an issue — is what the maintainer
      // decided against.
      expect(server.state.pulls).toHaveLength(0);
      // Visible in the daemon log, which is half of where the maintainer's
      // decision says this escalation lives (`adl status` is the other half).
      expect(
        logs.some(
          (log) =>
            log.level === 40 &&
            (log.msg ?? '').includes('escalated before any round committed'),
        ),
      ).toBe(true);
    });
  });

  it('opens the change request and posts the escalation once a round has committed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      await runRound(db, feature.id, 'a'.repeat(40));
      await escalate(
        db,
        feature.id,
        'the developer and the gate are at a stalemate — "null check" kept recurring',
      );

      const { inner } = deps(db);
      await publishOnEscalation(inner, { feature });

      expect(server.state.pulls).toHaveLength(1);
      const pull = server.state.pulls[0]!;
      expect(pull.head).toBe(changeRequestBranchFor(feature));

      const comments = commentsOn(pull.number);
      expect(comments).toHaveLength(1);
      // The marker the sticky upsert finds its own comment by, and the two
      // halves LOOP-08 asks for.
      expect(comments[0]?.body).toContain(
        `<!-- adl:role=${ESCALATION_COMMENT_KEY} -->`,
      );
      expect(comments[0]?.body).toContain('Escalated');
      expect(comments[0]?.body).toContain('"null check" kept recurring');
      expect(comments[0]?.body).toContain(`adl resume ${feature.id}`);
    });
  });

  it('edits the one escalation comment in place rather than adding a second', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      await runRound(db, feature.id, 'a'.repeat(40));
      await escalate(db, feature.id, 'the first escalation');

      const { inner } = deps(db);
      await publishOnEscalation(inner, { feature });

      // A human resumed it, it ran again, and it escalated again.
      await runRound(db, feature.id, 'b'.repeat(40));
      await escalate(db, feature.id, 'the second escalation');
      await publishOnEscalation(inner, { feature });

      const pull = server.state.pulls[0]!;
      const comments = commentsOn(pull.number);
      // One change request, one comment — FORGE-06's whole point. Four gates
      // over five rounds is twenty comments if this is gotten wrong.
      expect(server.state.pulls).toHaveLength(1);
      expect(comments).toHaveLength(1);

      const body = comments[0]?.body ?? '';
      // The newest expanded, the first folded away — and the first is still
      // there, because the comment is re-derived in full every time rather
      // than appended to.
      expect(body).toContain('the second escalation');
      expect(body).toContain('the first escalation');
      const fold = body.indexOf('<details>');
      expect(body.slice(0, fold)).toContain('the second escalation');
      expect(body.slice(fold)).toContain('the first escalation');
    });
  });

  it('carries the tail of the real transcript the worker wrote, and the `adl logs` id that resolves it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      const attempt = await runRound(db, feature.id, 'a'.repeat(40));

      // Written through the same path builder the `adl logs` route resolves
      // and the same writer the worker uses — not a hand-placed file, which
      // would prove only that this test can spell a path.
      const path = transcriptPathFor(logsRoot, {
        featureId: feature.id,
        roundId: attempt.roundId,
        stageId: DEVELOP,
        stageIndex: 0,
        attempt: 1,
      });
      const writer = await openTranscriptWriter(path);
      try {
        await writer.append({
          seq: 1,
          at: nowIso(),
          event: { kind: 'text', messageId: 'm1', delta: 'first thing' },
        });
        await writer.append({
          seq: 2,
          at: nowIso(),
          event: {
            kind: 'tool_call',
            callId: 'c1',
            name: 'Edit',
            input: { file_path: 'src/auth.ts' },
          },
        });
        await writer.append({
          seq: 3,
          at: nowIso(),
          event: {
            kind: 'error',
            errorKind: 'provider_error',
            detail: '429 rate limited',
          },
        });
      } finally {
        await writer.close();
      }

      await escalate(db, feature.id, 'the transient retry budget is spent');

      const { inner } = deps(db);
      await publishOnEscalation(inner, { feature });

      const body = commentsOn(server.state.pulls[0]!.number)[0]?.body ?? '';
      expect(body).toContain('first thing');
      expect(body).toContain('src/auth.ts');
      expect(body).toContain('provider_error: 429 rate limited');
      // The pointer to the whole thing is the attempt id `adl logs` takes.
      expect(body).toContain(`adl logs ${attempt.stageAttemptId}`);
    });
  });

  it('says the transcript is missing rather than staying silent about it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      // A crash before the agent launched leaves an attempt row and no file.
      await runRound(db, feature.id, 'a'.repeat(40));
      await escalate(db, feature.id, 'crashed three times');

      const { inner } = deps(db);
      await publishOnEscalation(inner, { feature });

      const body = commentsOn(server.state.pulls[0]!.number)[0]?.body ?? '';
      expect(body).toContain('No transcript was written');
      expect(body).toContain('crashed three times');
    });
  });

  it('logs and returns rather than throwing when the forge is unreachable', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;
      await runRound(db, feature.id, 'a'.repeat(40));
      await escalate(db, feature.id, 'a stalemate');

      const { inner } = deps(db);
      await server.close();

      // Reached from a fire-and-forget path with no caller awaiting a
      // rejection — the round, or the dispatch tick, must not fail because
      // commenting did.
      await expect(
        publishOnEscalation(inner, { feature }),
      ).resolves.toBeUndefined();

      // Reopened so `afterEach`'s close is a no-op rather than a second error.
      server = await startMockGithubServer();
    });
  });
});
