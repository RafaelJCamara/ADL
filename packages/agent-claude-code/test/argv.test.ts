import { describe, expect, it } from 'vitest';
import type {
  AgentTask,
  ExecResult,
  ExecSpec,
  LogChunk,
  Workspace,
} from '@adl/core/stage';
import { claudeCodeBackend } from '../src/backend.js';

/**
 * Phase 4 Plan 09, Task 1 — pinning, not re-deriving, the invocation flags
 * `backend.ts` already builds.
 *
 * `04-RESEARCH.md`'s Architecture Patterns § Pattern 2 quotes the vendor's
 * own headless-mode docs: **`--bare` is the recommended mode for scripted and
 * SDK calls, and will become the default for `-p` in a future release.**
 * That is why this file exists as a PERMANENT requirement, not a workaround —
 * a future contributor removing `--bare` to "match interactive behaviour" is
 * exactly the regression this file is here to catch (T-4-09, threat register
 * "Elevation of Privilege": without it, a headless session runs a watched
 * repository's own hooks and settings in a folder nobody ever trusted).
 *
 * This file does NOT modify `backend.ts`. If an assertion below ever fails,
 * the fix belongs in `backend.ts` itself, in a plan that owns that file —
 * this file's job is to report the regression, not to silently correct it.
 */

function fakeWorkspace(): { workspace: Workspace; execCalls: ExecSpec[] } {
  const execCalls: ExecSpec[] = [];
  const workspace: Workspace = {
    id: 'ws-argv-test',
    root: '/workspace/root',
    scratchHome: '/workspace/scratch-home',
    async exec(
      spec: ExecSpec,
      _log: (chunk: LogChunk) => void,
    ): Promise<ExecResult> {
      execCalls.push(spec);
      return { exitCode: 0, durationMs: 1 };
    },
    async read() {
      throw new Error('not implemented in fake');
    },
    async write() {
      throw new Error('not implemented in fake');
    },
    async snapshot() {
      throw new Error('not implemented in fake');
    },
    async destroy() {
      /* no-op */
    },
  };
  return { workspace, execCalls };
}

function baseTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    systemPrompt: 'You are the ADL developer agent.',
    instructions: 'Implement the feature described in the prompt.',
    contextFiles: [],
    limits: { maxWallClockMs: 60_000 },
    ...overrides,
  };
}

describe('claudeCodeBackend argv — the auto-discovery-disabling flag and the explicit system prompt', () => {
  it('carries --bare on every invocation across two differing option sets: bare default options', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.argv).toContain('--bare');
  });

  it('carries --bare on every invocation across two differing option sets: a custom binary, path, and env', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({
      binary: [process.execPath, '/some/fixture/claude-double.mjs'],
      path: '/custom/bin:/usr/bin',
      env: { ANTHROPIC_API_KEY: 'test-credential' },
      timeoutMs: 5000,
    });

    await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.argv).toContain('--bare');
  });

  it('there is no configuration path that omits --bare — a third, minimal option set still carries it', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    // No options at all: the default binary, empty path.
    const backend = claudeCodeBackend();

    await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.argv).toContain('--bare');
  });

  it('the system prompt value in the argv equals the renderer output supplied on the task, verbatim', async () => {
    // `buildDeveloperPrompt` (`@adl/manager`) is the renderer; this package
    // cannot import it (`@adl/manager` depends on `@adl/agent-claude-code`,
    // not the reverse — importing it here would be a circular workspace
    // dependency). Standing in for "the renderer's output" with a
    // distinctive, adversarial-shaped string proves the same property
    // `buildDeveloperPrompt`'s own docblock claims: whatever the renderer
    // hands the backend on `task.systemPrompt` reaches the argv unmodified —
    // no re-wrapping, no re-templating, no truncation.
    const rendererOutput =
      'RENDERER-OUTPUT-MARKER — multi\nline, with "quotes" and a literal $& sequence';
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(baseTask({ systemPrompt: rendererOutput }), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    const argv = execCalls[0]?.argv ?? [];
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain(rendererOutput);
    // Exactly the renderer's string, not a mutated copy of it.
    const idx = argv.indexOf(rendererOutput);
    expect(argv[idx]).toBe(rendererOutput);
  });
});
