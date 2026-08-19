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
