/**
 * `renderEscalationComment` — what a human reads on the change request when
 * ADL has stopped and is waiting for them (LOOP-08, M06 step 6.8).
 *
 * **Its own sticky comment, not a role's.** The developer's comment (5.11) is
 * a role's report: `role-rounds.ts` inner-joins `stage_attempts` on that
 * role's `stage_id`, so "a round in which this role did not run is absent".
 * That is right for a role and exactly wrong for an escalation — the
 * per-feature budget escalation runs no stage at all, and the round-ceiling
 * escalation belongs to the *gate* that sent back rather than to the developer
 * whose comment it would land in. An escalation is the feature's, not a
 * role's, so it gets the one key that is true for every source of it.
 *
 * **Rendered by `@adl/core/forge`'s `renderStickyComment`, not a second
 * renderer.** Everything that makes a sticky comment safe was already solved
 * once and is not worth solving differently here: the `<details>` fold, the
 * `escapeCollapsibleTags` treatment that stops an agent's prose closing the
 * fold early, oldest-first dropping with a stated omission notice, the
 * surrogate-safe final slice, and the guarantee that the result never exceeds
 * `maxLength`. An escalation maps onto its `StickyRound` shape without
 * distortion — each escalation happened *at* a round, which is the ordinal a
 * `<summary>` wants.
 *
 * ## The two halves LOOP-08 asks for
 *
 * "…with full transcript and the disagreement, where they will see it." The
 * disagreement is the escalation's own `reason`, which every producer already
 * writes (`round-runner.ts`'s `describeStalemate`, `planRoundStep`'s
 * `blocked`/`dispute` text, the limit that fired). The transcript is the
 * problem: it is an NDJSON file of every `tool_call`, `tool_result` and
 * `thinking` delta a run produced — megabytes, against a comment budget of
 * 60,000 characters. "Full transcript" and FORGE-06's "the PR stays readable"
 * cannot both be literally true, and the maintainer's call (2026-09-02) is a
 * **bounded tail plus a pointer**: the last {@link MAX_TRANSCRIPT_EVENTS}
 * events inline, so a reviewer sees what the agent was doing when it stopped
 * without leaving the pull request, and the exact `adl logs` invocation for
 * the whole thing. The excerpt is deliberately a small share of the budget —
 * an escalation history that got dropped to make room for one run's tool calls
 * would be the wrong trade.
 */
import {
  renderStickyComment,
  DEFAULT_COMMENT_BODY_MAX_LENGTH,
  type StickyRound,
} from '@adl/core/forge';
import type { AgentEvent, TranscriptRecord } from '@adl/core/stage';
import type { Escalation } from './escalation-history.js';

/**
 * The `upsertComment` key. Stable forever once a comment carrying it exists on
 * a real change request — a renamed key orphans every prior comment and starts
 * a second one beside it (`on-developer-committed.ts`'s own warning). It
 * deliberately does not collide with any role key: `'developer'` is 5.11's,
 * and M07/M08 take their own.
 */
export const ESCALATION_COMMENT_KEY = 'escalation';

/**
 * The heading. It carries the standing instruction rather than repeating it in
 * every fold — `renderStickyComment` renders exactly one heading and one
 * expanded round, so this is the line that is always visible.
 */
export const ESCALATION_COMMENT_TITLE =
  '⛔ Escalated — ADL has stopped and is waiting for a person';

/** How many trailing transcript events reach the comment. See the module docblock. */
export const MAX_TRANSCRIPT_EVENTS = 40;

/**
 * The characters of one rendered event that survive.
 *
 * A single `tool_result` carrying a whole file's contents is ordinary agent
 * output, not an attack, and it would otherwise be the entire excerpt. Bounded
 * per line so the excerpt shows *forty things that happened* rather than one.
 */
const MAX_EVENT_LINE_CHARS = 200;

/**
 * How much of the transcript file to read from its end.
 *
 * Sized so the tail comfortably contains {@link MAX_TRANSCRIPT_EVENTS} records
 * of ordinary size while staying a bounded read against a file that has no
 * bound at all. A window too small for forty records simply yields fewer,
 * which the excerpt states.
 */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/** Collapse every whitespace run — one event is one line, by construction. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  const line = oneLine(text);
  return line.length > MAX_EVENT_LINE_CHARS
    ? `${line.slice(0, MAX_EVENT_LINE_CHARS - 1)}…`
    : line;
}

/** A tool's input or result, as one short line. `undefined` stays empty rather than printing "undefined". */
function inlineJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return oneLine(JSON.stringify(value) ?? '');
  } catch {
    // A circular or unserialisable payload is a translator bug, not a reason
    // to lose the other thirty-nine events.
    return '<unserialisable>';
  }
}

