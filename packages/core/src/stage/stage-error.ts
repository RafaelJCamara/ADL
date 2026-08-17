/**
 * The infrastructure-failure channel (D-12, CORE-06).
 *
 * `StageError` sits **outside** the six-outcome `Verdict` union, and must stay
 * outside. "The gate judged" and "the gate broke" are different kinds of thing:
 * collapsing them into a seventh outcome would make a provider outage cost the
 * developer a round, which is exactly what CORE-06 forbids. The separation is
 * enforced in three places — this module's shape, the runtime schema disjointness
 * asserted in `test/stage/stage-error.test.ts`, and the compile-time mutual
 * non-assignability asserted in `test/stage/type-boundary.test-d.ts`.
 *
 * **Cost accounting (D-14).** Repair-retry and failed-parse spend is *recorded
 * and counted* against the feature budget, tagged `costCategory: 'overhead'`, so
 * `adl show` and the PR cost line can display wasted spend separately from the
 * feature's real cost. A budget that quietly ignores some spend is not a budget.
 * The `usage_events` column that carries that tag lands in plan **01-10**'s first
 * migration; this comment is the cross-reference so neither side is built
 * against a shape the other did not agree to. `stageErrorPolicy` below is where
 * the "did this cost money?" half of that question is answered.
 *
 * **What is deliberately not here.** The backoff loop and the wall-clock
 * deadline that `retryable` feeds are Phase 6 runtime (01-CONTEXT.md § Deferred
 * Ideas). This module ships the classification and the threshold, not the loop.
 * Likewise `rawRef` is a *pointer*: Phase 3's artifact store implements the sink,
 * and `capRawOutput` here is the retention contract it implements against.
 */
import * as z from 'zod';

import type { CriterionRef, GlobalCategory } from '../verdict/criterion-ref.js';
import type { Finding } from '../verdict/finding.js';
import {
  OUTCOMES,
  VerdictSchema,
  type PassVerdict,
  type Verdict,
} from '../verdict/verdict.js';

/**
 * The five ways a stage can break without having judged anything (D-12).
 *
 * Two of them — `provider_error` and `timeout` — are transient; the loop backs
 * off and tries again. The other three are the model, the machine, or the
 * credentials being wrong in a way another attempt will not fix.
 */
export const STAGE_ERROR_KINDS = Object.freeze([
  'unparseable',
  'provider_error',
  'timeout',
  'binary_missing',
  'auth',
] as const);

export type StageErrorKind = (typeof STAGE_ERROR_KINDS)[number];

export const StageErrorKindSchema = z.enum(STAGE_ERROR_KINDS).meta({
  id: 'StageErrorKind',
  description: 'Why a stage failed to produce a judgement at all',
});

/**
 * A stage that could not judge.
 *
 * A plain `z.object`, and pointedly **not** a member of any verdict union.
 *
 * Every constraint is structural — no `.refine()`, no `.superRefine()` — for the
 * same reason the verdict schemas are: `z.toJSONSchema()` drops refinements
 * silently, and this module sits beside the published contract (threat T-1-06).
 *
 * `rawRef` is an **artifact pointer**, never the raw blob. Raw agent output does
 * not live in database rows (`.planning/research/ARCHITECTURE.md` §
 * "Anti-Patterns"), and carrying it inline would put unbounded model output —
 * which may quote the workspace back at you — into every error record
 * (threat T-1-21). {@link capRawOutput} is the retention cap the artifact store
 * applies before it hands back a pointer.
 */
export const StageErrorSchema = z
  .object({
    kind: StageErrorKindSchema,
    /**
     * Whether another attempt could plausibly succeed. Derived from `kind` by
     * {@link stageErrorPolicy}; carried on the wire so a stage implemented in
     * another language can state it without reimplementing the table.
     */
    retryable: z.boolean(),
    /** What went wrong, in words a maintainer reading the PR can act on. */
    detail: z.string().min(1),
    /** Artifact-store pointer to the capped raw output. Never the blob itself. */
    rawRef: z.string().min(1).optional(),
  })
  .meta({
    id: 'StageError',
    description:
      'A stage that broke rather than judged — outside the Verdict union entirely',
  });

export type StageError = z.infer<typeof StageErrorSchema>;

