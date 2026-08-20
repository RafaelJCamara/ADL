import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import {
  featuresRepository,
  metaRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import {
  createApi,
  createControlState,
  createSupervisor,
  dispatchOnce,
  parkOnRoundBoundary,
  type ControlResult,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 3 Plan 07, Task 2: pause and resume (D-26) — a brake on new work,
 * never a kill.
 */

const API_TOKEN = `test-token-${ulid()}`;

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
  readonly leaseToken?: string | null;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  const leased =
    options.leaseToken !== undefined && options.leaseToken !== null;

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

function apiFor(
  db: Kysely<Database>,
  controlState: ReturnType<typeof createControlState>,
) {
  return createApi({
    apiToken: API_TOKEN,
    schemaVersion: 1,
    listFeatureViews: async () => [],
    db,
    controlState,
  });
}

function dispatchDeps(
  db: Kysely<Database>,
  controlState: ReturnType<typeof createControlState>,
  concurrency: { global?: number; per_repo?: number } = { global: 5 },
) {
  return {
    db,
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 5_000,
    daemonConfig: DaemonConfigSchema.parse({ concurrency }),
    resolveAdlYml: () => ADL_YML_FIXTURE,
    mainRepo: '/main/repo',
    scratchRoot: '/main/repo/.adl/scratch',
    controlState,
    spawnWorker: () => {
      /* no-op */
    },
  };
}

describe('POST /control/pause and /control/resume', () => {
  it('stops dispatch: a subsequent dispatchOnce leases nothing even with the cap free and features queued', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/control/pause`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: 'all' }),
        });
        expect(response.status).toBe(200);
      });

      const decision = await dispatchOnce(dispatchDeps(db, controlState));
      expect(decision.dispatched).toBe(false);
    });
  });

  it('restores dispatch and a previously parked feature returns to queued', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, { repoId, state: 'paused' });

      const controlState = createControlState({ db });
      await controlState.setGlobalPause(true);
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/control/resume`,
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
        expect(body.affected).toContain(featureId);
      });

      expect(controlState.isGlobalPaused()).toBe(false);
      const row = await featuresRepository(db).findById(featureId);
      expect(row?.state).toBe('queued');
    });
  });

  it('persists the global_pause meta row on pause, and clears it on resume (G-03-3)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const pauseResponse = await fetch(
          `http://127.0.0.1:${port}/control/pause`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ scope: 'all' }),
          },
        );
        expect(pauseResponse.status).toBe(200);

        const pausedRow = await metaRepository(db).getGlobalPause();
        expect(pausedRow).toEqual({ kind: 'valid', paused: true });

        const resumeResponse = await fetch(
          `http://127.0.0.1:${port}/control/resume`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ scope: 'all' }),
          },
        );
        expect(resumeResponse.status).toBe(200);

        const resumedRow = await metaRepository(db).getGlobalPause();
        expect(resumedRow).toEqual({ kind: 'valid', paused: false });
      });
    });
  });

  it('a repo-scoped pause leaves features in other repositories dispatchable', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoA = await seedRepo(db);
      const repoB = await seedRepo(db);
      await seedFeature(db, { repoId: repoA, state: 'queued' });
      const bId = await seedFeature(db, { repoId: repoB, state: 'queued' });

      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/control/pause`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: 'repo', repoId: repoA }),
        });
        expect(response.status).toBe(200);
      });

      const decision = await dispatchOnce(dispatchDeps(db, controlState));
      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(bId);
    });
  });
});

describe('POST /features/:id/pause and /features/:id/resume', () => {
  it('parks a queued feature and leaves dispatch running for others', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoA = await seedRepo(db);
      const repoB = await seedRepo(db);
      const targetId = await seedFeature(db, {
        repoId: repoA,
        state: 'queued',
      });
      const otherId = await seedFeature(db, { repoId: repoB, state: 'queued' });

      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/features/${targetId}/pause`,
          { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}` } },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as ControlResult;
        expect(body.affected).toEqual([targetId]);
      });

      const target = await featuresRepository(db).findById(targetId);
      expect(target?.state).toBe('paused');

      const decision = await dispatchOnce(dispatchDeps(db, controlState));
      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(otherId);
    });
  });

  it('on an unknown id responds 404 and writes no feature_events row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/features/${ulid()}/pause`,
          { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}` } },
        );
        expect(response.status).toBe(404);
      });

      const events = await db
        .selectFrom('feature_events')
        .selectAll()
        .execute();
      expect(events).toHaveLength(0);
    });
  });

  it('writes a feature_events row whose actor field is non-empty', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, { repoId, state: 'queued' });
      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        await fetch(`http://127.0.0.1:${port}/features/${featureId}/pause`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
      });

      const events = await featuresRepository(db).listEvents(featureId);
      const pauseEvent = events.find((e) => e.to_state === 'paused');
      expect(pauseEvent).toBeDefined();
      expect(pauseEvent?.actor).toBeTruthy();
    });
  });

  it('pausing an already-paused feature responds with a success status and reports zero changed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, { repoId, state: 'paused' });
      const controlState = createControlState({ db });
      const app = apiFor(db, controlState);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/features/${featureId}/pause`,
          { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}` } },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as ControlResult;
        expect(body.affected).toEqual([]);
      });
    });
  });
});

describe('the round boundary (D-26): parking in-flight work', () => {
  it('a feature already in flight when a global pause arrives finishes its current round and only then transitions to paused', async () => {
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
      process.env.ADL_TEST_STAGE_DELAY_MS = '250';
      const { logger } = createCapturingLogger();
      const controlState = createControlState({ db });
      let unexpectedExitCalls = 0;

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        // WR-02 regression coverage: a real async DB round-trip here (not
        // the omitted-dep short-circuit the old version of this test used)
        // exercises the exact `await` the fast-path exit race sits behind.
        // If `expectingExit` were only set after this await resolves, the
        // scripted worker's near-immediate `exitNow(0)` following its
        // `stage_result` could still race the parent's own `'exit'` handler
        // and misfire the fast path.
        getCurrentLeaseToken: (id) =>
          featuresRepository(db)
            .findById(id)
            .then((row) => row?.lease_token ?? null),
        onUnexpectedExit: () => {
          unexpectedExitCalls += 1;
        },
        onRoundBoundary: (params) => {
          void parkOnRoundBoundary(
            db,
            controlState,
            params.featureId,
            params.repoId,
            'pause-park',
          );
        },
      });

      try {
        const feature = (await featuresRepository(db).findById(featureId))!;
        supervisor.spawn(feature, leaseToken, {
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
        });

        await waitUntil(() => supervisor.get(featureId) !== undefined);

        // Pause arrives mid-round — well before the scripted stage's own delay
        // elapses.
        await controlState.setGlobalPause(true);

        const midRound = await featuresRepository(db).findById(featureId);
        expect(midRound?.state).toBe('developing');

        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(featureId);
          return row?.state === 'paused';
        });

        const events = await featuresRepository(db).listEvents(featureId);
        const pauseEvent = events.find((e) => e.to_state === 'paused');
        expect(pauseEvent).toBeDefined();
        expect(pauseEvent?.actor).toBeTruthy();

        // WR-02: the worker's near-immediate exit after `stage_result` must
        // never be misclassified as unexpected — `expectingExit` is marked
        // synchronously before the fence check's `await`, so the fast path
        // must not have fired even once.
        expect(unexpectedExitCalls).toBe(0);
      } finally {
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
      }
    });
  }, 10_000);
});
