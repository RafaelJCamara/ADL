/**
 * The `AgentRunner` port — the only way a stage calls a model (BACK-01).
 *
 * This file gives `AgentRunner` (`packages/core/src/stage/stage.ts`) its first
 * real shape, following exactly the path `Workspace` took: the real interfaces
 * live here, `stage.ts` imports and re-exports so `@adl/core/stage` stays the
 * single import path (D-01), and `@adl/plugin-sdk` republishes the surface —
 * which makes every signature below one-way once it ships (`04-03-PLAN.md`).
 *
 * ===========================================================================
 * THE VOCABULARY RULE — binding on every name in this file
 * ===========================================================================
 *
 * No member of this file may name a Claude-Code concept. Not a flag, not a
 * `stream-json` message type, not `session_id`, not `total_cost_usd`, not
 * `--max-turns`. `PITFALLS.md` line 375 names the failure this rule exists to
 * prevent: a port whose *vocabulary* is one vendor's is a port that later
 * backends fit by branching, and the branch is invisible because the type
 * names made it look like the right thing to do (ROADMAP's Phase 11 lint rule
 * is the enforcement; this rule is what it enforces).
 *
 * Where a concept genuinely is vendor-specific — a resumable session id, for
 * instance — it is modelled as an opaque, optional, backend-owned string that
 * ADL stores and hands back but never interprets. `sessionRef` below is that:
 * ADL treats it as an opaque token, and session resume is an optimisation,
 * never a correctness requirement (a run must succeed with `sessionRef`
 * omitted throughout).
 *
 * ===========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT CARRY
 * ===========================================================================
 *
 * No tool allowlist, no fine-grained tool-permission DSL. `04-CONTEXT.md`'s
 * flagged BACK-01 edge probe records the answer: what a delegated loop does
 * that ADL did not ask for is the workspace's containment problem (WORK-02,
 * and Phase 15's WORK-08 for write auditing), not this port's. Inventing a
 * permission surface here that no adapter can faithfully implement would be
 * exactly the "leak" `ARCHITECTURE.md` §4 warns against.
 *
 * ===========================================================================
 * TRANSLATE, NEVER RE-DRIVE
 * ===========================================================================
 *
 * A delegated-loop backend (the only family this phase implements) owns tool
 * use, file edits, and its own agentic loop. `AgentRunner.run` translates and
 * logs what the backend reports — it never branches on a `tool_call` /
 * `tool_result` event to make a decision. An implementation that does has
 * misunderstood the family it is adapting (`ARCHITECTURE.md` §4's
 * "delegated-loop adapter translates, never re-implements the loop").
 *
 * `@adl/core` is pure: no filesystem, no child processes, no environment.
 * Nothing in this file reads a file or spawns anything.
 */
import * as z from 'zod';

import { RepoRelativePathSchema } from '../config/path-guard.js';
import { StageErrorKindSchema } from './stage-error.js';
import type { Workspace } from './workspace.js';

// ---------------------------------------------------------------------------
// AgentCapabilities — what a backend declares about itself
// ---------------------------------------------------------------------------

/**
 * What a backend declares about itself, so the loop can degrade honestly
 * rather than assume.
 *
 * This is the mechanism by which `04-10`'s cost recording and Phase 6's
 * budget enforcement can say "this backend cannot report cost" instead of
 * silently recording nothing. `04-RESEARCH.md` records that one CLI family
 * returns a single JSON object at completion with no incremental stream at
 * all — `emitsIncrementalEvents` is a real axis, not a hypothetical one.
 *
 * There is deliberately no tool-allowlist field here — see the module
 * docblock's "what this file deliberately does not carry".
 */
export const AgentCapabilitiesSchema = z
  .strictObject({
    /** False means the backend reports only a single terminal result — no `text`/`thinking` deltas. */
    emitsIncrementalEvents: z.boolean(),
    /** False means `usage` events, if emitted at all, carry no meaningful token counts. */
    reportsUsage: z.boolean(),
    /** False means the loop must fall back to round count / wall clock for budget signal (`ARCHITECTURE.md` §4 leak 1). */
    reportsCost: z.boolean(),
    /** False means the loop must be correct re-sending the full brief every round — resume is never required (leak 3). */
    supportsSessionResume: z.boolean(),
    /** False means `AgentTask.limits.maxTurns` is advisory only; the loop must still bound wall clock. */
    enforcesTurnCap: z.boolean(),
  })
  .meta({
    id: 'AgentCapabilities',
    description:
      'What a backend declares about itself, so the loop degrades honestly instead of assuming',
  });