/** Width of the kind column, so a reader scans the excerpt down rather than across. */
const KIND_COLUMN = 12;

/**
 * One transcript event, split into the column that lines up and the detail
 * that gets clipped.
 *
 * **Split, rather than one clipped string**, because `clip` collapses
 * whitespace — that is its job, since an event is one line and agent text
 * contains newlines. Padding written into the string before clipping is
 * whitespace like any other and gets collapsed with it, which silently
 * destroys the alignment. Padding the label at the join site instead makes
 * that impossible rather than something to remember.
 *
 * Exhaustive over `AgentEvent`'s eight kinds with a `never` default, so a
 * ninth kind added to the union fails the **build** here rather than rendering
 * as a blank line in a pull request (rule 7).
 *
 * `TranscriptRecord.raw` is deliberately never read: its schema scopes it to
 * `packages/agent-claude-code/**` readers, and rendering a backend's own wire
 * format into a change request would put vendor-shaped output on the one
 * surface BACK-04 keeps neutral.
 */
function describeEvent(event: AgentEvent): {
  readonly kind: string;
  readonly detail: string;
} {
  switch (event.kind) {
    case 'started':
      return {
        kind: 'started',
        detail: event.model === undefined ? '' : `model=${event.model}`,
      };
    case 'text':
      return { kind: 'text', detail: clip(event.delta) };
    case 'thinking':
      return { kind: 'thinking', detail: clip(event.delta) };
    case 'tool_call':
      return {
        kind: 'tool_call',
        detail: clip(`${event.name} ${inlineJson(event.input)}`),
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        detail: clip(
          `${event.isError ? 'ERROR' : 'ok'} ${inlineJson(event.result)}`,
        ),
      };
    case 'usage':
      return {
        kind: 'usage',
        detail: [
          ['in', event.inputTokens],
          ['out', event.outputTokens],
          ['cache_read', event.cacheReadTokens],
          ['cache_write', event.cacheWriteTokens],
        ]
          // A null count is "the backend did not report this" (D-31), which is
          // not the same fact as zero — so it is omitted, never printed as 0.
          .filter(([, count]) => count !== null)
          .map(([label, count]) => `${String(label)}=${String(count)}`)
          .join(' '),
      };
    case 'result':
      return {
        kind: 'result',
        detail: clip(
          `${event.outcome} in ${String(Math.round(event.durationMs))}ms` +
            (event.costUsd === undefined
              ? ''
              : ` $${event.costUsd.toFixed(4)}`),
        ),
      };
    case 'error':
      return {
        kind: 'error',
        detail: clip(`${event.errorKind}: ${event.detail}`),
      };
    default: {
      const unhandled: never = event;
      void unhandled;
      return { kind: 'unknown', detail: '' };
    }
  }
}

/**
 * A code fence long enough that nothing in `content` can close it early.
 *
 * The excerpt is agent output inside a fenced block, and a `tool_result`
 * carrying a markdown file contains ``` as ordinary data. CommonMark closes a
 * fence only on a run of backticks at least as long as the opening one, so
 * measuring the longest run and opening one longer is the fix — the same
 * "neutralise what can break the container" reasoning `escapeCollapsibleTags`
 * applies to `<details>`, one layer in.
 *
 * This matters twice over: `renderStickyComment` escapes `<details>` outside
 * code spans only, and it decides what a code span *is* by parsing the
 * markdown. A fence broken by its own content would therefore also un-protect
 * the fold around it.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface TranscriptExcerpt {
  /** The tail of the transcript, oldest first. Empty when the attempt wrote nothing. */
  readonly records: readonly TranscriptRecord[];
  /** The `adl logs` argument for the whole transcript — a resolved `stage_attempts.id`. */
  readonly stageAttemptId: string;
  /** True when the transcript file did not exist at all, which is a different fact from "it was empty". */
  readonly absent: boolean;
}

/**
 * The transcript half of the newest escalation's body.
 *
 * Always says something. "The agent wrote no transcript" and "the agent wrote
 * one and here is the end of it" are both answers a reviewer can act on; a
 * silent omission is the one that reads as a bug in ADL rather than as a fact
 * about the run.
 */
