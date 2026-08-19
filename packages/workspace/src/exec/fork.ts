/**
 * The second and last process-launch primitive in the repository (WORK-02).
 *
 * `run.ts` in this same directory is execa-specific: it launches an arbitrary
 * external command and reports an exit code. `fork()` is a different
 * primitive — it launches ANOTHER NODE PROCESS and keeps a live IPC channel
 * open to it (`child.send` / `process.on('message')`), which is what the
 * manager's supervision of a worker (heartbeats, control messages, a
 * graceful-shutdown request) depends on. Wrapping `child_process.fork()` in
 * an execa call would lose that channel — execa's generic subprocess API does
 * not preserve it — so this file is a SIBLING of `run.ts`, not a modification
 * of it. `run.ts` is untouched by this change.
 *
 * This is the reason `eslint.config.js`'s spawn-ban message names it directly
 * (`eslint.config.js:218`): "The Phase 3 manager→worker seam is not an
 * exception: fork() lands as a named export of packages/workspace too, so the
 * exemption count stays at one." `WORKSPACE_EXEMPTION`
 * (`eslint.config.js:318`, `[mod('packages/workspace/**\/*')]`) already covers
 * this file — no eslint change accompanies this commit, and
 * `test/lint/no-restricted-imports.test.ts` measures that the exemption count
 * stays at exactly one rather than trusting this comment.
 *
 * `run.ts`'s `ExecOwner` distinction (`'agent'` versus `'adl'`) does not need
 * a parameter here: the process this file forks is always ADL's OWN worker
 * code, never an agent's, so it is deliberately never dropped to the
 * unprivileged worker user — the same reasoning `run.ts` documents for
 * `owner: 'adl'`, just decided once, structurally, rather than threaded
 * through a call. The privilege drop still happens, one layer down, inside
 * the worker, when IT calls `run()` for an agent's command.
 *
 * Stop/kill escalation is deliberately NOT implemented here. That is manager
 * policy (D-28 as amended, 03-RESEARCH.md § Pattern 2 / Pitfall 3 — a forked
 * worker is a plain `ChildProcess`, not an execa subprocess, so execa's
 * `cancelSignal`/`forceKillAfterDelay` do not extend to it) and belongs in
 * `@adl/manager`, which holds the `ForkedWorker.child` handle and decides
 * when and how hard to signal it. Putting that policy in `@adl/workspace`
 * would make this package responsible for a lifecycle it does not own.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { WorkspaceError } from '../errors.js';

/**
 * The parent-process variables that legitimately cross into a forked
 * worker's environment: the platform essentials Node itself needs to start,
 * and nothing else.
 *
 * WORK-06: the daemon holds forge tokens and model API keys. A worker's
 * whole job is to run other people's agent code, so spreading `process.env`
 * here would hand every one of those credentials to exactly the process
 * least entitled to see them. `forkWorker` therefore builds the child's
 * environment from this small allowlist plus `options.env`, never from
 * `process.env` directly.
 *
 * This restates `env.ts`'s `buildChildEnv` discipline rather than reusing
 * that function, and the divergence is a recorded decision, not an
 * oversight: `buildChildEnv` is scoped to an `ExecSpec` and to the
 * per-run scratch-`HOME` neutralisers an agent's exec needs — `GIT_CONFIG_*`
 * redirection, the `npm`/`XDG` config sinks. A worker fork has no use for any
 * of that: the worker is ADL's own code, not an agent's, so there is no
 * scratch `HOME` to point it at and no git configuration written by
 * untrusted input to neutralise. Reusing `buildChildEnv` here would be a
 * false shared dependency between two boundaries that happen to look
 * similar; a smaller, purpose-built list is the honest shape.
 *
 * `PATH` is required on every platform for Node's own module and
 * native-addon resolution. `SystemRoot` is Windows-only and is not a
 * convenience: Node's `crypto`/`tls` bindings call into Windows' CryptoAPI,
 * which reads `%SystemRoot%` to locate system libraries, and a child
 * launched without it fails TLS with an error that does not name this as the
 * cause — the same class of "looks unchanged in the diff" failure `env.ts`'s
 * own docblock warns about for a different variable.
 */
