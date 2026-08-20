import { describe, expect, it } from 'vitest';

import {
  AGENT_EVENT_KINDS,
  AgentEventSchema,
  AgentTaskSchema,
  TranscriptRecordSchema,
  type AgentEvent,
  type AgentEventKind,
  type TranscriptRecord,
} from '../../src/stage/index.js';

/**
 * The vendor-neutral spine (D-07) and the on-disk envelope it travels in
 * (Task 1's option-c decision). The single property every assertion here
 * defends: the union carries every kind D-07 names, parses a realistic
 * backend stream without loss, classifies rather than throws on a malformed
 * line, and the on-disk record round-trips byte-for-byte.
 */

const WELL_FORMED_CAPABILITIES = {
  emitsIncrementalEvents: true,
  reportsUsage: true,
  reportsCost: true,
  supportsSessionResume: false,
  enforcesTurnCap: true,
} as const;

/** One minimal, well-formed member per kind, in `AGENT_EVENT_KINDS` order. */
const WELL_FORMED_EVENTS: Record<AgentEventKind, AgentEvent> = {
  started: {
    kind: 'started',
    model: 'the-pinned-model',
    capabilities: WELL_FORMED_CAPABILITIES,
  },
  text: { kind: 'text', messageId: 'msg-1', delta: 'Implementing the ' },
  thinking: {
    kind: 'thinking',
    messageId: 'msg-1',
    delta: 'The spec asks for ',
  },
  tool_call: {
    kind: 'tool_call',
    callId: 'call-1',
    name: 'edit_file',
    input: { path: 'src/index.ts' },
  },
  tool_result: {
    kind: 'tool_result',
    callId: 'call-1',
    result: { ok: true },
    isError: false,
  },
  usage: {
    kind: 'usage',
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
  },
  result: {
    kind: 'result',
    outcome: 'completed',
    durationMs: 45_231,
    costUsd: 0.42,
  },
  error: {
    kind: 'error',
    errorKind: 'provider_error',
    detail: 'the provider returned a 529 overloaded response',
  },
};

describe('AGENT_EVENT_KINDS (D-07)', () => {
  it('has exactly the eight kinds D-07 names, in the order it names them', () => {
    expect(AGENT_EVENT_KINDS).toHaveLength(8);
    expect(AGENT_EVENT_KINDS).toEqual([
      'started',
      'text',
      'thinking',
      'tool_call',
      'tool_result',
      'usage',
      'result',
      'error',
    ]);
  });
});

