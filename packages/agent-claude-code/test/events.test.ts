import { describe, expect, it } from 'vitest';
import { AgentEventSchema, type AgentEvent } from '@adl/core/stage';
import { CLAUDE_CODE_CAPABILITIES, translateLine } from '../src/events.js';

/**
 * `translateLine` is written against the *documented* real event shapes
 * (`04-RESEARCH.md` § "Architecture Patterns", `ARCHITECTURE.md` §4), not
 * against a captured fixture — `04-01`'s Task 3 capture
 * (`packages/agent-claude-code/test/fixtures/stream-json-develop.ndjson`)
 * was deferred (see `04-01-SUMMARY.md`). This suite's representative lines
 * are a documented stand-in for that capture, exactly as `04-03`'s
 * `agent.test.ts` recorded for the same reason. See `events.ts`'s own
 * docblock for the full provenance note.
 */

const SYSTEM_INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  model: 'claude-sonnet-5',
  session_id: 'sess_abc123',
});

const ASSISTANT_TEXT_AND_TOOL_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'Implementing the feature now.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Write',
        input: { path: 'src/thing.ts', content: 'export {};' },
      },
    ],
  },
});

const USER_TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'file written',
        is_error: false,
      },
    ],
  },
});

const RESULT_SUCCESS_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  duration_ms: 4200,
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0,
  },
});

const RESULT_MAX_TURNS_LINE = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  duration_ms: 9000,
});

const FIXTURE_LINES = [
  SYSTEM_INIT_LINE,
  ASSISTANT_TEXT_AND_TOOL_LINE,
  USER_TOOL_RESULT_LINE,
  RESULT_SUCCESS_LINE,
];

function allEvents(lines: readonly string[]): AgentEvent[] {
  return lines.flatMap((line) => translateLine(line));
}

describe('translateLine', () => {
  it('maps every documented real shape to AgentEvent members that all parse against AgentEventSchema', () => {
    const events = allEvents(FIXTURE_LINES);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'text',
      'tool_call',
      'tool_result',
      'usage',
      'result',
    ]);
  });

  it('maps a system/init line to a started event carrying the declared capabilities', () => {
    const [event] = translateLine(SYSTEM_INIT_LINE);
    expect(event).toMatchObject({
      kind: 'started',
      model: 'claude-sonnet-5',
      sessionRef: 'sess_abc123',
      capabilities: CLAUDE_CODE_CAPABILITIES,
    });
  });

  it('never emits an event kind absent from the frozen AGENT_EVENT_KINDS list', () => {
    const events = allEvents(FIXTURE_LINES);
    const KNOWN_KINDS = new Set([
      'started',
      'text',
      'thinking',
      'tool_call',
      'tool_result',
      'usage',
      'result',
      'error',
    ]);
    for (const event of events) {
      expect(KNOWN_KINDS.has(event.kind)).toBe(true);
    }
  });

  it('maps result subtype error_max_turns to outcome turn_limit_reached (documented stand-in, see events.ts docblock)', () => {
    const events = translateLine(RESULT_MAX_TURNS_LINE);
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({
      kind: 'result',
      outcome: 'turn_limit_reached',
    });
  });

  it('a non-JSON line produces a single error-kind event and does not throw', () => {
    expect(() => translateLine('not json at all {{{')).not.toThrow();
    const events = translateLine('not json at all {{{');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'error',
      errorKind: 'unparseable',
    });
  });

  it('a JSON object with an unrecognised type produces a single error-kind event and the following line still translates', () => {
    const badLine = JSON.stringify({ type: 'something-unknown', x: 1 });
    const badEvents = translateLine(badLine);
    expect(badEvents).toHaveLength(1);
    expect(badEvents[0]).toMatchObject({
      kind: 'error',
      errorKind: 'unparseable',
    });

    // The following line, translated independently, still succeeds — one bad
    // line does not end the stream.
    const nextEvents = translateLine(SYSTEM_INIT_LINE);
    expect(nextEvents[0]).toMatchObject({ kind: 'started' });
  });

  it('a blank line produces no events', () => {
    expect(translateLine('')).toEqual([]);
    expect(translateLine('   \n')).toEqual([]);
  });

  it('produces the identical sequence of events whether the fixture is fed in one chunk or split at every character boundary', () => {
    const oneChunk = allEvents(FIXTURE_LINES);

    // Simulate per-character delivery: join every line with '\n', split into
    // one-character pieces, re-buffer exactly the way backend.ts's line
    // handler does, then translate each reconstructed line.
    const wholeText = `${FIXTURE_LINES.join('\n')}\n`;
    let buffer = '';
    const reconstructedLines: string[] = [];
    for (const ch of wholeText) {
      buffer += ch;
      if (buffer.endsWith('\n')) {
        reconstructedLines.push(buffer.slice(0, -1));
        buffer = '';
      }
    }
    const perCharacter = allEvents(reconstructedLines);

    expect(perCharacter).toEqual(oneChunk);
  });

  it('reassembles a line split mid multi-byte character across two chunks identically to an unsplit line', () => {
    // An emoji is a UTF-16 surrogate pair — splitting the JS string between
    // the two surrogate halves is the string-level analogue of a byte-level
    // split landing inside a multi-byte UTF-8 character.
    const textWithEmoji = 'Implementing the feature now. \u{1F680}';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        content: [{ type: 'text', text: textWithEmoji }],
      },
    });

    const unsplit = translateLine(line);

    const splitIndex = line.indexOf('\uD83D') + 1; // inside the surrogate pair
    const first = line.slice(0, splitIndex);
    const second = line.slice(splitIndex);
    // Simulate the buffering backend.ts performs: accumulate both halves
    // before translating the complete line.
    const reassembled = translateLine(first + second);

    expect(reassembled).toEqual(unsplit);
    const textEvent = reassembled.find((e) => e.kind === 'text');
    expect(textEvent).toMatchObject({ kind: 'text', delta: textWithEmoji });
  });

  it('maps a tool_result block to a tool_result event correlated by callId', () => {
    const [event] = translateLine(USER_TOOL_RESULT_LINE);
    expect(event).toMatchObject({
      kind: 'tool_result',
      callId: 'call_1',
      isError: false,
    });
  });

  it('maps the result line usage object to a usage event with every field present', () => {
    const events = translateLine(RESULT_SUCCESS_LINE);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toMatchObject({
      kind: 'usage',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });
  });

  it('maps the result line cost/duration onto the result event', () => {
    const events = translateLine(RESULT_SUCCESS_LINE);
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({
      kind: 'result',
      outcome: 'completed',
      durationMs: 4200,
      costUsd: 0.0123,
    });
  });

  it('classifies an unrecognised result subtype as a provider_error rather than forcing an AgentResultOutcome', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 100,
    });
    const events = translateLine(line);
    expect(
      events.some(
        (e) => e.kind === 'error' && e.errorKind === 'provider_error',
      ),
    ).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });
});
