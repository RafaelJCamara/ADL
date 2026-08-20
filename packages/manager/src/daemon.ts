import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import {
  createDb,
  featuresRepository,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import type { AdlYml, DaemonConfig } from '@adl/core/config';
import type { Kysely } from 'kysely';
import pino, { type Logger } from 'pino';
import { createApi } from './api/app.js';
import type { FeatureView } from './api/routes/features.js';
import {
  encodeLeaseOwner,
  killBootOrphans,
  readProcessStartTime,
} from './boot/orphans.js';
import { gracefulShutdown } from './boot/shutdown.js';
import {
  DAEMON_SCHEMA_VERSION,
  reconcileRepos,
  resolveMigrationsDir,
  runStartupGate,
  SchemaVersionRefusalError,
} from './boot/startup.js';
import { createStaleRejectionCounter } from './fencing.js';
import { dispatchOnce } from './scheduler/dispatcher.js';
import {
  createFastPathRecovery,
  reapOne,
  startReaper,
} from './scheduler/reaper.js';
import {
  createSupervisor,
  type WorkerReady,
  type WorkerSupervisor,
} from './worker-supervisor/supervisor.js';

/**
 * `startDaemon`/`stopDaemon` — the one function that wires the database, the
 * supervisor, the dispatcher, and the Hono API together, and returns a
 * handle a caller (production `adl daemon start`, or a test) can stop.
 *
 * The startup order is fixed by D-37: schema gate, then copy-and-migrate
 * (inside `runStartupGate`), then repository reconciliation (`reconcileRepos`,
 * D-35), then lease expiry and the boot orphan kill (D-13, `./boot/orphans.js`),
 * then dispatch. A refusal from the gate exits before the API server binds —
 * `startDaemon` throws {@link SchemaVersionRefusalError} rather than returning
 * a handle.
 */

/** The compiled worker entry's default location, relative to this module. */
const DEFAULT_WORKER_ENTRY_PATH = fileURLToPath(
  new URL('./worker-entry/index.js', import.meta.url),
);

export interface StartDaemonOptions {
  readonly dbFilePath: string;
  readonly host?: string;
  /** `0` lets the OS assign a free port — read back from `DaemonHandle.port`. */
  readonly port: number;
  readonly apiToken: string;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly daemonConfig: DaemonConfig;
  readonly resolveAdlYml: (feature: FeaturesTable) => AdlYml;
  /**
   * The migrations directory `runStartupGate` applies. Defaults to
   * `@adl/db`'s own shipped `migrations/` (via `resolveMigrationsDir()`,
   * matching `DAEMON_SCHEMA_VERSION`'s own derivation) — override only for a
   * test that needs to control exactly which directory's bytes the
   * checksum guard records against.
   */
  readonly migrationsDir?: string;
  /** Defaults to this package's own compiled worker entry. */
  readonly workerEntryPath?: string;
  readonly workerCwd?: string;
  readonly workerExecArgv?: readonly string[];
  /** How often `dispatchOnce` is called. Default: 25ms. */
  readonly dispatchIntervalMs?: number;
  readonly logger?: Logger;
  /** Test/observability seam: fires whenever a forked worker reports `ready`. */
  readonly onWorkerReady?: (ready: WorkerReady) => void;
}

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly supervisor: WorkerSupervisor;
  stop(): Promise<void>;
}

/**
 * D-13's other half: after {@link killBootOrphans} has had a chance to act
 * on it, expire every held lease unconditionally (`reapOne`, the same
 * function the reaper's own tick and the child-exit fast path both call) —
 * not only ones past `lease_expires_at`. Boot is a deterministic clean
 * slate: nothing from a previous daemon process is left holding a lease.
 */
async function expireAllLeasesAtBoot(
  db: Kysely<Database>,
  logger: Logger,
): Promise<void> {
  const leased = await featuresRepository(db).listLeased();
  const now = nowIso();
  for (const feature of leased) {
    await reapOne({ db, logger }, feature, now);
  }
}

/**
 * Read the just-forked worker's real process start time and persist the
 * D-14 encoded `{pid, startTime}` record into `lease_owner`, fenced by the
 * lease token so a late-arriving `ready` from an already-superseded lease
 * cannot overwrite a newer holder's record. Bound to the supervisor's
 * `onReady` hook — the earliest point the manager knows the worker's real
 * OS pid; the worker's own self-reported `startedAt` (wall-clock) is not
 * used here because D-14's comparison is boot-relative clock ticks, a
 * different value entirely, which only the manager itself can read.
 */
