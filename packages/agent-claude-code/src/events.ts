/**
 * `translateLine` — one line of the pinned Claude Code CLI's
 * `--output-format stream-json` output, translated into zero or more members
 * of `@adl/core`'s vendor-neutral `AgentEvent` union (D-07).
 *
 * ── Provenance of the shapes below (KNOWN GAP, read before editing) ────────
 *
 * `04-01-PLAN.md` Task 3 — capturing four real invocations of the pinned CLI
 * into `packages/agent-claude-code/test/fixtures/` (`stream-json-develop.ndjson`,
 * `stream-json-max-turns.ndjson`, `result-json.json`, `claude-version.txt`,
 * `CAPTURE.md`) — was deferred: no `ANTHROPIC_API_KEY` was available in the
 * session that ran it (see `04-01-SUMMARY.md`, "Task 3 — NOT DONE, blocked").
 * This module is therefore written against the *documented* real event shapes
 * (`.planning/phases/04-first-agent-backend-live-transcripts/04-RESEARCH.md` §
 * "Architecture Patterns" and `ARCHITECTURE.md` §4's verified surface) rather
 * than against a captured fixture — the same substitution `04-03`'s executor
 * made for `agent.test.ts`, recorded there as a Rule 3 deviation. Reconciling
 * this translator against the real fixtures once `04-01` Task 3 lands is a
 * natural, non-urgent follow-up; nothing here is a stub pending it, and every
 * mapping decision below is a real judgement, not a placeholder.
 *
 * The four documented shapes this module maps:
 *
 * - `{"type":"system","subtype":"init", model, session_id, ...}` — one per run.
 * - `{"type":"assistant","message":{"id","content":[{type:'text'|'thinking'|'tool_use',...}]}}`
 * - `{"type":"user","message":{"content":[{type:'tool_result', tool_use_id, content, is_error}]}}`
 * - `{"type":"result","subtype":'success'|'error_max_turns'|..., total_cost_usd, duration_ms, usage:{...}}`
 *
 * ── Turn-cap classification (Open Question 3) ───────────────────────────────
 *
 * `result.subtype === 'error_max_turns'` is mapped to
 * `AgentResultOutcome.turn_limit_reached`. This rests on the documented CLI
 * flag surface (`--max-turns N`, `04-RESEARCH.md`'s "What a realistic common
 * abstraction looks like" table) rather than a captured `result` line —
 * `04-01`'s `CAPTURE.md` would normally be the recorded answer this decision
 * rests on (per this task's own instruction), and it does not exist in this
 * worktree. Recorded here as a stand-in, not silently assumed correct.
 *
 * ── Classify, don't throw (T-4-11, `stage-error.ts`'s discipline) ──────────
 *
 * `translateLine` never throws. A line that is not JSON, an object with no
 * recognised `type`, or a payload whose shape does not match what the mapper
 * expects becomes a single `error`-kind `AgentEvent` — one bad line never
 * ends the stream. Every constructed event is re-validated against
 * `AgentEventSchema` before being returned, so "every produced value parses
 * against the union's schema" holds by construction, not by care.
 */
import {
  AgentEventSchema,
  type AgentCapabilities,
  type AgentEvent,
  type AgentResultOutcome,
} from '@adl/core/stage';

/** What the pinned Claude Code CLI declares about itself (D-07's `AgentCapabilities`).
 *
 * Grounded in `.claude/CLAUDE.md`'s own stack table and `04-RESEARCH.md`'s
 * "What a realistic common abstraction looks like": `stream-json` is
 * incremental, `total_cost_usd`/`usage` are reported, `--resume <session_id>`
 * is supported, and `--max-turns N` is enforced.
 */
export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = Object.freeze({
  emitsIncrementalEvents: true,
  reportsUsage: true,
  reportsCost: true,
  supportsSessionResume: true,
  enforcesTurnCap: true,
});

/** `translateLine`'s return shape — zero, one, or several events for one input line. */
export type TranslateResult = readonly AgentEvent[];

