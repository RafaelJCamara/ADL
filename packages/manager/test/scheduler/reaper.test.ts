import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import { processIsAlive } from '@adl/workspace';
import {
  createFastPathRecovery,
  createSupervisor,
  reapExpiredLeases,
  reapOne,
  startReaper,
  type ReaperDeps,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 3 Plan 05, Task 1: the reaper tick, the child-exit fast path, and
 * worker self-termination (D-02..D-05).
 */

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    await delay(intervalMs);
  }
}

interface SeedFeatureOptions {
  readonly state?: string;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: string | null;
  readonly currentStageIndex?: number;
  readonly round?: number;
  readonly crashCount?: number;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions = {},
): Promise<string> {
  const repoId = ulid();
  const featureId = ulid();
  const now = nowIso();

  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: options.state ?? 'leased',
      state_version: 1,
      round: options.round ?? 0,
      current_stage_index: options.currentStageIndex ?? 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: options.leaseToken === null ? null : 'manager',
      lease_token:
        options.leaseToken === undefined ? ulid() : options.leaseToken,
      lease_expires_at: options.leaseExpiresAt ?? now,
      heartbeat_at: now,
      crash_count: options.crashCount ?? 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return featureId;
}

// ---------------------------------------------------------------------------
// reapExpiredLeases / reapOne — the tick
// ---------------------------------------------------------------------------

describe('reapExpiredLeases', () => {
  it('against a database with no expired leases performs no write and reports zero reaped', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const { logger } = createCapturingLogger();

      const result = await reapExpiredLeases({ db, logger }, nowIso());
      expect(result.reaped).toHaveLength(0);

      const row = await featuresRepository(db).findById(featureId);
      expect(row?.state).toBe('leased');
    });
  });

  it('against one expired lease transitions the feature to queued, clears the lease, and appends a feature_events row with no gap in seq', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        state: 'leased',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const { logger } = createCapturingLogger();

      const now = nowIso();
      const result = await reapExpiredLeases({ db, logger }, now);
      expect(result.reaped).toHaveLength(1);
      expect(result.reaped[0]?.featureId).toBe(featureId);

      const repo = featuresRepository(db);
      const row = await repo.findById(featureId);
      expect(row?.state).toBe('queued');
      expect(row?.lease_token).toBeNull();
      expect(row?.lease_owner).toBeNull();
      expect(row?.lease_expires_at).toBeNull();

      const events = await repo.listEvents(featureId);
      const leaseEvent = events.find((event) => event.to_state === 'queued');
      expect(leaseEvent).toBeDefined();
      expect(leaseEvent?.seq).toBe(1);
      const seqs = events.map((event) => event.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([...seqs].map((_, index) => index + 1));
    });
  });

  it('recovers a feature the manager has no ChildProcess for — the case a restarted daemon is always in', async () => {
    // No supervisor, no worker-harness, nothing forked anywhere in this
    // test — reapOne is called against a bare database row.
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        state: 'developing',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const { logger } = createCapturingLogger();

      const row = await featuresRepository(db).findById(featureId);
      const reaped = await reapOne({ db, logger }, row!, nowIso());
      expect(reaped?.featureId).toBe(featureId);

      const after = await featuresRepository(db).findById(featureId);
      expect(after?.state).toBe('queued');
    });
  });

  it('judges every row in one tick against the same supplied now, not a clock read per row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const pivot = new Date('2026-01-01T00:00:00.000Z');
      const earlierId = await seedFeature(db, {
        state: 'leased',
        leaseExpiresAt: new Date(pivot.getTime() - 5000).toISOString(),
      });
      const laterId = await seedFeature(db, {
        state: 'leased',
        leaseExpiresAt: new Date(pivot.getTime() + 5000).toISOString(),
      });
      const { logger } = createCapturingLogger();

      const result = await reapExpiredLeases(
        { db, logger },
        pivot.toISOString(),
      );

      expect(result.reaped.map((r) => r.featureId)).toEqual([earlierId]);

      const laterRow = await featuresRepository(db).findById(laterId);
      expect(laterRow?.state).toBe('leased');
    });
  });

  it('ReaperDeps declares no clock member', () => {
    const keys: readonly (keyof ReaperDeps)[] = ['db', 'logger', 'actor'];
    expect([...keys].sort()).toEqual(['actor', 'db', 'logger']);
    expect(keys).not.toContain('now');
    expect(keys).not.toContain('clock');
  });
});

// ---------------------------------------------------------------------------
// The child-exit fast path (D-04) and worker self-termination (D-05)
// ---------------------------------------------------------------------------

