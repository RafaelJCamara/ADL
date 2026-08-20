import { fileURLToPath } from 'node:url';

/**
 * The scripted entry module `forkWorker` launches under test (D-30). A real,
 * separate file on disk — `child_process.fork()` launches a path, not an
 * in-process function, so the double has to be a real module, not a mock.
 */
export const scriptedWorkerEntry = fileURLToPath(
  new URL('./scripted-worker-entry.ts', import.meta.url),
);

export interface ScriptedWorkerConfig {
  readonly entryPath: string;
  readonly cwd: string;
  readonly execArgv: readonly string[];
}

/**
 * The fork() options that launch the scripted entry module. `execArgv`
 * carries `--import tsx`, because the scripted entry (and the real worker
 * entry it imports) are TypeScript sources with no build step in the test
 * loop — `tsx` is already the project's own dev-loop runner
 * (`tsx watch src/manager/index.ts`, `.claude/CLAUDE.md` § Development
 * Tools), resolved here the same way Node resolves it from anywhere under
 * the workspace.
 */
export function withScriptedWorker(
  options: { readonly cwd?: string } = {},
): ScriptedWorkerConfig {
  return {
    entryPath: scriptedWorkerEntry,
    cwd: options.cwd ?? process.cwd(),
    execArgv: ['--import', 'tsx'],
  };
}

/** The D-31 zombie's own entry module — see `zombie-worker-entry.ts`'s docblock. */
export const zombieWorkerEntry = fileURLToPath(
  new URL('./zombie-worker-entry.ts', import.meta.url),
);

/**
 * The fork() options that launch the D-31 zombie double: a scripted worker
 * that pauses (sending zero heartbeats) and never reacts to a
 * manager-to-worker message once assigned — D-05's self-termination
 * suppressed by construction, not by a flag. Used only by the zombie
 * scenario in `test/lease/fencing.test.ts`.
 */
export function withZombieWorker(
  options: { readonly cwd?: string } = {},
): ScriptedWorkerConfig {
  return {
    entryPath: zombieWorkerEntry,
    cwd: options.cwd ?? process.cwd(),
    execArgv: ['--import', 'tsx'],
  };
}

/** The D-28/T-3-33 "ignores soft_stop" double's own entry module — see `ignores-stop-worker-entry.ts`'s docblock. */
export const ignoresStopWorkerEntry = fileURLToPath(
  new URL('./ignores-stop-worker-entry.ts', import.meta.url),
);

/**
 * The fork() options that launch the "ignores soft_stop" double: a worker
 * that acknowledges `assign` and then reacts to nothing else — `soft_stop`
 * included — and never exits on its own. Used by `test/control/kill.test.ts`
 * to prove `stopWorker`'s forced path: `SIGKILL` after `worker_stop_grace_ms`.
 */
export function withIgnoresStopWorker(
  options: { readonly cwd?: string } = {},
): ScriptedWorkerConfig {
  return {
    entryPath: ignoresStopWorkerEntry,
    cwd: options.cwd ?? process.cwd(),
    execArgv: ['--import', 'tsx'],
  };
}

/**
 * The D-32 scenario's "held" double's own entry module (03-09) — see
 * `held-worker-entry.ts`'s docblock: it never completes a stage on its own,
 * so a `SIGKILL` aimed at it never races the worker's own completion timer.
 */
export const heldWorkerEntry = fileURLToPath(
  new URL('./held-worker-entry.ts', import.meta.url),
);

/**
 * The fork() options that launch the "held" double — the deterministic
 * mid-run kill hook `03-09-PLAN.md` names: every worker this config forks
 * stays assigned and heartbeating until an external signal or `soft_stop`
 * stops it, which is what lets the concurrency-3 crash-and-restart scenario
 * (`test/scenario/concurrency-crash-restart.test.ts`) capture all three of
 * its workers "mid-run" without a race against a stage runner's own
 * completion delay. Reusable across any number of concurrently-leased
 * features — the same factory, called once per feature.
 */
export function withHeldWorker(
  options: { readonly cwd?: string } = {},
): ScriptedWorkerConfig {
  return {
    entryPath: heldWorkerEntry,
    cwd: options.cwd ?? process.cwd(),
    execArgv: ['--import', 'tsx'],
  };
}
