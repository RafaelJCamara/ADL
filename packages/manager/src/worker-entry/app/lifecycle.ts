/**
 * The app lifecycle ADL owns (ROLE-07, M08 step 8.2) — `commands.build`, then
 * `commands.start` on an allocated port, then the readiness probe, then the gate,
 * then `commands.teardown` and the reaping of the app's whole process tree.
 *
 * This is the first production reader of three of `adl.yml`'s four required
 * commands. `CommandsSchema` has required `build` / `start` / `test` / `teardown`
 * since M01 and only `test` was ever read — M08's audit finding 4.
 *
 * ## The decision this step existed to make, and the probe that made it
 *
 * The audit's finding 5 said `Workspace.exec` **cannot** start a server: `run()`
 * awaits the child and returns an `ExecResult`, so there is no handle, no detach
 * and no "running" state. The step was therefore written to choose between two
 * uncomfortable options — a new `Workspace` method, which is one-way because
 * `@adl/plugin-sdk` republishes the port (D-01) and which would oblige a future
 * container backend to model a running process; or a third sanctioned launcher
 * inside `@adl/workspace`, which convention 1 says turns the contract guard red
 * and which `workspace-contract.test.ts` pins to exactly two.
 *
 * **Neither is necessary, and a throwaway probe against the installed execa
 * settled it before a line of this file was written** (convention 15). The
 * handle already exists: it is the `Promise<ExecResult>` a caller gets back and
 * *does not await*, paired with the `AbortSignal` `ExecSpec.signal` already
 * accepts. Measured against real node 24 on win32:
 *
 * | # | Question | Answer |
 * |---|---|---|
 * | Q1 | Is a server started through `exec` reachable while the promise is pending? | **Yes** |
 * | Q4 | Do log chunks arrive live before the promise settles? | **Yes** — which is what makes the `log` probe kind possible at all |
 * | Q3 | Does `abort()` reap a **grandchild** server, not just the direct child? | **Yes** — `run()` passes `killDescendants: true` |
 * | Q2 | What does the aborted child's `ExecResult` look like? | `exitCode: 1`, **no signal** |
 *
 * So: no port change, no third launcher, no movement in the contract suite's
 * importer pin. The lifecycle is composition over the published interface, and a
 * third party's gate declaring `needs_app` gets it through exactly the same path
 * the built-in tester will (HARN-04).
 *
 * ## Q2 is the finding worth carrying forward
 *
 * `gates/command-gate.ts` reads `exitCode === null` as *"killed rather than
 * exited"*, quoting `ExecResult`'s own declaration. On win32 that is **false for
 * a cancelled child**: the probe measured `{ exitCode: 1, durationMs: 1144 }`
 * with no `signal` field, which is byte-for-byte what an app that crashed with
 * status 1 returns. A lifecycle that inferred "I killed it" from the exit code
 * would therefore report a crashed app as a clean teardown on the maintainer's
 * own machine and correctly on Linux — the platform split `run()`'s own
 * `reject: false` comment warns about, one layer up.
 *
 * This module never makes that inference. It **holds** the controller, so it
 * knows whether it aborted, and {@link AppTeardown.reaped} is that fact rather
 * than a reading of the exit code.
 *
 * ## Every failure is reported, never thrown (rule 5)
 *
 * {@link AppLifecycleResult} is a discriminated result and {@link AppFailure}
 * enumerates the ways an app can fail to be judgeable. **Mapping those onto
 * `StageError` kinds, `send_back`s and `inconclusive` is step 8.3's** — audit
 * finding 6 is that a single mapping cannot serve three causes, and this step
 * deliberately stops at the facts so 8.3 has something real to map. The caller's
 * mapping today is conservative and says so.
 *
 * ## Teardown runs even when the body throws, and the reap comes first
 *
 * The abort and `commands.teardown` are in a `finally`, for the reason
 * `Workspace.detach`'s docblock gives about its own: a leaked app is a listening
 * port and a spending process that outlives the round it belonged to (T-2-07).
 * **In that order**, and `finish()` carries the argument — ADL reclaims the tree
 * it started before handing control to a repository-supplied teardown command,
 * and the order is what lets that command witness the reap from outside ADL.
 * **`D-2-07-1` limits this under the privilege drop**: on Linux the direct child
 * is `sudo`, which re-execs as the worker user, so the signal ADL sends reaches a
 * process it does not own. That limitation is inherited here rather than solved,
 * and it is stated because an accepted risk whose statement is absent is an
 * unaccepted risk (convention 18).
 */