const MAX_DETAIL_CHARS = 2000;

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}… (${String(text.length)} chars total)`
    : text;
}

/** Build an `error`-kind event and validate it before returning — never trusted unchecked. */
function errorEvent(
  errorKind:
    'unparseable' | 'provider_error' | 'timeout' | 'binary_missing' | 'auth',
  detail: string,
): AgentEvent {
  const candidate = {
    kind: 'error' as const,
    errorKind,
    detail: truncate(detail),
  };
  const parsed = AgentEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Structurally unreachable — `candidate` always matches `ErrorEventSchema` —
  // but a defensive fallback is cheaper than a thrown exception reaching the
  // one caller (`backend.ts`) that promised never to throw.
  return {
    kind: 'error',
    errorKind: 'unparseable',
    detail: 'translateLine: internal error constructing an error event',
  };
}

/** Validate a candidate event; on failure, classify rather than propagate a bad shape. */
function safeEvent(candidate: unknown, sourceLabel: string): AgentEvent {
  const parsed = AgentEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return errorEvent(
    'unparseable',
    `translator produced a value that does not match AgentEventSchema while mapping a "${sourceLabel}" line: ${parsed.error.issues
      .map((i) => i.message)
      .join('; ')}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Per-type mapping
// ---------------------------------------------------------------------------

function mapSystemInit(payload: Record<string, unknown>): TranslateResult {
  const model = asString(payload['model']);
  const sessionId = asString(payload['session_id']);
  return [
    safeEvent(
      {
        kind: 'started',
        ...(model !== undefined ? { model } : {}),
        capabilities: CLAUDE_CODE_CAPABILITIES,
        ...(sessionId !== undefined ? { sessionRef: sessionId } : {}),
      },
      'system/init',
    ),
  ];
}

/** One assistant-message content block, mapped to zero or one events. */
function mapAssistantBlock(
  block: unknown,
  messageId: string,
): AgentEvent | undefined {
  if (!isRecord(block)) {
    return errorEvent(
      'unparseable',
      'assistant content block was not an object',
    );
  }
  const type = asString(block['type']);
  switch (type) {
    case 'text': {
      const text = asString(block['text']) ?? '';
      return safeEvent(
        { kind: 'text', messageId, delta: text },
        'assistant.text',
      );
    }
    case 'thinking': {
      const thinking = asString(block['thinking']) ?? '';
      return safeEvent(
        { kind: 'thinking', messageId, delta: thinking },
        'assistant.thinking',
      );
    }
    case 'tool_use': {
      const callId = asString(block['id']);
      const name = asString(block['name']);
      if (callId === undefined || name === undefined) {
        return errorEvent(
          'unparseable',
          'assistant tool_use block is missing "id" or "name"',
        );
      }
      return safeEvent(
        { kind: 'tool_call', callId, name, input: block['input'] },
        'assistant.tool_use',
      );
    }
    default:
      return errorEvent(
        'unparseable',
        `assistant content block has an unrecognised type: ${JSON.stringify(type)}`,
      );
  }
}

function mapAssistant(payload: Record<string, unknown>): TranslateResult {
  const message = payload['message'];
  if (!isRecord(message)) {
    return [
      errorEvent('unparseable', 'assistant line has no "message" object'),
    ];
  }
  const messageId = asString(message['id']) ?? 'assistant-message';
  const content = message['content'];
  if (!Array.isArray(content)) {
    return [
      errorEvent('unparseable', 'assistant message has no "content" array'),
    ];
  }
  const events: AgentEvent[] = [];
  for (const block of content) {
    const event = mapAssistantBlock(block, messageId);
    if (event !== undefined) events.push(event);
  }
  return events;
}

function mapUserToolResult(payload: Record<string, unknown>): TranslateResult {
  const message = payload['message'];
  if (!isRecord(message)) {
    return [errorEvent('unparseable', 'user line has no "message" object')];
  }
  const content = message['content'];
  if (!Array.isArray(content)) {
    return [errorEvent('unparseable', 'user message has no "content" array')];
  }
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!isRecord(block) || asString(block['type']) !== 'tool_result') {
      events.push(
        errorEvent(
          'unparseable',
          'user content block was not a recognised tool_result',
        ),
      );
      continue;
    }
    const callId = asString(block['tool_use_id']);
    if (callId === undefined) {
      events.push(
        errorEvent('unparseable', 'tool_result block has no tool_use_id'),
      );
      continue;
    }
    events.push(
      safeEvent(
        {
          kind: 'tool_result',
          callId,
          result: block['content'],
          isError: block['is_error'] === true,
        },
        'user.tool_result',
      ),
    );
  }
  return events;
}