/**
 * What a stage returns (D-12).
 *
 * This alias is the return type of {@link import('./stage.js').Stage.run}, which
 * is the interface third-party harness authors implement against — so it is
 * one-way once `@adl/plugin-sdk` is published. The union is discriminated in
 * practice by the presence of `outcome` versus `kind`, and the two halves are
 * mutually non-assignable, so `isStageError` is a total, honest narrowing.
 */
export type StageOutcome = Verdict | StageError;

/** Narrows a {@link StageOutcome} to the infrastructure-failure half. */
export function isStageError(outcome: StageOutcome): outcome is StageError {
  return !('outcome' in outcome);
}

// ---------------------------------------------------------------------------
// Routing: retryable, and what a failure costs
// ---------------------------------------------------------------------------

/** How the loop should treat a {@link StageError} of a given kind (D-15). */
export interface StageErrorPolicy {
  /** May another attempt plausibly succeed? Transient kinds only. */
  readonly retryable: boolean;
  /**
   * Does this cost the feature one of its finite rounds?
   *
   * **Always `false`, for every kind.** This is CORE-06's entire promise: a gate
   * that broke did not judge, so there is nothing for the developer to have got
   * wrong. LOOP-07 (a provider outage consuming neither round nor budget) rides
   * this channel rather than needing its own.
   */
  readonly consumesRound: boolean;
  /**
   * Did the attempt actually spend money? Only `unparseable` did — the model
   * produced output, it just was not a verdict. That spend is real and is tagged
   * `overhead` rather than hidden (D-14). A provider error, a timeout, a missing
   * binary and an auth rejection all failed before or without a billable
   * completion.
   */
  readonly consumesBudget: boolean;
}

/** The transient kinds: another attempt may well succeed (D-15). */
const TRANSIENT_KINDS: ReadonlySet<StageErrorKind> = new Set<StageErrorKind>([
  'provider_error',
  'timeout',
]);

/** Is this a kind the loop should back off and retry, rather than escalate? */
export function isTransientStageErrorKind(kind: StageErrorKind): boolean {
  return TRANSIENT_KINDS.has(kind);
}

const STAGE_ERROR_POLICIES: Readonly<Record<StageErrorKind, StageErrorPolicy>> =
  Object.freeze({
    provider_error: {
      retryable: true,
      consumesRound: false,
      consumesBudget: false,
    },
    timeout: { retryable: true, consumesRound: false, consumesBudget: false },
    unparseable: {
      retryable: false,
      consumesRound: false,
      consumesBudget: true,
    },
    binary_missing: {
      retryable: false,
      consumesRound: false,
      consumesBudget: false,
    },
    auth: { retryable: false, consumesRound: false, consumesBudget: false },
  });

/**
 * How the loop must treat a failure of this kind.
 *
 * A total function over a closed enum — adding a sixth kind without deciding its
 * policy is a compile error here, not a silent default somewhere downstream.
 */
export function stageErrorPolicy(kind: StageErrorKind): StageErrorPolicy {
  return STAGE_ERROR_POLICIES[kind];
}

/**
 * How many consecutive non-transient failures before ADL stops trying and asks a
 * human (D-15, default 2).
 *
 * Named rather than inlined so the escalation point is one grep away, and so
 * Phase 6 can make it configurable without hunting for a literal `2`.
 */
export const NON_TRANSIENT_ESCALATION_THRESHOLD = 2;

/**
 * Should a run of consecutive non-transient failures escalate to a human?
 *
 * Pure and boundary-explicit: false at one, true at two. The counter itself, and
 * the backoff schedule for the transient kinds, are Phase 6 runtime.
 */