import type { CommandSpec, EffectiveConfig } from '@adl/core/config';
import {
  appVariables,
  interpolateCommandEnv,
  interpolateReadyProbe,
  parseDuration,
} from '@adl/core/config';
import type { ExecResult, LogChunk, Workspace } from '@adl/core/stage';
import { join } from 'node:path';
import { startTimeoutMsFor, timeoutMsFor } from '../command-timeout.js';
import { allocatePort } from './port.js';
import { awaitReady, type ReadinessOutcome } from './probe.js';

/**
 * Which command's output a log chunk came from.
 *
 * A distinct value per phase rather than one undifferentiated stream: the caller
 * puts it on the transcript record, and "the build printed this" is a different
 * statement from "the app printed this" when an operator is reading a failing
 * round.
 */
export const APP_PHASES = Object.freeze([
  'build',
  'start',
  'ready',
  'teardown',
] as const);

export type AppPhase = (typeof APP_PHASES)[number];

/** How long ADL waits for readiness when `commands.start` declares no timeout. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Why an app could not be brought to a state in which the gate's judgement would
 * mean anything.
 *
 * Deliberately *facts*, not verdicts. See the module docblock: step 8.3 owns the
 * mapping onto `StageError` kinds, and a `kind` here that already read
 * `'inconclusive'` would have made that step a rename.
 */
export type AppFailure =
  /** No loopback port could be allocated. */
  | { readonly kind: 'port-unavailable'; readonly detail: string }
  /**
   * A command referenced a `${VAR}` ADL does not supply, so `interpolate()`
   * refused it. A configuration error, and the one failure here that will
   * reproduce identically on every retry.
   */
  | { readonly kind: 'config-invalid'; readonly detail: string }
  | {
      readonly kind: 'build-failed';
      readonly exitCode: number | null;
      readonly detail: string;
    }
  /** `commands.start` could not be spawned at all — the workspace refused it. */
  | { readonly kind: 'start-failed'; readonly detail: string }
  /** The app's process ended while ADL was still waiting for readiness. */
  | {
      readonly kind: 'app-exited-before-ready';
      readonly exitCode: number | null;
      readonly detail: string;
    }
  /** `ready_timeout` elapsed with the probe unsatisfied. */
  | {
      readonly kind: 'never-ready';
      readonly waitedMs: number;
      readonly detail: string;
    };

/** What teardown managed to do, reported rather than discarded. */
export interface AppTeardown {
  /** `commands.teardown`'s exit code, or `null` when it was killed or never ran. */
  readonly teardownExitCode: number | null;
  /**
   * Whether ADL aborted the app's process tree — **known, not inferred**.
   *
   * See the module docblock's Q2: on win32 a cancelled child reports
   * `exitCode: 1` with no signal, so the exit code cannot distinguish "ADL killed
   * it" from "it crashed". This field is set from the fact that this module
   * called `abort()`, which it either did or did not.
   */
  readonly reaped: boolean;
  /** The app's own final `ExecResult`, once its process tree had ended. */
  readonly appExit: ExecResult | undefined;
  /** Populated when `commands.teardown` itself could not be run at all. */
  readonly teardownError?: string;
  /**
   * Populated when `commands.start` could not be run at all.
   *
   * A separate field from {@link AppTeardown.teardownError} rather than one
   * "something went wrong" string, for rule 6's reason: "the app never started"
   * and "teardown could not run" are different events, and a caller that cannot
   * tell them apart will report the second as the first.
   */
  readonly appError?: string;
}

/** What {@link withAppUnderTest} answers. */
export type AppLifecycleResult<T> =
  | {
      readonly kind: 'ran';
      /** Whatever the body returned. */
      readonly value: T;
      /** The port the app was told to use, and the gate was told about. */
      readonly port: number;
      readonly readiness: ReadinessOutcome | 'no-probe-declared';
      readonly teardown: AppTeardown;
    }
  | {
      readonly kind: 'not-judgeable';
      readonly failure: AppFailure;
      /**
       * Present whenever the app was started before the failure, so a caller can
       * report that teardown ran even on the failure path. `undefined` means
       * nothing was ever started.
       */
      readonly teardown?: AppTeardown;
    };