export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// AgentEvent — the vendor-neutral spine (D-07)
// ---------------------------------------------------------------------------

/**
 * The backend announced it has started. Names the model in force (only when
 * the backend, not ADL, selects it — see {@link AgentTaskSchema.model}) and
 * the capabilities it is operating under for this run.
 */
export const StartedEventSchema = z
  .strictObject({
    kind: z.literal('started'),
    model: z.string().min(1).optional(),
    capabilities: AgentCapabilitiesSchema,
    /** Opaque, backend-owned. See the module docblock's vocabulary rule. */
    sessionRef: z.string().min(1).optional(),
  })
  .meta({ id: 'AgentStartedEvent' });

/**
 * An incremental chunk of assistant-visible text. `messageId` is what lets a
 * consumer reassemble the deltas belonging to one message — it carries no
 * meaning beyond grouping.
 */
export const TextEventSchema = z
  .strictObject({
    kind: z.literal('text'),
    messageId: z.string().min(1),
    delta: z.string(),
  })
  .meta({ id: 'AgentTextEvent' });

/** An incremental chunk of the backend's own reasoning trace, when it reports one. */
export const ThinkingEventSchema = z
  .strictObject({
    kind: z.literal('thinking'),
    messageId: z.string().min(1),
    delta: z.string(),
  })
  .meta({ id: 'AgentThinkingEvent' });

/**
 * The backend invoked one of its own tools. ADL logs this; it never acts on
 * it (see the module docblock's "translate, never re-drive").
 */
export const ToolCallEventSchema = z
  .strictObject({
    kind: z.literal('tool_call'),
    callId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .meta({ id: 'AgentToolCallEvent' });

/** The matching result for a {@link ToolCallEventSchema}, correlated by `callId`. */
export const ToolResultEventSchema = z
  .strictObject({
    kind: z.literal('tool_result'),
    callId: z.string().min(1),
    result: z.unknown(),
    isError: z.boolean(),
  })
  .meta({ id: 'AgentToolResultEvent' });

/**
 * The four token counts a backend may report, shared between the `usage`
 * event and {@link AgentRunResultSchema}.
 *
 * Every field is **separately nullable, and never defaulted to zero**
 * (01-CONTEXT.md § D-31): "the backend did not report this" and "the backend
 * reported zero" are two facts that cannot be recovered once merged. A
 * backend whose `reportsUsage` capability is `false` reports every field
 * `null`, honestly, rather than a translator inventing zeros.
 */
export const AgentUsageSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    cacheReadTokens: z.int().nonnegative().nullable(),
    cacheWriteTokens: z.int().nonnegative().nullable(),
  })
  .meta({
    id: 'AgentUsage',
    description:
      'Token counts a backend reported. Each field is null, never zero, when unreported',
  });

export type AgentUsage = z.infer<typeof AgentUsageSchema>;

/** A token/cache-count report, on its own line so a transcript reader sees usage as it accrues. */
export const UsageEventSchema = AgentUsageSchema.extend({
  kind: z.literal('usage'),
}).meta({ id: 'AgentUsageEvent' });

/**
 * How a run ended. `turn_limit_reached` exists because
 * `AgentTask.limits.maxTurns` is a real, honoured bound (04-RESEARCH.md §
 * Open Questions 3 flags that its exact backend-reported shape is still being
 * confirmed by a later plan against a real invocation — this union is the
 * classification contract that confirmation writes into, not a guess it
 * replaces).
 */
export const AGENT_RESULT_OUTCOMES = Object.freeze([
  'completed',
  'turn_limit_reached',
  'cancelled',
] as const);

export type AgentResultOutcome = (typeof AGENT_RESULT_OUTCOMES)[number];

export const AgentResultOutcomeSchema = z.enum(AGENT_RESULT_OUTCOMES).meta({
  id: 'AgentResultOutcome',
  description: 'How an agent run ended',
});

/**
 * The terminal event of a successful run. Carries what a caller needs to
 * account for the round — the outcome, how long it took, and what the
 * backend itself says it cost (never ADL's own arithmetic; see
 * {@link AgentCapabilitiesSchema.reportsCost}).
 */
