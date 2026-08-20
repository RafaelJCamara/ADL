import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { FEATURE_STATES } from '@adl/core/state';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  usageRepository,
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
  encodeLeaseOwner,
  readProcessStartTime,
  runGcOnce,
  startDaemon,
  startReaper,
  type WorkerSupervisor,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { withHeldWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import {
  collectLeaseIntervals,
  findOverlappingLeases,
} from '../helpers/lease-audit.js';
import { requirePlatform } from '../helpers/platform.js';

/**
 * Phase 3 Plan 09, Task 1 — the D-32 scenario: three concurrent features, one
 * worker `SIGKILL`ed mid-run, the daemon restarted while the other two are
 * still leased. This is the ONE test that composes all three failures — a
 * crash the fast path handles, a restarted manager with no child handle
 * (only the reaper/boot path can act), and enough concurrency that a bug in
 * one feature's recovery would show up as damage to another's — which is
 * exactly the interaction `03-VALIDATION.md` says the per-criterion tests
 * each individually miss.
 *
 * **Deliberately excluded from the fast per-task loop** (`03-VALIDATION.md`
 * § Sampling Rate: "the concurrency-3 scenario test is deliberately excluded
 * from the quick loop"), because of its runtime — real forked processes, a
 * real git repository, and a real second daemon boot. It still runs in every
 * full-suite invocation (`pnpm --filter @adl/manager test`, `pnpm test`) —
 * there is no second vitest config or `.skip` gating it out; the "excluded
 * from the quick loop" instruction is about a developer's own local
 * iteration rhythm, not about which command an unattended CI run makes.
 *
 * **Why there are two "daemons" assembled by hand, not two `startDaemon()`
 * calls.** `test/boot/daemon-restart.test.ts` already established the
 * precedent for the *second* daemon: seed pre-crash state directly and boot
 * a fresh `startDaemon()` against it, because a live first daemon's own
 * reaper/fast-path recovery would recover the lease during its own lifetime,
 * defeating the point of proving the *boot* sequence does the recovering.
 * This scenario needs to go one step further and prove the boot-time orphan
 * kill (D-13/D-14) against **real, still-running** worker processes — not a
 * synthetic dead PID — which means a first daemon does need to exist, hold
 * real leases, and fork real workers. `startDaemon()`'s own `DaemonHandle`
 * only exposes a monolithic `stop()` that gracefully stops every live worker
 * (soft_stop, then SIGKILL) — exactly what a *graceful* shutdown does, and
 * exactly NOT what simulates a manager process that has simply died, leaving
 * its children running unsupervised. So "daemon 1" here is assembled from
 * the same exported pieces `startDaemon()` itself wires together
 * (`createSupervisor`, `startReaper`, `dispatchOnce`), which gives this test
 * the one seam `startDaemon()` does not: the ability to sever daemon 1's
 * observation of its own live children (`removeAllListeners()`, standing in
 * for "the process that held these listeners no longer exists") without
 * touching the children themselves, and to stop only its own timers. Daemon
 * 2 is then the real, unmodified `startDaemon()` — the actual boot sequence
 * a restarted `adl daemon start` runs — against the same on-disk database.
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

function daemonConfigFixture(): DaemonConfig {
  // D-02/D-31: real timers, small values. `lease_ttl_ms` must stay >= 3x
  // `heartbeat_interval_ms` (the config's own `superRefine`), and
  // `concurrency.global: 3` is the literal number the ROADMAP names for this
  // scenario ("run CI at concurrency 3").
  return DaemonConfigSchema.parse({
    concurrency: { global: 3 },
    lease_ttl_ms: 100_000,
    heartbeat_interval_ms: 50,
    worker_stop_grace_ms: 200,
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 10 } = {},
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

interface SeededFeature {
  readonly featureId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly commitSha: string;
}

/**
 * Create a real worktree for `featureId`, make a real commit inside it
 * (standing in for "the developer agent's own commit", the same
 * test-supplies-the-commit shape `test/recovery/crash-recovery.test.ts`
 * already establishes — the worker process itself never touches git in
 * either test), record a `usage_events` row for it (D-01 keeps `@adl/db` out
 * of the worker's own dependency graph, so a real worker could never write
 * this row either; a future phase's round-completion write site is what
 * would do so in production — see `resetCrashCountOnSuccess`'s own
 * still-unwired precedent), and seed the `features` row already pointing at
 * that worktree and `queued` for lease.
 */
async function seedCommittedFeature(
  db: Kysely<Database>,
  mainRepo: string,
  scratchRoot: string,
  gitRaw: (args: readonly string[]) => Promise<string>,
  repoId: string,
): Promise<SeededFeature> {
  const featureId = ulid();
  const created = await createWorktree(
    mainRepo,
    scratchRoot,
    featureId,
    'HEAD',
  );

  await writeFile(
    join(created.worktreePath, 'feature.txt'),
    `work for ${featureId}\n`,
  );
  await gitRaw(['-C', created.worktreePath, 'add', 'feature.txt']);
  await gitRaw([
    '-C',
    created.worktreePath,
    'commit',
    '-m',
    `developer commit for ${featureId}`,
  ]);
  const commitSha = (
    await gitRaw(['-C', created.worktreePath, 'rev-parse', 'HEAD'])
  ).trim();

  const now = nowIso();
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
      // Already attached (D-12's "attach, never rebuild" branch) — the
      // worktree pre-exists this row's first lease, matching what a
      // recovered-from-crash feature always looks like.
      workspace_handle: created.worktreePath,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await usageRepository(db).record({
    id: ulid(),
    feature_id: featureId,
    round_id: null,
    stage_attempt_id: null,
    model_id: 'claude-sonnet-5',
    speed: 'standard',
    input_tokens: 500,
    output_tokens: 120,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cost_usd: 0.005,
    cost_source: 'reported',
    cost_category: 'feature',
    at: now,
  });

  return {
    featureId,
    worktreePath: created.worktreePath,
    branch: created.branch,
    commitSha,
  };
}

describe('the D-32 scenario: concurrency 3, one SIGKILL, one daemon restart', () => {
  it('all three features are accounted for, committed work and the spend ledger are untouched, no orphan worktree remains, and no feature was ever double-leased', async () => {
    await withTempRepo(async (repoCtx) => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        const repoId = ulid();
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

        const gitRaw = (args: readonly string[]): Promise<string> =>
          repoCtx.git.raw([...args]);

        // --- Setup: three features, each with a real worktree and a real
        // commit already made, each recorded with its own usage_events row.
        const features = await Promise.all(
          [0, 1, 2].map(() =>
            seedCommittedFeature(
              db,
              repoCtx.mainRepo,
              repoCtx.scratchRoot,
              gitRaw,
              repoId,
            ),
          ),
        );

        const usageBefore = await db
          .selectFrom('usage_events')
          .selectAll()
          .where(
            'feature_id',
            'in',
            features.map((f) => f.featureId),
          )
          .orderBy('feature_id')
          .execute();
        expect(usageBefore).toHaveLength(3);

        const daemonConfig = daemonConfigFixture();
        const worker = withHeldWorker();
        const { logger: logger1 } = createCapturingLogger();

        // --- "Daemon 1": manually assembled from the same exported pieces
        // startDaemon() itself wires together (see the module docblock for
        // why a live startDaemon() handle cannot be used here).
        const readyPids = new Map<string, number>();
        const supervisor1: WorkerSupervisor = createSupervisor({
          entryPath: worker.entryPath,
          cwd: worker.cwd,
          execArgv: worker.execArgv,
          logger: logger1,
          leaseTtlMs: daemonConfig.lease_ttl_ms,
          renewLease: (params) => featuresRepository(db).renewLease(params),
          getCurrentLeaseToken: async (featureId) => {
            const row = await featuresRepository(db).findById(featureId);
            return row?.lease_token ?? null;
          },
          onReady: (ready) => {
            readyPids.set(ready.featureId, ready.pid);
            // Mirrors daemon.ts's own recordLeaseOwnerOnReady exactly —
            // reusing the exported encodeLeaseOwner/readProcessStartTime
            // rather than re-deriving the encoding, since this is the one
            // piece a manually-assembled "daemon 1" must replicate for
            // D-13/D-14's boot orphan kill to have anything to read.
            const startTimeResult = readProcessStartTime(ready.pid);
            void db
              .updateTable('features')
              .set({
                lease_owner: encodeLeaseOwner({
                  pid: ready.pid,
                  startTime:
                    startTimeResult.kind === 'available'
                      ? startTimeResult.startTime
                      : null,
                }),
              })
              .where('id', '=', ready.featureId)
              .where('lease_token', '=', ready.leaseToken)
              .execute();
          },
          onUnexpectedExit: createFastPathRecovery({
            db,
            logger: logger1,
          }),
        });

        const reaper1 = startReaper({
          db,
          logger: logger1,
          intervalMs: daemonConfig.heartbeat_interval_ms,
        });

        // Lease and fork all three — concurrency.global: 3 admits exactly
        // three, one dispatchOnce call per feature (FIFO by ulid, D-17).
        const dispatched: { featureId: string; leaseToken: string }[] = [];
        for (let i = 0; i < 3; i += 1) {
          const decision = await dispatchOnce({
            db,
            leaseTtlMs: daemonConfig.lease_ttl_ms,
            heartbeatIntervalMs: daemonConfig.heartbeat_interval_ms,
            daemonConfig,
            resolveAdlYml: () => ADL_YML_FIXTURE,
            mainRepo: '/main/repo',
            scratchRoot: '/main/repo/.adl/scratch',
            spawnWorker: (call) => {
              supervisor1.spawn(call.feature, call.leaseToken, call.assign);
            },
          });
          expect(decision.dispatched).toBe(true);
          dispatched.push({
            featureId: decision.featureId!,
            leaseToken: decision.leaseToken!,
          });
        }
        expect(new Set(dispatched.map((d) => d.featureId)).size).toBe(3);

        await waitUntil(() => readyPids.size === 3);

        // --- The interaction: SIGKILL exactly one worker, after its
        // commit (already made, above) and before its result (the held
        // double never sends one on its own).
        const killed = dispatched[0]!;
        const stillInFlight = [dispatched[1]!, dispatched[2]!];

        const killedPid = supervisor1.get(killed.featureId)!.worker.pid;
        supervisor1.get(killed.featureId)!.worker.child.kill('SIGKILL');

        // Daemon 1 is still "alive" for this one recovery — the fast path
        // (child.on('exit')) reclaims it in well under the (deliberately
        // large, in this scenario) lease TTL, exactly D-04's point: the
        // fast path is what makes TTL a ceiling, not the actual latency.
        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(killed.featureId);
          return row?.state === 'queued' && row.lease_token === null;
        });
        await waitUntil(() => !processIsAlive(killedPid));

        // --- "Stop daemon 1" — without touching the two still-live
        // workers. A real crashed manager process no longer has any
        // listeners registered on children it forked; `removeAllListeners`
        // is how a single-process test simulates that severance without an
        // actual second OS process. The features these two hold remain
        // `leased`/whatever `lease_acquired` produced, with a lease that
        // will never be renewed again — precisely what a real orphan looks
        // like from the database's point of view.
        const stillInFlightPids = stillInFlight.map(
          (entry) => supervisor1.get(entry.featureId)!.worker.pid,
        );
        for (const entry of stillInFlight) {
          const active = supervisor1.get(entry.featureId)!;
          active.worker.child.removeAllListeners();
          active.worker.stdout.removeAllListeners();
          active.worker.stderr.removeAllListeners();
        }
        reaper1.stop();

        expect(stillInFlightPids.every((pid) => processIsAlive(pid))).toBe(
          true,
        );

        // --- "Restart the daemon": the real, unmodified startDaemon()
        // against the same on-disk database — the actual production boot
        // sequence (schema gate, D-35 reconciliation, D-13's boot orphan
        // kill, then D-13's unconditional lease expiry) runs here, not a
        // second hand-rolled approximation of it.
        const { logger: logger2 } = createCapturingLogger();
        const handle2 = await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: `scenario-token-${ulid()}`,
          leaseTtlMs: daemonConfig.lease_ttl_ms,
          heartbeatIntervalMs: daemonConfig.heartbeat_interval_ms,
          daemonConfig,
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          workerEntryPath: worker.entryPath,
          workerCwd: worker.cwd,
          workerExecArgv: [...worker.execArgv],
          logger: logger2,
          // Large and effectively disabled for this assertion window
          // (mirrors test/boot/daemon-restart.test.ts's own precedent):
          // this test asserts what BOOT did, not what a subsequent
          // dispatch tick would do to the freshly-requeued features.
          dispatchIntervalMs: 60_000,
        });

        try {
          // D-13's unconditional half runs regardless of platform: every
          // lease held at boot is expired and the feature requeued, whether
          // or not the orphan process itself could be signalled.
          await waitUntil(async () => {
            const rows = await Promise.all(
              stillInFlight.map((entry) =>
                featuresRepository(db).findById(entry.featureId),
              ),
            );
            return rows.every(
              (row) => row?.state === 'queued' && row.lease_token === null,
            );
          });

          // D-13/D-14's OTHER half — actually signalling the still-running
          // orphan — only has a subject on Linux: `readProcessStartTime`
          // returns `unavailable` on every other platform (no `/proc`),
          // which `killBootOrphans` treats as not-attributable and
          // deliberately leaves alone (T-3-03's accepted Windows
          // degradation, documented in packages/manager/README.md).
          const orphanKillGate = requirePlatform(
            'linux',
            'the boot orphan kill only signals a PID once /proc/<pid>/stat ' +
              'confirms its start time still matches the recorded one — ' +
              'unavailable everywhere else, so the actual SIGKILL has no ' +
              'subject off Linux (D-33, T-3-03)',
            'EXEC-03',
          );
          if (orphanKillGate.kind === 'run') {
            await waitUntil(() =>
              stillInFlightPids.every((pid) => !processIsAlive(pid)),
            );
          }

          // --- Closing assertion 1: all three features are accounted for
          // — a defined state, no expired lease still held.
          const allIds = [killed, ...stillInFlight].map((d) => d.featureId);
          const finalRows = await Promise.all(
            allIds.map((id) => featuresRepository(db).findById(id)),
          );
          for (const row of finalRows) {
            expect(row).toBeDefined();
            expect(FEATURE_STATES as readonly string[]).toContain(row!.state);
            expect(row!.lease_token).toBeNull();
            expect(row!.lease_expires_at).toBeNull();
          }

          // --- Closing assertion 2: committed work is intact — every
          // feature's commit (including the killed one's) is still
          // reachable on its branch.
          for (const feature of features) {
            const log = await gitRaw([
              '-C',
              feature.worktreePath,
              'log',
              feature.branch,
              '--format=%H',
            ]);
            expect(log).toContain(feature.commitSha);
          }

          // --- Closing assertion 3: the spend ledger is unchanged by the
          // crash — recovery writes no usage_events row and deletes none.
          const usageAfter = await db
            .selectFrom('usage_events')
            .selectAll()
            .where('feature_id', 'in', allIds)
            .orderBy('feature_id')
            .execute();
          expect(usageAfter).toEqual(usageBefore);

          // --- Closing assertion 5: no feature was ever double-leased —
          // proven from the append-only feature_events log, not a
          // snapshot (a snapshot cannot see an overlap that opened and
          // closed before the assertions ran).
          const allEvents = (
            await Promise.all(
              allIds.map((id) => featuresRepository(db).listEvents(id)),
            )
          ).flat();

          for (const id of allIds) {
            const seqs = allEvents
              .filter((e) => e.feature_id === id)
              .map((e) => e.seq)
              .sort((a, b) => a - b);
            for (let i = 0; i < seqs.length; i += 1) {
              expect(seqs[i]).toBe(i + 1);
            }
            expect(seqs.length).toBeGreaterThan(0);
          }

          const intervals = collectLeaseIntervals(allEvents);
          const overlaps = findOverlappingLeases(intervals);
          expect(overlaps).toEqual([]);

          // --- Closing assertion 4: no orphan worktrees remain, after a
          // GC pass. None of the three features can naturally reach a
          // TERMINAL_STATE in this phase (no gate pipeline exists yet to
          // walk one there — the same gap test/recovery/crash-recovery.
          // test.ts's own precedent works around) — so one feature is
          // driven directly to `abandoned` to give the sweep a subject,
          // exactly the way `sweepOrphans`'s own suite exercises the
          // "terminal or unknown" collection rule (`@adl/workspace`'s
          // TERMINAL_STATES import, not a transcribed list). The other two
          // stay non-terminal and their worktrees must survive the same
          // pass untouched.
          const noLongerNeeded = killed.featureId;
          const stillNeeded = stillInFlight.map((d) => d.featureId);
          await db
            .updateTable('features')
            .set({ state: 'abandoned' })
            .where('id', '=', noLongerNeeded)
            .execute();

          const { logger: gcLogger } = createCapturingLogger();
          await runGcOnce({ mainRepo: repoCtx.mainRepo, db, logger: gcLogger });

          const worktreesAfterGc = await listManagedWorktrees(repoCtx.mainRepo);
          const worktreeFeatureIds = new Set(
            worktreesAfterGc
              .map((entry) => entry.branch)
              .filter((branch): branch is string => branch !== undefined)
              .map((branch) => branch.replace(/^refs\/heads\//, '')),
          );
          expect(
            [...worktreeFeatureIds].some((branchName) =>
              branchName.includes(noLongerNeeded),
            ),
          ).toBe(false);
          for (const id of stillNeeded) {
            expect(
              [...worktreeFeatureIds].some((branchName) =>
                branchName.includes(id),
              ),
            ).toBe(true);
          }
        } finally {
          await handle2.stop();
        }

        // --- Teardown: no orphaned processes leak out of this scenario
        // into the rest of the CI run (T-3-36) — every recorded pid,
        // including the one this test killed directly and the two the
        // restart orphaned, whether or not production code already
        // reclaimed them.
        const everyRecordedPid = [...readyPids.values()];
        for (const pid of everyRecordedPid) {
          if (processIsAlive(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already gone between the check and the signal — fine.
            }
          }
        }
        await waitUntil(() =>
          everyRecordedPid.every((pid) => !processIsAlive(pid)),
        );
        for (const pid of everyRecordedPid) {
          expect(processIsAlive(pid)).toBe(false);
        }
      });
    });
  }, 30_000);
});