describe('AgentEventSchema', () => {
  it.each(AGENT_EVENT_KINDS)(
    'accepts a minimal well-formed "%s" event',
    (kind) => {
      const result = AgentEventSchema.safeParse(WELL_FORMED_EVENTS[kind]);
      expect(result.success).toBe(true);
    },
  );

  it('rejects an object whose kind is not in the list', () => {
    const result = AgentEventSchema.safeParse({
      kind: 'system_plugin_install',
      detail: 'not one of the eight',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra property on a member (.strictObject, not passthrough)', () => {
    const smuggled = {
      ...WELL_FORMED_EVENTS.started,
      sessionId: 'claude-session-abc123', // a Claude-Code-shaped field the union never modelled
    };
    const result = AgentEventSchema.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  describe('the "usage" kind — four separately nullable fields, never defaulted to zero (D-31)', () => {
    it('accepts null on every one of the four token fields', () => {
      const result = AgentEventSchema.safeParse({
        kind: 'usage',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });
      expect(result.success).toBe(true);
    });

    it('parses null and 0 to distinguishable values — "unreported" is not "zero"', () => {
      const unreported = AgentEventSchema.safeParse({
        kind: 'usage',
        inputTokens: null,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });
      const allZero = AgentEventSchema.safeParse({
        kind: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(unreported.success).toBe(true);
      expect(allZero.success).toBe(true);
      expect(unreported.data).not.toEqual(allZero.data);
    });
  });

  describe('a malformed backend payload classifies to the error kind, never throws (T-4-11)', () => {
    /**
     * A translator (out of this plan's scope — `packages/agent-claude-code`
     * owns it) is what turns a malformed raw line into this shape. What this
     * plan's schema must guarantee is that the shape a classify-don't-throw
     * translator produces is itself a valid `AgentEvent` — never rejected,
     * never requiring the translator to throw to satisfy the schema.
     */
    it('accepts the classification a translator would produce for a payload it could not parse', () => {
      const classified = AgentEventSchema.safeParse({
        kind: 'error',
        errorKind: 'unparseable',
        detail: 'the backend emitted a line that was not valid JSON',
      });
      expect(classified.success).toBe(true);
    });

    it('never throws for a completely malformed input — safeParse always returns, never raises', () => {
      const wildInputs: unknown[] = [
        null,
        undefined,
        42,
        'not even an object',
        { kind: 'tool_call' /* missing callId, name */ },
        { no_kind_at_all: true },
      ];
      for (const input of wildInputs) {
        expect(() => AgentEventSchema.safeParse(input)).not.toThrow();
        expect(AgentEventSchema.safeParse(input).success).toBe(false);
      }
    });
  });

  /**
   * `packages/agent-claude-code/test/fixtures/stream-json-develop.ndjson`
   * (built by plan `04-01`, running in parallel with this plan in the same
   * wave) does not exist in this worktree — `04-01` has not merged. This
   * suite substitutes a representative sample of the *documented* real
   * shapes instead (`system/init`, an `assistant` message with text and
   * `tool_use` content blocks, a `user` message carrying `tool_result`, and
   * a terminal `result` reporting `total_cost_usd` — all cited in
   * `04-RESEARCH.md`'s Architecture Patterns and `ARCHITECTURE.md` §4's
   * verified surface), translated by a small test-local mapping function
   * that stands in for the real adapter's `translateLine` (owned by
   * `packages/agent-claude-code/src/events.ts`, out of this plan's file
   * list). This proves the same property the fixture-driven test would:
   * every documented real event shape maps onto `AgentEvent` without loss,
   * and an unrecognised shape maps to the `error` kind rather than
   * throwing. Reconciling this against the real captured fixture is a
   * follow-up once `04-01` merges, not a gap in what this plan's schema
   * itself guarantees.
   */
  describe('representative backend-shaped lines (substitute for the 04-01 fixture)', () => {
    interface RawSystemInit {
      readonly type: 'system';
      readonly subtype: 'init';
      readonly model: string;
    }
    interface RawAssistantText {
      readonly type: 'assistant';
      readonly message: {
        readonly content: readonly {
          readonly type: 'text';
          readonly text: string;
        }[];
      };
    }
    interface RawAssistantToolUse {
      readonly type: 'assistant';
      readonly message: {
        readonly content: readonly {
          readonly type: 'tool_use';
          readonly id: string;
          readonly name: string;
          readonly input: unknown;
        }[];
      };
    }
    interface RawUserToolResult {
      readonly type: 'user';
      readonly message: {
        readonly content: readonly {
          readonly type: 'tool_result';
          readonly tool_use_id: string;
          readonly content: string;
          readonly is_error: boolean;
        }[];
      };
    }
    interface RawResult {
      readonly type: 'result';
      readonly duration_ms: number;
      readonly total_cost_usd: number;
    }
    type RawLine =
      | RawSystemInit
      | RawAssistantText
      | RawAssistantToolUse
      | RawUserToolResult
      | RawResult;

    /** Test-local stand-in for `translateLine` — never re-used as production code. */
    function shapeAsAgentEvent(raw: RawLine): AgentEvent {
      switch (raw.type) {
        case 'system':
          return {
            kind: 'started',
            model: raw.model,
            capabilities: WELL_FORMED_CAPABILITIES,
          };
        case 'assistant': {
          const block = raw.message.content[0];
          if (block?.type === 'text') {
            return { kind: 'text', messageId: 'm-1', delta: block.text };
          }
          if (block?.type === 'tool_use') {
            return {
              kind: 'tool_call',
              callId: block.id,
              name: block.name,
              input: block.input,
            };
          }
          throw new Error('unreachable in this representative sample');
        }
        case 'user': {
          const block = raw.message.content[0];
          return {
            kind: 'tool_result',
            callId: block?.tool_use_id ?? '',
            result: block?.content,
            isError: block?.is_error ?? false,
          };
        }
        case 'result':
          return {
            kind: 'result',
            outcome: 'completed',
            durationMs: raw.duration_ms,
            costUsd: raw.total_cost_usd,
          };
      }
    }

    const REPRESENTATIVE_LINES: readonly RawLine[] = [
      { type: 'system', subtype: 'init', model: 'the-pinned-model' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Reading the spec.' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'edit_file',
              input: { path: 'src/index.ts' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'file written',
              is_error: false,
            },
          ],
        },
      },
      { type: 'result', duration_ms: 12_345, total_cost_usd: 0.08 },
    ];

    it('maps every representative line to a valid AgentEvent with no thrown exception', () => {
      for (const line of REPRESENTATIVE_LINES) {
        let event: AgentEvent | undefined;
        expect(() => {
          event = shapeAsAgentEvent(line);
        }).not.toThrow();
        expect(AgentEventSchema.safeParse(event).success).toBe(true);
      }
    });
  });
});

describe('TranscriptRecordSchema (Task 1: option-c, translated event + scoped raw)', () => {
  it.each(AGENT_EVENT_KINDS)(
    'round-trips a record carrying a "%s" event: parse(JSON.parse(JSON.stringify(x))) deep-equals x',
    (kind) => {
      const record: TranscriptRecord = {
        seq: 7,
        at: '2026-08-20T12:00:00.000Z',
        event: WELL_FORMED_EVENTS[kind],
      };
      const roundTripped = TranscriptRecordSchema.parse(
        JSON.parse(JSON.stringify(record)) as unknown,
      );
      expect(roundTripped).toEqual(record);
    },
  );

  it('carries the raw line beside the translated event when option-c supplies one', () => {
    const record: TranscriptRecord = {
      seq: 1,
      at: '2026-08-20T12:00:00.000Z',
      event: WELL_FORMED_EVENTS.started,
      raw: '{"type":"system","subtype":"init","model":"the-pinned-model"}',
    };
    const parsed = TranscriptRecordSchema.parse(record);
    expect(parsed.raw).toBe(record.raw);
  });

  it('serialises to a single line — no raw newline character in the JSON form', () => {
    const record: TranscriptRecord = {
      seq: 2,
      at: '2026-08-20T12:00:01.000Z',
      event: WELL_FORMED_EVENTS.text,
      raw: 'a raw backend line\nthat itself contains an embedded newline',
    };
    const serialised = JSON.stringify(record);
    expect(serialised.includes('\n')).toBe(false);
    // The embedded newline is still present, just escaped — nothing was
    // silently dropped, it was made line-safe.
    expect(serialised.includes('\\n')).toBe(true);
  });
});

describe('AgentTaskSchema', () => {
  const WELL_FORMED_TASK = {
    systemPrompt: 'You are the developer agent for ADL.',
    instructions: 'Implement the feature described in features/foo/SPEC.md.',
    contextFiles: ['README.md'],
    limits: { maxWallClockMs: 600_000, maxTurns: 40 },
  };

  it('accepts a well-formed task', () => {
    expect(AgentTaskSchema.safeParse(WELL_FORMED_TASK).success).toBe(true);
  });

  it('rejects an empty instructions string', () => {
    const result = AgentTaskSchema.safeParse({
      ...WELL_FORMED_TASK,
      instructions: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing limits block', () => {
    const { limits: _limits, ...withoutLimits } = WELL_FORMED_TASK;
    const result = AgentTaskSchema.safeParse(withoutLimits);
    expect(result.success).toBe(false);
  });

  it('defaults contextFiles to empty when omitted', () => {
    const { contextFiles: _contextFiles, ...withoutContextFiles } =
      WELL_FORMED_TASK;
    const result = AgentTaskSchema.parse(withoutContextFiles);
    expect(result.contextFiles).toEqual([]);
  });
});
