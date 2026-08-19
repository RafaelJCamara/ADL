import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import {
  createDb,
  featuresRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import type { AdlYml, DaemonConfig } from '@adl/core/config';
import type { Kysely } from 'kysely';
import pino, { type Logger } from 'pino';
import { createApi } from './api/app.js';
import type { FeatureView } from './api/routes/features.js';
import { dispatchOnce } from './scheduler/dispatcher.js';
import { createFastPathRecovery, startReaper } from './scheduler/reaper.js';
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
 * The startup schema-version gate, repo reconciliation, and boot orphan kill
 * (D-13, D-35, D-37) are **not** here yet — a later plan adds them. Keeping
 * the wiring in one function is what lets that plan extend a sequence rather
 * than restructure one.
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
  readonly schemaVersion: number;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly daemonConfig: DaemonConfig;
  readonly resolveAdlYml: (feature: FeaturesTable) => AdlYml;
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

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonHandle> {
  const db: Kysely<Database> = createDb(options.dbFilePath);
  const logger = options.logger ?? pino({ level: 'info' });
  const host = options.host ?? '127.0.0.1';

  const supervisor = createSupervisor({
    entryPath: options.workerEntryPath ?? DEFAULT_WORKER_ENTRY_PATH,
    cwd: options.workerCwd ?? process.cwd(),
    execArgv: options.workerExecArgv,
    logger,
    leaseTtlMs: options.leaseTtlMs,
    renewLease: (params) => featuresRepository(db).renewLease(params),
    onReady: options.onWorkerReady,
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
      };
    });
  }

  const app = createApi({
    apiToken: options.apiToken,
    schemaVersion: options.schemaVersion,
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
    clearInterval(dispatchTimer);
    reaper.stop();

    const workers = supervisor.list();
    await Promise.all(
      workers.map((entry) => {
        // Deliberate shutdown: this exit is manager-requested, so the fast
        // path must not race `db.destroy()` below with its own write.
        supervisor.markExpectedExit(entry.featureId);
        return new Promise<void>((resolve) => {
          const child = entry.worker.child;
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
      }),
    );

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.destroy();
  }

  return { host, port: boundPort, supervisor, stop };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  await handle.stop();
}
