import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { AdlYmlSchema, type AdlYml, type DaemonConfig } from '@adl/core/config';
import {
  featuresRepository,
  metaRepository,
  migrateToLatest,
  nowIso,
} from '@adl/db';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { startDaemon } from '../../src/daemon.js';
import {
  BackendUnavailableError,
  runBackendPreflight,
  SUPPORTED_BACKEND_ID,
  type BackendVersionCheckResult,
} from '../../src/boot/backend-preflight.js';
import {
  DAEMON_SCHEMA_VERSION,
  SchemaVersionRefusalError,
} from '../../src/boot/startup.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
// Reused directly, per 03-CONTEXT.md's read_first list.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * 04-07 Task 2: the backend startup gate (D-01, D-02) — a broken CLI
 * installation stops the daemon before it leases a single feature, mirroring
 * `runStartupGate`'s own refuse/proceed shape exactly.
 */

const API_TOKEN = `test-token-${ulid()}`;
const PINNED_VERSION = '2.1.237';

const ADL_YML_FIXTURE: AdlYml = AdlYmlSchema.parse({
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
  pipeline: ['develop'],
});

function daemonConfigFixture(
  overrides: Partial<DaemonConfig> = {},
): DaemonConfig {
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
    ...overrides,
  };
}

function okVersionCheck(): () => Promise<BackendVersionCheckResult> {
  return () =>
    Promise.resolve({ stdout: `${PINNED_VERSION} (Claude Code)`, exitCode: 0 });
}

function mismatchedVersionCheck(): () => Promise<BackendVersionCheckResult> {
  return () => Promise.resolve({ stdout: '9.9.9 (Claude Code)', exitCode: 0 });
}

function missingBinaryVersionCheck(): () => Promise<BackendVersionCheckResult> {
  return () => Promise.resolve({ stdout: '', exitCode: 1 });
}

function unreadableVersionCheck(): () => Promise<BackendVersionCheckResult> {
  return () => Promise.resolve({ stdout: 'garbage', exitCode: 0 });
}

/** A free ephemeral port, released immediately — used only as a FIXED port number a refused `startDaemon` must never bind. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Whether `port` can be bound right now — proof that a refused `startDaemon` left nothing listening on it. */
async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function seedRepo(db: Kysely<Database>, id: string): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://example.invalid/repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedQueuedFeature(
  db: Kysely<Database>,
  repoId: string,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  await featuresRepository(db).insert({
    id: featureId,
    repo_id: repoId,
    path: `features/${featureId}`,
    state: 'queued',
    state_version: 1,
    round: 0,
    current_stage_index: 0,
    spec_hash: 'x',
    effective_config_json: null,
    workspace_handle: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    heartbeat_at: now,
    crash_count: 0,
    created_at: now,
    updated_at: now,
  });
  return featureId;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 15 } = {},
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