async function recordLeaseOwnerOnReady(
  db: Kysely<Database>,
  ready: WorkerReady,
  logger: Logger,
): Promise<void> {
  const startTimeResult = readProcessStartTime(ready.pid);
  const record = {
    pid: ready.pid,
    startTime:
      startTimeResult.kind === 'available' ? startTimeResult.startTime : null,
  };
  try {
    await db
      .updateTable('features')
      .set({ lease_owner: encodeLeaseOwner(record) })
      .where('id', '=', ready.featureId)
      .where('lease_token', '=', ready.leaseToken)
      .execute();
  } catch (error) {
    logger.error(
      { err: error, featureId: ready.featureId },
      'failed to record lease_owner PID/start-time on worker ready',
    );
  }
}

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonHandle> {
  const db: Kysely<Database> = createDb(options.dbFilePath);
  const logger = options.logger ?? pino({ level: 'info' });
  const host = options.host ?? '127.0.0.1';
  const migrationsDir = options.migrationsDir ?? resolveMigrationsDir();

  // D-37's fixed order: schema gate (refuse newer, copy-then-migrate an
  // older or unseeded database) before any other database access beyond
  // the gate's own.
  const gateResult = await runStartupGate({
    db,
    dbFilePath: options.dbFilePath,
    migrationsDir,
    logger,
  });
  if (gateResult.kind === 'refused') {
    await db.destroy();
    throw new SchemaVersionRefusalError(gateResult.refusal);
  }

  // D-35: reconcile watched repositories next.
  await reconcileRepos({ db, repos: options.daemonConfig.repos, logger });

  // D-13: kill any still-running orphan from a previous daemon process
  // *before* expiring leases — `killBootOrphans` needs `lease_owner`'s PID
  // while it is still populated; expiring first would lose it.
  await killBootOrphans({ db, logger });
  await expireAllLeasesAtBoot(db, logger);

  const staleRejectionCounter = createStaleRejectionCounter();

  const supervisor = createSupervisor({
    entryPath: options.workerEntryPath ?? DEFAULT_WORKER_ENTRY_PATH,
    cwd: options.workerCwd ?? process.cwd(),
    execArgv: options.workerExecArgv,
    logger,
    leaseTtlMs: options.leaseTtlMs,
    renewLease: (params) => featuresRepository(db).renewLease(params),
    getCurrentLeaseToken: async (featureId) => {
      const row = await featuresRepository(db).findById(featureId);
      return row?.lease_token ?? null;
    },
    staleRejectionCounter,
    onReady: (ready) => {
      void recordLeaseOwnerOnReady(db, ready, logger);
      options.onWorkerReady?.(ready);
    },
    // D-04's fast path: a forked worker exited without an accepted result.
    // `createFastPathRecovery` re-reads the row (it may have moved since the
    // fork started) and hands it to `reapOne` — the same function the
    // reaper's own tick calls — whose `expectedLeaseToken` guard makes this a
    // safe no-op if the lease was already reassigned by the time this exit
    // is observed.
    onUnexpectedExit: createFastPathRecovery({ db, logger }),
  });

  const reaper = startReaper({
    db,
    logger,
    intervalMs: options.heartbeatIntervalMs,
  });

  async function listFeatureViews(): Promise<readonly FeatureView[]> {
    const rows = await db
      .selectFrom('features')
      .selectAll()
      .orderBy('id')
      .execute();
    const now = Date.now();
    return rows.map((row): FeatureView => {
      let pipelineLength = 0;
      if (row.effective_config_json) {
        try {
          const parsed = JSON.parse(row.effective_config_json) as {
            pipeline?: readonly unknown[];
          };
          pipelineLength = parsed.pipeline?.length ?? 0;
        } catch {
          pipelineLength = 0;
        }
      }
      const active = supervisor.get(row.id);
      return {
        id: row.id,
        repoId: row.repo_id,
        path: row.path,
        state: row.state,
        round: row.round,
        stageIndex: row.current_stage_index,
        pipelineLength,
        ageMs: now - Date.parse(row.created_at),
        worker: active ? { pid: active.worker.pid } : null,
        staleRejections: staleRejectionCounter.forFeature(row.id),
      };
    });
  }

  const app = createApi({
    apiToken: options.apiToken,
    schemaVersion: DAEMON_SCHEMA_VERSION,
    listFeatureViews,
  });

  const server: ServerType = await new Promise((resolve) => {
    const instance = serve(
      { fetch: app.fetch, hostname: host, port: options.port },
      () => resolve(instance),
    );
  });
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null
      ? address.port
      : options.port;

  async function tick(): Promise<void> {
    try {
      await dispatchOnce({
        db,
        leaseTtlMs: options.leaseTtlMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        daemonConfig: options.daemonConfig,
        resolveAdlYml: options.resolveAdlYml,
        spawnWorker: ({ feature, leaseToken, assign }) => {
          supervisor.spawn(feature, leaseToken, assign);
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'dispatch tick failed');
    }
  }

  const dispatchTimer = setInterval(() => {
    void tick();
  }, options.dispatchIntervalMs ?? 25);

  async function stop(): Promise<void> {
    // D-37: stop dispatch, then every worker with a real grace window
    // (soft_stop over IPC, SIGKILL after worker_stop_grace_ms — Pattern 2,
    // never an OS SIGTERM), then close the server, then flush.
    await gracefulShutdown({
      supervisor,
      reaper,
      dispatchTimer,
      server,
      db,
      workerStopGraceMs: options.daemonConfig.worker_stop_grace_ms,
      logger,
    });
  }

  return { host, port: boundPort, supervisor, stop };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  await handle.stop();
}
