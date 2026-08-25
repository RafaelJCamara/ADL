import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { translateLine } from '../src/events.js';
import { usageFromResult } from '../src/usage.js';

/**
 * `usageFromResult` is written against the *documented* real terminal-line
 * shape (`04-RESEARCH.md` § "Architecture Patterns" Pattern 4,
 * cross-checked against `events.ts`'s own already-verified `mapResult`), not
 * against a captured fixture — `04-01`'s Task 3 capture
 * (`packages/agent-claude-code/test/fixtures/result-json.json` /
 * `stream-json-develop.ndjson` / `CAPTURE.md`) was deferred (no
 * `ANTHROPIC_API_KEY` in any session to date — see `04-01-SUMMARY.md`,
 * `04-07-SUMMARY.md`, `04-09-SUMMARY.md`'s identical Known Gap). Per the
 * maintainer's explicit prior rejection (04-01) of fabricating a CLI fixture
 * file from documentation, none is created here either — this suite's
 * `RESULT_SUCCESS_LINE` is the same documented stand-in `events.test.ts`
 * already established, translated through the real, tested `translateLine`
 * (never a hand-built `AgentEvent` literal), so these tests exercise the
 * actual translation path a real invocation would produce.
 */

const RESULT_SUCCESS_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  duration_ms: 4200,
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 5,
  },
});

const SYSTEM_INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  model: 'claude-sonnet-5',
  session_id: 'sess_abc123',
});

function eventsFor(line: string): { usage?: AgentEvent; result?: AgentEvent } {
  const events = translateLine(line);
  return {
    usage: events.find((e) => e.kind === 'usage'),
    result: events.find((e) => e.kind === 'result'),
  };
}

