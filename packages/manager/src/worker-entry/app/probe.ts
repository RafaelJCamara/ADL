/**
 * The readiness contract, all four kinds of it (ROLE-07, M08 step 8.2).
 *
 * `ReadyProbeSchema` has declared `http`, `tcp`, `log` and `exec` since M01 with
 * **no implementation of any of them** — M08's audit finding 4, and the reason
 * the step sketch's "three probe kinds" was corrected to four. A fifth kind is a
 * compile error here rather than a silent fall-through, because the switch below
 * is exhaustive over the discriminated union and has no `default`.
 *
 * ## Why every dependency is injected
 *
 * This module answers "is it up yet?", which is four different questions of four
 * different subsystems. Two of them (`http`, `tcp`) it asks itself; two of them
 * it cannot:
 *
 * - **`log`** is answered from the output of a child this module did not start.
 *   It is handed a `() => string` reader rather than a stream, because the
 *   start command's output is already being accumulated for the transcript and a
 *   second consumer of the same stream would either steal chunks or need the
 *   whole thing buffered twice.
 * - **`exec`** has to run a program inside the workspace, and `Workspace` is not
 *   this module's to hold: `packages/workspace` is the exec boundary, and a
 *   probe module reaching for it directly is how a second launcher gets written.
 *   It is handed a function that runs an argv and answers with an exit code.
 *
 * The same injection makes every case unit-testable with no server, no port and
 * no child process — the shape `@adl/core`'s purity rule teaches even outside
 * `@adl/core`.
 *
 * ## The app dying is a distinct answer from the app being slow
 *
 * {@link ReadinessOutcome} has three members, not two. An app that exits during
 * the probe window and an app that is merely still starting want different
 * treatment — the first is very likely the developer's code crashing on boot,
 * which is a `send_back`; the second is a timeout, which is retryable and costs
 * no round. Collapsing them into "not ready" is exactly the single mapping M08's
 * audit finding 6 says cannot serve three causes, and step 8.3 owns the table
 * this feeds.
 */
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReadyProbe } from '@adl/core/config';

/** How often a probe is retried while it is not yet satisfied. */
export const DEFAULT_PROBE_INTERVAL_MS = 100;

/**
 * How long one `http` or `tcp` attempt may hang before it is abandoned and
 * retried.
 *
 * A per-attempt ceiling, not the overall one: `ready_timeout` bounds the whole
 * wait, and an attempt that hangs for longer than the remaining budget would
 * overshoot it. A connection to a port nothing is listening on is refused
 * immediately on every platform measured; a connection to a port a *firewall* is
 * dropping hangs, and that is the case this bounds.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 2_000;

/** What a single probe attempt concluded. */
type AttemptResult =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly detail: string };

/** What {@link awaitReady} answers. */
export type ReadinessOutcome =
  /** The probe was satisfied. */
  | { readonly kind: 'ready'; readonly afterMs: number }
  /**
   * The app's own process ended while ADL was still waiting. Distinct from
   * `not-ready` on purpose — see the module docblock.
   */
  | {
      readonly kind: 'app-exited';
      readonly afterMs: number;
      readonly detail: string;
    }
  /** `ready_timeout` elapsed with the probe still unsatisfied. */
  | {
      readonly kind: 'not-ready';
      readonly afterMs: number;
      readonly detail: string;
    };

/** Everything {@link awaitReady} needs, and nothing it could obtain itself. */
export interface ReadinessDeps {
  /** The probe, with `${ADL_PORT}` already substituted (`interpolateReadyProbe`). */
  readonly probe: ReadyProbe;
  /** `commands.start.ready_timeout`, in milliseconds. Bounds the whole wait. */
  readonly timeoutMs: number;
  /** See the module docblock: the start command's accumulated output. */
  readonly output: () => string;
  /** Whether the start command's own process has ended. */
  readonly exited: () => boolean;
  /**
   * Run one probe command inside the workspace and answer with its exit code
   * (`null` when it was killed rather than exiting). Only the `exec` kind uses
   * it, and it is required rather than optional so a caller cannot configure an
   * `exec` probe that silently never runs.
   */
  readonly execProbe: (argv: readonly string[]) => Promise<number | null>;
  /** Overridable for tests; defaults to {@link DEFAULT_PROBE_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** Budget interrupt, pause, or shutdown. */
  readonly signal?: AbortSignal;
}

