import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import { startDaemon } from '../../src/daemon.js';
import { restoreGlobalPause } from '../../src/boot/startup.js';
import { MIGRATIONS_DIR, withTempDb } from '../../../db/test/helpers/temp-db.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 3 Plan 10, Task 1: G-03-3's own proof — a global `adl pause`
 * survives a daemon restart. Two real `startDaemon` processes share one
 * database file; the first pauses and stops, the second must boot still
 * paused, and only `adl resume` against the second lets the very same
 * feature dispatch (the non-vacuity half — see `03-10-PLAN.md`'s own
 * warning that a fixture that never dispatches would pass the negative half
 * of this test forever).
 */

const API_TOKEN = `pause-persist-token-${ulid()}`;

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

function daemonConfigFixture(): DaemonConfig {
  return DaemonConfigSchema.parse({
    worker_stop_grace_ms: 200,
    concurrency: { global: 5 },
  });
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postControl(
  port: number,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('restoreGlobalPause', () => {
  it('returns false against a migrated database with no global_pause row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger } = createCapturingLogger();

      const result = await restoreGlobalPause({ db, logger });

      expect(result).toBe(false);
    });
  });
});

describe('a global pause survives a daemon restart (G-03-3)', () => {
  it('a daemon paused via POST /control/pause stays paused across a restart, and only adl resume lets it dispatch', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const repoId = 'repo-1';
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

      const worker = withScriptedWorker();

      // --- First daemon: pause globally (with no feature queued yet — the
      // brake this test proves is the *persisted flag*, not incidental
      // feature-row state a synchronous park could produce), then stop.
      let firstWorkerReadyCount = 0;
      const first = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: daemonConfigFixture(),
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        workerEntryPath: worker.entryPath,
        workerCwd: worker.cwd,
        workerExecArgv: worker.execArgv,
        dispatchIntervalMs: 5_000, // effectively disabled for this window
        onWorkerReady: () => {
          firstWorkerReadyCount += 1;
        },
      });

      try {
        const pauseResponse = await postControl(first.port, '/control/pause', {
          scope: 'all',
        });
        expect(pauseResponse.status).toBe(200);
      } finally {
        await first.stop();
      }
      expect(firstWorkerReadyCount).toBe(0);

      // A feature queued only *after* the pause request — it was never
      // touched by the pause's own synchronous park-the-queue loop, so it
      // stays genuinely dispatchable on its own terms. If the persisted
      // brake did not hold, this is exactly the feature the second daemon
      // would dispatch.
      const featureId = 'feature-pause-persist-1';
      await db
        .insertInto('features')
        .values({
          id: featureId,
          repo_id: repoId,
          path: `features/${featureId}`,
          state: 'queued',
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
          created_at: now,
          updated_at: now,
        })
        .execute();

      // --- Second daemon, same database file: dispatch must still be
      // stopped, across a window spanning many dispatch intervals.
      let secondWorkerReadyCount = 0;
      const second = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5_000,
        daemonConfig: daemonConfigFixture(),
        resolveAdlYml: () => ADL_YML_FIXTURE,
        migrationsDir: MIGRATIONS_DIR,
        workerEntryPath: worker.entryPath,
        workerCwd: worker.cwd,
        workerExecArgv: worker.execArgv,
        dispatchIntervalMs: 20,
        onWorkerReady: () => {
          secondWorkerReadyCount += 1;
        },
      });

      try {
        // 300ms at a 20ms tick is ~15 dispatch attempts — a real window, not
        // a single lucky check.
        await sleep(300);

        const stillQueued = await featuresRepository(db).findById(featureId);
        expect(stillQueued?.state).toBe('queued');
        expect(stillQueued?.lease_token).toBeNull();
        expect(secondWorkerReadyCount).toBe(0);

        // The non-vacuity half: resuming against the second daemon lets the
        // very same feature dispatch. Without this half, "it never
        // dispatched" would be indistinguishable from "the fixture could
        // never dispatch at all".
        const resumeResponse = await postControl(
          second.port,
          '/control/resume',
          { scope: 'all' },
        );
        expect(resumeResponse.status).toBe(200);

        await waitUntil(() => secondWorkerReadyCount > 0, {
          timeoutMs: 5_000,
        });

        const dispatched = await featuresRepository(db).findById(featureId);
        expect(dispatched?.lease_token).not.toBeNull();
      } finally {
        await second.stop();
      }
    });
  }, 20_000);
});