function renderExcerpt(excerpt: TranscriptExcerpt): string {
  const pointer = `Full transcript: \`adl logs ${excerpt.stageAttemptId}\``;

  if (excerpt.absent) {
    return `_No transcript was written for the stage that stopped._\n\n${pointer}`;
  }
  const shown = excerpt.records.slice(-MAX_TRANSCRIPT_EVENTS);
  if (shown.length === 0) {
    return `_The transcript for the stage that stopped is empty._\n\n${pointer}`;
  }

  const body = shown
    .map((record) => {
      const { kind, detail } = describeEvent(record.event);
      return `${String(record.seq).padStart(4)} ${kind.padEnd(KIND_COLUMN)} ${detail}`.trimEnd();
    })
    .join('\n');
  const fence = fenceFor(body);
  const heading =
    shown.length < MAX_TRANSCRIPT_EVENTS
      ? `**Transcript — ${String(shown.length)} event${shown.length === 1 ? '' : 's'}:**`
      : `**Transcript — the last ${String(shown.length)} events:**`;

  // **A fenced block, not a nested `<details>` fold** — a constraint rather
  // than a preference. `renderStickyComment` runs `escapeCollapsibleTags` over
  // every body it is given, which turns a `<details>` written here into a
  // literal `&lt;details>`. That behaviour is correct and worth keeping: round
  // bodies are agent-authored, and a stray tag in one must not close the fold
  // the whole comment is built from. So this renders *inside* the fold rather
  // than adding one. (Found the way this codebase prefers — the first draft
  // used a nested fold and this module's own test showed the escaped tag.)
  //
  // Nothing is lost by it. The excerpt is bounded to
  // {@link MAX_TRANSCRIPT_EVENTS} lines and appears only on the newest
  // escalation, which is the one a reviewer opened the pull request to read;
  // every earlier escalation is already folded by `renderStickyComment` itself.
  return [heading, '', `${fence}text`, body, fence, '', pointer].join('\n');
}

export interface EscalationCommentInput {
  /** Every escalation this feature has had, newest first — `readEscalations`' own order. */
  readonly escalations: readonly Escalation[];
  /** The transcript of the stage that was running when the newest escalation happened. */
  readonly excerpt?: TranscriptExcerpt;
  /** The feature id, so the comment can name the exact command that un-blocks it. */
  readonly featureId: string;
  /** Defaults to `DEFAULT_COMMENT_BODY_MAX_LENGTH`. */
  readonly maxLength?: number;
}

/**
 * One escalation's body: what happened, then — for the newest only — what the
 * agent was doing when it happened and what un-blocks it.
 *
 * **The excerpt is attached to the newest escalation alone**, and that is a
 * deliberate asymmetry rather than an oversight. A transcript is a file on the
 * daemon's disk, not a column: re-reading every historical escalation's
 * transcript on every republish would be an unbounded read for content the
 * comment budget could never hold anyway. The durable half — the reason — *is*
 * a column, and is therefore re-derived in full for every escalation, every
 * time, exactly as `role-rounds.ts`'s docblock requires.
 *
 * **`isNewest` decides that, not `excerpt !== undefined`.** The two look
 * interchangeable and are not: an escalation whose stage attempt never opened
 * — the dispatcher's budget escalation on a feature whose rounds all closed —
 * has no attempt to read a transcript from, and keying on the excerpt would
 * silently drop the `adl resume` line with it. That line is the single most
 * actionable thing in the comment; it belongs to the escalation being
 * displayed, not to whether a file happened to exist. (Found the way this
 * codebase prefers — the dispatcher's own test showed the missing line.)
 */
function bodyFor(
  escalation: Escalation,
  featureId: string,
  isNewest: boolean,
  excerpt: TranscriptExcerpt | undefined,
): string {
  const lines = [
    escalation.reason,
    '',
    `Recorded at \`${escalation.at}\`${escalation.fromState === null ? '' : `, while the feature was \`${escalation.fromState}\``}.`,
  ];
  if (!isNewest) return lines.join('\n');

  if (excerpt !== undefined) lines.push('', renderExcerpt(excerpt));
  lines.push(
    '',
    'Nothing here is merged and nothing is ready for review. Once the cause is ' +
      `addressed, \`adl resume ${featureId}\` returns this feature to the queue.`,
  );
  return lines.join('\n');
}

/**
 * The whole comment, or `undefined` when this feature has never escalated —
 * which is not an empty comment but *no* comment, the same distinction
 * `publishStickyComment` already draws for a role that has not run.
 */
export function renderEscalationComment(
  input: EscalationCommentInput,
): string | undefined {
  if (input.escalations.length === 0) return undefined;

  const rounds: StickyRound[] = input.escalations.map(
    (escalation, index): StickyRound => ({
      number: escalation.round,
      headline: escalation.headline,
      body: bodyFor(
        escalation,
        input.featureId,
        // `readEscalations` returns newest-first and rounds only ever
        // increase, so index 0 is also the highest `number` —
        // `renderStickyComment` sorts by that and expands the same one.
        index === 0,
        index === 0 ? input.excerpt : undefined,
      ),
    }),
  );

  return renderStickyComment({
    title: ESCALATION_COMMENT_TITLE,
    rounds,
    maxLength: input.maxLength ?? DEFAULT_COMMENT_BODY_MAX_LENGTH,
  });
}
