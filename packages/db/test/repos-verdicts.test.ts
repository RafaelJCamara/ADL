import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import {
  migrateToLatest,
  verdictsRepository,
  type Database,
  type NewFinding,
  type NewVerdict,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * `verdictsRepository().fingerprintCountsForFeature()` — LOOP-06's
 * stall-detection input (M06 step 6.6): how many distinct rounds each
 * fingerprint has been raised in, across one feature's whole round history.
 *
 * Same fixture discipline as `repos-usage.test.ts`: foreign keys are
 * enforced on this connection, so every fixture seeds a real
 * repo -> feature -> round -> stage_attempt -> verdict -> finding chain.
 */

const NOW = '2026-08-30T00:00:00.000Z';

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
      state: 'gating',
      state_version: 1,
      round: 0,
      current_stage_index: 1,
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
  number: number,
): Promise<string> {
  const id = ulid();
  await db
    .insertInto('rounds')
    .values({
      id,
      feature_id: featureId,
      number,
      outcome: null,
      outcome_json: null,
      head_sha: null,
      started_at: NOW,
      ended_at: null,
    })
    .execute();
  return id;
}

async function seedStageAttempt(
  db: Kysely<Database>,
  roundId: string,
  stageId = 'review',
): Promise<string> {
  const id = ulid();
  await db
    .insertInto('stage_attempts')
    .values({
      id,
      round_id: roundId,
      stage_id: stageId,
      stage_index: 1,
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

/** A `send_back` verdict carrying the given fingerprints, one finding each. */
async function seedSendBack(
  db: Kysely<Database>,
  stageAttemptId: string,
  fingerprints: readonly string[],
): Promise<void> {
  const verdict: NewVerdict = {
    id: ulid(),
    stage_attempt_id: stageAttemptId,
    outcome: 'send_back',
    summary: 'changes required',
    reason: null,
    waiver_id: null,
    created_at: NOW,
  };
  const findings: NewFinding[] = fingerprints.map((fingerprint) => ({
    id: ulid(),
    verdict_id: verdict.id,
    fingerprint,
    severity: 'blocker',
    title: 'a finding',
    detail: 'a finding',
    criterion_ref_kind: 'global',
    criterion_id: null,
    global_category: 'other',
    path: null,
    line: null,
    end_line: null,
    suggested_action: null,
    created_at: NOW,
  }));
  await verdictsRepository(db).recordVerdict({ verdict, findings });
}

describe('verdictsRepository().fingerprintCountsForFeature', () => {
  it('counts a fingerprint once per distinct round it was raised in', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const round1 = await seedRound(db, featureId, 1);
      const attempt1 = await seedStageAttempt(db, round1);
      await seedSendBack(db, attempt1, ['fp-a']);

      const round2 = await seedRound(db, featureId, 2);
      const attempt2 = await seedStageAttempt(db, round2);
      await seedSendBack(db, attempt2, ['fp-a', 'fp-b']);

      const counts =
        await verdictsRepository(db).fingerprintCountsForFeature(featureId);

      expect(counts.get('fp-a')).toBe(2);
      expect(counts.get('fp-b')).toBe(1);
    });
  });

  it('counts a fingerprint raised twice within one round as one occurrence, not two', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const round1 = await seedRound(db, featureId, 1);
      const attempt1 = await seedStageAttempt(db, round1);
      // The same fingerprint listed twice in one gate's own output.
      await seedSendBack(db, attempt1, ['fp-a', 'fp-a']);

      const counts =
        await verdictsRepository(db).fingerprintCountsForFeature(featureId);

      expect(counts.get('fp-a')).toBe(1);
    });
  });

  it('is scoped to one feature — another feature’s findings never bleed in', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureA = await seedFeature(db, repoId);
      const featureB = await seedFeature(db, repoId);

      const roundA = await seedRound(db, featureA, 1);
      const attemptA = await seedStageAttempt(db, roundA);
      await seedSendBack(db, attemptA, ['fp-shared']);

      const roundB = await seedRound(db, featureB, 1);
      const attemptB = await seedStageAttempt(db, roundB);
      await seedSendBack(db, attemptB, ['fp-shared']);

      const countsA =
        await verdictsRepository(db).fingerprintCountsForFeature(featureA);
      expect(countsA.get('fp-shared')).toBe(1);
    });
  });

  it('has no entry for a fingerprint never raised — absent, never a zero', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, repoId);

      const counts =
        await verdictsRepository(db).fingerprintCountsForFeature(featureId);

      expect(counts.size).toBe(0);
      expect(counts.get('fp-a')).toBeUndefined();
    });
  });
});