export function shouldEscalate(consecutiveNonTransient: number): boolean {
  return consecutiveNonTransient >= NON_TRANSIENT_ESCALATION_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Raw output retention (T-1-21)
// ---------------------------------------------------------------------------

/** Bytes of raw output kept from the head before eliding (01-RESEARCH.md § OQ5). */
export const RAW_REF_HEAD_BYTES = 16_384;

/** Bytes of raw output kept from the tail before eliding. */
export const RAW_REF_TAIL_BYTES = 16_384;

/**
 * The marker that replaces the elided middle.
 *
 * It names how many bytes went missing, so nobody reads a capped blob as a whole
 * one. A silent truncation is how a debugging session ends in the wrong place.
 */
export function rawRefElisionMarker(bytesElided: number): string {
  return `\n… ${bytesElided} bytes elided by ADL (head ${RAW_REF_HEAD_BYTES}B + tail ${RAW_REF_TAIL_BYTES}B retained) …\n`;
}

/** Is `byte` a UTF-8 continuation byte (`10xxxxxx`)? */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** The largest cut point at or before `end` that does not split a character. */
function safeHeadEnd(buf: Buffer, end: number): number {
  let p = end;
  while (p > 0 && isContinuation(buf[p - 1] as number)) p--;
  if (p === 0) return end;
  const lead = buf[p - 1] as number;
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  // Keep the straddling character only if it finishes at or before `end`.
  return p - 1 + width <= end ? end : p - 1;
}

/** The smallest cut point at or after `start` that does not split a character. */
function safeTailStart(buf: Buffer, start: number): number {
  let p = start;
  while (p < buf.length && isContinuation(buf[p] as number)) p++;
  return p;
}

/**
 * Apply the retention cap to raw stage output before it is handed to the
 * artifact store (01-RESEARCH.md § Open Questions 5).
 *
 * At or under `RAW_REF_HEAD_BYTES + RAW_REF_TAIL_BYTES` the input is returned
 * untouched. Above it, the head and tail are kept and the middle is replaced by
 * {@link rawRefElisionMarker} — the head because that is where a model states
 * its intent, the tail because that is where a stack trace ends.
 *
 * Cuts land on UTF-8 character boundaries, so a capped blob never contains a
 * replacement character that was not in the original. That backs the cap off by
 * at most three bytes per seam; a byte-exact cap that corrupts text is the worse
 * trade.
 *
 * Phase 1 writes no file: this is the contract, and Phase 3's artifact store is
 * the sink. `StageError.rawRef` holds the pointer that sink returns.
 */
export function capRawOutput(raw: string): string {
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= RAW_REF_HEAD_BYTES + RAW_REF_TAIL_BYTES) return raw;

  const headEnd = safeHeadEnd(buf, RAW_REF_HEAD_BYTES);
  const tailStart = safeTailStart(buf, buf.length - RAW_REF_TAIL_BYTES);
  const elided = tailStart - headEnd;

  return (
    buf.subarray(0, headEnd).toString('utf8') +
    rawRefElisionMarker(elided) +
    buf.subarray(tailStart).toString('utf8')
  );
}

// ---------------------------------------------------------------------------
// The parse ladder (D-13)
// ---------------------------------------------------------------------------

/**
 * The ladder performs **at most one** repair reprompt.
 *
 * One recovers the common case — valid JSON wrapped in prose or a fence — and
 * fails fast when the model is genuinely confused. An unbounded repair loop on
 * an unparseable payload is threat T-1-20, and it is unbounded *spend*, not just
 * unbounded time.
 */
export const MAX_REPAIR_ATTEMPTS = 1;

/** What the single repair reprompt should carry back to the model. */
export interface RepairReprompt {
  /** One line the model can act on. */
  readonly reason: string;
  /** The issues from the failed parse, quoted back verbatim. */
  readonly issues: readonly z.core.$ZodIssue[];
  /**
   * The valid `outcome` names.
   *
   * Lifted from Zod's `invalid_union` issue when the failure was an unknown
   * discriminant — verified to carry `options: ['pass', 'send_back', 'fail',
   * 'inconclusive', 'warn', 'skip']` — because quoting the model's own error
   * back at it is the cheapest repair prompt there is. Falls back to the
   * canonical six when the payload was not JSON at all.
   */
  readonly validOutcomes: readonly string[];
}

export type ParseStageOutputResult =
  /** Parsed. `repairAttempts` is 0 on a first-attempt success, 1 after a repair. */
  | {
      readonly kind: 'parsed';
      readonly verdict: Verdict;
      readonly repairAttempts: number;
    }
  /** One repair reprompt is warranted. There will not be a second. */
  | {
      readonly kind: 'repair';
      readonly repairAttempts: 1;
      readonly reprompt: RepairReprompt;
    }
  /** The ladder is exhausted. An infrastructure failure, never a verdict. */
  | {
      readonly kind: 'failed';
      readonly repairAttempts: 1;
      readonly error: StageError;
    };

