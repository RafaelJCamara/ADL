import { pathToFileURL } from 'node:url';
import {
  parseManagerMessage,
  type AssignMessage,
  type WorkerToManagerMessage,
} from '../ipc/protocol.js';
import { createProductionStageRunner } from './stage-runner.js';

/**
 * The forked worker's own main (D-30).
 *
 * This module **must not import `@adl/db`** — `eslint.config.js`'s
 * `adl/worker-entry-no-db` rule enforces that at build time (Task 3), because
 * D-21 fixes the package count at two and pnpm's strict `node_modules` can no
 * longer keep `@adl/db` out of this module's dependency graph structurally
 * (D-01). Every state change is reported to the manager over the `fork()` IPC
 * channel instead; the manager is the one writer.
 *
 * `runWorker(deps)` is exported so the actual process entry point can be
 * exercised two ways with no divergence between them: this file's own bottom
 * `main()` (the real, shipped forked process), and a scripted double that
 * imports `runWorker` and passes a scripted {@link StageRunner}
 * (`test/helpers/worker-harness.ts`, D-30). There is deliberately no `--fake`
 * flag and no environment variable selecting a runner — a flag on the shipped
 * binary is a foot-gun on a real installation, and injection through a
 * parameter means a later phase replaces one module rather than deleting a
 * harness.
 */

/** What a stage run produced, in the shape the worker reports back. */
export interface StageRunnerResult {
  readonly verdictJson: string;
}

/**
 * The thing that would call an agent. Injected so `runWorker` never decides
 * for itself whether it is running for real or under test.
 */
export type StageRunner = (assign: AssignMessage) => Promise<StageRunnerResult>;

export interface WorkerDeps {
  readonly stageRunner: StageRunner;
}

function send(message: WorkerToManagerMessage): void {
  // `process.send` is only defined when this process was started with an IPC
  // channel (`fork()`'s fourth stdio slot) — true for every real and scripted
  // invocation of this module, and simply absent if someone runs this file
  // directly with `node worker-entry/index.js`, in which case there is no
  // channel to report over and dropping the message is the honest behaviour.
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

/**
 * Register the message loop and run until an `assign`ed stage completes, a
 * `soft_stop`/`lease_lost` message arrives, or the IPC channel dies.
 *
 * Accepts exactly one `assign` per process lifetime — a second is rejected
 * and logged (dropped silently to stderr; this module owns no logger and
 * `@adl/db` is off limits). On `soft_stop` it aborts the current stage and
 * exits — the same self-termination path D-05 already specifies for a dead
 * renewal or channel, which is why the D-28 amendment (soft_stop over IPC)
 * costs no new capability. On a dead IPC channel (`process.disconnect`) it
 * exits non-zero, because nothing this worker does past that point can be
 * observed or trusted.
 */
export function runWorker(deps: WorkerDeps): void {
  let assigned: AssignMessage | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  /** Stop without reporting anything further — the manager already knows why. */
  function exitNow(code: number): void {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    process.exit(code);
  }

  /** Stop and tell the manager why, if a lease was ever assigned. */
  function exitFatal(reason: string): void {
    if (stopped) return;
    stopped = true;
    if (assigned) {
      send({ t: 'fatal', leaseToken: assigned.leaseToken, reason });
    }
    clearHeartbeat();
    process.exit(1);
  }

  async function runAssignedStage(assign: AssignMessage): Promise<void> {
    try {
      const result = await deps.stageRunner(assign);
      if (stopped) return;
      send({
        t: 'stage_result',
        leaseToken: assign.leaseToken,
        // Round/stage bookkeeping lands with the full pipeline walk in a
        // later plan; this tracer's stage runner always reports the first
        // slot of the first round of the round it was assigned for.
        roundId: 0,
        stageIndex: 0,
        verdictJson: result.verdictJson,
      });
      exitNow(0);
    } catch (error) {
      exitFatal(error instanceof Error ? error.message : String(error));
    }
  }

  process.on('message', (raw: unknown) => {
    const parsed = parseManagerMessage(raw);
    if (!parsed.ok) {
      process.stderr.write(
        `worker-entry: dropped an unparseable manager message: ${parsed.reason}\n`,
      );
      return;
    }
    const message = parsed.message;

    switch (message.t) {
      case 'assign': {
        if (assigned) {
          process.stderr.write(
            'worker-entry: a second assign message was rejected — exactly one per process lifetime\n',
          );
          return;
        }
        assigned = message;
        send({
          t: 'ready',
          leaseToken: message.leaseToken,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        });
        heartbeatTimer = setInterval(() => {
          if (!assigned) return;
          send({
            t: 'heartbeat',
            leaseToken: assigned.leaseToken,
            at: new Date().toISOString(),
          });
        }, message.heartbeatIntervalMs);
        heartbeatTimer.unref?.();
        void runAssignedStage(message);
        break;
      }
      case 'soft_stop': {
        exitNow(0);
        break;
      }
      case 'lease_lost': {
        exitNow(1);
        break;
      }
    }
  });

  process.on('disconnect', () => {
    exitFatal('ipc channel disconnected');
  });
}

function isEntryPoint(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;
  return pathToFileURL(argvPath).href === import.meta.url;
}

function main(): void {
  runWorker({ stageRunner: createProductionStageRunner() });
}

if (isEntryPoint()) {
  main();
}
