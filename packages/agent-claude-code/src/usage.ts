/**
 * `usageFromResult` — the run's terminal `result` event, combined with what
 * the run already observed on its `started` and `usage` events, mapped into
 * a `usage_events`-shaped record with honest provenance (D-06, D-31).
 *
 * ── Provenance of the mapping below (KNOWN GAP, read before editing) ───────
 *
 * `04-01-PLAN.md` Task 3 — capturing four real invocations of the pinned CLI
 * into `packages/agent-claude-code/test/fixtures/` (`stream-json-develop.ndjson`,
 * `stream-json-max-turns.ndjson`, `result-json.json`, `claude-version.txt`,
 * `CAPTURE.md`) — was deferred: no `ANTHROPIC_API_KEY` was available in any
 * session that ran it (`04-01-SUMMARY.md`, `04-07-SUMMARY.md`,
 * `04-09-SUMMARY.md` all carry the same gap forward). This module therefore
 * does NOT re-derive a second raw-JSON-to-record mapping from a fixture that
 * does not exist — it reuses `events.ts`'s ALREADY-verified translation
 * (`translateLine`'s `mapResult`, itself built from `04-RESEARCH.md`'s
 * Pattern 4 table and documented alongside the identical gap note) as its
 * single source of the token/cost field mapping, and only combines what that
 * translator already produced (the `usage` and `result` `AgentEvent`s, plus
 * the `started` event's `model`) into one `usage_events`-shaped record. A
 * second independent mapping of the same raw field names, built against the
 * same undocumented shape, would be free to drift from `events.ts`'s and
 * give the two modules disagreeing answers about the same invocation — this
 * module deliberately does not create that risk.
 *
 * Reconciling `events.ts` (and, transitively, this module) against a real
 * capture once `04-01` Task 3 lands is the same non-urgent follow-up already
 * recorded for `events.ts`, `preflight.ts`'s parser, and `argv.test.ts`.
 *
 * ── Nullable, never defaulted (D-31) ────────────────────────────────────────
 *
 * Every token counter below is copied straight from the `usage` `AgentEvent`
 * `events.ts` already produced — which is itself null, not zero, for a field
 * the backend did not report (`AgentUsageSchema`'s own discipline). This
 * module adds no `?? 0` anywhere; a missing counter stays missing all the
 * way to the `usage_events` row `spendByCategory`'s `unpricedEvents` counter
 * depends on distinguishing from a reported zero.
 *
 * ── Cost source: reported or unknown, never computed ────────────────────────
 *
 * `.claude/CLAUDE.md` § Cost accounting and `01-CONTEXT.md` § D-31 both say
 * the same thing: prefer the backend's own reported figure over ADL's
 * arithmetic. This backend's `result` event either carries `costUsd`
 * (`total_cost_usd` from the CLI, per `events.ts`'s `mapResult`) — recorded
 * verbatim, `costSource: 'reported'` — or it does not, and this module
 * records a null cost and `costSource: 'unknown'` rather than inventing a
 * figure `priceUsageEvent`'s `model_prices` lookup would otherwise compute
 * for a backend that already told the truth about not knowing. `'computed'`
 * never appears here — that source belongs to `@adl/db`'s `pricing.ts`, the
 * caller this backend's honest `'unknown'` defers to.
 *
 * ── Two producers, one vocabulary (M05 step 5.18, BACK-09) ──────────────────
 *
 * {@link usageFromResult} maps a run that *reached* its terminal event.
 * {@link unknownUsageRecord} is its counterpart for a run that did not — a
 * CLI killed by a timeout, or one that exited non-zero before emitting
 * `result`. Both of those burned tokens; neither reported any. Before 5.18
 * the second case produced nothing at all and the invocation left no trace on
 * the ledger, which is the silent degradation BACK-09 forbids. They share
 * `UNRESOLVED_MODEL_ID`, `DEFAULT_SPEED` and `DEFAULT_COST_CATEGORY` rather
 * than restating them, so the two records a reader has to tell apart differ
 * in exactly the field that distinguishes them — `costSource`.
 */
import type { AgentEvent, AgentUsageEvent } from '@adl/core/stage';

/** The DB check constraint's vocabulary (`usage_events.cost_source`). This backend only ever produces the first two. */
export type UsageCostSource = 'reported' | 'unknown';

/** The DB check constraint's vocabulary (`usage_events.cost_category`), D-14. */
export type UsageCostCategory = 'feature' | 'overhead';

/** The DB check constraint's vocabulary (`usage_events.speed`, `model_prices.speed`). */
export type ModelSpeed = 'standard' | 'fast';

/**
 * A `usage_events` row's worth of data, independent of `@adl/db` — this
 * package depends on `@adl/core` and `zod` only (see `package.json`); the
 * caller (`packages/manager/src/worker-entry/stage-runner.ts`) is the one
 * that already depends on `@adl/db` and turns this into a `NewUsageEvent`.
 */
export interface AgentUsageRecord {
  readonly modelId: string;
  readonly speed: ModelSpeed;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  /** Null when {@link AgentUsageRecord.costSource} is `'unknown'` — never zero (D-31). */
  readonly costUsd: number | null;
  readonly costSource: UsageCostSource;
  readonly costCategory: UsageCostCategory;
}

