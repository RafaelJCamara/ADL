import type { ServerType } from '@hono/node-server';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { SoftStopMessage } from '../ipc/protocol.js';
import type {
  ActiveWorker,
  WorkerSupervisor,
} from '../worker-supervisor/supervisor.js';

/**
 * `gracefulShutdown` — stop dispatch, stop every worker with a real grace
 * window, close the HTTP server, flush the logger, in that order (D-37).
 *
 * The per-worker escalation (`stopWorkerGracefully`) is factored into its
 * own exported function so a later plan's `adl kill` (D-28, `03-07`) shares
 * it rather than drifting — same IPC `soft_stop`-then-`SIGKILL` shape,
 * one implementation.
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

function raceWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<'resolved' | 'timed-out'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve('resolved');
    });
  });
}

/**
 * Stop one worker: send `soft_stop` over IPC (Pattern 2 — a Windows
 * `child.kill('SIGTERM')` is emulated by unconditional forceful termination
 * and runs no handler, so an OS signal gives no grace period at all on one
 * of the two platforms D-33 requires CI to cover), wait up to `graceMs` for
 * it to exit on its own, and `SIGKILL` whatever is still alive afterwards.
 *
 * Marks the worker's next exit as expected first, so the supervisor's own
 * `child.on('exit')` fast path does not also apply `lease_expired` for an
 * exit this function itself requested.
 */
export async function stopWorkerGracefully(
  supervisor: WorkerSupervisor,
  entry: ActiveWorker,
  graceMs: number,
  logger: Logger,
): Promise<void> {
  supervisor.markExpectedExit(entry.featureId);
  const child = entry.worker.child;

  if (child.exitCode !== null || child.signalCode !== null) {
    return; // already gone
  }

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  const softStop: SoftStopMessage = {
    t: 'soft_stop',
    reason: 'daemon shutdown',
  };
  child.send?.(softStop);

  const raceResult = await raceWithTimeout(exited, graceMs);
  if (raceResult === 'timed-out') {
    logger.warn(
      { featureId: entry.featureId, pid: child.pid },
      `worker did not exit within the ${graceMs}ms grace period after soft_stop — SIGKILLing`,
    );
    child.kill('SIGKILL');
    await exited;
  }
}

async function flushLogger(logger: Logger): Promise<void> {
  if (typeof logger.flush !== 'function') return;
  await new Promise<void>((resolve) => {
    logger.flush(() => resolve());
  });
}

/**
 * Stop the daemon in the order D-37 fixes: stop dispatch, stop every worker
 * (with a real grace window on both platforms), close the HTTP server,
 * destroy the database handle, flush the logger.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  clearInterval(deps.dispatchTimer);
  deps.reaper.stop();

  const workers = deps.supervisor.list();
  await Promise.all(
    workers.map((entry) =>
      stopWorkerGracefully(
        deps.supervisor,
        entry,
        deps.workerStopGraceMs,
        deps.logger,
      ),
    ),
  );

  await new Promise<void>((resolve, reject) => {
    deps.server.close((err) => (err ? reject(err) : resolve()));
  });
  await deps.db.destroy();
  await flushLogger(deps.logger);
}
