import type { Logger } from 'pino';
import type { SoftStopMessage } from '../ipc/protocol.js';
import type { ActiveWorker, WorkerSupervisor } from './supervisor.js';

/**
 * `src/worker-supervisor/lifecycle.ts` — `stopWorker`, the single
 * implementation of D-28 as amended (`<amendment_reference>`,
 * `03-04-PLAN.md`'s `<amendment>`): a `soft_stop` IPC message, a bounded
 * grace window, then `SIGKILL`. It does **not** send `SIGTERM` — on
 * Windows a forked child's `child.kill('SIGTERM')` is emulated by
 * unconditional forceful termination and runs no handler, so an OS signal
 * gives no grace period at all on one of the two platforms D-33 requires CI
 * to cover. `SIGKILL` is the one signal that is reliably forceful on both
 * platforms.
 *
 * This is the single implementation three call sites share, so the
 * escalation behaviour cannot drift between them: `03-06`'s
 * `gracefulShutdown` (`boot/shutdown.ts`), `adl kill` (this plan's
 * `api/routes/control.ts` and `api/routes/features.ts`), and — unlike
 * either of those — Task 2's park path, which deliberately does **not**
 * call this: parking waits for a round boundary, killing does not.
 */

/**
 * How a `stopWorker` call ended:
 * - `'already-gone'` — the child had already exited before this call; no
 *   IPC message and no signal were sent.
 * - `'graceful'` — the child exited on its own within `graceMs` of
 *   receiving `soft_stop`.
 * - `'forced'` — the child did not exit within `graceMs`, and was
 *   `SIGKILL`ed.
 */
export type StopOutcome = 'already-gone' | 'graceful' | 'forced';

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
 * Stop one worker: send `soft_stop` over IPC, wait up to `graceMs` for it
 * to exit on its own, and `SIGKILL` whatever is still alive afterwards.
 * Resolves with the {@link StopOutcome} rather than hanging — a wedged
 * worker cannot block the caller indefinitely (T-3-33).
 *
 * Marks the worker's next exit as expected first, so the supervisor's own
 * `child.on('exit')` fast path does not also apply `lease_expired` for an
 * exit this function itself requested.
 */
export async function stopWorker(
  supervisor: WorkerSupervisor,
  entry: ActiveWorker,
  graceMs: number,
  logger: Logger,
): Promise<StopOutcome> {
  supervisor.markExpectedExit(entry.featureId);
  const child = entry.worker.child;

  if (child.exitCode !== null || child.signalCode !== null) {
    return 'already-gone';
  }

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  const softStop: SoftStopMessage = {
    t: 'soft_stop',
    reason: 'stopped by operator',
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
    return 'forced';
  }
  return 'graceful';
}

/** Stop every currently-active worker, in parallel, with the same grace window. */
export async function stopAllWorkers(
  supervisor: WorkerSupervisor,
  graceMs: number,
  logger: Logger,
): Promise<void> {
  const workers = supervisor.list();
  await Promise.all(
    workers.map((entry) => stopWorker(supervisor, entry, graceMs, logger)),
  );
}