/**
 * What `usageFromResult` needs beyond the terminal event itself: the model
 * named on the run's earlier `started` event (the `result` event, per
 * `AgentEventSchema`, never itself carries a model id — see the module
 * docblock) and the most recent `usage` event observed in the same run (the
 * token counts, similarly absent from `result`). Both travel alongside the
 * terminal event rather than being re-derived, because `backend.ts`'s `run()`
 * is the one place that has already seen every event in order and is the
 * only caller of this function.
 */
export interface UsageFromResultEvent {
  /** The event being classified. Only a `kind: 'result'` event produces a record — see {@link usageFromResult}. */
  readonly event: AgentEvent;
  /** The most recent `usage` event observed earlier in the same run, if any. */
  readonly usage?: AgentUsageEvent | undefined;
  /** The model named on the run's `started` event, or ADL's own selection (`AgentTask.model`) when the backend did not report one. */
  readonly model?: string | undefined;
  /** Defaults to `'feature'`. D-14's repair-reprompt path is the only caller that will ever pass `'overhead'`, and it does not exist until a later phase. */
  readonly costCategory?: UsageCostCategory;
}

/**
 * The default speed tier: this adapter's argv never requests "fast mode" (a
 * Claude Code CLI concept `0003_seed_model_prices.ts` prices separately, only
 * for `claude-opus-5`) — every invocation this backend makes is `'standard'`.
 * Since this backend's cost is always `'reported'`, not `'computed'`, `speed`
 * never actually feeds a price lookup for THIS backend's own rows; it is
 * still populated honestly because the column is `not null`.
 */
const DEFAULT_SPEED: ModelSpeed = 'standard';

const DEFAULT_COST_CATEGORY: UsageCostCategory = 'feature';

/**
 * A model id could not be resolved from either the `started` event or the
 * caller's own selection — an edge case with no captured evidence of ever
 * happening for a real invocation (the CLI's `system/init` line is the very
 * first line it emits). Recorded literally rather than crashing or
 * fabricating a plausible-looking model name, so a reader of the row can
 * tell the difference between "the backend really did not say" and a typo.
 */
const UNRESOLVED_MODEL_ID = 'unknown-model';

/**
 * Map the backend's terminal `result` event — plus what the run already
 * observed — to a `usage_events`-shaped record.
 *
 * Returns `undefined` for any event that is not the run's terminal `result`
 * event, rather than a partially-filled record: a `text`/`tool_call`/etc.
 * event has no usage to report, and returning an all-null record for one
 * would let a caller mistake "not terminal yet" for "the backend reported
 * nothing" (T-4-39's repudiation risk, restated for this boundary).
 */
export function usageFromResult(
  event: UsageFromResultEvent,
): AgentUsageRecord | undefined {
  if (event.event.kind !== 'result') return undefined;
  const result = event.event;

  const reportedCost = result.costUsd;
  const costUsd = reportedCost ?? null;
  const costSource: UsageCostSource =
    reportedCost !== undefined ? 'reported' : 'unknown';

  return {
    modelId: event.model ?? UNRESOLVED_MODEL_ID,
    speed: DEFAULT_SPEED,
    inputTokens: event.usage?.inputTokens ?? null,
    outputTokens: event.usage?.outputTokens ?? null,
    cacheCreationInputTokens: event.usage?.cacheWriteTokens ?? null,
    cacheReadInputTokens: event.usage?.cacheReadTokens ?? null,
    costUsd,
    costSource,
    costCategory: event.costCategory ?? DEFAULT_COST_CATEGORY,
  };
}

/** What {@link unknownUsageRecord} needs — everything else about the run is, by definition, unknown. */
export interface UnknownUsageInput {
  /**
   * The model this invocation was launched against: whatever the run's
   * `started` event named, or — when it never got that far — ADL's own
   * selection (`AgentTask.model`). Absent resolves to
   * {@link UNRESOLVED_MODEL_ID}, exactly as {@link usageFromResult} does.
   */
  readonly model?: string | undefined;
  /** Defaults to `'feature'`, mirroring {@link UsageFromResultEvent.costCategory}. */
  readonly costCategory?: UsageCostCategory;
}

/**
 * The honest record for an agent invocation that **ran and reported nothing**
 * (BACK-09, D-31, M05 step 5.18).
 *
 * Every counter is null and `costSource` is `'unknown'` — the row says "an
 * agent ran here and we do not know what it cost", which is a different and
 * far more useful statement than either a row of zeroes (a lie a budget gate
 * would enforce against) or no row at all (a gap indistinguishable from a
 * stage that never invoked an agent).
 *
 * The caller decides *when* this applies, and that decision is the load-bearing
 * half: `backend.ts` produces this only once the CLI process has actually been
 * spawned. A spawn that never happened — a missing binary — is not an
 * invocation and gets no record, because its true cost is zero rather than
 * unknown, and `stage-runner.ts` already reports that failure through the
 * `stage_error` channel.
 */
export function unknownUsageRecord(
  input: UnknownUsageInput = {},
): AgentUsageRecord {
  return {
    modelId: input.model ?? UNRESOLVED_MODEL_ID,
    speed: DEFAULT_SPEED,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: null,
    costSource: 'unknown',
    costCategory: input.costCategory ?? DEFAULT_COST_CATEGORY,
  };
}
