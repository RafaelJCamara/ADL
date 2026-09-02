/**
 * `readEscalations` — every time this feature has stopped and asked for a
 * human, read back out of the audit trail (LOOP-08, M06 step 6.8).
 *
 * **`feature_events` is the source, not `rounds`.** That is the whole reason
 * this module exists rather than a second filter inside `role-rounds.ts`.
 * `rounds.outcome_json` records an escalation only when the round loop closed
 * a round around it, and the per-feature budget escalation deliberately does
 * not: `scheduler/dispatcher.ts`'s `escalateFeatureForBudget` fires *between*
 * rounds, before a lease is taken, and its own docblock says "No round is
 * touched". A reader keyed on `rounds` would therefore be silent for exactly
 * the limit LOOP-04 added — the escalation a human is most likely to be
 * surprised by, since it costs money.
 *
 * Every escalation, from every source, has one thing in common instead: it
 * reached `escalated` through `transition()`, which appended a
 * `feature_events` row. Reading the row that already exists is the same
 * "evaluate state, don't remember events" discipline `@adl/core/detect`'s
 * undeveloped predicate (5.2), DETECT-05's restart reconciliation (5.6) and
 * `publish/role-rounds.ts` itself already run on — and it needs no migration,
 * no column, and no second writer to keep in step.
 *
 * **`to_state` is the filter, and the event kind is only a label.** Three
 * event kinds reach `escalated` today and they are not the obvious two:
 * `unrecoverable`, `limit_exceeded`, and — easy to miss — `send_back`, which
 * `transition()` diverts to `escalated` when the round it would hand out is
 * past `maxRounds` (LOOP-03, M06 step 6.2). Enumerating those three here
 * would restate a decision `transition.ts` owns, and would silently drop a
 * fourth the day one is added. So {@link describe} is **total over every
 * kind** and its fallback still renders an escalation rather than skipping
 * the row: a row this build cannot label is an escalation a human has not
 * been told about, which is the one failure this module exists to prevent.
 *
 * **The round is derived, never stored.** `feature_events` carries no round
 * column, so an escalation's round is the highest-numbered round that had
 * already started when the event was recorded. That is correct for both
 * producers rather than a convenient approximation for one: the round loop
 * escalates while its own round is open (the close lands in the same
 * transaction, so `started_at <= at` holds), and the dispatcher escalates
 * between rounds, where the round a human cares about is the last one that
 * ran. Adding a column would give two writers of a fact one query already
 * answers (rule 8).
 */
import type { Kysely } from 'kysely';
import type { Database } from '@adl/db';
import { LIMIT_REASONS, type LimitReason } from '@adl/core/state';

/** One occasion on which this feature stopped for a human. */
export interface Escalation {
  /** `feature_events.seq` — the total order, and the only thing that never ties. */
  readonly seq: number;
  /** ISO-8601 instant the escalation was recorded. */
  readonly at: string;
  /** The round in flight when it happened — derived, see the module docblock. */
  readonly round: number;
  /** The state it escalated *from*, which says what ADL was doing at the time. */
  readonly fromState: string | null;
  /** A one-line gist for the `<summary>` of a fold. */
  readonly headline: string;
  /** The escalation in its own words, at full length — rendered into the body. */
  readonly reason: string;
}

/**
 * How a {@link LimitReason} reads to a human.
 *
 * `satisfies Record<LimitReason, string>` rather than a lookup with a
 * fallback: a fourth limit reason added to `@adl/core/state` fails the
 * **build** here rather than silently rendering its own wire value into a
 * public change request (rule 7).
 */
const LIMIT_REASON_TEXT = {
  round_limit: 'the round limit was reached',
  budget_limit: 'the per-feature budget was exhausted',
  budget_limit_midstage:
    'the per-feature budget was exhausted while a stage was running',
} satisfies Record<LimitReason, string>;

/**
 * Compile-time proof the map above covers `LIMIT_REASONS` — the frozen list's
 * half of rule 7's pairing. `satisfies` alone checks the type; this checks it
 * against the runtime list the rest of the codebase enumerates.
 */
type _EveryLimitReasonDescribed =
  Exclude<
    (typeof LIMIT_REASONS)[number],
    keyof typeof LIMIT_REASON_TEXT
  > extends never
    ? true
    : never;
const _everyLimitReasonDescribed: _EveryLimitReasonDescribed = true;
void _everyLimitReasonDescribed;

