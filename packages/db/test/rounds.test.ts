import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * `closeRound` and `listDispatchable` — the two queries M05 step 5.13's round
 * loop added, and the two guards on them that are load-bearing rather than
 * incidental.
 *
 * `closeRound`'s `ended_at is null` predicate is the same idempotency shape
 * `closeAttempt`, `expireLease` and `destroy()` all already use: workers report
 * at-least-once, so a replayed round completion must match zero rows rather
 * than rewrite a verdict a pull request has already been rendered from.
 *
 * `listDispatchable`'s second half is what makes the loop turn at all —
 * `transition()` draws no edge from `gating` back to `queued`, so a feature
 * midway through its pipeline is picked up from the state it reached, and
 * `publishing` is deliberately excluded because it is waiting on a forge
 * rather than on a stage.
 */

async function seedFeature(
  db: Kysely<Database>,
  state: string,
  leaseToken: string | null,
): Promise<string> {
  const now = nowIso();
  const repoId = ulid();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://example.invalid/repo.git',
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
      path: `features/${id}`,
      state,
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: leaseToken === null ? null : 'manager',
      lease_token: leaseToken,
      lease_expires_at:
        leaseToken === null
          ? null
          : new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

describe('featuresRepository.closeRound', () => {
  it('records the outcome, the payload and ended_at', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await seedFeature(db, 'gating', null);

      const roundId = ulid();
      await repo.insertRound({
        id: roundId,
        feature_id: featureId,
        number: 1,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      const closed = await repo.closeRound({
        id: roundId,
        outcome: 'send_back',
        outcomeJson: '{"kind":"send_back"}',
        endedAt: nowIso(),
      });

      expect(closed).toBe(true);
      const round = await repo.latestRound(featureId);
      expect(round?.outcome).toBe('send_back');
      expect(round?.outcome_json).toBe('{"kind":"send_back"}');
      expect(round?.ended_at).not.toBeNull();
    });
  });

  it('is a no-op the second time — a replayed completion never rewrites a decided round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await seedFeature(db, 'gating', null);

      const roundId = ulid();
      await repo.insertRound({
        id: roundId,
        feature_id: featureId,
        number: 1,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      await repo.closeRound({
        id: roundId,
        outcome: 'green',
        outcomeJson: '{"kind":"green"}',
        endedAt: nowIso(),
      });
      const second = await repo.closeRound({
        id: roundId,
        outcome: 'escalate',
        outcomeJson: '{"kind":"escalate","reason":"a replay"}',
        endedAt: nowIso(),
      });

      expect(second).toBe(false);
      // The first answer stands. A round that reported green and was then
      // quietly rewritten to `escalate` by a duplicate message would make the
      // pull request disagree with the history it was rendered from.
      expect((await repo.latestRound(featureId))?.outcome).toBe('green');
    });
  });
});

describe('featuresRepository.recordRoundHeadSha', () => {
  it('records the developer’s commit on a round that is still open', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await seedFeature(db, 'developing', null);

      const roundId = ulid();
      await repo.insertRound({
        id: roundId,
        feature_id: featureId,
        number: 1,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      // The round is emphatically NOT closed here, and that is the case that
      // matters: in any pipeline with a gate in it the developer's stage
      // `advance`s rather than completing, so a sha only ever written at round
      // close would never be written at all (M05 step 5.14).
      expect(
        await repo.recordRoundHeadSha({ id: roundId, headSha: 'abc1234' }),
      ).toBe(true);

      const round = await repo.latestRound(featureId);
      expect(round?.head_sha).toBe('abc1234');
      expect(round?.outcome).toBeNull();
      expect(round?.ended_at).toBeNull();
    });
  });

  it('overwrites, so a re-run stage’s commit replaces the superseded one', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await seedFeature(db, 'developing', null);

      const roundId = ulid();
      await repo.insertRound({
        id: roundId,
        feature_id: featureId,
        number: 1,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      await repo.recordRoundHeadSha({ id: roundId, headSha: 'aaaaaaa' });
      await repo.recordRoundHeadSha({ id: roundId, headSha: 'bbbbbbb' });

      // Deliberately unlike `closeRound`, whose `ended_at is null` guard makes
      // a replay a no-op. A retryable stage error re-dispatches into the SAME
      // open round (`openAttempt` reuses a round whose outcome is null), so one
      // round can legitimately see the developer commit twice — and the sha
      // that matters is the one on the branch now.
      expect((await repo.latestRound(featureId))?.head_sha).toBe('bbbbbbb');
    });
  });

  it('reports no match for a round id that does not exist', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      expect(
        await featuresRepository(db).recordRoundHeadSha({
          id: ulid(),
          headSha: 'abc1234',
        }),
      ).toBe(false);
    });
  });
});

describe('featuresRepository.listDispatchable', () => {
  it('includes a queued feature and an unleased in-loop one, and excludes the rest', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);

      const queued = await seedFeature(db, 'queued', null);
      const developing = await seedFeature(db, 'developing', null);
      const gating = await seedFeature(db, 'gating', null);
      const stillLeased = await seedFeature(db, 'gating', ulid());
      const publishing = await seedFeature(db, 'publishing', null);
      const escalated = await seedFeature(db, 'escalated', null);

      const ids = (await repo.listDispatchable()).map((row) => row.id);

      expect(new Set(ids)).toEqual(new Set([queued, developing, gating]));
      // A stage is running: re-leasing it would put two workers in one
      // worktree, which is the data-loss path the lease exists to prevent.
      expect(ids).not.toContain(stillLeased);
      // Waiting on the forge, not on a stage.
      expect(ids).not.toContain(publishing);
      // A human is the next actor.
      expect(ids).not.toContain(escalated);
    });
  });
});
