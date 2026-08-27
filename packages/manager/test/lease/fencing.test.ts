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
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import {
  checkFence,
  createApi,
  createStaleRejectionCounter,
  createSupervisor,
  dispatchOnce,
  reapExpiredLeases,
  type ActiveWorker,
  type FeatureView,
  type SpawnCall,
  type StageCell,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withZombieWorker } from '../helpers/worker-harness.js';
import {
  createCapturingLogger,
  type CapturedLog,
} from '../helpers/capturing-logger.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';

/**
 * Phase 3 Plan 05, Task 2: the fence — rejecting the zombie's write, loudly
 * (D-06, D-07, D-09, D-31).
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

async function seedQueuedFeature(db: Kysely<Database>): Promise<string> {
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

  return featureId;
}

// ---------------------------------------------------------------------------
// checkFence — the pure verdict
// ---------------------------------------------------------------------------

describe('checkFence', () => {
  it('returns a match verdict when the tokens are equal', () => {
    const verdict = checkFence('feature-1', 'tok-a', 'tok-a');
    expect(verdict.kind).toBe('match');
  });

  it('returns a stale verdict carrying both tokens when they differ', () => {
    const verdict = checkFence('feature-1', 'tok-old', 'tok-new');
    expect(verdict).toEqual({
      kind: 'stale',
      featureId: 'feature-1',
      presented: 'tok-old',
      current: 'tok-new',
    });
  });

  it('returns stale when the row currently has no lease at all', () => {
    const verdict = checkFence('feature-1', 'tok-a', null);
    expect(verdict.kind).toBe('stale');
    expect(verdict.kind === 'stale' && verdict.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createStaleRejectionCounter
// ---------------------------------------------------------------------------

describe('createStaleRejectionCounter', () => {
  it('tracks a total and a per-feature count', () => {
    const counter = createStaleRejectionCounter();
    counter.increment('feature-1');
    counter.increment('feature-1');
    counter.increment('feature-2');

    expect(counter.forFeature('feature-1')).toBe(2);
    expect(counter.forFeature('feature-2')).toBe(1);
    expect(counter.forFeature('feature-3')).toBe(0);
    expect(counter.snapshot().total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The repository-level fence, independent of any supervisor or message handler
// ---------------------------------------------------------------------------

describe('the SQL predicate half of the fence, called directly', () => {
  it('renewLease with a stale token returns false, with no message handler in this test', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedQueuedFeature(db);
      const repo = featuresRepository(db);
      const now = nowIso();

      const acquired = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'manager',
        leaseToken: 'the-real-token',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: now,
      });
      expect(acquired).toBe(true);

      const renewed = await repo.renewLease({
        id: featureId,
        leaseToken: 'a-completely-different-token',
        heartbeatAt: nowIso(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(renewed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /features surfaces staleRejections
// ---------------------------------------------------------------------------

describe('GET /features', () => {
  it('response objects contain a staleRejections numeric field', async () => {
    const stage: StageCell = {
      state: 'developing',
      position: 1,
      pipelineLength: 3,
      name: 'develop',
      label: 'developing 1/3 (develop)',
    };
    const featureView: FeatureView = {
      id: 'feature-1',
      repoId: 'repo-1',
      path: 'features/feature-1',
      state: 'developing',
      stage,
      round: 0,
      ageMs: 10,
      worker: null,
      staleRejections: 2,
      spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
    };
    const app = createApi({
      apiToken: 'tok',
      schemaVersion: 1,
      listFeatureViews: async () => [featureView],
    });

    await withEphemeralPort(app, async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/features`, {
        headers: { Authorization: 'Bearer tok' },
      });
      const body = (await response.json()) as FeatureView[];
      expect(typeof body[0]?.staleRejections).toBe('number');
      expect(body[0]?.staleRejections).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// The D-31 zombie scenario, end to end
// ---------------------------------------------------------------------------

describe('the D-31 zombie scenario', () => {
  it('a zombie reporting with a stale token is dropped, logged, and counted, and the newer state is unchanged', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedQueuedFeature(db);

      // Long enough that neither lease's own TTL ever becomes the reason
      // it gets reaped in this test — expiry is forced directly below
      // instead of waited for, so the zombie's real (and variable, cold
      // fork-startup-dependent) pause duration can never race a lease's
      // own natural clock.
      const leaseTtlMs = 60_000;
      const zombie = withZombieWorker();
      const { logger, logs } = createCapturingLogger();
      const staleRejectionCounter = createStaleRejectionCounter();
      const staleMessages: {
        featureId: string;
        kind: string;
        presentedToken: string;
        currentToken: string | null;
      }[] = [];

      const spawnedChildren: ActiveWorker['worker']['child'][] = [];

      const supervisor = createSupervisor({
        entryPath: zombie.entryPath,
        cwd: zombie.cwd,
        execArgv: zombie.execArgv,
        logger,
        leaseTtlMs,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        getCurrentLeaseToken: async (id) => {
          const row = await featuresRepository(db).findById(id);
          return row?.lease_token ?? null;
        },
        staleRejectionCounter,
        onStaleMessage: (message) => staleMessages.push(message),
      });

      function spawnAndTrack(call: SpawnCall): void {
        const entry = supervisor.spawn(
          call.feature,
          call.leaseToken,
          call.assign,
        );
        spawnedChildren.push(entry.worker.child);
      }

      try {
        // First dispatch: leases the feature to the zombie.
        const first = await dispatchOnce({
          db,
          leaseTtlMs,
          heartbeatIntervalMs: 50,
          daemonConfig: DAEMON_CONFIG,
          resolveAdlYml: () => ADL_YML_FIXTURE,
          mainRepo: '/main/repo',
          scratchRoot: '/main/repo/.adl/scratch',
          spawnWorker: spawnAndTrack,
        });
        expect(first.dispatched).toBe(true);
        const oldToken = first.leaseToken!;

        // Force the zombie's lease expired *now*, deterministically, rather
        // than waiting on the real clock — the D-31 scenario's substance is
        // the fence, not the reaper's own timing (already covered by
        // `test/scheduler/reaper.test.ts`). One direct `reapExpiredLeases`
        // call stands in for "the reaper has meanwhile reaped".
        await db
          .updateTable('features')
          .set({
            lease_expires_at: new Date(Date.now() - 1000).toISOString(),
          })
          .where('id', '=', featureId)
          .execute();
        await reapExpiredLeases({ db, logger }, nowIso());

        const reapedRow = await featuresRepository(db).findById(featureId);
        expect(reapedRow?.state).toBe('queued');

        // A fresh dispatch re-leases the same (only queued) feature to a new
        // token, through the same supervisor — "the dispatcher re-leases the
        // feature with a fresh token" (D-31).
        const second = await dispatchOnce({
          db,
          leaseTtlMs,
          heartbeatIntervalMs: 50,
          daemonConfig: DAEMON_CONFIG,
          resolveAdlYml: () => ADL_YML_FIXTURE,
          mainRepo: '/main/repo',
          scratchRoot: '/main/repo/.adl/scratch',
          spawnWorker: spawnAndTrack,
        });
        expect(second.dispatched).toBe(true);
        const newToken = second.leaseToken!;
        expect(newToken).not.toBe(oldToken);

        const legitimateRow = await featuresRepository(db).findById(featureId);
        const legitimateStateVersion = legitimateRow?.state_version;
        const legitimateState = legitimateRow?.state;
        const eventsBefore = await featuresRepository(db).listEvents(featureId);

        // The original zombie wakes up (after its fixed internal pause) and
        // reports with its now-stale token.
        await waitUntil(
          () => staleRejectionCounter.forFeature(featureId) >= 1,
          { timeoutMs: 5000 },
        );

        expect(
          staleMessages.some(
            (message) =>
              message.presentedToken === oldToken &&
              message.currentToken === newToken,
          ),
        ).toBe(true);

        const warnLine = logs.find(
          (log: CapturedLog) =>
            log.level === 40 && // pino 'warn'
            log.presentedToken === oldToken &&
            log.currentToken === newToken,
        );
        expect(warnLine).toBeDefined();

        const afterRow = await featuresRepository(db).findById(featureId);
        expect(afterRow?.state_version).toBe(legitimateStateVersion);
        expect(afterRow?.state).toBe(legitimateState);
        expect(afterRow?.lease_token).toBe(newToken);

        const eventsAfter = await featuresRepository(db).listEvents(featureId);
        expect(eventsAfter).toHaveLength(eventsBefore.length);
      } finally {
        // The second zombie (spawned by the re-lease dispatch) is still
        // paused and would otherwise report — and call `getCurrentLeaseToken`
        // against this test's `db` — well after `withTempDb`'s own teardown
        // has destroyed the connection. Kill every forked child before that
        // teardown runs.
        await Promise.all(
          spawnedChildren.map(
            (child) =>
              new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                  resolve();
                  return;
                }
                child.once('exit', () => resolve());
                child.kill('SIGKILL');
              }),
          ),
        );
      }
    });
  }, 15_000);
});