/** Fenced code blocks, scanned without a regex so the cost is provably linear. */
function* fencedBlocks(raw: string): Generator<string> {
  const FENCE = '```';
  let cursor = 0;
  for (;;) {
    const open = raw.indexOf(FENCE, cursor);
    if (open === -1) return;
    const infoEnd = raw.indexOf('\n', open);
    if (infoEnd === -1) return;
    const close = raw.indexOf(FENCE, infoEnd);
    if (close === -1) return;
    yield raw.slice(infoEnd + 1, close);
    cursor = close + FENCE.length;
  }
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * The candidates the ladder tries, most-faithful first: the whole payload
 * (what a schema-constrained backend returns), then each fenced block, then the
 * widest brace span (a model that forgot the fence but not the JSON).
 */
function* jsonCandidates(raw: string): Generator<unknown> {
  const whole = tryJson(raw);
  if (whole.ok) yield whole.value;

  for (const block of fencedBlocks(raw)) {
    const parsed = tryJson(block);
    if (parsed.ok) yield parsed.value;
  }

  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) {
    const span = tryJson(raw.slice(open, close + 1));
    if (span.ok) yield span.value;
  }
}

/** Lift Zod's own list of valid discriminants out of an `invalid_union` issue. */
function validOutcomesFrom(
  issues: readonly z.core.$ZodIssue[],
): readonly string[] {
  for (const issue of issues) {
    const options = (issue as { options?: unknown }).options;
    if (
      Array.isArray(options) &&
      options.every((option) => typeof option === 'string')
    ) {
      return options as readonly string[];
    }
  }
  return OUTCOMES;
}

/**
 * Turn raw stage output into a `Verdict`, a warranted repair, or a `StageError`
 * (D-13).
 *
 * Pure: `attempt` is the number of repair reprompts already spent, supplied by
 * the caller, so the bound is visible in the signature rather than hidden in
 * mutable state. `attempt >= MAX_REPAIR_ATTEMPTS` can only ever produce `parsed`
 * or `failed` — there is no input that buys a second repair.
 */
export function parseStageOutput(
  raw: string,
  attempt: number,
): ParseStageOutputResult {
  let firstFailure: readonly z.core.$ZodIssue[] | undefined;

  for (const candidate of jsonCandidates(raw)) {
    const parsed = VerdictSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        kind: 'parsed',
        verdict: parsed.data,
        repairAttempts: Math.min(Math.max(attempt, 0), MAX_REPAIR_ATTEMPTS),
      };
    }
    firstFailure ??= parsed.error.issues;
  }

  const issues = firstFailure ?? [];

  if (attempt < MAX_REPAIR_ATTEMPTS) {
    return {
      kind: 'repair',
      repairAttempts: MAX_REPAIR_ATTEMPTS,
      reprompt: {
        reason:
          issues.length > 0
            ? 'the payload was JSON but did not validate as a Verdict'
            : 'no JSON verdict could be extracted from the response',
        issues,
        validOutcomes: validOutcomesFrom(issues),
      },
    };
  }

  return {
    kind: 'failed',
    repairAttempts: MAX_REPAIR_ATTEMPTS,
    error: {
      kind: 'unparseable',
      retryable: stageErrorPolicy('unparseable').retryable,
      detail:
        issues.length > 0
          ? `the stage returned JSON that is not a Verdict, and one repair reprompt did not fix it: ${issues
              .map((issue) => issue.message)
              .join('; ')}`
          : 'the stage returned no extractable JSON verdict, and one repair reprompt did not fix it',
    },
  };
}

// ---------------------------------------------------------------------------
// Unknown criterion ids (D-04)
// ---------------------------------------------------------------------------

/** The two directions an unknown criterion id can arrive from. */
export type CriterionRefTarget =
  | { readonly kind: 'finding'; readonly finding: Finding }
  | { readonly kind: 'pass'; readonly verdict: PassVerdict };

/** The loud record left behind when a complaint's reference had to be demoted. */
export interface UnknownCriterionFlag {
  /** The id the gate cited, preserved so the PR can show what it meant. */
  readonly originalCriterionId: string;
  /** Every unknown id the payload cited, in cited order. */
  readonly allUnknownIds: readonly string[];
  /** Where the reference was moved to. */
  readonly demotedTo: GlobalCategory;
  /** Human-readable, and deliberately hard to miss on a pull request. */
  readonly notice: string;
}

