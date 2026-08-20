import type { ServerType } from '@hono/node-server';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { stopAllWorkers } from '../worker-supervisor/lifecycle.js';
import type { WorkerSupervisor } from '../worker-supervisor/supervisor.js';

/**
 * `gracefulShutdown` — stop dispatch, stop every worker with a real grace
 * window, close the HTTP server, flush the logger, in that order (D-37).
 *
 * The per-worker escalation itself lives in `worker-supervisor/lifecycle.ts`
 * (`stopWorker`/`stopAllWorkers`) — the single implementation `adl kill`
 * (D-28, `03-07`) shares rather than a parallel copy here, so the
 * grace-period behaviour cannot drift between shutdown and kill.
 */

export interface ShutdownDeps {
  readonly supervisor: WorkerSupervisor;
  readonly reaper: { stop(): void };
  readonly dispatchTimer: NodeJS.Timeout;
  readonly server: ServerType;
  readonly db: Kysely<Database>;
  readonly workerStopGraceMs: number;
  readonly logger: Logger;
}

async function flushLogger(logger: Logger): Promise<void> {
  if (typeof logger.flush !== 'function') return;
  await new Promise<void>((resolve) => {
    logger.flush(() => resolve());
  });
}

/**
 * Stop the daemon in the order D-37 fixes: stop dispatch, stop every worker
 * (with a real grace window on both platforms, via `stopAllWorkers`), close
 * the HTTP server, destroy the database handle, flush the logger.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  clearInterval(deps.dispatchTimer);
  deps.reaper.stop();

  await stopAllWorkers(deps.supervisor, deps.workerStopGraceMs, deps.logger);

  await new Promise<void>((resolve, reject) => {
    deps.server.close((err) => (err ? reject(err) : resolve()));
  });
  await deps.db.destroy();
  await flushLogger(deps.logger);
}
