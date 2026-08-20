import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { FEATURE_STATES, TERMINAL_STATES } from '@adl/core/state';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import {
  createWorktree,
  listManagedWorktrees,
  processIsAlive,
} from '@adl/workspace';
import {
  createFastPathRecovery,
  createSupervisor,
  dispatchOnce,
  MAX_CONSECUTIVE_CRASHES,
  planRecovery,
  reapOne,
  resetCrashCountOnSuccess,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 3 Plan 05, Task 3: crash recovery policy — same round, stage 0,
 * re-attached worktree, bounded retries (D-10, D-11, D-12).
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

interface SeedFeatureOptions {
  readonly featureId?: string;
  readonly state?: string;
  readonly leaseToken?: string | null;
  readonly round?: number;
  readonly currentStageIndex?: number;
  readonly crashCount?: number;
  readonly workspaceHandle?: string | null;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions = {},
): Promise<string> {
  const repoId = ulid();
  const featureId = options.featureId ?? ulid();
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
      state: options.state ?? 'developing',
      state_version: 1,
      round: options.round ?? 0,
      current_stage_index: options.currentStageIndex ?? 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: options.workspaceHandle ?? null,
      lease_owner: options.leaseToken === null ? null : 'manager',
      lease_token:
        options.leaseToken === undefined ? ulid() : options.leaseToken,
      lease_expires_at:
        options.leaseToken === null
          ? null
          : new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: options.crashCount ?? 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return featureId;
}

// ---------------------------------------------------------------------------
// planRecovery — the pure truth table
// ---------------------------------------------------------------------------

describe('planRecovery', () => {
  const NON_TERMINAL_STATES = FEATURE_STATES.filter(
    (state) => !(TERMINAL_STATES as readonly string[]).includes(state),
  );

  it.each(NON_TERMINAL_STATES)(
    'recovers a %s feature at crash counts 0, 1, and 2, and resets the stage index to 0',
    (state) => {
      for (const crashCount of [0, 1, 2]) {
        const decision = planRecovery({
          state,
          round: 2,
          currentStageIndex: 3,
          crashCount,
        });
        expect(decision.kind).toBe('recover');
        expect(decision.kind === 'recover' && decision.resetStageIndexTo).toBe(
          0,
        );
      }
    },
  );

  it.each(NON_TERMINAL_STATES)(
    'escalates a %s feature at crash count %i (the ceiling)',
    (state) => {
      const decision = planRecovery({
        state,
        round: 2,
        currentStageIndex: 3,
        crashCount: MAX_CONSECUTIVE_CRASHES,
      });
      expect(decision.kind).toBe('escalate');
      expect(decision.kind === 'escalate' && decision.reason.length > 0).toBe(
        true,
      );
    },
  );

  it('MAX_CONSECUTIVE_CRASHES is 3', () => {
    expect(MAX_CONSECUTIVE_CRASHES).toBe(3);
  });

  it('imports nothing from @adl/db or node:fs — verified against its own source', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../src/recovery/policy.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]@adl\/db['"]/);
    expect(source).not.toMatch(/from ['"]node:fs['"]/);
  });
});

// ---------------------------------------------------------------------------
// resetCrashCountOnSuccess
// ---------------------------------------------------------------------------

describe('resetCrashCountOnSuccess', () => {
  it('resets crash_count to 0', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, { crashCount: 2 });

      await resetCrashCountOnSuccess(db, featureId);

      const row = await featuresRepository(db).findById(featureId);
      expect(row?.crash_count).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// The escalation ceiling, driven through reapOne across real crash cycles
// ---------------------------------------------------------------------------

describe('the crash ceiling', () => {
  it('escalates on the fourth consecutive crash, and any successful round would have reset the counter', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        state: 'developing',
        crashCount: 0,
      });
      const { logger } = createCapturingLogger();

      // Three crashes recover; the fourth escalates.
      for (let i = 0; i < 3; i += 1) {
        // Simulate a fresh lease held by a worker that is about to crash —
        // each cycle re-leases the same row before reaping it, since
        // `reapOne` only has an edge to walk from a non-terminal,
        // lease-bearing state.
        await db
          .updateTable('features')
          .set({ state: 'developing', lease_token: ulid() })
          .where('id', '=', featureId)
          .execute();
        const row = await featuresRepository(db).findById(featureId);
        const reaped = await reapOne({ db, logger }, row!, nowIso());
        expect(reaped?.decision).toBe('recovered');

        const after = await featuresRepository(db).findById(featureId);
        expect(after?.state).toBe('queued');
        expect(after?.crash_count).toBe(i + 1);
      }

      // Fourth crash: crash_count is now 3 — at the ceiling.
      await db
        .updateTable('features')
        .set({ state: 'developing', lease_token: ulid() })
        .where('id', '=', featureId)
        .execute();
      const rowAtCeiling = await featuresRepository(db).findById(featureId);
      const escalated = await reapOne({ db, logger }, rowAtCeiling!, nowIso());
      expect(escalated?.decision).toBe('escalated');

      const finalRow = await featuresRepository(db).findById(featureId);
      expect(finalRow?.state).toBe('escalated');
      expect(finalRow?.state).not.toBe('paused');
      expect(finalRow?.state).not.toBe('abandoned');

      const events = await featuresRepository(db).listEvents(featureId);
      const unrecoverableEvent = events.find((event) => {
        const parsed = JSON.parse(event.event_json) as { t: string };
        return parsed.t === 'unrecoverable';
      });
      expect(unrecoverableEvent).toBeDefined();
      expect(unrecoverableEvent?.to_state).toBe('escalated');
    });
  });
});