/** One `http` attempt: reachable, and the expected status when one was declared. */
async function attemptHttp(
  probe: Extract<ReadyProbe, { kind: 'http' }>,
): Promise<AttemptResult> {
  try {
    const response = await fetch(probe.url, {
      signal: AbortSignal.timeout(PROBE_ATTEMPT_TIMEOUT_MS),
      // A readiness probe must not be answered out of a cache, and must not
      // follow a redirect into a different app: `expect: 200` on a URL that
      // 302s to a login page would otherwise read as ready.
      redirect: 'manual',
    });
    if (probe.expect !== undefined && response.status !== probe.expect) {
      return {
        satisfied: false,
        detail: `${probe.url} answered ${String(response.status)}, expected ${String(probe.expect)}`,
      };
    }
    return { satisfied: true };
  } catch (error) {
    return {
      satisfied: false,
      detail: `${probe.url} is not answering: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** One `tcp` attempt: does anything accept a connection on that port? */
async function attemptTcp(
  probe: Extract<ReadyProbe, { kind: 'tcp' }>,
): Promise<AttemptResult> {
  return await new Promise<AttemptResult>((resolve) => {
    const socket = connect({ port: probe.port, host: '127.0.0.1' });
    let done = false;
    const finish = (result: AttemptResult): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_ATTEMPT_TIMEOUT_MS, () => {
      finish({
        satisfied: false,
        detail: `port ${String(probe.port)} did not answer within ${String(PROBE_ATTEMPT_TIMEOUT_MS)}ms`,
      });
    });
    socket.once('connect', () => {
      finish({ satisfied: true });
    });
    socket.once('error', (error: Error) => {
      finish({
        satisfied: false,
        detail: `port ${String(probe.port)} refused a connection: ${error.message}`,
      });
    });
  });
}

/**
 * Wait until the probe is satisfied, the app dies, or `ready_timeout` elapses.
 *
 * The exit check runs **before** the first attempt as well as between them, so
 * an app that died instantly — which is exactly what
 * `commands.start: { argv: ['true'] }` does, and what every pre-M08 fixture
 * declares — is reported as `app-exited` rather than probed for the full
 * timeout.
 */
export async function awaitReady(
  deps: ReadinessDeps,
): Promise<ReadinessOutcome> {
  const { probe, timeoutMs, output, exited, execProbe } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastDetail = 'the probe was never attempted';

  for (;;) {
    const elapsed = (): number => Date.now() - startedAt;

    if (exited()) {
      return {
        kind: 'app-exited',
        afterMs: elapsed(),
        detail: `the start command's process ended while ADL was still waiting for the ${probe.kind} readiness probe`,
      };
    }

    const attempt = await attemptFor(probe, output, execProbe);
    if (attempt.satisfied) {
      return { kind: 'ready', afterMs: elapsed() };
    }
    lastDetail = attempt.detail;

    // Checked immediately after the attempt rather than at the top of the loop,
    // so the last attempt's own detail is what a human reads — convention 10's
    // "before the state-changing action" does not apply to a read-only poll, and
    // reporting "the probe was never attempted" after a 30s wait would be worse
    // than useless.
    if (Date.now() >= deadline) {
      return {
        kind: 'not-ready',
        afterMs: elapsed(),
        detail: lastDetail,
      };
    }

    await delay(intervalMs, undefined, {
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
  }
}

/**
 * Dispatch one attempt. Exhaustive over the union with **no `default` branch**,
 * so a fifth probe kind fails the build rather than being quietly treated as
 * never-ready.
 */
async function attemptFor(
  probe: ReadyProbe,
  output: () => string,
  execProbe: (argv: readonly string[]) => Promise<number | null>,
): Promise<AttemptResult> {
  switch (probe.kind) {
    case 'http':
      return await attemptHttp(probe);
    case 'tcp':
      return await attemptTcp(probe);
    case 'log':
      // A literal substring, as `LogReadyProbeSchema` declares — not a regular
      // expression. A pattern out of `adl.yml` is repository-supplied input
      // (D-22), and compiling one as a regex would hand a watched repository a
      // catastrophic-backtracking primitive pointed at the daemon's own worker.
      return output().includes(probe.pattern)
        ? { satisfied: true }
        : {
            satisfied: false,
            detail: `the start command has not printed ${JSON.stringify(probe.pattern)} yet`,
          };
    case 'exec': {
      const exitCode = await execProbe(probe.argv);
      return exitCode === 0
        ? { satisfied: true }
        : {
            satisfied: false,
            detail: `\`${probe.argv.join(' ')}\` exited ${exitCode === null ? 'without an exit code' : String(exitCode)}`,
          };
    }
  }
}