/** Collapse whitespace — a reason is inlined into one markdown line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * How many characters of a reason reach the `<summary>` line.
 *
 * `describeStalemate` and `describeProtectedPathViolation`
 * (`loop/round-runner.ts`) each already bound what they put in a reason, but a
 * reason is a plain string and nothing in the type stops a future producer —
 * or a `blocked` outcome quoting an agent verbatim — from writing a paragraph.
 * A `<summary>` is one line by construction; this is what keeps it one. The
 * full reason is still rendered in the body below it.
 */
const HEADLINE_REASON_CHARS = 120;

function clip(text: string): string {
  const gist = oneLine(text);
  return gist.length > HEADLINE_REASON_CHARS
    ? `${gist.slice(0, HEADLINE_REASON_CHARS - 1)}…`
    : gist;
}

/**
 * What one `escalated` audit row says, in a human's words.
 *
 * Total over every event kind by construction — see the module docblock for
 * why that matters more here than a tidy exhaustive switch would.
 */
function describe(eventJson: string): { headline: string; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson) as unknown;
  } catch {
    return {
      headline: 'escalated',
      reason:
        'ADL stopped and asked for a human. The audit row recording why could not be read by this build.',
    };
  }
  const payload =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { t?: unknown; reason?: unknown; findingCount?: unknown })
      : {};
  const kind = typeof payload.t === 'string' ? payload.t : 'unknown';

  if (kind === 'limit_exceeded') {
    const reason =
      typeof payload.reason === 'string' && payload.reason in LIMIT_REASON_TEXT
        ? LIMIT_REASON_TEXT[payload.reason as LimitReason]
        : // A limit reason this build does not know is still a limit a human
          // has to see. Naming the raw value beats dropping the row.
          `a limit was reached${typeof payload.reason === 'string' ? ` (\`${oneLine(payload.reason)}\`)` : ''}`;
    return { headline: `limit reached — ${clip(reason)}`, reason };
  }

  if (kind === 'send_back') {
    // LOOP-03's ceiling (M06 step 6.2). `transition()` diverts the send-back
    // to `escalated` instead of handing out the round, so the event on the row
    // is the send-back itself — the limit is implied by where it landed, and
    // is stated here rather than left for a reader to infer.
    const count =
      typeof payload.findingCount === 'number' ? payload.findingCount : 0;
    const reason =
      'the round limit was reached — a gate sent the work back with ' +
      `${String(count)} finding${count === 1 ? '' : 's'} and no round remained to fix them in`;
    return { headline: `limit reached — ${clip(reason)}`, reason };
  }

  if (typeof payload.reason === 'string' && payload.reason.trim() !== '') {
    const reason = oneLine(payload.reason);
    return { headline: `escalated — ${clip(reason)}`, reason };
  }

  return {
    headline: `escalated — \`${clip(kind)}\``,
    reason: `ADL stopped and asked for a human (\`${oneLine(kind)}\`), without recording a reason.`,
  };
}

/**
 * Every escalation recorded for `featureId`, **newest first**.
 *
 * Newest first because that is the order the caller renders in and the order a
 * reader wants: the escalation blocking the feature right now belongs at the
 * top. `seq` is the sort key rather than `at` — a transaction applying several
 * events shares one instant across them, and `seq` is `transition()`'s own
 * total order.
 */
export async function readEscalations(
  db: Kysely<Database>,
  featureId: string,
): Promise<readonly Escalation[]> {
  const rows = await db
    .selectFrom('feature_events')
    .select(['seq', 'at', 'from_state as fromState', 'event_json as eventJson'])
    .where('feature_id', '=', featureId)
    .where('to_state', '=', 'escalated')
    .orderBy('seq', 'desc')
    .execute();
  if (rows.length === 0) return [];

  // Every round's start, oldest first — the windows the events are placed
  // into. Read once for the whole set: a feature has a handful of rounds and
  // this is a publish rather than a hot path, but a query per escalation would
  // still be a query per escalation.
  const rounds = await db
    .selectFrom('rounds')
    .select(['number', 'started_at as startedAt'])
    .where('feature_id', '=', featureId)
    .orderBy('started_at')
    .execute();

  return rows.map((row): Escalation => {
    // The last round that had already started. `0` when a feature escalated
    // before any round opened at all, which reads honestly as "nothing ran"
    // rather than claiming round 1 did.
    const round = rounds.reduce(
      (latest, candidate) =>
        candidate.startedAt <= row.at ? candidate.number : latest,
      0,
    );
    const { headline, reason } = describe(row.eventJson);
    return {
      seq: row.seq,
      at: row.at,
      round,
      fromState: row.fromState,
      headline,
      reason,
    };
  });
}