export const ResultEventSchema = z
  .strictObject({
    kind: z.literal('result'),
    outcome: AgentResultOutcomeSchema,
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  })
  .meta({ id: 'AgentResultEvent' });

/**
 * The backend broke rather than produced a result. Reuses {@link StageErrorKindSchema}
 * rather than inventing a second failure taxonomy — D-12's classification is
 * already the vocabulary the loop acts on. This is a transcript *event*, not
 * the `run()` return channel; see {@link AgentRunner.run}'s docblock for how
 * the two relate.
 */
export const ErrorEventSchema = z
  .strictObject({
    kind: z.literal('error'),
    errorKind: StageErrorKindSchema,
    detail: z.string().min(1),
  })
  .meta({ id: 'AgentErrorEvent' });

/**
 * The vendor-neutral spine (D-07, `ARCHITECTURE.md` §4): a delegated-loop
 * adapter is a line-by-line translator from the backend's own output into
 * this union; an owned-loop adapter (Phase 11) emits the same events from its
 * own loop. Everything downstream — the transcript store, the cost ledger,
 * the dashboard SSE, PR-comment generation — consumes one shape regardless of
 * which backend produced it.
 *
 * Every member is a `.strictObject`: an extra property a backend's translator
 * tries to smuggle through is a parse failure, not a silently carried value
 * that reaches a transcript a pull request later renders (T-4-10).
 *
 * A malformed or unrecognised backend payload is the translator's job to
 * classify into {@link ErrorEventSchema}, never to throw — "classify, don't
 * throw, for expected-but-notable outcomes" (T-4-11). One bad line must not
 * end a run that is otherwise fine.
 */
export const AgentEventSchema = z
  .discriminatedUnion('kind', [
    StartedEventSchema,
    TextEventSchema,
    ThinkingEventSchema,
    ToolCallEventSchema,
    ToolResultEventSchema,
    UsageEventSchema,
    ResultEventSchema,
    ErrorEventSchema,
  ])
  .meta({
    id: 'AgentEvent',
    description:
      "The vendor-neutral spine of a backend's output — one union, eight kinds, every backend family",
  });

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentStartedEvent = z.infer<typeof StartedEventSchema>;
export type AgentTextEvent = z.infer<typeof TextEventSchema>;
export type AgentThinkingEvent = z.infer<typeof ThinkingEventSchema>;
export type AgentToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type AgentToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type AgentUsageEvent = z.infer<typeof UsageEventSchema>;
export type AgentResultEvent = z.infer<typeof ResultEventSchema>;
export type AgentErrorEvent = z.infer<typeof ErrorEventSchema>;

/** The discriminator values of {@link AgentEvent}, as runtime data. */
export type AgentEventKind = AgentEvent['kind'];

/**
 * The eight kinds D-07 names, in the order it names them.
 *
 * Paired with the compile-time exhaustiveness assertion below —
 * `FEATURE_EVENT_KINDS`' pattern (`packages/core/src/state/feature-state.ts`)
 * — so a kind added to {@link AgentEventSchema}'s union but missing from this
 * list fails the **build**, not a test.
 */
export const AGENT_EVENT_KINDS = Object.freeze([
  'started',
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'usage',
  'result',
  'error',
] as const) satisfies readonly AgentEventKind[];

/**
 * Compile-time exhaustiveness: an event kind added to the union but missing
 * from `AGENT_EVENT_KINDS` fails the build. Without this, a ninth kind added
 * to {@link AgentEventSchema} without being added here would silently stop
 * being covered by anything that enumerates `AGENT_EVENT_KINDS` — the exact
 * failure mode the list exists to prevent.
 */
type _EveryAgentEventKindListed =
  Exclude<AgentEventKind, (typeof AGENT_EVENT_KINDS)[number]> extends never
    ? true
    : never;
const _everyAgentEventKindListed: _EveryAgentEventKindListed = true;
void _everyAgentEventKindListed;

// ---------------------------------------------------------------------------
// AgentTask — what ADL hands the backend for one invocation
// ---------------------------------------------------------------------------

