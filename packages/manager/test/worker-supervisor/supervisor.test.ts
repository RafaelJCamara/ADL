import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import { createSupervisor } from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import {
  SCRIPTED_COMMITTED_SHA,
  withCommittedWorker,
  withScriptedWorker,
} from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * `SupervisorDeps.onDeveloperCommitted` (M05 step 5.10) — fires exactly once
 * for a fence-matched `stage_result` reporting a real `developer_outcome:
 * committed`, and never for anything else. `test/control/pause.test.ts`'s
 * "round boundary" describe block is the established pattern this file
 * follows for driving a real forked scripted worker through `createSupervisor`.
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function seedLeasedFeature(
  db: Parameters<typeof featuresRepository>[0],
): Promise<{ featureId: string; leaseToken: string; repoId: string }> {
  const now = nowIso();
  const repoId = ulid();
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

  const featureId = ulid();
  const leaseToken = ulid();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'developing',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: 'manager',
      lease_token: leaseToken,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return { featureId, leaseToken, repoId };
}

describe('createSupervisor — onDeveloperCommitted (M05 step 5.10)', () => {
  it('fires with the feature row and sha for a fence-matched, real committed outcome', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId, leaseToken } = await seedLeasedFeature(db);

      const worker = withCommittedWorker();
      const { logger } = createCapturingLogger();
      let captured: { featureId: string; sha: string } | undefined;

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        getCurrentLeaseToken: (id) =>
          featuresRepository(db)
            .findById(id)
            .then((row) => row?.lease_token ?? null),
        onDeveloperCommitted: (params) => {
          captured = { featureId: params.feature.id, sha: params.sha };
        },
      });

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
        logsRoot: '/main/repo/.adl/logs',
        baseRef: 'main',
        workspaceBackendId: 'worktree',
        roundId: 'round-1',
        stageAttemptId: 'attempt-1',
        stageId: 'develop',
        stageIndex: 0,
      });

      await waitUntil(() => captured !== undefined);
      // Let the scripted worker finish exiting on its own before this test
      // (and the temp db it's using) tears down — avoids racing the child's
      // own `exitNow(0)` against process/channel teardown.
      await waitUntil(() => supervisor.get(featureId) === undefined);

      expect(captured).toEqual({
        featureId,
        sha: SCRIPTED_COMMITTED_SHA,
      });
    });
  }, 10_000);

  it('never fires for a stage_result whose verdict is not a committed developer_outcome', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId, leaseToken } = await seedLeasedFeature(db);

      // `scripted-worker-entry.ts`'s legacy `{outcome:'skip', ...}` shape —
      // never `{kind:'developer_outcome', ...}` — is exactly the "anything
      // else" this callback must ignore.
      const worker = withScriptedWorker();
      const { logger } = createCapturingLogger();
      let onDeveloperCommittedCalls = 0;
      let roundBoundaryFired = false;

      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: (params) => featuresRepository(db).renewLease(params),
        getCurrentLeaseToken: (id) =>
          featuresRepository(db)
            .findById(id)
            .then((row) => row?.lease_token ?? null),
        onRoundBoundary: () => {
          roundBoundaryFired = true;
        },
        onDeveloperCommitted: () => {
          onDeveloperCommittedCalls += 1;
        },
      });

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
        logsRoot: '/main/repo/.adl/logs',
        baseRef: 'main',
        workspaceBackendId: 'worktree',
        roundId: 'round-1',
        stageAttemptId: 'attempt-1',
        stageId: 'develop',
        stageIndex: 0,
      });

      // The round boundary DOES fire (proves the worker really completed and
      // was observed) while onDeveloperCommitted must not have.
      await waitUntil(() => roundBoundaryFired);
      // Let the scripted worker finish exiting on its own before this test
      // (and the temp db it's using) tears down — avoids racing the child's
      // own `exitNow(0)` against process/channel teardown.
      await waitUntil(() => supervisor.get(featureId) === undefined);
      expect(onDeveloperCommittedCalls).toBe(0);
    });
  }, 10_000);
});