/** `result.subtype` -> `AgentResultOutcome`, or `undefined` when it is not a terminal-success shape. */
function outcomeFromSubtype(
  subtype: string | undefined,
): AgentResultOutcome | undefined {
  switch (subtype) {
    case 'success':
      return 'completed';
    // Stand-in decision — see the module docblock's "Turn-cap classification" section.
    case 'error_max_turns':
      return 'turn_limit_reached';
    default:
      return undefined;
  }
}

function mapResult(payload: Record<string, unknown>): TranslateResult {
  const subtype = asString(payload['subtype']);
  const outcome = outcomeFromSubtype(subtype);
  const events: AgentEvent[] = [];

  const usage = payload['usage'];
  if (isRecord(usage)) {
    events.push(
      safeEvent(
        {
          kind: 'usage',
          inputTokens: asNumber(usage['input_tokens']) ?? null,
          outputTokens: asNumber(usage['output_tokens']) ?? null,
          cacheReadTokens: asNumber(usage['cache_read_input_tokens']) ?? null,
          cacheWriteTokens:
            asNumber(usage['cache_creation_input_tokens']) ?? null,
        },
        'result.usage',
      ),
    );
  }

  if (outcome === undefined) {
    // A subtype this translator does not recognise as a terminal success is
    // classified rather than forced into `AgentResultOutcome`. A subtype
    // naming authentication/authorization is classified `auth` (D-15: not
    // retryable, costs nothing) rather than the generic `provider_error` —
    // there is no captured fixture naming the real subtype the pinned CLI
    // reports for a rejected credential (04-01 Task 3's own gap), so this is
    // a keyword-based best effort, not a confirmed mapping. Anything else
    // unrecognised becomes a provider-side infrastructure failure, following
    // D-15's transient disposition for a provider-reported break.
    events.push(
      errorEvent(
        subtype !== undefined && /auth/i.test(subtype)
          ? 'auth'
          : 'provider_error',
        `result line reported an unrecognised subtype: ${JSON.stringify(subtype)}`,
      ),
    );
    return events;
  }

  const durationMs = asNumber(payload['duration_ms']) ?? 0;
  const costUsd = asNumber(payload['total_cost_usd']);
  events.push(
    safeEvent(
      {
        kind: 'result',
        outcome,
        durationMs,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
      'result',
    ),
  );
  return events;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Map one line of the CLI's `stream-json` output to zero, one, or several
 * `AgentEvent`s. Never throws — a non-JSON line, or a JSON object this
 * translator does not recognise, becomes a single `error`-kind event and the
 * stream continues with the next line.
 *
 * An empty (whitespace-only) line — the common case of a trailing newline —
 * produces no events at all; it is not itself malformed content.
 */
export function translateLine(line: string): TranslateResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [errorEvent('unparseable', `non-JSON line: ${truncate(trimmed)}`)];
  }

  try {
    if (!isRecord(parsed)) {
      return [
        errorEvent('unparseable', 'line was valid JSON but not an object'),
      ];
    }
    const type = asString(parsed['type']);
    switch (type) {
      case 'system':
        return asString(parsed['subtype']) === 'init'
          ? mapSystemInit(parsed)
          : [
              errorEvent(
                'unparseable',
                `system line has an unrecognised subtype: ${JSON.stringify(parsed['subtype'])}`,
              ),
            ];
      case 'assistant':
        return mapAssistant(parsed);
      case 'user':
        return mapUserToolResult(parsed);
      case 'result':
        return mapResult(parsed);
      default:
        return [
          errorEvent(
            'unparseable',
            `line has an unrecognised "type": ${JSON.stringify(type)}`,
          ),
        ];
    }
  } catch (error) {
    // Belt-and-braces: no mapper above is expected to throw, but a translator
    // that ends the stream on its own bug would be worse than one that
    // classifies its own failure the same way it classifies a bad payload.
    return [
      errorEvent(
        'unparseable',
        `translateLine: internal mapping error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }
}
