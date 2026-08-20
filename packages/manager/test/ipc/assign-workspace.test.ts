import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import type { WorkspaceSpec } from '@adl/core/stage';
import {
  createDb,
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import {
  dispatchOnce,
  IPC_MESSAGE_KINDS,
  parseManagerMessage,
  startDaemon,
  type AssignMessage,
  type SpawnCall,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * Phase 4 Plan 04, Task 1: the `assign` message carries everything a worker
 * needs to build its own workspace — `mainRepo`, `scratchRoot`, `baseRef`,
 * `workspaceBackendId` — plus the round/attempt addressing the worker needs
 * to name its own transcript and attribute usage without ever reading the
 * database.
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

const DAEMON_CONFIG: DaemonConfig = DaemonConfigSchema.parse({});

const VALID_ASSIGN = {
  t: 'assign',
  featureId: 'feature-1',
  leaseToken: 'lease-1',
  workspaceHandle: '/main/repo/features/feature-1',
  effectiveConfigJson: '{}',
  heartbeatIntervalMs: 5000,
  mainRepo: '/main/repo',
  scratchRoot: '/main/repo/.adl/scratch',
  baseRef: 'main',
  workspaceBackendId: 'worktree',
  roundId: 'round-1',
  stageAttemptId: 'attempt-1',
  stageId: 'develop',
  stageIndex: 0,
  logsRoot: '/main/repo/.adl/logs',
} as const;

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

async function seedRepo(
  db: Kysely<Database>,
  defaultBranch = 'main',
): Promise<string> {
  const id = ulid();
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: defaultBranch,
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
  readonly workspaceHandle?: string | null;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: options.repoId,
      path: `features/${featureId}`,
      state: 'queued',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: options.workspaceHandle ?? null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return featureId;
}

describe('parseManagerMessage — assign carries the workspace spec', () => {
  it('rejects an assign missing mainRepo, scratchRoot, baseRef, or workspaceBackendId, each a named failure', () => {
    for (const field of [
      'mainRepo',
      'scratchRoot',
      'baseRef',
      'workspaceBackendId',
    ] as const) {
      const result = parseManagerMessage(omit(VALID_ASSIGN, field));
      expect(result.ok, `expected missing ${field} to fail`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(field);
      }
    }
  });

  it('rejects an assign whose workspaceBackendId is not a registered backend id', () => {
    const result = parseManagerMessage({
      ...VALID_ASSIGN,
      workspaceBackendId: 'nonexistent-backend',
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a fully-populated assign, and the parsed workspace fields reconstruct a valid WorkspaceSpec', () => {
    const result = parseManagerMessage(VALID_ASSIGN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const message = result.message as AssignMessage;

    const spec: WorkspaceSpec = {
      featureId: message.featureId,
      mainRepo: message.mainRepo,
      scratchRoot: message.scratchRoot,
      baseRef: message.baseRef,
    };
    expect(spec).toEqual({
      featureId: VALID_ASSIGN.featureId,
      mainRepo: VALID_ASSIGN.mainRepo,
      scratchRoot: VALID_ASSIGN.scratchRoot,
      baseRef: VALID_ASSIGN.baseRef,
    });
  });
});

describe('IPC_MESSAGE_KINDS', () => {
  it('is unchanged by this plan — still exactly 7 entries', () => {
    expect(IPC_MESSAGE_KINDS).toHaveLength(7);
  });
});

describe('dispatchOnce — the assign message is self-sufficient', () => {
  it('carries the configured main repository and the repo row default_branch as baseRef', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db, 'develop-branch');
      const featureId = await seedFeature(db, { repoId });
      const spawnCalls: SpawnCall[] = [];

      const decision = await dispatchOnce({
        db,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/srv/adl/main-repo',
        scratchRoot: '/srv/adl/scratch',
        spawnWorker: (call) => spawnCalls.push(call),
      });

      expect(decision.dispatched).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      const { assign } = spawnCalls[0]!;
      expect(assign.featureId).toBe(featureId);
      expect(assign.mainRepo).toBe('/srv/adl/main-repo');
      expect(assign.scratchRoot).toBe('/srv/adl/scratch');
      expect(assign.baseRef).toBe('develop-branch');
      expect(assign.workspaceBackendId).toBe('worktree');
      expect(assign.roundId).toBeTruthy();
      expect(assign.stageAttemptId).toBeTruthy();
      expect(assign.stageId).toBe('develop');
      expect(assign.stageIndex).toBe(0);
      // 04-06: absent from DispatcherDeps, dispatchOnce defaults logsRoot to
      // the scratchRoot-colocated path — always a real, non-empty string on
      // the assign message, never left for the worker to guess.
      expect(assign.logsRoot).toBeTruthy();
    });
  });

  it('fails the dispatch, without throwing, when the feature repo_id has no repos row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // `features.repo_id` is FK-enforced against `repos.id` in normal
      // operation (D-35's reconciliation always inserts the repo row
      // first), so this state is reached here only by disabling the
      // constraint for this one seed — the point is to prove dispatchOnce's
      // own defensive check, for the case a repo row is removed out from
      // under a feature between reconciliation runs.
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      const featureId = await seedFeature(db, { repoId: 'no-such-repo' });
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      const decision = await dispatchOnce({
        db,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/srv/adl/main-repo',
        scratchRoot: '/srv/adl/scratch',
        spawnWorker: () => {
          /* should never be called */
        },
      });

      expect(decision.dispatched).toBe(false);
      const row = await featuresRepository(db).findById(featureId);
      // Refused before ever acquiring a lease.
      expect(row?.lease_token).toBeNull();
      expect(row?.state).toBe('queued');
    });
  });

  it('leaves workspace_handle unchanged for a feature that already has one, and writes one on a first-ever lease', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const existingHandle = '/srv/adl/main-repo/features/recovered';
      const recoveredFeatureId = await seedFeature(db, {
        repoId,
        workspaceHandle: existingHandle,
      });
      const freshFeatureId = await seedFeature(db, {
        repoId,
        workspaceHandle: null,
      });

      const baseDeps = {
        db,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: DaemonConfigSchema.parse({ concurrency: { global: 5 } }),
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/srv/adl/main-repo',
        scratchRoot: '/srv/adl/scratch',
      };

      const spawnCalls: SpawnCall[] = [];
      // Dispatch twice — one call per queued feature, FIFO by id.
      await dispatchOnce({
        ...baseDeps,
        spawnWorker: (call) => spawnCalls.push(call),
      });
      await dispatchOnce({
        ...baseDeps,
        spawnWorker: (call) => spawnCalls.push(call),
      });

      const recoveredRow =
        await featuresRepository(db).findById(recoveredFeatureId);
      expect(recoveredRow?.workspace_handle).toBe(existingHandle);

      const freshRow = await featuresRepository(db).findById(freshFeatureId);
      expect(freshRow?.workspace_handle).toBeTruthy();
      expect(freshRow?.workspace_handle).not.toBe(existingHandle);
    });
  });
});

