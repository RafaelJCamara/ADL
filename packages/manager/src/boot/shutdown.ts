import type { ServerType } from '@hono/node-server';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { stopAllWorkers } from '../worker-supervisor/lifecycle.js';
import type { WorkerSupervisor } from '../worker-supervisor/supervisor.js';
import type { SettleOutcome } from '../in-flight.js';

/**
 * `gracefulShutdown` — stop dispatch, stop every worker with a real grace
 * window, close the HTTP server, flush the logger, in that order (D-37).
 *
 * The per-worker escalation itself lives in `worker-supervisor/lifecycle.ts`
 * (`stopWorker`/`stopAllWorkers`) — the single implementation `adl kill`
 * (D-28, `03-07`) shares rather than a parallel copy here, so the
 * grace-period behaviour cannot drift between shutdown and kill.
 *
 * Nothing destroys the database while work that uses it is still running
 * (D-8-03-1): the daemon starts several fire-and-forget tasks -- a dispatch
 * tick, a reaper tick, every worker message being fenced and written -- and
 * each is awaited here, with a bound, before `db.destroy()`.
 */

export interface ShutdownDeps {
  readonly supervisor: WorkerSupervisor;
  readonly reaper: {
    stop(): void;
    /** Resolves when no reaper tick is in flight, or after `timeoutMs`. */
    settled(timeoutMs: number): Promise<SettleOutcome>;
  };
  readonly dispatchTimer: NodeJS.Timeout;
  /**
   * The dispatch ticks (and `POST /dev-run` dispatches) that are in flight.
   * Awaited BEFORE the workers are stopped: a dispatch that is mid-lease would
   * otherwise fork a worker after `stopAllWorkers` had already listed them.
   */
  readonly dispatch: {
    settled(timeoutMs: number): Promise<SettleOutcome>;
  };
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
 * A wait that timed out is reported, never thrown: shutdown must finish even
 * when a task is wedged. The stragglers are each guarded by their own
 * `.catch`, so the worst case is a logged warning, not an unhandled rejection.
 */
function warnIfUnsettled(
  logger: Logger,
  what: string,
  outcome: SettleOutcome,
): void {
  if (outcome.kind === 'settled') return;
  logger.warn(
    { pending: outcome.pending },
    `shutdown: ${outcome.pending} ${what} task(s) were still running when the grace period ended -- destroying the database anyway`,
  );
}

/**
 * Stop the daemon in the order D-37 fixes: stop dispatch, stop every worker
 * (with a real grace window on both platforms, via `stopAllWorkers`), close
 * the HTTP server, destroy the database handle, flush the logger -- and, since
 * D-8-03-1, wait for the in-flight tasks that use the database between the
 * worker stop and the destroy.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  clearInterval(deps.dispatchTimer);
  deps.reaper.stop();

  warnIfUnsettled(
    deps.logger,
    'dispatch',
    await deps.dispatch.settled(deps.workerStopGraceMs),
  );

  await stopAllWorkers(deps.supervisor, deps.workerStopGraceMs, deps.logger);

  // Every worker has exited and been told so: what is left is the work their
  // last messages (and exits) started. Wait for it before the database goes.
  warnIfUnsettled(
    deps.logger,
    'worker-message',
    await deps.supervisor.drain(deps.workerStopGraceMs),
  );

  await new Promise<void>((resolve, reject) => {
    deps.server.close((err) => (err ? reject(err) : resolve()));
  });
  warnIfUnsettled(
    deps.logger,
    'reaper',
    await deps.reaper.settled(deps.workerStopGraceMs),
  );
  await deps.db.destroy();
  await flushLogger(deps.logger);
}