describe('usageFromResult', () => {
  it('maps the real (documented-shape) terminal line to a record with every token counter non-null', () => {
    const { usage, result } = eventsFor(RESULT_SUCCESS_LINE);
    const record = usageFromResult({
      event: result!,
      usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
      model: 'claude-sonnet-5',
    });

    expect(record).toBeDefined();
    expect(record?.inputTokens).toBe(1000);
    expect(record?.outputTokens).toBe(200);
    expect(record?.cacheReadInputTokens).toBe(50);
    expect(record?.cacheCreationInputTokens).toBe(5);
  });

  it('the produced cost equals the fixture figure and the source is reported', () => {
    const { usage, result } = eventsFor(RESULT_SUCCESS_LINE);
    const record = usageFromResult({
      event: result!,
      usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
      model: 'claude-sonnet-5',
    });

    expect(record?.costUsd).toBe(0.0123);
    expect(record?.costSource).toBe('reported');
  });

  it('a payload missing one token counter yields null for that counter and non-null for the others', () => {
    const withoutCacheRead = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        // cache_read_input_tokens deliberately absent
      },
    });
    const { usage, result } = eventsFor(withoutCacheRead);
    const record = usageFromResult({
      event: result!,
      usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
    });

    expect(record?.cacheReadInputTokens).toBeNull();
    expect(record?.inputTokens).toBe(10);
    expect(record?.outputTokens).toBe(5);
    expect(record?.cacheCreationInputTokens).toBe(0);
  });

  it('a payload with no cost figure at all yields a null cost and source unknown — never zero', () => {
    const noCost = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { usage, result } = eventsFor(noCost);
    const record = usageFromResult({
      event: result!,
      usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
    });

    expect(record?.costUsd).toBeNull();
    expect(record?.costUsd).not.toBe(0);
    expect(record?.costSource).toBe('unknown');
  });

  it("a payload with no model identifier still carries the token counts, with the model taken from the run's earlier started event rather than fabricated", () => {
    const [started] = translateLine(SYSTEM_INIT_LINE);
    const { usage, result } = eventsFor(RESULT_SUCCESS_LINE);
    const startedModel =
      started?.kind === 'started' ? started.model : undefined;

    const record = usageFromResult({
      event: result!,
      usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
      model: startedModel,
    });

    expect(record?.modelId).toBe('claude-sonnet-5');
    expect(record?.inputTokens).toBe(1000);
  });

  it('the source is never computed across every fixture-derived case', () => {
    const cases = [RESULT_SUCCESS_LINE];
    for (const line of cases) {
      const { usage, result } = eventsFor(line);
      const record = usageFromResult({
        event: result!,
        usage: usage as Extract<AgentEvent, { kind: 'usage' }>,
      });
      expect(record?.costSource).not.toBe('computed');
    }
  });

  it('returns undefined for an event that is not the terminal result event', () => {
    const [textEvent] = translateLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
      }),
    );
    expect(usageFromResult({ event: textEvent! })).toBeUndefined();
  });

  it('the package manifest declares no tokenizer dependency', () => {
    const packageJsonPath = fileURLToPath(
      new URL('../package.json', import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    const tokenizerNames = ['tiktoken', 'gpt-tokenizer'];
    for (const name of tokenizerNames) {
      expect(Object.keys(allDeps)).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// backend.ts's capability-reconciliation wiring
// ---------------------------------------------------------------------------

function fakeWorkspace(
  execImpl: (
    spec: ExecSpec,
    log: (chunk: LogChunk) => void,
  ) => Promise<ExecResult>,
): Workspace {
  return {
    id: 'ws-1',
    root: '/workspace/root',
    scratchHome: '/workspace/scratch-home',
    exec: execImpl,
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
}

function baseTask(): AgentTask {
  return {
    systemPrompt: 'You are the ADL developer agent.',
    instructions: 'Implement the feature described in the prompt.',
    contextFiles: [],
    limits: { maxWallClockMs: 60_000 },
  };
}

describe('claudeCodeBackend — usage capability reconciliation', () => {
  // NOTE: this backend deliberately does NOT emit a `kind: 'error'` transcript
  // event for "declares reportsCost but the terminal line carried none" — see
  // `backend.ts`'s own "DELIBERATE DEVIATION" comment at the reconciliation
  // site. Every `kind: 'error'` event folds into
  // `worker-entry/stage-runner.ts`'s `firstError`, which would turn an
  // otherwise-successful run into a false `stage_error` for every replay
  // double that simply omits a cost figure — verified by running the suite,
  // which broke `stage-runner.test.ts`'s pre-existing "reports blocked
  // honestly" case. The honest signal this test asserts instead is the
  // recorded `costSource: 'unknown'` itself (D-31, Prohibition P5).
  it('a backend declaring it reports cost, given a terminal event with none, records an honest unknown source rather than a silent zero', async () => {
    const workspace = fakeWorkspace(async (_spec, log) => {
      log({
        stream: 'stdout',
        text: `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          duration_ms: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
        })}\n`,
      });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });
    const events: AgentEvent[] = [];

    const result = await backend.run(baseTask(), {
      workspace,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    expect(result.usageRecord?.costSource).toBe('unknown');
    expect(result.usageRecord?.costUsd).toBeNull();
    // And no error-kind event was manufactured for the missing cost figure —
    // this run is otherwise clean.
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('surfaces the usage record on the run result — the caller does not re-parse the terminal event', async () => {
    const workspace = fakeWorkspace(async (_spec, log) => {
      log({
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' })}\n`,
      });
      log({ stream: 'stdout', text: `${RESULT_SUCCESS_LINE}\n` });
      return { exitCode: 0, durationMs: 1 };
    });
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    const result = await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(result.usageRecord).toBeDefined();
    expect(result.usageRecord?.modelId).toBe('claude-sonnet-5');
    expect(result.usageRecord?.costSource).toBe('reported');
    expect(result.usageRecord?.costUsd).toBe(0.0123);
    expect(result.costUsd).toBe(0.0123);
    expect(result.usage.inputTokens).toBe(1000);
  });

  it('an invocation whose backend reported no usage at all produces no usage record', async () => {
    const workspace = fakeWorkspace(async () => ({
      exitCode: 1,
      durationMs: 1,
    }));
    const backend = claudeCodeBackend({ path: '/usr/bin' });

    const result = await backend.run(baseTask(), {
      workspace,
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });

    expect(result.usageRecord).toBeUndefined();
  });
});
