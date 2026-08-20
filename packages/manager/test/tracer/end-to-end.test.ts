import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import {
  createDb,
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
  dispatchOnce,
  IPC_MESSAGE_KINDS,
  parseWorkerMessage,
  startDaemon,
  UNAUTHENTICATED_PATHS,
  type FeatureView,
  type StageCell,
  type WorkerReady,
} from '../../src/index.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
// Reused directly, per 03-CONTEXT.md's read_first list — the temp-SQLite
// helper `@adl/db`'s own suite already relies on, not re-derived here.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
// The CLI's status command, exercised in-process against the live daemon
// rather than shelling out to an unbuilt binary (03-04's own instruction).
import {
  daemonClient,
  DaemonUnreachableError,
  daemonDownMessage,
} from '../../../cli/src/http-client.js';
import { statusCommand } from '../../../cli/src/commands/status.js';

/**
 * Phase 3 Plan 04 — the tracer. Covers every behaviour in the plan's
 * `<behavior>` list: the IPC protocol's parsing discipline, `dispatchOnce`'s
 * lease-acquire-and-transition sequence, the API's auth/health surface, and
 * finally the end-to-end case — a real forked worker, a real heartbeat loop,
 * the HTTP API, and `adl status --json` in one path.
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

const DAEMON_CONFIG: DaemonConfig = DaemonConfigSchema.parse({});

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

async function insertRepoAndQueuedFeature(
  db: Kysely<Database>,
): Promise<{ repoId: string; featureId: string }> {
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

  return { repoId, featureId };
}

// ---------------------------------------------------------------------------
// parseWorkerMessage / IPC_MESSAGE_KINDS
// ---------------------------------------------------------------------------

describe('parseWorkerMessage', () => {
  it('accepts each valid worker-to-manager kind', () => {
    const cases: readonly unknown[] = [
      { t: 'ready', leaseToken: 'tok', pid: 123, startedAt: nowIso() },
      { t: 'heartbeat', leaseToken: 'tok', at: nowIso() },
      {
        t: 'stage_result',
        leaseToken: 'tok',
        roundId: 0,
        stageIndex: 0,
        verdictJson: '{}',
      },
      { t: 'fatal', leaseToken: 'tok', reason: 'boom' },
    ];

    for (const raw of cases) {
      const result = parseWorkerMessage(raw);
      expect(result.ok, `expected ${JSON.stringify(raw)} to parse`).toBe(true);
    }
  });

  it('rejects an object with an unknown t, returning a failure value rather than throwing', () => {
    let result: ReturnType<typeof parseWorkerMessage> | undefined;
    expect(() => {
      result = parseWorkerMessage({ t: 'unknown-kind', leaseToken: 'tok' });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it('rejects a lease-scoped kind missing leaseToken', () => {
    const result = parseWorkerMessage({ t: 'heartbeat', at: nowIso() });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(parseWorkerMessage('not-an-object').ok).toBe(false);
    expect(parseWorkerMessage(null).ok).toBe(false);
    expect(parseWorkerMessage(42).ok).toBe(false);
    expect(parseWorkerMessage(undefined).ok).toBe(false);
  });
});

describe('IPC_MESSAGE_KINDS', () => {
  it('lists every discriminator in both unions, including soft_stop', () => {
    expect(IPC_MESSAGE_KINDS).toContain('soft_stop');
    expect([...IPC_MESSAGE_KINDS].sort()).toEqual(
      [
        'assign',
        'fatal',
        'heartbeat',
        'lease_lost',
        'ready',
        'soft_stop',
        'stage_result',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchOnce
// ---------------------------------------------------------------------------

describe('dispatchOnce', () => {
  it('against a database with zero queued features makes no lease and forks nothing', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const spawnCalls: unknown[] = [];

      const decision = await dispatchOnce({
        db,
        leaseTtlMs: 200,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        spawnWorker: (call) => spawnCalls.push(call),
      });

      expect(decision.dispatched).toBe(false);
      expect(spawnCalls).toHaveLength(0);
    });
  });

  it('against one queued feature acquires a lease, mints a ULID lease_token, writes lease fields, and transitions to leased in one transaction', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId } = await insertRepoAndQueuedFeature(db);
      const spawnCalls: { feature: FeaturesTable; leaseToken: string }[] = [];

      const decision = await dispatchOnce({
        db,
        leaseTtlMs: 200,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        spawnWorker: (call) => spawnCalls.push(call),
      });

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(featureId);
      expect(decision.leaseToken).toMatch(/^[0-9A-Z]{26}$/); // ULID shape
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.leaseToken).toBe(decision.leaseToken);

      const repo = featuresRepository(db);
      const row = await repo.findById(featureId);
      expect(row?.state).toBe('leased');
      expect(row?.lease_token).toBe(decision.leaseToken);
      expect(row?.lease_owner).toBeTruthy();
      expect(row?.lease_expires_at).toBeTruthy();
      expect(row?.heartbeat_at).toBeTruthy();
      expect(row?.effective_config_json).toBeTruthy();

      const parsedConfig = JSON.parse(row!.effective_config_json!) as {
        pipeline: readonly unknown[];
      };
      expect(parsedConfig.pipeline).toEqual(['develop', 'review', 'test']);

      const events = await repo.listEvents(featureId);
      const leaseEvent = events.find(
        (event) => event.to_state === 'leased' && event.from_state === 'queued',
      );
      expect(
        leaseEvent,
        'the lease_acquired transition must have written a feature_events row',
      ).toBeDefined();
    });
  });

  it('a second call against an already-leased feature makes no further lease', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await insertRepoAndQueuedFeature(db);
      const deps = {
        db,
        leaseTtlMs: 200,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        spawnWorker: () => {
          /* no-op */
        },
      };

      const first = await dispatchOnce(deps);
      const second = await dispatchOnce(deps);

      expect(first.dispatched).toBe(true);
      expect(second.dispatched).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createApi — health, auth, the loopback bind
