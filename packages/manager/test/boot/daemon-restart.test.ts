import { ulid } from 'ulid';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  reposRepository,
  type Database,
} from '@adl/db';
import type { DaemonConfig } from '@adl/core/config';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { startDaemon } from '../../src/daemon.js';
import { encodeLeaseOwner } from '../../src/boot/orphans.js';
// Reused directly, per 03-CONTEXT.md's read_first list.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

const API_TOKEN = 'restart-test-token';

function daemonConfigFixture(): DaemonConfig {
  return {
    limits: {},
    agents: {},
    lease_ttl_ms: 30_000,
    heartbeat_interval_ms: 10_000,
    worker_stop_grace_ms: 200,
    concurrency: { global: 1 },
    api: { host: '127.0.0.1', port: 0, token: API_TOKEN },
    gc: { interval_ms: 1_800_000 },
    repos: [],
  };
}

/**
 * ROADMAP criterion 4: a daemon that starts against a database left behind
 * by a previous (crashed or stopped) daemon process must produce a
 * deterministic clean slate — every held lease expired and requeued — while
 * leaving `rounds`, `usage_events`, and the append-only `feature_events` log
 * intact and gap-free.
 *
 * The "previous daemon" state is constructed directly at the SQL layer
 * (mirroring `test/boot/orphans.test.ts`'s own fixture shape) rather than
 * run through a first live daemon instance: a live daemon's own reaper/
 * fast-path recovery would recover the lease *during its own lifetime*,
 * which defeats the point of proving that a *fresh* daemon's boot sequence
 * — not an already-running one's background timers — is what performs the
 * recovery this test asserts on.
 */
async function seedPreCrashState(
  db: Kysely<Database>,
): Promise<{ featureId: string; repoId: string }> {
  const now = nowIso();
  const repoId = 'repo-1';
  const featureId = 'feature-restart-1';

  await reposRepository(db).upsert({
    id: repoId,
    remote_url: 'git@example.com:acme/repo.git',
    default_branch: 'main',
    forge: 'github',
    features_dir: 'features',
    created_at: now,
    updated_at: now,
  });

  const repo = featuresRepository(db);
  await repo.insert({
    id: featureId,
    repo_id: repoId,
    path: `features/${featureId}`,
    state: 'leased',
    state_version: 2,
    round: 1,
    current_stage_index: 1,
    spec_hash: 'x',
    effective_config_json: null,
    workspace_handle: 'features/feature-restart-1',
    lease_owner: encodeLeaseOwner({ pid: 999_999, startTime: '1' }), // a dead pid — no real process leaks
    lease_token: 'stale-token-1',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), // not yet TTL-expired — boot must expire it anyway (D-13)
    heartbeat_at: now,
    crash_count: 0,
    created_at: now,
    updated_at: now,
  });

  // Two append-only events, seq 1 and 2 — contiguity is what the assertion checks.
  await repo.appendEvent({
    id: ulid(),
    feature_id: featureId,
    seq: 1,
    from_state: null,
    to_state: 'discovered',
    event_json: JSON.stringify({ t: 'discovered' }),
    actor: 'test-setup',
    at: now,
  });
  await repo.appendEvent({
    id: ulid(),
    feature_id: featureId,
    seq: 2,
    from_state: 'discovered',
    to_state: 'leased',
    event_json: JSON.stringify({
      t: 'lease_acquired',
      workerId: 'stale-token-1',
    }),
    actor: 'test-setup',
    at: now,
  });

  await repo.insertRound({
    id: ulid(),
    feature_id: featureId,
    number: 1,
    outcome: null,
    outcome_json: null,
    started_at: now,
    ended_at: null,
  });

  await db
    .insertInto('usage_events')
    .values({
      id: ulid(),
      feature_id: featureId,
      round_id: null,
      stage_attempt_id: null,
      model_id: 'claude-sonnet-5',
      speed: 'standard',
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cost_usd: 0.01,
      cost_source: 'reported',
      cost_category: 'feature',
      at: now,
    })
    .execute();

  return { featureId, repoId };
}

describe('daemon-restart — ROADMAP criterion 4', () => {
  it('boot recovers a dangling lease to queued, and leaves rounds/usage_events/feature_events intact and gap-free', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId } = await seedPreCrashState(db);

      const roundsBefore = await db
        .selectFrom('rounds')
        .selectAll()
        .where('feature_id', '=', featureId)
        .execute();
      const usageBefore = await db
        .selectFrom('usage_events')
        .selectAll()
        .where('feature_id', '=', featureId)
        .execute();

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        daemonConfig: daemonConfigFixture(),
        resolveAdlYml: () => {
          throw new Error('not exercised — no dispatch happens in this test');
        },
        migrationsDir: MIGRATIONS_DIR,
        dispatchIntervalMs: 5_000, // effectively disabled for the duration of this assertion window
      });

      try {
        const repo = featuresRepository(db);
        const row = await repo.findById(featureId);
        expect(row?.state).toBe('queued');
        expect(row?.lease_owner).toBeNull();
        expect(row?.lease_token).toBeNull();
        expect(row?.lease_expires_at).toBeNull();

        const events = await repo.listEvents(featureId);
        const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
        // Contiguous: no gap, no duplicate.
        for (let i = 0; i < seqs.length; i++) {
          expect(seqs[i]).toBe(i + 1);
        }
        expect(seqs.length).toBeGreaterThanOrEqual(3); // the 2 seeded + the recovery transition

        const roundsAfter = await db
          .selectFrom('rounds')
          .selectAll()
          .where('feature_id', '=', featureId)
          .execute();
        expect(roundsAfter).toEqual(roundsBefore);

        const usageAfter = await db
          .selectFrom('usage_events')
          .selectAll()
          .where('feature_id', '=', featureId)
          .execute();
        expect(usageAfter).toEqual(usageBefore);
      } finally {
        await handle.stop();
      }
    });
  });
});