/**
 * What ADL hands the backend for one invocation.
 *
 * `systemPrompt` and `instructions` arrive fully rendered — the port never
 * receives a spec or a template. `PromptBuilder` owns rendering and adapters
 * never build prompts (`ARCHITECTURE.md` §4); accepting anything less than a
 * finished string here would reopen that door.
 *
 * `model` is present, not absent: `packages/core/src/config/adl-yml.ts`'s
 * `AgentsConfigSchema.developer.model` establishes that ADL — not the
 * backend — selects the model per role. **Who inside ADL decides was
 * amended by M06 step 6.11:** the daemon still decides, but it may delegate
 * the choice to the watched repository for models it names in
 * `repo_model_allowlist` (an absent allowlist names none). Either way the
 * value arriving here has already been through `mergeConfig`, so a backend
 * never has to know which side of that decision it came from. A backend that
 * reports back a different model at `started` than the one named here is a
 * probe-worthy discrepancy for the adapter, not this schema's concern.
 *
 * `04-CONTEXT.md`'s flagged BACK-01 edge probe row is why there is no tool
 * policy field here — see the module docblock.
 */
export const AgentTaskSchema = z
  .strictObject({
    /** Fully rendered by `PromptBuilder`. Never a template or a spec fragment. */
    systemPrompt: z.string().min(1),
    /** Fully rendered by `PromptBuilder`. Never empty — an empty instruction is not a task. */
    instructions: z.string().min(1),
    /** Workspace-relative paths to load explicitly. Empty when nothing beyond the prompt is needed. */
    contextFiles: z.array(RepoRelativePathSchema).default([]),
    /** The model ADL selected for this role — daemon-chosen, or repo-requested from the daemon's allowlist (D-22 as amended by M06 step 6.11). */
    model: z.string().min(1).optional(),
    /** Opaque, backend-owned, opportunistic. Omitting it must never break correctness (leak 3). */
    sessionRef: z.string().min(1).optional(),
    limits: z
      .strictObject({
        maxWallClockMs: z.int().positive(),
        maxTurns: z.int().positive().optional(),
      })
      .meta({ id: 'AgentTaskLimits' }),
  })
  .meta({
    id: 'AgentTask',
    description: 'What ADL hands a backend for one invocation',
  });

export type AgentTask = z.infer<typeof AgentTaskSchema>;

// ---------------------------------------------------------------------------
// AgentRunResult — what run() resolves to
// ---------------------------------------------------------------------------

/**
 * What {@link AgentRunner.run} resolves to: the terminal outcome and the
 * observed usage, named rather than left for the caller to infer from the
 * event stream it just consumed.
 */
export const AgentRunResultSchema = z
  .strictObject({
    outcome: AgentResultOutcomeSchema,
    durationMs: z.number().nonnegative(),
    usage: AgentUsageSchema,
    costUsd: z.number().nonnegative().optional(),
    /** Opaque, backend-owned. What the backend reported back, if anything, for a later opportunistic resume. */
    sessionRef: z.string().min(1).optional(),
  })
  .meta({
    id: 'AgentRunResult',
    description: 'The terminal outcome and observed usage of one agent run',
  });

export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

// ---------------------------------------------------------------------------
// AgentProbe — what probe() resolves to
// ---------------------------------------------------------------------------

/**
 * What {@link AgentRunner.probe} resolves to: whether the backend is usable
 * and, when it is not, why — installed version, expected version, and a
 * human-readable detail (OBS-08). A hard-block-dispatch decision is made from
 * this, not from a caught exception.
 */
export const AgentProbeSchema = z
  .strictObject({
    usable: z.boolean(),
    installedVersion: z.string().min(1).nullable(),
    expectedVersion: z.string().min(1),
    detail: z.string().min(1).optional(),
  })
  .meta({
    id: 'AgentProbe',
    description: 'Whether a backend is usable, and why not when it is not',
  });

export type AgentProbe = z.infer<typeof AgentProbeSchema>;

// ---------------------------------------------------------------------------
// AgentRunner — the port itself
// ---------------------------------------------------------------------------

/** Everything {@link AgentRunner.run} is given, beyond the task itself. */
export interface AgentRunContext {
  /** The workspace this invocation runs inside — the adapter's subprocess launches through this, never directly (WORK-02). */
  readonly workspace: Workspace;
  /** Called once per translated event, as it arrives — never buffered until the run ends (streamed logging, OBS-02). */
  readonly onEvent: (event: AgentEvent) => void;
  /** Fires on budget interrupt, pause, or shutdown. A runner that ignores it will be killed, same as a `Stage`. */
  readonly signal: AbortSignal;
}