// ---------------------------------------------------------------------------
// dispatchOnce's attach-if-present branch (D-12's other half)
// ---------------------------------------------------------------------------

describe("dispatchOnce's workspace_handle branch", () => {
  it('persists a handle on the first lease, and leaves an existing one untouched on a later dispatch', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db, {
        state: 'queued',
        leaseToken: null,
        workspaceHandle: null,
      });

      const spawnCalls: { assign: { workspaceHandle: string } }[] = [];
      const first = await dispatchOnce({
        db,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        logsRoot: '/main/repo/.adl/logs',
        spawnWorker: (call) => spawnCalls.push(call),
      });
      expect(first.dispatched).toBe(true);

      const row = await featuresRepository(db).findById(featureId);
      expect(row?.workspace_handle).toBeTruthy();
      const persistedHandle = row!.workspace_handle!;
      expect(spawnCalls[0]?.assign.workspaceHandle).toBe(persistedHandle);

      // A later dispatch (the recovery path, once the reaper has requeued
      // it) attaches to the same handle rather than deriving a new one.
      await db
        .updateTable('features')
        .set({ state: 'queued', lease_token: null, lease_expires_at: null })
        .where('id', '=', featureId)
        .execute();

      const second = await dispatchOnce({
        db,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 50,
        daemonConfig: DAEMON_CONFIG,
        resolveAdlYml: () => ADL_YML_FIXTURE,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        logsRoot: '/main/repo/.adl/logs',
        spawnWorker: (call) => spawnCalls.push(call),
      });
      expect(second.dispatched).toBe(true);

      const rowAfterSecond = await featuresRepository(db).findById(featureId);
      expect(rowAfterSecond?.workspace_handle).toBe(persistedHandle);
      expect(spawnCalls[1]?.assign.workspaceHandle).toBe(persistedHandle);
    });
  });
});

// ---------------------------------------------------------------------------
// The full integration case: a mid-run SIGKILL, recovered without loss
// ---------------------------------------------------------------------------