/** What the body is told about the app it is judging. */
export interface AppUnderTest {
  /** The port ADL allocated and the app was told to bind. */
  readonly port: number;
}

/** Everything the lifecycle needs. */
export interface AppLifecycleDeps {
  /**
   * The workspace the app is built and started in — the **developer's**
   * worktree, not a gate's composed view.
   *
   * 8.1's finding, generalised: what a gate can reach and where ADL does its own
   * work are two questions. The app *is* the implementation running, so building
   * it in a code-blind copy would fail, and building it in the worktree is what
   * makes a code-blind tester able to judge a real program at all.
   */
  readonly workspace: Workspace;
  /** All four commands, straight off the effective config. */
  readonly commands: EffectiveConfig['commands'];
  /** The feature's folder name — `ADL_FEATURE_ID`. */
  readonly featureId: string;
  /** The child `PATH`, as `ExecSpec` requires. */
  readonly path: string;
  /** Every chunk every phase printed, tagged with the phase that printed it. */
  readonly onLog: (phase: AppPhase, chunk: LogChunk) => void;
  /** Budget interrupt, pause, or shutdown. */
  readonly signal?: AbortSignal;
  /** Overridable for tests. */
  readonly probeIntervalMs?: number;
}

/** `commands.*.cwd` is repo-relative by schema; this is where it resolves to. */
function cwdFor(workspace: Workspace, command: CommandSpec): string {
  // Deliberately not re-guarded here, for `command-gate.ts`'s reason: the only
  // thing this path is ever passed to is `Workspace.exec`, which calls
  // `assertCwdWithinRoot` first and unconditionally on every backend (D-02,
  // WR-01). A second check would be a second implementation to keep in
  // agreement, and `assertWithinRoot` is the wrong guard anyway — it rejects the
  // workspace root itself, which is the normal value here.
  return join(workspace.root, command.cwd ?? '.');
}

/**
 * Build, start, probe, run `body`, tear down.
 *
 * Never throws for an app that failed — that is what {@link AppFailure} is. It
 * still propagates whatever `body` throws, **after** teardown has run, because a
 * gate's own failure is the caller's to classify and swallowing it here would
 * hide it behind an app-lifecycle result.
 */
