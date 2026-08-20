import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import type { Kysely } from 'kysely';
import { processIsAlive } from '@adl/workspace';
import {
  createApi,
  createControlState,
  createSupervisor,
  stopWorker,
  type ControlResult,
  type WorkerSupervisor,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';
import {
  withIgnoresStopWorker,
  withScriptedWorker,
} from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 3 Plan 07, Task 3: kill — soft stop over IPC, then SIGKILL, and the
 * feature lands in `paused` (D-27, D-28, D-29).
 *
 * `stopWorker`'s graceful and forced paths are exercised against **real
 * forked processes**, with no platform skip — the whole point of the D-28
 * amendment (`<amendment_reference>`, `03-04-PLAN.md`) is that Linux and
 * Windows now behave identically.
 */

const API_TOKEN = `test-token-${ulid()}`;

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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A feature row that is never persisted — for the pure `stopWorker` tests, which never touch a database. */
function fakeFeature(overrides: Partial<FeaturesTable> = {}): FeaturesTable {
  const id = overrides.id ?? ulid();
  const now = nowIso();
  return {
    id,
    repo_id: overrides.repo_id ?? ulid(),
    path: `features/${id}`,
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
    ...overrides,
  };
}

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
  readonly state?: string;
  readonly leaseToken?: string;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  const leased = options.leaseToken !== undefined;

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
      lease_token: options.leaseToken ?? null,
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

/** Spawn a real forked worker for an already-seeded, already-leased feature row, and wait for it to report `ready`. */
async function spawnInFlight(
  db: Kysely<Database>,
  supervisor: WorkerSupervisor,
  featureId: string,
  leaseToken: string,
): Promise<void> {
  const feature = (await featuresRepository(db).findById(featureId))!;
  supervisor.spawn(feature, leaseToken, {
    t: 'assign',
    featureId,
    leaseToken,
    workspaceHandle: feature.path,
    effectiveConfigJson: '{}',
    heartbeatIntervalMs: 1000,
    mainRepo: '/main/repo',
    scratchRoot: '/main/repo/.adl/scratch',
    baseRef: 'main',
    workspaceBackendId: 'worktree',
    roundId: 'round-1',
    stageAttemptId: 'attempt-1',
    stageId: 'develop',
    stageIndex: 0,
  });
  await waitUntil(() => supervisor.get(featureId) !== undefined);
}

describe('stopWorker', () => {
  it('against a child that handles soft_stop, exits gracefully within the grace period and never sends a signal', async () => {
    const worker = withScriptedWorker();
    const { logger } = createCapturingLogger();
    const supervisor = createSupervisor({
      entryPath: worker.entryPath,
      cwd: worker.cwd,
      execArgv: worker.execArgv,
      logger,
      leaseTtlMs: 60_000,
      renewLease: async () => true,
    });

    const feature = fakeFeature();
    process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
    try {
      supervisor.spawn(feature, feature.lease_token!, {
        t: 'assign',
        featureId: feature.id,
        leaseToken: feature.lease_token!,
        workspaceHandle: feature.path,
        effectiveConfigJson: '{}',
        heartbeatIntervalMs: 1000,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        baseRef: 'main',
        workspaceBackendId: 'worktree',
        roundId: 'round-1',
        stageAttemptId: 'attempt-1',
        stageId: 'develop',
        stageIndex: 0,
      });
      await waitUntil(() => supervisor.get(feature.id) !== undefined);
      const entry = supervisor.get(feature.id)!;
      const killSpy = vi.spyOn(entry.worker.child, 'kill');

      const graceMs = 5000;
      const startedAt = Date.now();
      const outcome = await stopWorker(supervisor, entry, graceMs, logger);
      const elapsedMs = Date.now() - startedAt;

      expect(outcome).toBe('graceful');
      expect(killSpy).not.toHaveBeenCalled();
      expect(elapsedMs).toBeLessThan(graceMs);
    } finally {
      delete process.env.ADL_TEST_STAGE_DELAY_MS;
    }
  }, 10_000);

  it('against a child that ignores soft_stop, sends SIGKILL after worker_stop_grace_ms and resolves rather than hanging', async () => {
    const worker = withIgnoresStopWorker();
    const { logger } = createCapturingLogger();
    const supervisor = createSupervisor({
      entryPath: worker.entryPath,
      cwd: worker.cwd,
      execArgv: worker.execArgv,
      logger,
      leaseTtlMs: 60_000,
      renewLease: async () => true,
    });

    const feature = fakeFeature();
    supervisor.spawn(feature, feature.lease_token!, {
      t: 'assign',
      featureId: feature.id,
      leaseToken: feature.lease_token!,
      workspaceHandle: feature.path,
      effectiveConfigJson: '{}',
      heartbeatIntervalMs: 1000,
      mainRepo: '/main/repo',
      scratchRoot: '/main/repo/.adl/scratch',
      baseRef: 'main',
      workspaceBackendId: 'worktree',
      roundId: 'round-1',
      stageAttemptId: 'attempt-1',
      stageId: 'develop',
      stageIndex: 0,
    });
    await waitUntil(() => supervisor.get(feature.id) !== undefined);
    const entry = supervisor.get(feature.id)!;
    const killSpy = vi.spyOn(entry.worker.child, 'kill');
    const pid = entry.worker.pid;

    const graceMs = 150;
    const startedAt = Date.now();
    const outcome = await stopWorker(supervisor, entry, graceMs, logger);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toBe('forced');
    // No signal name other than SIGKILL is ever passed to a forked worker's
    // kill — this spy is what proves it.
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    expect(elapsedMs).toBeGreaterThanOrEqual(graceMs);

    await waitUntil(() => !processIsAlive(pid));
  }, 10_000);

  it('against a child that is already gone, resolves immediately and sends nothing', async () => {
    const worker = withScriptedWorker();
    const { logger } = createCapturingLogger();
    const supervisor = createSupervisor({
      entryPath: worker.entryPath,
      cwd: worker.cwd,
      execArgv: worker.execArgv,
      logger,
      leaseTtlMs: 60_000,
      renewLease: async () => true,
    });

    const feature = fakeFeature();
    process.env.ADL_TEST_STAGE_DELAY_MS = '10';
    try {
      supervisor.spawn(feature, feature.lease_token!, {
        t: 'assign',
        featureId: feature.id,
        leaseToken: feature.lease_token!,
        workspaceHandle: feature.path,
        effectiveConfigJson: '{}',
        heartbeatIntervalMs: 1000,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        baseRef: 'main',
        workspaceBackendId: 'worktree',
        roundId: 'round-1',
        stageAttemptId: 'attempt-1',
        stageId: 'develop',
        stageIndex: 0,
      });
      await waitUntil(() => supervisor.get(feature.id) !== undefined);
      const entry = supervisor.get(feature.id)!;

      // Let the stage complete and the worker exit cleanly on its own.
      await waitUntil(
        () =>
          entry.worker.child.exitCode !== null ||
          entry.worker.child.signalCode !== null,
      );

      const sendSpy = vi.spyOn(entry.worker.child, 'send' as never);
      const killSpy = vi.spyOn(entry.worker.child, 'kill');

      const outcome = await stopWorker(supervisor, entry, 2000, logger);

      expect(outcome).toBe('already-gone');
      expect(sendSpy).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.ADL_TEST_STAGE_DELAY_MS;
    }
  }, 10_000);
});

describe('POST /features/:id/kill', () => {
  it('stops the worker, transitions the feature to paused, and records no escalated transition', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const leaseToken = ulid();
      const featureId = await seedFeature(db, {
        repoId,
        state: 'developing',
        leaseToken,
      });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
      const { logger } = createCapturingLogger();
      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
      });

      try {
        await spawnInFlight(db, supervisor, featureId, leaseToken);
        const pid = supervisor.get(featureId)!.worker.pid;

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          controlState: createControlState({ db }),
          supervisor,
          workerStopGraceMs: 2000,
          logger,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/features/${featureId}/kill`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as ControlResult;
          expect(body.affected).toEqual([featureId]);
        });

        const row = await featuresRepository(db).findById(featureId);
        expect(row?.state).toBe('paused');
        expect(row?.state).not.toBe('queued');

        const events = await featuresRepository(db).listEvents(featureId);
        expect(events.some((e) => e.to_state === 'escalated')).toBe(false);

        await waitUntil(() => !processIsAlive(pid));
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);
});

describe('POST /control/kill', () => {
  it("a repo-scoped kill stops only that repository's in-flight features", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoA = await seedRepo(db);
      const repoB = await seedRepo(db);
      const leaseA = ulid();
      const leaseB = ulid();
      const featureA = await seedFeature(db, {
        repoId: repoA,
        state: 'developing',
        leaseToken: leaseA,
      });
      const featureB = await seedFeature(db, {
        repoId: repoB,
        state: 'developing',
        leaseToken: leaseB,
      });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
      const { logger } = createCapturingLogger();
      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
      });

      try {
        await spawnInFlight(db, supervisor, featureA, leaseA);
        await spawnInFlight(db, supervisor, featureB, leaseB);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          controlState: createControlState({ db }),
          supervisor,
          workerStopGraceMs: 2000,
          logger,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/control/kill`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ scope: 'repo', repoId: repoA }),
            },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as ControlResult;
          expect(body.affected).toEqual([featureA]);
        });

        const rowA = await featuresRepository(db).findById(featureA);
        const rowB = await featuresRepository(db).findById(featureB);
        expect(rowA?.state).toBe('paused');
        expect(rowB?.state).toBe('developing');
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);

  it('an all-scoped kill stops every in-flight feature and parks every queued one, listing every affected id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const leaseA = ulid();
      const inFlightId = await seedFeature(db, {
        repoId,
        state: 'developing',
        leaseToken: leaseA,
      });
      const queuedId = await seedFeature(db, { repoId, state: 'queued' });

      const worker = withScriptedWorker();
      process.env.ADL_TEST_STAGE_DELAY_MS = '30000';
      const { logger } = createCapturingLogger();
      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
      });

      try {
        await spawnInFlight(db, supervisor, inFlightId, leaseA);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          controlState: createControlState({ db }),
          supervisor,
          workerStopGraceMs: 2000,
          logger,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/control/kill`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ scope: 'all' }),
            },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as ControlResult;
          expect(new Set(body.affected)).toEqual(
            new Set([inFlightId, queuedId]),
          );
        });

        const rowInFlight = await featuresRepository(db).findById(inFlightId);
        const rowQueued = await featuresRepository(db).findById(queuedId);
        expect(rowInFlight?.state).toBe('paused');
        expect(rowQueued?.state).toBe('paused');
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);
});

describe('boot/shutdown.ts reuses stopWorker', () => {
  it('imports stopWorker from lifecycle.ts and contains no second escalation implementation', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../src/boot/shutdown.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("from '../worker-supervisor/lifecycle.js'");
    expect(source).toContain('stopAllWorkers');
    expect(source).not.toContain('function raceWithTimeout');
    expect(source).not.toContain("t: 'soft_stop'");
  });
});