describe('startDaemon — the scratch root', () => {
  // A hand-managed temp directory rather than `withTempDb`: this suite
  // pre-migrates the database with its own short-lived connection (matching
  // every other `startDaemon` test's convention of running `migrateToLatest`
  // before the daemon's own `runStartupGate` sees the file — that gate
  // seeds an absent `schema_version` *value* in an already-migrated `meta`
  // table; it does not create the table itself) and closes that connection
  // before `startDaemon` opens its own, so there is never a second handle
  // on the file for `fs.rm`'s cleanup to contend with.
  async function withTempDbFile<T>(
    fn: (filePath: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'adl-manager-scratch-'));
    try {
      const filePath = join(dir, 'adl.db');
      const seedDb = createDb(filePath);
      await migrateToLatest(seedDb, MIGRATIONS_DIR);
      await seedDb.destroy();
      return await fn(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('is created at startup when absent, defaulting beside the database file', async () => {
    await withTempDbFile(async (filePath) => {
      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: `test-token-${ulid()}`,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        dispatchIntervalMs: 5_000,
      });
      try {
        const expectedDefault = join(dirname(filePath), 'scratch');
        expect(existsSync(expectedDefault)).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });

  it('is created at the configured path when one is given', async () => {
    await withTempDbFile(async (filePath) => {
      const scratchRoot = join(dirname(filePath), 'custom-scratch-dir');
      expect(existsSync(scratchRoot)).toBe(false);

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: `test-token-${ulid()}`,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        scratchRoot,
        dispatchIntervalMs: 5_000,
      });
      try {
        expect(existsSync(scratchRoot)).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });
});
