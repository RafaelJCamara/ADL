import { describe, expect, it } from 'vitest';
import type {
  AgentTask,
  ExecResult,
  ExecSpec,
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
    async exec(spec: ExecSpec): Promise<ExecResult> {
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
    async detach() {
      /* no-op */
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

/**
 * BACK-10 (M06 step 6.9) — the model selection reaching the CLI.
 *
 * Everything upstream of this argv has existed since M01: `adl.yml`'s
 * `agents.<role>.model`, `DaemonConfigSchema`, `mergeConfig`'s resolution, the
 * vendor-neutral `AgentTask.model` port field, and the manager's read of it.
 * None of it selected anything, because no `--model` was ever built here.
 *
 * The two halves are asserted separately because they fail separately: a
 * configured model must **reach** the CLI, and an absent one must produce **no
 * flag at all** rather than an empty or sentinel value the CLI would try to
 * resolve as a model name.
 *
 * **Probed against the installed CLI before the flag was encoded** (rule 15).
 * On 2.1.227, this exact argv with `--model claude-haiku-4-5` is accepted
 * alongside `--bare` and its `system/init` line reports
 * `"model":"claude-haiku-4-5"`; the same argv without the flag reports
 * `"claude-opus-5[1m]"`.
 *
 * Those two observations are recorded here because there is nowhere else to
 * put them: `version.ts`'s docblock names a `test/fixtures/CAPTURE.md` as the
 * capture the pin re-runs, and that file has never existed (`DEBT.md`). The
 * probe also ran on **2.1.227**, one patch below the pinned **2.1.237** —
 * that is what was installed, so the flag's presence on the pinned build is
 * inferred from a patch-level release, not observed.
 */
describe('claudeCodeBackend argv — model selection (BACK-10, M06 step 6.9)', () => {
  it('carries `--model <id>` when the task names a model', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(baseTask({ model: 'claude-haiku-4-5' }), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    const argv = execCalls[0]?.argv ?? [];
    expect(argv).toContain('--model');
    // Adjacency, not mere presence: `--model` takes its value as the next
    // argv element, so a flag separated from its id by anything else would
    // make the CLI read the wrong token as the model name.
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
  });

  it('carries NO `--model` at all when the task names none', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    // The negative half, and the one that matters most: ADL's own
    // "no model selected" sentinel never crosses the port (the manager omits
    // the field), so this adapter has no sentinel to recognise and must not
    // invent a value. No flag means the CLI picks its own default — the
    // behaviour every pre-6.9 run already had.
    expect(execCalls[0]?.argv).not.toContain('--model');
  });

  it('passes the configured model through verbatim, without interpreting it', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    // An alias rather than a full model id. The CLI accepts both ("Provide an
    // alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
    // model's full name"), and BACK-04 keeps ADL out of the business of
    // knowing which is which — the adapter forwards what it was given.
    await backend.run(baseTask({ model: 'opus' }), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    const argv = execCalls[0]?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  });

  it('keeps the instructions as the final positional argument, after the model flag', async () => {
    const { workspace, execCalls } = fakeWorkspace();
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(
      baseTask({ model: 'claude-haiku-4-5', instructions: 'do the thing' }),
      {
        workspace,
        onEvent: () => undefined,
        signal: new AbortController().signal,
      },
    );

    const argv = execCalls[0]?.argv ?? [];
    // WR-03 (`DEBT.md`) records that the prompt is a trailing positional with
    // no `--` terminator. Inserting a flag pair before it is safe only while
    // it stays last; asserting that here is what keeps a future flag from
    // being appended after it and silently becoming the prompt.
    expect(argv[argv.length - 1]).toBe('do the thing');
    expect(argv.indexOf('--model')).toBeLessThan(argv.length - 1);
  });
});