describe('runBackendPreflight (unit)', () => {
  it('passes for the pinned version', async () => {
    const { logger } = createCapturingLogger();
    const outcome = await runBackendPreflight({
      backendId: SUPPORTED_BACKEND_ID,
      runVersionCheck: okVersionCheck(),
      logger,
    });
    expect(outcome.kind).toBe('passed');
  });

  it('refuses a version mismatch, naming expected, found, and "broken"', async () => {
    const { logger } = createCapturingLogger();
    const outcome = await runBackendPreflight({
      backendId: SUPPORTED_BACKEND_ID,
      runVersionCheck: mismatchedVersionCheck(),
      logger,
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('backend-unavailable');
      expect(outcome.refusal.message).toContain(PINNED_VERSION);
      expect(outcome.refusal.message).toContain('9.9.9');
      expect(outcome.refusal.message.toLowerCase()).toContain('broken');
    }
  });

  it('refuses a missing binary', async () => {
    const { logger } = createCapturingLogger();
    const outcome = await runBackendPreflight({
      backendId: SUPPORTED_BACKEND_ID,
      runVersionCheck: missingBinaryVersionCheck(),
      logger,
    });
    expect(outcome.kind).toBe('refused');
    if (
      outcome.kind === 'refused' &&
      outcome.refusal.reason === 'backend-unavailable'
    ) {
      expect(outcome.refusal.preflight.kind).toBe('binary_missing');
    }
  });

  it('refuses unreadable version output', async () => {
    const { logger } = createCapturingLogger();
    const outcome = await runBackendPreflight({
      backendId: SUPPORTED_BACKEND_ID,
      runVersionCheck: unreadableVersionCheck(),
      logger,
    });
    expect(outcome.kind).toBe('refused');
    if (
      outcome.kind === 'refused' &&
      outcome.refusal.reason === 'backend-unavailable'
    ) {
      expect(outcome.refusal.preflight.kind).toBe('unparseable');
    }
  });

  it('refuses a backend id this build does not implement — "no agent backend configured"', async () => {
    const { logger } = createCapturingLogger();
    const outcome = await runBackendPreflight({
      backendId: 'not-a-real-backend',
      runVersionCheck: okVersionCheck(),
      logger,
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('no-backend-configured');
    }
  });
});

describe('startDaemon — backend preflight gate (04-07)', () => {
  it('with a preflight that reports ok, returns a handle and dispatches normally', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        daemonConfig: daemonConfigFixture(),
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        agentBackendVersionCheck: okVersionCheck(),
      });
      try {
        expect(handle.port).toBeGreaterThan(0);
      } finally {
        await handle.stop();
      }
    });
  });

  it('rejects with a named error naming expected, found, and "broken" for a version mismatch', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await expect(
        startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: mismatchedVersionCheck(),
        }),
      ).rejects.toThrow(BackendUnavailableError);

      // A fresh attempt to inspect the thrown error's own fields.
      let caught: unknown;
      try {
        await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: mismatchedVersionCheck(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackendUnavailableError);
      const err = caught as BackendUnavailableError;
      expect(err.message).toContain(PINNED_VERSION);
      expect(err.message).toContain('9.9.9');
      expect(err.message.toLowerCase()).toContain('broken');
    });
  });

  it('rejects the same way for a missing binary and for unreadable version output', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await expect(
        startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: missingBinaryVersionCheck(),
        }),
      ).rejects.toThrow(BackendUnavailableError);
    });

    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await expect(
        startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: unreadableVersionCheck(),
        }),
      ).rejects.toThrow(BackendUnavailableError);
    });
  });

  it('when the gate refuses, no feature is leased — a queued feature stays queued and no worker was forked', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = 'repo-1';
      await seedRepo(db, repoId);
      const featureId = await seedQueuedFeature(db, repoId);

      await expect(
        startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture({
            repos: [
              {
                id: repoId,
                remote_url: 'https://example.invalid/repo.git',
                default_branch: 'main',
                forge: 'github',
                features_dir: 'features',
              },
            ],
          }),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: mismatchedVersionCheck(),
        }),
      ).rejects.toThrow(BackendUnavailableError);

      // `startDaemon` throws before `createSupervisor` is even constructed
      // (placement in daemon.ts) — no worker could have been forked. The
      // feature row is the observable proof: still queued, never leased.
      const row = await featuresRepository(db).findById(featureId);
      expect(row?.state).toBe('queued');
      expect(row?.lease_token).toBeNull();
    });
  });

  it('when the gate refuses, no server is left listening on the requested port', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const port = await freePort();

      await expect(
        startDaemon({
          dbFilePath: filePath,
          port,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          agentBackendVersionCheck: mismatchedVersionCheck(),
        }),
      ).rejects.toThrow(BackendUnavailableError);

      expect(await canBind(port)).toBe(true);
    });
  });

  it('a daemon configured with no agent backend refuses to start with a named error', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      let caught: unknown;
      try {
        await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture({
            agents: {
              developer: { backend: 'not-a-real-backend', model: 'default' },
            },
          }),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          // Supplied so the gate is not silently skipped — a real caller
          // that has wired preflight at all still hits this refusal for an
          // id this build cannot check.
          agentBackendVersionCheck: okVersionCheck(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackendUnavailableError);
      const err = caught as BackendUnavailableError;
      expect(err.refusal.reason).toBe('no-backend-configured');
    });
  });

  it('the schema gate is evaluated before the backend gate', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await metaRepository(db).setSchemaVersion(
        DAEMON_SCHEMA_VERSION + 1,
        new Date().toISOString(),
      );

      let caught: unknown;
      try {
        await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          // A backend refusal is ALSO true here (version mismatch), but the
          // schema refusal must surface first — refusing both and observing
          // which error surfaces is the point of this test.
          agentBackendVersionCheck: mismatchedVersionCheck(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaVersionRefusalError);
      expect(caught).not.toBeInstanceOf(BackendUnavailableError);
    });
  });

  it('runs once per daemon start: a daemon that dispatches three features invokes the version check exactly once', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = 'repo-1';
      await seedRepo(db, repoId);
      const featureIds = [
        await seedQueuedFeature(db, repoId),
        await seedQueuedFeature(db, repoId),
        await seedQueuedFeature(db, repoId),
      ];

      let calls = 0;
      const spiedVersionCheck = () => {
        calls++;
        return okVersionCheck()();
      };

      const scripted = withScriptedWorker();
      const readyPids: number[] = [];

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 200,
        daemonConfig: daemonConfigFixture({
          concurrency: { global: 3 },
          repos: [
            {
              id: repoId,
              remote_url: 'https://example.invalid/repo.git',
              default_branch: 'main',
              forge: 'github',
              features_dir: 'features',
            },
          ],
        }),
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        agentBackendVersionCheck: spiedVersionCheck,
        workerEntryPath: scripted.entryPath,
        workerExecArgv: scripted.execArgv,
        workerEnv: { ADL_TEST_STAGE_DELAY_MS: '10' },
        dispatchIntervalMs: 10,
        onWorkerReady: (ready) => readyPids.push(ready.pid),
      });

      try {
        await waitUntil(() => readyPids.length >= featureIds.length, {
          timeoutMs: 10_000,
        });
      } finally {
        await handle.stop();
      }

      expect(calls).toBe(1);
    });
  });
});