// ---------------------------------------------------------------------------

const FIXTURE_STAGE_CELL: StageCell = {
  state: 'leased',
  position: 1,
  pipelineLength: 3,
  name: 'develop',
  label: 'leased 1/3 (develop)',
};

const FIXTURE_FEATURE_VIEW: FeatureView = {
  id: 'feature-1',
  repoId: 'repo-1',
  path: 'features/feature-1',
  state: 'leased',
  stage: FIXTURE_STAGE_CELL,
  round: 0,
  ageMs: 1234,
  worker: { pid: 4242 },
  staleRejections: 0,
};

describe('createApi', () => {
  it('GET /health responds without a bearer token, carrying only status and schema version', async () => {
    const app = createApi({
      apiToken: API_TOKEN,
      schemaVersion: 3,
      listFeatureViews: async () => [],
    });

    await withEphemeralPort(app, async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        schemaVersion: number;
      };
      expect(body.status).toBe('ok');
      expect(body.schemaVersion).toBe(3);
      expect(Object.keys(body).sort()).toEqual(
        ['schemaVersion', 'status'].sort(),
      );
    });
  });

  it('GET /features without the bearer token responds 401; with it responds 200 and a JSON array', async () => {
    const app = createApi({
      apiToken: API_TOKEN,
      schemaVersion: 1,
      listFeatureViews: async () => [FIXTURE_FEATURE_VIEW],
    });

    await withEphemeralPort(app, async ({ port }) => {
      const unauthed = await fetch(`http://127.0.0.1:${port}/features`);
      expect(unauthed.status).toBe(401);

      const authed = await fetch(`http://127.0.0.1:${port}/features`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(authed.status).toBe(200);
      const body = (await authed.json()) as FeatureView[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual([FIXTURE_FEATURE_VIEW]);
      expect(Object.keys(body[0]!).sort()).toEqual(
        [
          'id',
          'repoId',
          'path',
          'state',
          'stage',
          'round',
          'ageMs',
          'worker',
          'staleRejections',
        ].sort(),
      );
    });
  });

  it('a wrong bearer token is rejected the same as a missing one', async () => {
    const app = createApi({
      apiToken: API_TOKEN,
      schemaVersion: 1,
      listFeatureViews: async () => [],
    });

    await withEphemeralPort(app, async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/features`, {
        headers: { Authorization: 'Bearer not-the-right-token' },
      });
      expect(response.status).toBe(401);
    });
  });

  it('exempts exactly one path from the bearer-token requirement — the agreed mitigation for widening the exception', () => {
    expect(UNAUTHENTICATED_PATHS).toHaveLength(1);
    expect(UNAUTHENTICATED_PATHS).toContain('/health');
  });

  it('binds a loopback address, not 0.0.0.0', async () => {
    const app = createApi({
      apiToken: API_TOKEN,
      schemaVersion: 1,
      listFeatureViews: async () => [],
    });

    await withEphemeralPort(app, async ({ address }) => {
      expect(address).toBe('127.0.0.1');
      expect(address).not.toBe('0.0.0.0');
    });
  });
});

// ---------------------------------------------------------------------------
// adl status --json against a stopped daemon (D-25)
// ---------------------------------------------------------------------------

describe('adl status --json against a stopped daemon', () => {
  it('exits with a DaemonUnreachableError naming the host and port, per D-25', async () => {
    const host = '127.0.0.1';
    const port = 1; // nothing listens on a privileged low port in a test sandbox
    const client = daemonClient({ host, port, token: API_TOKEN });

    await expect(client.getFeatures()).rejects.toThrow(DaemonUnreachableError);

    try {
      await client.getFeatures();
      expect.unreachable('getFeatures must reject when the daemon is down');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonUnreachableError);
      const message = (error as DaemonUnreachableError).message;
      expect(message).toBe(daemonDownMessage(host, port));
      expect(message).toContain('Is it running? Try: adl daemon start');
      expect(message).toContain(String(port));
    }
  });

  it('statusCommand surfaces the same error to a CLI-shaped caller', async () => {
    const client = daemonClient({
      host: '127.0.0.1',
      port: 1,
      token: API_TOKEN,
    });
    const written: string[] = [];

    await expect(
      statusCommand(
        { json: true },
        { client, stdout: { write: (chunk) => written.push(chunk) } },
      ),
    ).rejects.toThrow(DaemonUnreachableError);
    expect(written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The tracer case — the full path, for real
// ---------------------------------------------------------------------------

describe('tracer: a queued feature is leased by a real forked worker and appears in adl status', () => {
  it('travels dispatch -> lease -> real forked process -> IPC heartbeat -> manager write -> HTTP -> CLI, and stopping the daemon leaves no child process running', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId } = await insertRepoAndQueuedFeature(db);

      const worker = withScriptedWorker();
      // Faster than the stage's own scripted delay, so at least two heartbeats
      // land before the stage completes and the worker exits (D-02, D-31: real
      // timers, small values, no fake clock).
      process.env.ADL_TEST_STAGE_DELAY_MS = '260';

      const readyEvents: WorkerReady[] = [];

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        // 03-06: startDaemon now derives its own reported schema version
        // from DAEMON_SCHEMA_VERSION (the migrations directory), rather
        // than accepting an arbitrary caller-supplied value — the whole
        // point of Task 1's checkpoint is that this number cannot drift
        // from the code. migrationsDir is pinned to this suite's own
        // MIGRATIONS_DIR (the same directory `migrateToLatest` above just
        // applied) so the gate's internal migration call records checksums
        // against the identical bytes already on record for this database
        // — a different directory (e.g. the default dist-compiled one)
        // would trip the checksum guard on a database this test already
        // migrated with the source .ts migrations.
        migrationsDir: MIGRATIONS_DIR,
        leaseTtlMs: 5000,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        workerEntryPath: worker.entryPath,
        workerCwd: worker.cwd,
        workerExecArgv: worker.execArgv,
        dispatchIntervalMs: 20,
        onWorkerReady: (ready) => readyEvents.push(ready),
      });

      let readyPid: number | undefined;
      const readDb = createDb(filePath);

      try {
        expect(handle.host).toBe('127.0.0.1');

        // The feature reaches `leased`, dispatched by the daemon's own loop —
        // no test code calls dispatchOnce directly here.
        await waitUntil(async () => {
          const row = await featuresRepository(readDb).findById(featureId);
          return row?.state === 'leased';
        });

        // A real child process exists: the pid comes from the `ready` message.
        await waitUntil(() =>
          readyEvents.some((ready) => ready.featureId === featureId),
        );
        readyPid = readyEvents.find(
          (ready) => ready.featureId === featureId,
        )?.pid;
        expect(readyPid).toBeDefined();
        expect(processIsAlive(readyPid!)).toBe(true);

        const leasedRow = await featuresRepository(readDb).findById(featureId);
        expect(leasedRow?.state).toBe('leased');

        const events = await featuresRepository(readDb).listEvents(featureId);
        expect(
          events.some(
            (event) =>
              event.to_state === 'leased' && event.from_state === 'queued',
          ),
        ).toBe(true);

        // heartbeat_at advances at least twice, and the worker never opened
        // the database — its module graph is proven clean by Task 3's lint
        // rule, not by inspection here.
        const seenHeartbeats = new Set<string>();
        await waitUntil(
          async () => {
            const row = await featuresRepository(readDb).findById(featureId);
            if (row?.heartbeat_at) seenHeartbeats.add(row.heartbeat_at);
            return seenHeartbeats.size >= 2;
          },
          { timeoutMs: 4000, intervalMs: 15 },
        );
        expect(seenHeartbeats.size).toBeGreaterThanOrEqual(2);

        // GET /features carries the shape adl status needs.
        const response = await fetch(
          `http://127.0.0.1:${handle.port}/features`,
          { headers: { Authorization: `Bearer ${API_TOKEN}` } },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as FeatureView[];
        const feature = body.find((row) => row.id === featureId);
        expect(feature).toBeDefined();
        expect(feature?.state).toBe('leased');
        expect(feature?.worker?.pid).toBe(readyPid);

        // adl status --json, in-process against the live daemon.
        const client = daemonClient({
          host: '127.0.0.1',
          port: handle.port,
          token: API_TOKEN,
        });
        const written: string[] = [];
        await statusCommand(
          { json: true },
          { client, stdout: { write: (chunk) => written.push(chunk) } },
        );
        const printed = JSON.parse(written.join('')) as FeatureView[];
        const printedFeature = printed.find((row) => row.id === featureId);
        expect(printedFeature).toBeDefined();
        expect(printedFeature?.state).toBe('leased');
      } finally {
        await readDb.destroy();
        delete process.env.ADL_TEST_STAGE_DELAY_MS;
        await handle.stop();
      }

      // Stopping the daemon leaves no child process running.
      if (readyPid !== undefined) {
        expect(processIsAlive(readyPid)).toBe(false);
      }
    });
  }, 20_000);
});