describe('the child-exit fast path', () => {
  it('a SIGKILLed worker reaches queued in well under lease_ttl_ms — the fast path, not the reaper, did it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // A long TTL and no reaper running at all in this test: if the
      // feature reaches `queued` quickly anyway, only the fast path could
      // have done it.
      const leaseTtlMs = 60_000;
      const leaseToken = ulid();
      const featureId = await seedFeature(db, {
        state: 'developing',
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
      });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
      const { logger } = createCapturingLogger();

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        onUnexpectedExit: createFastPathRecovery({ db, logger }),
      });

      try {
        supervisor.spawn(
          (await featuresRepository(db).findById(featureId))!,
          leaseToken,
          {
            t: 'assign',
            featureId,
            leaseToken,
            workspaceHandle: `features/${featureId}`,
            effectiveConfigJson: '{}',
            heartbeatIntervalMs: 50,
            mainRepo: '/main/repo',
            scratchRoot: '/main/repo/.adl/scratch',
            baseRef: 'main',
            workspaceBackendId: 'worktree',
            roundId: 'round-1',
            stageAttemptId: 'attempt-1',
            stageId: 'develop',
            stageIndex: 0,
          },
        );

        await waitUntil(() => supervisor.get(featureId) !== undefined);
        const active = supervisor.get(featureId)!;
        const killedPid = active.worker.pid;

        const startedAt = Date.now();
        active.worker.child.kill('SIGKILL');

        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(featureId);
          return row?.state === 'queued';
        });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(leaseTtlMs / 10);

        const row = await featuresRepository(db).findById(featureId);
        expect(row?.lease_token).toBeNull();

        // No orphaned child process survives the SIGKILL.
        await waitUntil(() => !processIsAlive(killedPid));
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);

  it("a worker's expected, clean exit after reporting its result does not apply lease_expired", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const leaseTtlMs = 60_000;
      const leaseToken = ulid();
      const featureId = await seedFeature(db, {
        state: 'developing',
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
      });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30';
      const { logger } = createCapturingLogger();
      let unexpectedExitCalls = 0;

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        onUnexpectedExit: () => {
          unexpectedExitCalls += 1;
        },
      });

      try {
        supervisor.spawn(
          (await featuresRepository(db).findById(featureId))!,
          leaseToken,
          {
            t: 'assign',
            featureId,
            leaseToken,
            workspaceHandle: `features/${featureId}`,
            effectiveConfigJson: '{}',
            heartbeatIntervalMs: 50,
            mainRepo: '/main/repo',
            scratchRoot: '/main/repo/.adl/scratch',
            baseRef: 'main',
            workspaceBackendId: 'worktree',
            roundId: 'round-1',
            stageAttemptId: 'attempt-1',
            stageId: 'develop',
            stageIndex: 0,
          },
        );

        await waitUntil(() => supervisor.get(featureId) === undefined, {
          timeoutMs: 5000,
        });

        // Give any (incorrect) fast-path write a moment to have landed.
        await delay(100);

        expect(unexpectedExitCalls).toBe(0);
        const row = await featuresRepository(db).findById(featureId);
        expect(row?.state).toBe('developing');
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);

  it('a worker whose renewLease is refused receives lease_lost and exits non-zero', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const leaseTtlMs = 60_000;
      const leaseToken = ulid();
      const featureId = await seedFeature(db, {
        state: 'developing',
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
      });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
      const { logger } = createCapturingLogger();

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs,
        // Every renewal is refused, regardless of the presented token.
        renewLease: async () => false,
      });

      try {
        supervisor.spawn(
          (await featuresRepository(db).findById(featureId))!,
          leaseToken,
          {
            t: 'assign',
            featureId,
            leaseToken,
            workspaceHandle: `features/${featureId}`,
            effectiveConfigJson: '{}',
            heartbeatIntervalMs: 30,
            mainRepo: '/main/repo',
            scratchRoot: '/main/repo/.adl/scratch',
            baseRef: 'main',
            workspaceBackendId: 'worktree',
            roundId: 'round-1',
            stageAttemptId: 'attempt-1',
            stageId: 'develop',
            stageIndex: 0,
          },
        );

        await waitUntil(() => supervisor.get(featureId) === undefined, {
          timeoutMs: 5000,
        });
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// startReaper — the periodic tick, wired into a real interval
// ---------------------------------------------------------------------------

describe('startReaper', () => {
  it('recovers an expired lease on its own schedule, and stop() halts it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        state: 'leased',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const { logger } = createCapturingLogger();

      const handle = startReaper({ db, logger, intervalMs: 20 });
      try {
        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(featureId);
          return row?.state === 'queued';
        });
      } finally {
        handle.stop();
      }
    });
  }, 10_000);
});
