/**
 * `in-flight.ts` -- a tiny registry of fire-and-forget async work, so a
 * shutdown can wait for it instead of closing the database underneath it
 * (D-8-03-1).
 *
 * The daemon starts work nobody awaits: a worker message being fenced and
 * written, a fast-path reap after a worker exit, a dispatch tick, a reaper
 * tick. Each one reads or writes the database, and `gracefulShutdown` ends by
 * destroying that handle -- so any of them still running at that point
 * rejects with `driver has already been destroyed`. Registering the promise
 * here is what lets shutdown say "wait for these, with a bound, then destroy".
 *
 * Classify, don't throw: {@link InFlightTracker.settled} resolves with a
 * {@link SettleOutcome} rather than rejecting, and a tracked task that rejects
 * is *not* this module's problem -- it is swallowed here only so that
 * waiting on it cannot itself throw; the task's owner is responsible for
 * handling its own failure (every call site already does).
 */

/** How a {@link InFlightTracker.settled} wait ended. */
export type SettleOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'timed-out'; readonly pending: number };

export interface InFlightTracker {
  /**
   * Register `task` as in flight until it settles (either way). Returns the
   * very same promise, so the call site keeps its own handling of the result.
   */
  track<T>(task: Promise<T>): Promise<T>;
  /** How many tracked tasks have not settled yet. */
  pending(): number;
  /**
   * Resolve once no tracked task is pending -- including a task registered
   * *while* waiting -- or after `timeoutMs`, whichever comes first.
   */
  settled(timeoutMs: number): Promise<SettleOutcome>;
}

export function createInFlightTracker(): InFlightTracker {
  const tasks = new Set<Promise<unknown>>();

  function track<T>(task: Promise<T>): Promise<T> {
    tasks.add(task);
    const forget = (): void => {
      tasks.delete(task);
    };
    task.then(forget, forget);
    return task;
  }

  async function settled(timeoutMs: number): Promise<SettleOutcome> {
    const deadline = Date.now() + timeoutMs;
    while (tasks.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: 'timed-out', pending: tasks.size };
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), remaining);
      });
      const snapshot = [...tasks].map((task) =>
        task.then(
          () => undefined,
          () => undefined,
        ),
      );
      const result = await Promise.race([
        Promise.all(snapshot).then(() => 'drained' as const),
        timedOut,
      ]);
      clearTimeout(timer);
      if (result === 'timed-out') {
        return { kind: 'timed-out', pending: tasks.size };
      }
      // Loop: a task may have registered more work while we waited.
    }
    return { kind: 'settled' };
  }

  return { track, pending: () => tasks.size, settled };
}