describe('a feature killed mid-round', () => {
  it('resumes at the same round, stage 0, with its commit and worktree untouched and usage_events unchanged', async () => {
    await withTempRepo(async (repoCtx) => {
      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        const featureId = ulid();
        const created = await createWorktree(
          repoCtx.mainRepo,
          repoCtx.scratchRoot,
          featureId,
          'HEAD',
        );

        // Simulate the developer agent's own commit, made before the
        // crash — real git operations, through the already-constructed
        // handle `withTempRepo` returns (never a fresh `simple-git`
        // import in this file: `adl/no-direct-spawn` bans that outside
        // `packages/workspace/**`, so the worktree is addressed with
        // `-C` on the handle this test was already given).
        await writeFile(
          join(created.worktreePath, 'feature.txt'),
          'work in progress\n',
        );
        await repoCtx.git.raw([
          '-C',
          created.worktreePath,
          'add',
          'feature.txt',
        ]);
        await repoCtx.git.raw([
          '-C',
          created.worktreePath,
          'commit',
          '-m',
          'developer commit before the crash',
        ]);
        const commitSha = (
          await repoCtx.git.raw([
            '-C',
            created.worktreePath,
            'rev-parse',
            'HEAD',
          ])
        ).trim();

        const leaseToken = ulid();
        await seedFeature(db, {
          featureId,
          state: 'gating',
          round: 2,
          currentStageIndex: 3,
          crashCount: 0,
          leaseToken,
          workspaceHandle: created.worktreePath,
        });

        const worker = withScriptedWorker();
        const { logger } = createCapturingLogger();

        const supervisor = createSupervisor({
          entryPath: worker.entryPath,
          cwd: worker.cwd,
          execArgv: worker.execArgv,
          logger,
          leaseTtlMs: 60_000,
          renewLease: (params) => featuresRepository(db).renewLease(params),
          onUnexpectedExit: createFastPathRecovery({ db, logger }),
        });

        const feature = (await featuresRepository(db).findById(featureId))!;
        supervisor.spawn(feature, leaseToken, {
          t: 'assign',
          featureId,
          leaseToken,
          workspaceHandle: created.worktreePath,
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

        await waitUntil(() => supervisor.get(featureId) !== undefined);
        const killedPid = supervisor.get(featureId)!.worker.pid;
        supervisor.get(featureId)!.worker.child.kill('SIGKILL');

        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(featureId);
          return row?.state === 'queued';
        });

        // No orphaned child process survives the SIGKILL.
        await waitUntil(() => !processIsAlive(killedPid));

        const recoveredRow = await featuresRepository(db).findById(featureId);
        expect(recoveredRow?.round).toBe(2);
        expect(recoveredRow?.current_stage_index).toBe(0);
        expect(recoveredRow?.crash_count).toBe(1);
        expect(recoveredRow?.workspace_handle).toBe(created.worktreePath);
        expect(recoveredRow?.lease_token).toBeNull();

        // The commit survives — recovery deleted nothing.
        const log = await repoCtx.git.raw([
          '-C',
          created.worktreePath,
          'log',
          created.branch,
          '--format=%H',
        ]);
        expect(log).toContain(commitSha);

        // The worktree survives — no teardown ran (Phase 2's D-14: a
        // crash is deliberately not a terminal state).
        const worktrees = await listManagedWorktrees(repoCtx.mainRepo);
        // git reports forward slashes even on Windows; normalise before
        // comparing against the `path.join`-built worktreePath.
        const expectedPath = created.worktreePath.replace(/\\/g, '/');
        expect(
          worktrees.some(
            (entry) => entry.path.replace(/\\/g, '/') === expectedPath,
          ),
        ).toBe(true);

        // usage_events: recovery writes no row and deletes none.
        const usageEvents = await db
          .selectFrom('usage_events')
          .selectAll()
          .where('feature_id', '=', featureId)
          .execute();
        expect(usageEvents).toHaveLength(0);
      });
    });
  }, 20_000);
});
