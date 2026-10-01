import { once } from 'node:events';
import type { ServerType } from '@hono/node-server';
import type { Database, FeaturesTable } from '@adl/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createInFlightTracker,
  createSupervisor,
  gracefulShutdown,
  type SupervisorDeps,
  type WorkerSupervisor,
} from '../../src/index.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withHeldWorker } from '../helpers/worker-harness.js';

/**
 * D-8-03-1 -- `gracefulShutdown` must not destroy the database while work that
 * uses it is still running.
 *
 * Every race here is made deterministic by a GATE: a promise the test holds
 * and releases, standing in for "this database call is slow". Nothing depends
 * on how fast a worker or a query happens to be -- only on whether shutdown
 * waits for a task that has provably not finished. The only wall-clock use is
 * an upper bound on the one test that proves the wait is bounded.
 *
 * Watched failing (convention 13): against the pre-fix `gracefulShutdown` /
 * `createSupervisor`, "does not destroy the database until ..." fails with the
 * database already destroyed while the gated fence check is still pending --
 * exactly the production defect (a `driver has already been destroyed`
 * rejection after the test, or the daemon, had finished).
 */

const LEASE_TOKEN = 'lease-token-d-8-03-1';
const FEATURE_ID = 'feature-d-8-03-1';

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function createGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Enough macrotask turns for any already-runnable continuation to have run. */
async function yieldToEventLoop(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Only `id`, `repo_id` and `path` are read by the supervisor on these paths. */
const feature = {
  id: FEATURE_ID,
  repo_id: 'repo-d-8-03-1',
  path: `features/${FEATURE_ID}`,
} as unknown as FeaturesTable;

async function spawnHeldWorker(overrides: Partial<SupervisorDeps> = {}) {
  const worker = withHeldWorker();
  const { logger, logs } = createCapturingLogger();
  let ready = false;
  const supervisor = createSupervisor({
    entryPath: worker.entryPath,
    cwd: worker.cwd,
    execArgv: worker.execArgv,
    logger,
    leaseTtlMs: 60_000,
    renewLease: async () => true,
    onReady: () => {
      ready = true;
    },
    ...overrides,
  });
  const entry = supervisor.spawn(feature, LEASE_TOKEN, {
    t: 'assign',
    featureId: FEATURE_ID,
    leaseToken: LEASE_TOKEN,
    workspaceHandle: `features/${FEATURE_ID}`,
    effectiveConfigJson: '{}',
    // Long, so the worker's own heartbeats never add noise to the counts.
    heartbeatIntervalMs: 3_600_000,
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
  await waitUntil(() => ready);
  return { supervisor, entry, logs };
}

/** A synthetic, schema-valid heartbeat delivered on the supervisor's real channel. */
function deliverHeartbeat(entry: { worker: { child: NodeJS.EventEmitter } }) {
  entry.worker.child.emit('message', {
    t: 'heartbeat',
    leaseToken: LEASE_TOKEN,
    at: new Date().toISOString(),
  });
}

const settledNothing = { settled: async () => ({ kind: 'settled' as const }) };

function shutdownDeps(
  supervisor: WorkerSupervisor,
  extra: {
    onDestroy: () => void;
    dispatch?: { settled: ReturnType<typeof createInFlightTracker>['settled'] };
    graceMs?: number;
  },
) {
  const { logger, logs } = createCapturingLogger();
  const db = {
    destroy: async () => {
      extra.onDestroy();
    },
  } as unknown as Kysely<Database>;
  const server = {
    close: (callback: (error?: Error) => void) => callback(),
  } as unknown as ServerType;
  return {
    logs,
    deps: {
      supervisor,
      reaper: { stop: () => undefined, ...settledNothing },
      dispatchTimer: setInterval(() => undefined, 3_600_000),
      dispatch: extra.dispatch ?? settledNothing,
      server,
      db,
      workerStopGraceMs: extra.graceMs ?? 20_000,
      logger,
    },
  };
}

describe('gracefulShutdown waits for in-flight database work (D-8-03-1)', () => {
  it('does not destroy the database until a worker message already being fenced has finished', async () => {
    const fenceGate = createGate();
    let fenceStarted = 0;
    let fenceFinished = 0;
    let renewed = 0;
    const { supervisor, entry } = await spawnHeldWorker({
      getCurrentLeaseToken: async () => {
        fenceStarted += 1;
        await fenceGate.promise;
        fenceFinished += 1;
        return LEASE_TOKEN;
      },
      renewLease: async () => {
        renewed += 1;
        return true;
      },
    });

    // A heartbeat is now mid-fence: read the token, not yet written.
    deliverHeartbeat(entry);
    await waitUntil(() => fenceStarted === 1);

    let destroyed = false;
    let startedAtDestroy = -1;
    let finishedAtDestroy = -1;
    const { deps } = shutdownDeps(supervisor, {
      onDestroy: () => {
        destroyed = true;
        startedAtDestroy = fenceStarted;
        finishedAtDestroy = fenceFinished;
      },
    });
    const shutdown = gracefulShutdown(deps);

    // Shutdown stops the worker for real; once it has exited, everything that
    // does not depend on the gated message has had its chance to run.
    await waitUntil(() => supervisor.get(FEATURE_ID) === undefined);
    await yieldToEventLoop();

    // THE RACE: the unfixed code has already destroyed the database here, with
    // the heartbeat's fence check still pending.
    expect(destroyed).toBe(false);

    fenceGate.release();
    await shutdown;

    expect(destroyed).toBe(true);
    expect(finishedAtDestroy).toBe(startedAtDestroy);
    expect(renewed).toBe(1);
    expect(startedAtDestroy).toBe(1);
  }, 30_000);

  it('does not destroy the database until an unexpected-exit recovery has finished', async () => {
    const recoveryGate = createGate();
    let recoveryStarted = false;
    let recoveryFinished = false;
    const { supervisor, entry } = await spawnHeldWorker({
      onUnexpectedExit: async () => {
        recoveryStarted = true;
        await recoveryGate.promise;
        recoveryFinished = true;
      },
    });

    // An exit nobody requested -- the 'exit' handler's own database work
    // (`createFastPathRecovery` in production) is now in flight.
    const exited = once(entry.worker.child, 'exit');
    entry.worker.child.kill('SIGKILL');
    await exited;
    await waitUntil(() => recoveryStarted);

    let finishedAtDestroy: boolean | undefined;
    const { deps } = shutdownDeps(supervisor, {
      onDestroy: () => {
        finishedAtDestroy = recoveryFinished;
      },
    });
    const shutdown = gracefulShutdown(deps);
    await yieldToEventLoop();
    expect(finishedAtDestroy).toBeUndefined();

    recoveryGate.release();
    await shutdown;
    expect(finishedAtDestroy).toBe(true);
  }, 30_000);

  it('waits for a dispatch already in flight BEFORE it stops the workers', async () => {
    const dispatchGate = createGate();
    const dispatches = createInFlightTracker();
    void dispatches.track(dispatchGate.promise);
    const { supervisor, entry } = await spawnHeldWorker();
    // Recorded at the moment of the call: `stopWorker` sends `soft_stop`
    // synchronously, so this does not depend on how quickly the child exits.
    const sent: string[] = [];
    const realSend = entry.worker.child.send.bind(entry.worker.child);
    entry.worker.child.send = ((message: { t: string }, ...rest: unknown[]) => {
      sent.push(message.t);
      return (realSend as (...args: unknown[]) => boolean)(message, ...rest);
    }) as typeof entry.worker.child.send;

    const { deps } = shutdownDeps(supervisor, {
      onDestroy: () => undefined,
      dispatch: dispatches,
    });
    const shutdown = gracefulShutdown(deps);
    await yieldToEventLoop();

    // A dispatch that is mid-lease could still fork a worker; stopping the
    // existing ones first would leave that one unstopped.
    expect(sent).not.toContain('soft_stop');

    dispatchGate.release();
    await shutdown;
    expect(sent).toContain('soft_stop');
    expect(supervisor.get(FEATURE_ID)).toBeUndefined();
  }, 30_000);

  it('is bounded: a task that never finishes is reported, and the database is destroyed anyway', async () => {
    const neverGate = createGate();
    let fenceStarted = 0;
    const { supervisor, entry } = await spawnHeldWorker({
      getCurrentLeaseToken: async () => {
        fenceStarted += 1;
        await neverGate.promise;
        return LEASE_TOKEN;
      },
    });
    deliverHeartbeat(entry);
    await waitUntil(() => fenceStarted === 1);

    let destroyed = false;
    const { deps, logs } = shutdownDeps(supervisor, {
      onDestroy: () => {
        destroyed = true;
      },
      graceMs: 300,
    });
    await gracefulShutdown(deps);

    expect(destroyed).toBe(true);
    const warning = logs.find((line) =>
      String(line.msg).includes('still running when the grace period ended'),
    );
    expect(warning).toMatchObject({ pending: 1 });

    neverGate.release(); // let the straggler finish so nothing leaks into the next test
  }, 30_000);
});

describe('WorkerSupervisor.drain (D-8-03-1)', () => {
  it('reports timed-out with the pending count when a tracked task outlives the bound', async () => {
    const gate = createGate();
    let started = 0;
    const { supervisor, entry } = await spawnHeldWorker({
      getCurrentLeaseToken: async () => {
        started += 1;
        await gate.promise;
        return LEASE_TOKEN;
      },
    });
    deliverHeartbeat(entry);
    await waitUntil(() => started === 1);

    expect(await supervisor.drain(50)).toEqual({
      kind: 'timed-out',
      pending: 1,
    });

    gate.release();
    entry.worker.child.kill('SIGKILL');
    await once(entry.worker.child, 'exit');
  }, 30_000);

  it('is closed afterwards: a late message or exit touches nothing', async () => {
    let fenceCalls = 0;
    let exitCalls = 0;
    const { supervisor, entry, logs } = await spawnHeldWorker({
      getCurrentLeaseToken: async () => {
        fenceCalls += 1;
        return LEASE_TOKEN;
      },
      onUnexpectedExit: () => {
        exitCalls += 1;
      },
    });

    expect(await supervisor.drain(1_000)).toEqual({ kind: 'settled' });

    deliverHeartbeat(entry);
    await yieldToEventLoop();
    expect(fenceCalls).toBe(0);

    const exited = once(entry.worker.child, 'exit');
    entry.worker.child.kill('SIGKILL');
    await exited;
    await yieldToEventLoop();
    expect(exitCalls).toBe(0);
    expect(
      logs.some((line) =>
        String(line.msg).includes('after the supervisor was drained'),
      ),
    ).toBe(true);
  }, 30_000);
});

describe('createInFlightTracker', () => {
  it('settles immediately when nothing is tracked', async () => {
    expect(await createInFlightTracker().settled(10)).toEqual({
      kind: 'settled',
    });
  });

  it('waits for work that a tracked task registers as it finishes', async () => {
    const tracker = createInFlightTracker();
    const first = createGate();
    const second = createGate();
    void tracker.track(first.promise);
    // Registered in a continuation of the first task, i.e. while `settled` is
    // already waiting on it.
    void first.promise.then(() => tracker.track(second.promise));

    let done = false;
    const waiting = tracker.settled(10_000).then((outcome) => {
      done = true;
      return outcome;
    });

    first.release();
    await yieldToEventLoop();
    expect(done).toBe(false);

    second.release();
    expect(await waiting).toEqual({ kind: 'settled' });
    expect(tracker.pending()).toBe(0);
  });

  it('treats a rejected task as settled and does not rethrow it', async () => {
    const tracker = createInFlightTracker();
    const rejecting = Promise.reject(new Error('boom'));
    const caught = tracker.track(rejecting).catch(() => 'handled-by-owner');
    expect(await tracker.settled(1_000)).toEqual({ kind: 'settled' });
    expect(await caught).toBe('handled-by-owner');
  });

  it('reports timed-out with the pending count', async () => {
    const tracker = createInFlightTracker();
    const gate = createGate();
    void tracker.track(gate.promise);
    expect(await tracker.settled(20)).toEqual({
      kind: 'timed-out',
      pending: 1,
    });
    gate.release();
  });
});
