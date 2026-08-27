import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import {
  migrateToLatest,
  usageRepository,
  type Database,
  type NewUsageEvent,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * `usageRepository().spendByFeature()` — OBS-05's data source (M06 step
 * 6.3): every feature's spend, broken down by role, in one query rather
 * than one query per feature (`GET /features` reads this once for the
 * whole response, the same discipline `ageMs`'s single clock read already
 * holds itself to).
 *
 * Foreign keys ARE enforced on this connection (`stage_attempts.round_id`,
 * `usage_events.feature_id`, verified empirically against the real schema
 * before this file was written — the naive minimal-fixture version of this
 * test failed with `SqliteError: FOREIGN KEY constraint failed`), so every
 * fixture here seeds a real repo -> feature -> round -> stage_attempt
 * chain, not just the two columns this join reads.
 */

const NOW = '2026-08-27T00:00:00.000Z';

async function seedRepo(db: Kysely<Database>): Promise<string> {
  const id = ulid();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  return id;
}

async function seedFeature(
  db: Kysely<Database>,
  repoId: string,
): Promise<string> {
  const id = ulid();
  await db
    .insertInto('features')
    .values({
      id,
      repo_id: repoId,
      path: `features/${id}`,
      state: 'developing',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  return id;
}

async function seedRound(
  db: Kysely<Database>,
  featureId: string,
): Promise<string> {
  const id = ulid();
  await db
    .insertInto('rounds')
    .values({
      id,
      feature_id: featureId,
      number: 1,
      outcome: null,
      outcome_json: null,
      head_sha: null,
      started_at: NOW,
      ended_at: null,
    })
    .execute();
  return id;
}

/** A real `stage_attempts` row with the given role (`stage_id`), for a real round. */
async function seedStageAttempt(
  db: Kysely<Database>,
  roundId: string,
  stageId: string,
  stageIndex = 0,
): Promise<string> {
  const id = ulid();
  await db
    .insertInto('stage_attempts')
    .values({
      id,
      round_id: roundId,
      stage_id: stageId,
      stage_index: stageIndex,
      attempt: 1,
      status: 'verdict',
      error_kind: null,
      error_retryable: null,
      error_raw_ref: null,
      started_at: NOW,
      ended_at: NOW,
    })
    .execute();
  return id;
}

function usageEvent(
  overrides: Partial<NewUsageEvent> & Pick<NewUsageEvent, 'feature_id'>,
): NewUsageEvent {
  return {
    id: ulid(),
    round_id: null,
    stage_attempt_id: null,
    model_id: 'claude-sonnet-5',
    speed: 'standard',
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cost_usd: 0.01,
    cost_source: 'reported',
    cost_category: 'feature',
    at: NOW,
    ...overrides,
  };
}

describe('usageRepository().spendByFeature', () => {
  it('groups spend by feature and by role (stage_id), for every feature in one call', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const usage = usageRepository(db);

      const repoId = await seedRepo(db);
      const featureA = await seedFeature(db, repoId);
      const featureB = await seedFeature(db, repoId);
      const roundA = await seedRound(db, featureA);
      const roundB = await seedRound(db, featureB);
      const developA = await seedStageAttempt(db, roundA, 'develop', 0);
      const testA = await seedStageAttempt(db, roundA, 'test', 1);
      const developB = await seedStageAttempt(db, roundB, 'develop', 0);

      await usage.record(
        usageEvent({
          feature_id: featureA,
          round_id: roundA,
          stage_attempt_id: developA,
          cost_usd: 0.02,
        }),
      );
      await usage.record(
        usageEvent({
          feature_id: featureA,
          round_id: roundA,
          stage_attempt_id: testA,
          cost_usd: 0.03,
        }),
      );
      await usage.record(
        usageEvent({
          feature_id: featureB,
          round_id: roundB,
          stage_attempt_id: developB,
          cost_usd: 0.05,
        }),
      );

      const spend = await usage.spendByFeature();

      expect(spend.get(featureA)).toEqual({
        total: 0.05,
        unpricedEvents: 0,
        byRole: { develop: 0.02, test: 0.03 },
      });
      expect(spend.get(featureB)).toEqual({
        total: 0.05,
        unpricedEvents: 0,
        byRole: { develop: 0.05 },
      });
    });
  });

  it('folds a row with no resolvable stage_attempt_id into the "unknown" role, not into a dropped total', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const usage = usageRepository(db);

      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      // `stage_attempt_id: null` — nothing to join against.
      await usage.record(
        usageEvent({
          feature_id: featureId,
          stage_attempt_id: null,
          cost_usd: 0.04,
        }),
      );

      const spend = await usage.spendByFeature();

      expect(spend.get(featureId)).toEqual({
        total: 0.04,
        unpricedEvents: 0,
        byRole: { unknown: 0.04 },
      });
    });
  });

  it('counts an unpriced row separately, never as zero spend, and never drops it from either total or byRole (D-31)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const usage = usageRepository(db);

      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);
      const roundId = await seedRound(db, featureId);
      const attempt = await seedStageAttempt(db, roundId, 'develop');

      await usage.record(
        usageEvent({
          feature_id: featureId,
          round_id: roundId,
          stage_attempt_id: attempt,
          cost_usd: null,
          cost_source: 'unknown',
        }),
      );
      await usage.record(
        usageEvent({
          feature_id: featureId,
          round_id: roundId,
          stage_attempt_id: attempt,
          cost_usd: 0.01,
        }),
      );

      const spend = await usage.spendByFeature();

      expect(spend.get(featureId)).toEqual({
        total: 0.01,
        unpricedEvents: 1,
        byRole: { develop: 0.01 },
      });
    });
  });

  it('has no entry for a feature with zero usage rows — the caller supplies its own zeroed default', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const usage = usageRepository(db);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const spend = await usage.spendByFeature();

      expect(spend.size).toBe(0);
      expect(spend.get(featureId)).toBeUndefined();
    });
  });
});
