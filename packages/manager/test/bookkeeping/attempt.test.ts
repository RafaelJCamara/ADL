import { sql } from 'kysely';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { migrateToLatest, nowIso, type Database } from '@adl/db';
import type { Kysely } from 'kysely';
import {
  closeAttempt,
  findAttempt,
  openAttempt,
} from '../../src/bookkeeping/attempt.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * Phase 4 Plan 04, Task 2: the one place a round and a stage attempt are
 * opened and closed, and the one query that resolves a stage attempt id
 * back to its feature, round, and stage.
 */

async function seedRepo(db: Kysely<Database>): Promise<string> {
  const id = ulid();
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function seedFeature(
  db: Kysely<Database>,
  repoId: string,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'leased',
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
  return featureId;
}

describe('openAttempt', () => {
  it('for a feature with no open round inserts a rounds row numbered 1 and a stage_attempts row with attempt 1', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const result = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );

      expect(result.roundNumber).toBe(1);
      expect(result.attempt).toBe(1);
      expect(result.stageId).toBe('develop');
      expect(result.stageIndex).toBe(0);

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', result.roundId)
        .executeTakeFirst();
      expect(round?.number).toBe(1);
      expect(round?.outcome).toBeNull();

      const attemptRow = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('id', '=', result.stageAttemptId)
        .executeTakeFirst();
      expect(attemptRow?.attempt).toBe(1);
      expect(attemptRow?.status).toBe('running');
    });
  });

  it('called a second time for the same feature, round, and stage index returns attempt 2 with an unchanged round id — a repair reprompt is a second attempt, not an overwrite', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const first = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );
      const second = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );

      expect(second.roundId).toBe(first.roundId);
      expect(second.attempt).toBe(2);
      expect(second.stageAttemptId).not.toBe(first.stageAttemptId);

      const rows = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('round_id', '=', first.roundId)
        .orderBy('attempt')
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    });
  });

  it('for a feature whose previous round is closed opens round 2, not a second row numbered 1', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const first = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );
      // Close the round out from under openAttempt — this is the loop's
      // (Phase 5's) job in production; here it is a direct write so this
      // test stays scoped to openAttempt's own round-selection behaviour.
      await db
        .updateTable('rounds')
        .set({ outcome: 'green', outcome_json: '{}', ended_at: nowIso() })
        .where('id', '=', first.roundId)
        .execute();

      const second = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );

      expect(second.roundId).not.toBe(first.roundId);
      expect(second.roundNumber).toBe(2);
      expect(second.attempt).toBe(1);

      const rounds = await db
        .selectFrom('rounds')
        .selectAll()
        .where('feature_id', '=', featureId)
        .orderBy('number')
        .execute();
      expect(rounds.map((r) => r.number)).toEqual([1, 2]);
    });
  });

  it('rolls back the round when the stage attempt insert fails, leaving no orphaned round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      // A real failure, not a stub: the stage_attempts insert that
      // openAttempt issues after the round insert genuinely rejects.
      await sql`drop table stage_attempts`.execute(db);

      await expect(
        openAttempt({ db }, { featureId, stageId: 'develop', stageIndex: 0 }),
      ).rejects.toThrow();

      const rounds = await db
        .selectFrom('rounds')
        .selectAll()
        .where('feature_id', '=', featureId)
        .execute();
      expect(rounds).toHaveLength(0);
    });
  });

  it('two concurrent openAttempt calls for the same feature do not both claim round number 1', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const [first, second] = await Promise.all([
        openAttempt({ db }, { featureId, stageId: 'develop', stageIndex: 0 }),
        openAttempt({ db }, { featureId, stageId: 'review', stageIndex: 1 }),
      ]);

      expect(first.roundId).toBe(second.roundId);
      const rounds = await db
        .selectFrom('rounds')
        .selectAll()
        .where('feature_id', '=', featureId)
        .where('number', '=', 1)
        .execute();
      expect(rounds).toHaveLength(1);
    });
  });
});

describe('closeAttempt', () => {
  it('sets ended_at and the terminal status, and a second call is a no-op rather than an error', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);
      const opened = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );

      await closeAttempt(
        { db },
        { stageAttemptId: opened.stageAttemptId, status: 'verdict' },
      );
      const afterFirst = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('id', '=', opened.stageAttemptId)
        .executeTakeFirstOrThrow();
      expect(afterFirst.status).toBe('verdict');
      expect(afterFirst.ended_at).toBeTruthy();
      const firstEndedAt = afterFirst.ended_at;

      await expect(
        closeAttempt(
          { db },
          { stageAttemptId: opened.stageAttemptId, status: 'error' },
        ),
      ).resolves.toBeUndefined();

      const afterSecond = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('id', '=', opened.stageAttemptId)
        .executeTakeFirstOrThrow();
      // The second call is a no-op: status and ended_at are unchanged from
      // the first, terminal write.
      expect(afterSecond.status).toBe('verdict');
      expect(afterSecond.ended_at).toBe(firstEndedAt);

      const rows = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('id', '=', opened.stageAttemptId)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });
});

describe('findAttempt', () => {
  it('returns the feature id, round id, stage id, stage index, and attempt number for a known attempt id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);
      const opened = await openAttempt(
        { db },
        { featureId, stageId: 'develop', stageIndex: 0 },
      );

      const address = await findAttempt(db, opened.stageAttemptId);

      expect(address).toEqual({
        featureId,
        roundId: opened.roundId,
        stageId: 'develop',
        stageIndex: 0,
        attempt: 1,
      });
    });
  });

  it('returns undefined for an unknown id, never a throw and never a partial record', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const address = await findAttempt(db, 'not-a-real-attempt-id');
      expect(address).toBeUndefined();
    });
  });

  it('given two features in one database, resolves each attempt id to its own feature — the two are never conflated', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureA = await seedFeature(db, repoId);
      const featureB = await seedFeature(db, repoId);

      const openedA = await openAttempt(
        { db },
        { featureId: featureA, stageId: 'develop', stageIndex: 0 },
      );
      const openedB = await openAttempt(
        { db },
        { featureId: featureB, stageId: 'develop', stageIndex: 0 },
      );

      const addressA = await findAttempt(db, openedA.stageAttemptId);
      const addressB = await findAttempt(db, openedB.stageAttemptId);

      expect(addressA?.featureId).toBe(featureA);
      expect(addressB?.featureId).toBe(featureB);
      expect(addressA?.featureId).not.toBe(addressB?.featureId);
    });
  });
});