export const WORKER_ENV_ALLOWLIST: readonly string[] = Object.freeze(
  process.platform === 'win32' ? ['PATH', 'SystemRoot'] : ['PATH'],
);

/**
 * Options accepted by {@link forkWorker}.
 *
 * `env` is the caller's explicit allowlist for THIS fork — merged over
 * {@link WORKER_ENV_ALLOWLIST}, never replacing it, so a caller cannot
 * accidentally widen the child's environment by omission.
 */
export interface ForkWorkerOptions {
  /** Arguments passed to the worker module. */
  readonly argv?: readonly string[];
  readonly cwd: string;
  /** Explicit variables the caller wants the child to have. */
  readonly env?: Readonly<Record<string, string>>;
  readonly execArgv?: readonly string[];
}

/**
 * The handle {@link forkWorker} returns: the live `ChildProcess` (carrying the
 * IPC channel `send`/`on('message')` uses), its pid, and its piped stdio.
 */
export interface ForkedWorker {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

/**
 * The forked worker's COMPLETE environment: {@link WORKER_ENV_ALLOWLIST} plus
 * whatever the caller named on `options.env`, and nothing else. Unlike
 * `buildChildEnv`, there is no reserved-variable rejection here — the
 * allowlist is small and fixed, and a caller naming `PATH` on `options.env`
 * is overriding a platform default, not bypassing a security control the way
 * naming `HOME` would in `env.ts`.
 */
function buildWorkerEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return { ...result, ...(env ?? {}) };
}

/**
 * Fork `entryPath` as a worker process with a live IPC channel and a
 * constructed (not inherited) environment.
 *
 * `stdio` is `['ignore', 'pipe', 'pipe', 'ipc']`. The fourth slot is what
 * keeps the IPC channel; the two `pipe` slots are what let the manager attach
 * a pino child logger to the worker's own output instead of interleaving it
 * into the daemon's own stream, and are what a later phase's transcript
 * streaming reads from.
 */
export function forkWorker(
  entryPath: string,
  options: ForkWorkerOptions,
): ForkedWorker {
  if (entryPath.trim().length === 0) {
    throw new WorkspaceError('forkWorker: entryPath must not be empty.');
  }

  const child = fork(entryPath, options.argv ? [...options.argv] : [], {
    cwd: options.cwd,
    env: buildWorkerEnv(options.env),
    ...(options.execArgv ? { execArgv: [...options.execArgv] } : {}),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  if (!existsSync(entryPath)) {
    // `fork()` does not validate `entryPath` itself: it always launches Node
    // successfully — Node's own binary resolves fine — and a missing-module
    // failure only surfaces inside the CHILD, as a non-zero exit and a
    // "Cannot find module" line on stderr, never as the native `'error'`
    // event a spawn failure would raise (verified locally: forking a path
    // that does not exist produces `exit(1, null)` with no `'error'` event
    // at all). Checked and reported here instead, so a caller gets a
    // deterministic `'error'` event naming the path rather than having to
    // parse stderr or infer meaning from an exit code — the alternative is
    // a handle that looks the same as a healthy one until something else
    // notices it never spoke.
    //
    // Deferred to a microtask so a caller that attaches its `'error'`
    // listener immediately after this call returns (the only supported
    // pattern — `child` is a plain Node `EventEmitter`, and an `'error'`
    // event with no listener throws) has already done so by the time this
    // fires.
    queueMicrotask(() => {
      child.emit(
        'error',
        new WorkspaceError(
          `forkWorker: entry module not found at ${entryPath}.`,
        ),
      );
    });
  }

  const { stdout, stderr, pid } = child;
  if (stdout === null || stderr === null || pid === undefined) {
    // Unreachable given the explicit stdio array above — `'pipe'` guarantees
    // both streams, and a spawn attempt assigns a pid synchronously. Stated
    // rather than asserted past, so the invariant is visible instead of
    // silently relied on.
    throw new WorkspaceError(
      `forkWorker: child process for ${entryPath} did not receive a pid or piped stdio streams.`,
    );
  }

  return { child, pid, stdout, stderr };
}
