import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import { dispatchOnce } from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * Phase 3 Plan 07, Task 1: the concurrency cap (D-15..17) — inclusive
 * ceiling, FIFO by ULID, drain on lower. `test/tracer/end-to-end.test.ts`
 * already covers `dispatchOnce`'s basic lease-acquire-and-transition path
 * with no cap in play; this file is the cap's own behavior surface.
 */

const ADL_YML_FIXTURE: AdlYml = AdlYmlSchema.parse({
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
  pipeline: ['develop', 'review', 'test'],
});

async function seedRepo(
  db: Kysely<Database>,
  id: string = ulid(),
): Promise<string> {
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

interface SeedFeatureOptions {
  readonly repoId: string;
  readonly state?: 'queued' | 'leased';
  readonly id?: string;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = options.id ?? ulid();
  const now = nowIso();
  const leased = (options.state ?? 'queued') === 'leased';

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: options.repoId,
      path: `features/${featureId}`,
      state: options.state ?? 'queued',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: leased ? 'manager' : null,
      lease_token: leased ? ulid() : null,
      lease_expires_at: leased
        ? new Date(Date.now() + 60_000).toISOString()
        : null,
      heartbeat_at: leased ? now : null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return featureId;
}

function baseDeps(
  db: Kysely<Database>,
  daemonConfig: ReturnType<typeof DaemonConfigSchema.parse>,
) {
  return {
    db,
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 5_000,
    daemonConfig,
    resolveAdlYml: () => ADL_YML_FIXTURE,
    mainRepo: '/main/repo',
    scratchRoot: '/main/repo/.adl/scratch',
    spawnWorker: () => {
      /* no-op — this file never forks a real worker */
    },
  };
}

describe('dispatchOnce — the concurrency cap', () => {
  it('with cap 3 and 2 in flight, leases one more', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
    });
  });

  it('with cap 3 and exactly 3 in flight, leases nothing and listLeased() still returns 3 rows — the boundary case', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(3);
    });
  });

  it('with cap 3 and 4 in flight (reachable only by lowering the cap mid-flight), leases nothing and revokes nothing', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(4);
    });
  });

  it('lowering the cap from 3 to 1 with 3 in flight leaves all 3 alive; as slots open, only one replacement is dispatched per call', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const leasedIds = [
        await seedFeature(db, { repoId, state: 'leased' }),
        await seedFeature(db, { repoId, state: 'leased' }),
        await seedFeature(db, { repoId, state: 'leased' }),
      ];
      for (let i = 0; i < 5; i += 1) {
        await seedFeature(db, { repoId, state: 'queued' });
      }

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 1 },
      });

      const blocked = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(blocked.dispatched).toBe(false);
      const stillLeased = await featuresRepository(db).listLeased();
      expect(stillLeased).toHaveLength(3);
      expect(stillLeased.map((row) => row.id).sort()).toEqual(
        [...leasedIds].sort(),
      );

      // Every held lease finishes — the in-flight count drops to 0.
      const repo = featuresRepository(db);
      for (const id of leasedIds) {
        const row = await repo.findById(id);
        await repo.releaseLease({ id, leaseToken: row!.lease_token! });
      }

      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
      const afterOne = await featuresRepository(db).listLeased();
      expect(afterOne).toHaveLength(1);

      // A second call, with the one new lease still held, dispatches nothing
      // further — the cap of 1 admits exactly one replacement at a time.
      const second = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(second.dispatched).toBe(false);
      const afterTwo = await featuresRepository(db).listLeased();
      expect(afterTwo).toHaveLength(1);
    });
  });

  it('with per_repo 1 and two queued features in one repository, only one is leased even with global cap room', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5, per_repo: 1 },
      });

      const first = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(first.dispatched).toBe(true);

      const second = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(second.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(1);
    });
  });

  it('with per_repo unset, only the global cap applies', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
    });
  });

  it('with an empty daemon config, the effective global cap is 1', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({});
      expect(daemonConfig.concurrency.global).toBe(1);

      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);
    });
  });

  it('given several queued features seeded out of id order, the one leased is the lowest id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const ids = [ulid(), ulid(), ulid()].sort();
      // Insert deliberately out of sorted order.
      await seedFeature(db, { repoId, id: ids[2], state: 'queued' });
      await seedFeature(db, { repoId, id: ids[0], state: 'queued' });
      await seedFeature(db, { repoId, id: ids[1], state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(ids[0]);
    });
  });
});
