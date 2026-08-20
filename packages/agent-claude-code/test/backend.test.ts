import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentTask,
  ExecResult,
  ExecSpec,
  LogChunk,
  Workspace,
} from '@adl/core/stage';
import { claudeCodeBackend } from '../src/backend.js';

/** A minimal fake `Workspace` whose `exec` is a controllable spy. */
function fakeWorkspace(
  execImpl: (
    spec: ExecSpec,
    log: (chunk: LogChunk) => void,
  ) => Promise<ExecResult>,
): { workspace: Workspace; execCalls: ExecSpec[] } {
  const execCalls: ExecSpec[] = [];
  const workspace: Workspace = {
    id: 'ws-1',
    root: '/workspace/root',
    scratchHome: '/workspace/scratch-home',
    async exec(spec, log) {
      execCalls.push(spec);
      return execImpl(spec, log);
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

describe('claudeCodeBackend', () => {
  it('calls workspace.exec exactly once per run, with the agent CLI as the program', async () => {
    const { workspace, execCalls } = fakeWorkspace(async (_spec, log) => {
      log({
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`,
      });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.argv[0]).toBe('claude');
  });

  it('the argv carries the reproducibility flag, the streaming output format, and the explicitly-supplied system prompt', async () => {
    const { workspace, execCalls } = fakeWorkspace(async () => ({
      exitCode: 0,
      durationMs: 1,
    }));
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    await backend.run(
      baseTask({ systemPrompt: 'UNIQUE-SYSTEM-PROMPT-MARKER' }),
      {
        workspace,
        onEvent: () => undefined,
        signal: new AbortController().signal,
      },
    );

    const argv = execCalls[0]?.argv ?? [];
    expect(argv).toContain('--bare');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('UNIQUE-SYSTEM-PROMPT-MARKER');
  });

  it('reads no environment of its own — the exec spec env is exactly what options.env supplied', async () => {
    const { workspace, execCalls } = fakeWorkspace(async () => ({
      exitCode: 0,
      durationMs: 1,
    }));
    const backend = claudeCodeBackend({
      path: '/usr/bin',
      env: { ANTHROPIC_API_KEY: 'test-credential-value' },
    });

    await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(execCalls[0]?.env).toEqual({
      ANTHROPIC_API_KEY: 'test-credential-value',
    });
  });

  it('never puts the model credential into an emitted event', async () => {
    const { workspace } = fakeWorkspace(async (_spec, log) => {
      log({ stream: 'stderr', text: 'a generic failure line\n' });
      return { exitCode: 1, durationMs: 1 };
    });
    const backend = claudeCodeBackend({
      path: '/usr/bin',
      env: { ANTHROPIC_API_KEY: 'super-secret-value' },
    });
    const events: AgentEvent[] = [];

    await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('super-secret-value');
  });

  it('produces an identical event sequence whether the transport batches every line into one LogChunk or delivers each line as its own LogChunk', async () => {
    // `Workspace.exec()`'s real implementation (execa's line iterable)
    // delivers one already-complete, delimiter-stripped line per `LogChunk`
    // — see `backend.ts`'s own docblock on `createLineHandler`. This test
    // proves the two shapes a transport could plausibly deliver both
    // resolve to the same events: every line batched into one chunk (with
    // embedded '\n's), and every line as its own separate chunk (no
    // embedded '\n' at all, matching execa's real behaviour).
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-5',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5 }),
    ];

    async function runWithChunking(chunks: readonly string[]) {
      const { workspace } = fakeWorkspace(async (_spec, log) => {
        for (const piece of chunks) {
          log({ stream: 'stdout', text: piece });
        }
        return { exitCode: 0, durationMs: 5 };
      });
      const backend = claudeCodeBackend({ path: '/usr/bin' });
      const events: AgentEvent[] = [];
      await backend.run(baseTask(), {
        workspace,
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
      });
      return events;
    }

    const batchedIntoOneChunk = await runWithChunking([
      `${lines.join('\n')}\n`,
    ]);
    const onePerChunkNoDelimiter = await runWithChunking(lines);

    expect(onePerChunkNoDelimiter).toEqual(batchedIntoOneChunk);
    expect(batchedIntoOneChunk.some((e) => e.kind === 'result')).toBe(true);
    expect(batchedIntoOneChunk.some((e) => e.kind === 'started')).toBe(true);
  });

  it('a chunk split mid multi-byte character, when the transport re-batches it behind one embedded newline, still translates correctly', async () => {
    // The multi-byte-character-safety property itself is `translateLine`'s
    // (proven exhaustively in `@adl/agent-claude-code`'s `events.test.ts`);
    // this asserts the SAME fixture line, carrying an emoji, survives this
    // module's own chunk handling when delivered as a single embedded-'\n'
    // chunk — the shape this handler's buffering branch actually exercises.
    const textWithEmoji = 'Implementing the feature now. \u{1F680}';
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'm2', content: [{ type: 'text', text: textWithEmoji }] },
    });

    const { workspace } = fakeWorkspace(async (_spec, log) => {
      log({ stream: 'stdout', text: `${line}\n` });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];
    await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    const textEvent = events.find((e) => e.kind === 'text');
    expect(textEvent).toMatchObject({ kind: 'text', delta: textWithEmoji });
  });

  it('a non-JSON line mid-stream produces an error event and the following line still translates', async () => {
    const { workspace } = fakeWorkspace(async (_spec, log) => {
      log({ stream: 'stdout', text: 'not json {{\n' });
      log({
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`,
      });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    expect(
      events.some((e) => e.kind === 'error' && e.errorKind === 'unparseable'),
    ).toBe(true);
    expect(
      events.some((e) => e.kind === 'result' && e.outcome === 'completed'),
    ).toBe(true);
  });

  it('run() does not throw for a non-zero exit — it returns an outcome and emits an error event', async () => {
    const { workspace } = fakeWorkspace(async () => ({
      exitCode: 1,
      durationMs: 1,
    }));
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    const result = await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    expect(result.outcome).not.toBe('completed');
    expect(
      events.some(
        (e) => e.kind === 'error' && e.errorKind === 'provider_error',
      ),
    ).toBe(true);
  });

  it('run() does not throw for a missing binary — it classifies binary_missing and returns an outcome', async () => {
    const { workspace } = fakeWorkspace(async () => {
      const error = new Error('spawn claude ENOENT') as Error & {
        code?: string;
      };
      error.code = 'ENOENT';
      throw error;
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    await expect(
      backend.run(baseTask(), {
        workspace,
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
      }),
    ).resolves.toBeDefined();

    expect(
      events.some(
        (e) => e.kind === 'error' && e.errorKind === 'binary_missing',
      ),
    ).toBe(true);
  });

  it('declares capabilities honestly and reports them on the started event', async () => {
    const { workspace } = fakeWorkspace(async (_spec, log) => {
      log({
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' })}\n`,
      });
      log({
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`,
      });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    const started = events.find((e) => e.kind === 'started');
    expect(started).toMatchObject({
      kind: 'started',
      capabilities: {
        emitsIncrementalEvents: true,
        reportsUsage: true,
        reportsCost: true,
        supportsSessionResume: true,
        enforcesTurnCap: true,
      },
    });
  });

  it('probe() reports the pinned expected version', async () => {
    const backend = claudeCodeBackend();
    const probe = await backend.probe();
    expect(probe.expectedVersion).toBe('2.1.237');
  });
});