/**
 * The port itself. Two methods.
 *
 * `run` translates and never re-drives — see the module docblock. An
 * implementation that branches on a `tool_call` event to make a decision has
 * misunderstood the delegated-loop family: the events exist to be logged and
 * reported, not consumed as control flow.
 *
 * Both methods return rather than throw for expected-but-notable outcomes,
 * following `StageError` and `compareAndSwapState`: a missing binary, an auth
 * failure, and a version mismatch are all answers, not exceptions. `run`
 * itself only ever rejects for a genuinely unexpected/programmer-error
 * condition — an in-band, expected failure (provider down, auth rejected,
 * turn cap hit) is reported as an `error`/`result` {@link AgentEvent} via
 * `ctx.onEvent`, and folded into the resolved {@link AgentRunResult}, not
 * thrown.
 */
export interface AgentRunner {
  run(task: AgentTask, ctx: AgentRunContext): Promise<AgentRunResult>;
  /** Binary present? Auth valid? Version pinned correctly? Called at startup / `adl doctor`, never per-invocation (OBS-08). */
  probe(): Promise<AgentProbe>;
}

// ---------------------------------------------------------------------------
// TranscriptRecord — the on-disk envelope (one record, one line, append-only)
// ---------------------------------------------------------------------------

/**
 * The on-disk envelope for one line of
 * `logs/<feature>/<round>/<stage>/<attempt>.ndjson` (`ARCHITECTURE.md` §4,
 * §9).
 *
 * **Decision (Task 1 of this plan, human-selected option-c):** a record
 * carries both the translated {@link AgentEvent} and, when the backend that
 * produced it has one, the backend's own raw output line for that event —
 * verbatim, as `raw`. This is the option that loses nothing (a debugger has
 * the input the translator saw) while staying readable by a backend-blind
 * consumer (a reader that only knows ADL's vocabulary ignores `raw`
 * entirely).
 *
 * **`raw` is scoped, not general-purpose.** It is a documented invitation for
 * a downstream reader to depend on one backend's shape — the exact leak
 * option-a avoids by construction and option-c accepts in exchange for never
 * losing evidence. The human decision that selected option-c also scoped it:
 * **`raw` may be read only by code inside `packages/agent-claude-code/**`.**
 * Every other reader — the transcript store, the SSE route, Phase 9's rollup,
 * Phase 17's dashboard, any third-party consumer of a persisted transcript —
 * must treat `raw` as opaque and unread, consuming only `event`. This is a
 * stated rule enforced by convention and code review today; a lint rule
 * enforcing it mechanically is a natural follow-up but is not part of this
 * plan's scope.
 *
 * **Two invariants byte-offset addressing depends on, and that later phases
 * rely on** (`ARCHITECTURE.md` §9):
 *
 * 1. **One record is one line.** A serialised `TranscriptRecord` must never
 *    contain a raw newline — `JSON.stringify` already guarantees this for any
 *    string field, since control characters are escaped, not emitted literally.
 * 2. **The file is append-only.** Nothing in this schema is ever rewritten in
 *    place; a correction is a new record, never a mutation of an old one.
 *
 * `seq` exists for **ordering and gap detection** (T-4-12), and is
 * deliberately **not** the addressing scheme — `ARCHITECTURE.md` §9 fixes the
 * address as a byte offset (`?offset=N&follow=1`), and a second scheme would
 * break the property that the CLI and the dashboard are the same code.
 */
export const TranscriptRecordSchema = z
  .strictObject({
    /** Monotonically increasing, scoped to one stage attempt. For ordering and gap detection — never for addressing. */
    seq: z.int().nonnegative(),
    /** ISO-8601 instant this record was appended. */
    at: z.iso.datetime(),
    event: AgentEventSchema,
    /**
     * The backend's own raw output line for `event`, verbatim, when the
     * producing backend has one. Readable only inside
     * `packages/agent-claude-code/**` — see the schema docblock above.
     */
    raw: z.string().min(1).optional(),
  })
  .meta({
    id: 'TranscriptRecord',
    description:
      'One line of an on-disk transcript file — the translated event, plus the producing ' +
      "backend's raw line when it has one (raw is scoped: agent-claude-code readers only)",
  });

export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>;