export type CriterionRefReconciliation =
  /** Every cited id is known. Nothing to do, nothing spent. */
  | {
      readonly kind: 'ok';
      readonly target: CriterionRefTarget;
      readonly repairAttempts: 0;
    }
  /** One repair reprompt is warranted, carrying the ids the spec actually has. */
  | {
      readonly kind: 'repair';
      readonly repairAttempts: 1;
      readonly unknownIds: readonly string[];
      readonly knownIds: readonly string[];
    }
  /** A finding whose reference was demoted to global after the repair failed. */
  | {
      readonly kind: 'demoted';
      readonly repairAttempts: 1;
      readonly finding: Finding;
      readonly flag: UnknownCriterionFlag;
    }
  /** A pass citation that stayed unknown. Infrastructure failure, not a verdict. */
  | {
      readonly kind: 'failed';
      readonly repairAttempts: 1;
      readonly error: StageError;
    };

/** The criterion ids a reference names — none, for a global reference. */
function citedIds(ref: CriterionRef): readonly string[] {
  return ref.kind === 'criterion' ? [ref.id] : [];
}

function citedIdsOf(target: CriterionRefTarget): readonly string[] {
  return target.kind === 'finding'
    ? citedIds(target.finding.criterionRef)
    : target.verdict.checked.flatMap(citedIds);
}

/**
 * Reconcile cited criterion ids against the ids the spec actually has (D-04).
 *
 * **The asymmetry is deliberate and must not be smoothed out.** Both directions
 * ride the same one-repair ladder as {@link parseStageOutput} rather than
 * inventing a second mechanism, but they end differently:
 *
 * - A **finding** citing an id the spec does not have is demoted to
 *   `{ kind: 'global', category: 'other' }` and flagged loudly. Demoting a
 *   complaint is safe: the complaint survives, a human still sees it, and the
 *   worst case is that it is filed under the wrong heading.
 *
 * - A **pass verdict's cited coverage** citing an unknown id becomes a
 *   `StageError`. Accepting it would mean recording that a criterion was checked
 *   on the strength of a citation that points at nothing — fabricated evidence
 *   of coverage. That is precisely the silently-wrong-but-green failure this
 *   project exists to prevent, so it goes down the CORE-06 infrastructure path
 *   instead. There is no attempt count at which a pass citation gets demoted.
 *
 * Pure: `attempt` is supplied by the caller, exactly as in the parse ladder.
 */
export function reconcileCriterionRefs(
  target: CriterionRefTarget,
  knownCriterionIds: readonly string[],
  attempt: number,
): CriterionRefReconciliation {
  const known = new Set(knownCriterionIds);
  const unknownIds = [
    ...new Set(citedIdsOf(target).filter((id) => !known.has(id))),
  ];

  if (unknownIds.length === 0) {
    return { kind: 'ok', target, repairAttempts: 0 };
  }

  if (attempt < MAX_REPAIR_ATTEMPTS) {
    return {
      kind: 'repair',
      repairAttempts: MAX_REPAIR_ATTEMPTS,
      unknownIds,
      knownIds: knownCriterionIds,
    };
  }

  if (target.kind === 'finding') {
    const originalCriterionId = unknownIds[0] as string;
    return {
      kind: 'demoted',
      repairAttempts: MAX_REPAIR_ATTEMPTS,
      finding: {
        ...target.finding,
        criterionRef: { kind: 'global', category: 'other' },
      },
      flag: {
        originalCriterionId,
        allUnknownIds: unknownIds,
        demotedTo: 'other',
        notice: `This finding cited "${originalCriterionId}", which is not an acceptance criterion in this spec. The complaint is shown, but it is not counted as criterion coverage.`,
      },
    };
  }

  return {
    kind: 'failed',
    repairAttempts: MAX_REPAIR_ATTEMPTS,
    error: {
      kind: 'unparseable',
      retryable: stageErrorPolicy('unparseable').retryable,
      detail: `the gate approved while citing criteria this spec does not contain (${unknownIds.join(', ')}); a pass citing nothing real is not evidence of coverage`,
    },
  };
}