export async function withAppUnderTest<T>(
  deps: AppLifecycleDeps,
  body: (app: AppUnderTest) => Promise<T>,
): Promise<AppLifecycleResult<T>> {
  const { workspace, commands, featureId, path, onLog } = deps;

  const allocation = await allocatePort();
  if (!allocation.ok) {
    return {
      kind: 'not-judgeable',
      failure: { kind: 'port-unavailable', detail: allocation.reason },
    };
  }
  const { port } = allocation;

  // The one place `${ADL_PORT}` becomes a number, and the closed allowlist for
  // every substitution below. A command naming a variable ADL does not supply is
  // a `LoadError` from `interpolate()`, caught here and reported as
  // `config-invalid` — never an empty-string substitution (D-21).
  const values = appVariables({ port, featureId });
  let build: CommandSpec;
  let start: EffectiveConfig['commands']['start'];
  let teardown: CommandSpec;
  let readyProbe: EffectiveConfig['commands']['start']['ready'];
  try {
    build = interpolateCommandEnv(commands.build, values);
    start = interpolateCommandEnv(commands.start, values);
    teardown = interpolateCommandEnv(commands.teardown, values);
    readyProbe =
      commands.start.ready === undefined
        ? undefined
        : interpolateReadyProbe(commands.start.ready, values);
  } catch (error) {
    return {
      kind: 'not-judgeable',
      failure: {
        kind: 'config-invalid',
        detail: `an app lifecycle command could not be interpolated: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  // -- build ---------------------------------------------------------------
  // Before the app is started and before the port is handed anywhere, so a
  // repository whose dependencies will not install never reaches a listening
  // socket. This is the first time ADL has ever installed dependencies, and it
  // does it per worktree.
  let buildResult: ExecResult;
  try {
    buildResult = await workspace.exec(
      {
        argv: build.argv,
        cwd: cwdFor(workspace, build),
        path,
        ...(build.env !== undefined ? { env: build.env } : {}),
        timeoutMs: timeoutMsFor(build),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        networkPolicy: 'full',
        resources: {},
      },
      (chunk) => {
        onLog('build', chunk);
      },
    );
  } catch (error) {
    return {
      kind: 'not-judgeable',
      failure: {
        kind: 'build-failed',
        exitCode: null,
        detail: `\`${build.argv.join(' ')}\` could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  if (buildResult.exitCode !== 0) {
    return {
      kind: 'not-judgeable',
      failure: {
        kind: 'build-failed',
        exitCode: buildResult.exitCode,
        detail: `\`${build.argv.join(' ')}\` exited ${
          buildResult.exitCode === null
            ? 'without an exit code'
            : String(buildResult.exitCode)
        } after ${String(buildResult.durationMs)}ms`,
      },
    };
  }

  // -- start ---------------------------------------------------------------
  // The un-awaited exec that is the whole mechanism. `controller` is ADL's own
  // and is CHAINED to `deps.signal` rather than replaced by it, so a budget
  // interrupt still reaches the app while ADL keeps its own ability to reap the
  // app independently of the round.
  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  if (deps.signal?.aborted === true) {
    // An `abort` listener added to an already-aborted signal never fires, so the
    // pre-aborted case has to be handled rather than subscribed to.
    controller.abort();
  } else {
    deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
  }

  let appOutput = '';
  let appExit: ExecResult | undefined;
  let appError: string | undefined;

  const appRun = workspace
    .exec(
      {
        argv: start.argv,
        cwd: cwdFor(workspace, start),
        path,
        ...(start.env !== undefined ? { env: start.env } : {}),
        // See `startTimeoutMsFor`: an absent `start.timeout` means no ceiling,
        // because the app is meant to outlive its own invocation.
        ...((): { timeoutMs?: number } => {
          const ms = startTimeoutMsFor(start);
          return ms === undefined ? {} : { timeoutMs: ms };
        })(),
        signal: controller.signal,
        networkPolicy: 'full',
        resources: {},
      },
      (chunk) => {
        // Accumulated for the `log` readiness probe AND streamed to the
        // transcript. One subscription, two consumers — a second reader of the
        // same stream would either steal chunks or buffer the app's whole output
        // twice.
        appOutput += chunk.text;
        onLog('start', chunk);
      },
    )
    .then(
      (result) => {
        appExit = result;
      },
      (error: unknown) => {
        appError = error instanceof Error ? error.message : String(error);
      },
    );

  let tornDown: AppTeardown | undefined;

  /** Reap, then run teardown, then report. Idempotent — it runs on every path. */
  const finish = async (): Promise<AppTeardown> => {
    if (tornDown !== undefined) return tornDown;

    // ── the reap, FIRST ──────────────────────────────────────────────────
    //
    // ADL started `commands.start`, so ADL owns that process tree and reclaims it
    // before handing control to anything else. `commands.teardown` is for what the
    // REPOSITORY knows about and ADL cannot see — containers, volumes, a temp
    // database — and running it while the app is still up is the wrong order for
    // the case that actually hurts: an app whose database is removed underneath it
    // spends its last seconds writing errors into the transcript of a round that
    // had already finished.
    //
    // **This order is also what makes the reap observable from outside ADL**, and
    // that is not a happy accident — it is the defect the step's own
    // watched-failing pass found. With teardown running first, removing
    // `controller.abort()` from this function changed *nothing* a test could see:
    // the worker process exits at the end of a dispatch and execa's own
    // `cleanup: true` kills the subprocess then, so the app died either way and
    // the assertion was measuring execa rather than ADL. Reaping first lets
    // `commands.teardown` — a repository-supplied program, not ADL bookkeeping —
    // witness that the app is already gone.
    controller.abort();
    deps.signal?.removeEventListener('abort', onOuterAbort);
    // Awaited, not fired and forgotten. The promise settles once execa has
    // finished killing the tree, so a teardown command that ran before it did
    // would see a process mid-death and report it as alive.
    await appRun;

    // ── then commands.teardown ───────────────────────────────────────────
    let teardownExitCode: number | null = null;
    let teardownError: string | undefined;
    try {
      const result = await workspace.exec(
        {
          argv: teardown.argv,
          cwd: cwdFor(workspace, teardown),
          path,
          ...(teardown.env !== undefined ? { env: teardown.env } : {}),
          timeoutMs: timeoutMsFor(teardown),
          // `deps.signal` and never `controller.signal`: the controller is what
          // killed the app and is already aborted by this point, so passing it
          // here would cancel teardown before it started.
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          networkPolicy: 'full',
          resources: {},
        },
        (chunk) => {
          onLog('teardown', chunk);
        },
      );
      teardownExitCode = result.exitCode;
    } catch (error) {
      teardownError = error instanceof Error ? error.message : String(error);
    }

    tornDown = {
      teardownExitCode,
      // Known because this function called it, never read off an exit code. See
      // the module docblock's Q2.
      reaped: true,
      appExit,
      ...(teardownError !== undefined ? { teardownError } : {}),
      ...(appError !== undefined ? { appError } : {}),
    };
    return tornDown;
  };

  try {
    // -- ready -------------------------------------------------------------
    let readiness: ReadinessOutcome | 'no-probe-declared';
    if (readyProbe === undefined) {
      // `StartCommandSpecSchema` says so in as many words: *"Default: no probe
      // (the tester races the server; prefer declaring one)"*. ADL does not
      // invent a grace period it never promised — a fixed sleep is a probe that
      // is always wrong, and the schema's both-or-neither rule means an operator
      // who wants one says so in two lines.
      readiness = 'no-probe-declared';
    } else {
      let readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
      if (start.ready_timeout !== undefined) {
        try {
          readyTimeoutMs = parseDuration(start.ready_timeout);
        } catch {
          // `timeoutMsFor`'s reasoning: the value crossed the worker boundary on
          // a cast JSON blob, and a conservative default beats refusing to run.
          readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
        }
      }

      readiness = await awaitReady({
        probe: readyProbe,
        timeoutMs: readyTimeoutMs,
        output: () => appOutput,
        exited: () => appExit !== undefined || appError !== undefined,
        execProbe: async (argv) => {
          const result = await workspace.exec(
            {
              argv,
              cwd: workspace.root,
              path,
              networkPolicy: 'full',
              resources: {},
            },
            (chunk) => {
              onLog('ready', chunk);
            },
          );
          return result.exitCode;
        },
        ...(deps.probeIntervalMs !== undefined
          ? { intervalMs: deps.probeIntervalMs }
          : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });

      if (readiness.kind === 'app-exited') {
        // Two causes, one observation, and they are told apart HERE rather than
        // in `awaitReady`: the probe knows only that the process is gone, while
        // this function knows whether `exec` ever managed to spawn it. A start
        // command whose binary is missing is the operator's problem; an app that
        // booted and died is very likely the developer's.
        return {
          kind: 'not-judgeable',
          failure:
            appError === undefined
              ? {
                  kind: 'app-exited-before-ready',
                  exitCode: appExit?.exitCode ?? null,
                  detail: readiness.detail,
                }
              : {
                  kind: 'start-failed',
                  detail: `\`${start.argv.join(' ')}\` could not be run: ${appError}`,
                },
          teardown: await finish(),
        };
      }
      if (readiness.kind === 'not-ready') {
        return {
          kind: 'not-judgeable',
          failure: {
            kind: 'never-ready',
            waitedMs: readiness.afterMs,
            detail: `the ${readyProbe.kind} readiness probe was not satisfied within ${String(readyTimeoutMs)}ms: ${readiness.detail}`,
          },
          teardown: await finish(),
        };
      }
    }

    // Best-effort, and deliberately not a `setTimeout` away from the spawn: with
    // no probe declared, this is the only chance to notice that `exec` refused
    // the start command outright. It can legitimately still be `undefined` here,
    // which is the cost of declaring no readiness probe and is exactly what the
    // schema warns about.
    if (appError !== undefined) {
      return {
        kind: 'not-judgeable',
        failure: {
          kind: 'start-failed',
          detail: `\`${start.argv.join(' ')}\` could not be run: ${appError}`,
        },
        teardown: await finish(),
      };
    }

    // -- the gate ----------------------------------------------------------
    const value = await body({ port });
    return { kind: 'ran', value, port, readiness, teardown: await finish() };
  } finally {
    // Runs on the throw path too, and is idempotent so the success path above
    // does not tear down twice. The body's own error is what the caller needs to
    // see, which is why this `finally` discards the report rather than replacing
    // the error with it — the same rule `Workspace.detach` states one layer down.
    await finish();
  }
}
