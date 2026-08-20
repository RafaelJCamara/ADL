import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '@adl/db';
import { findAttempt, isAttemptEnded } from '../../bookkeeping/attempt.js';
import { readTranscriptFrom } from '../../store/ndjson-log-store.js';
import { transcriptPathFor } from '../../store/transcript-path.js';

/**
 * `GET /stages/:id/logs?offset=N&follow=1` — serves one stage attempt's
 * transcript over server-sent events, from a byte offset, and — when
 * `follow` is set — keeps the connection open and pushes whatever new
 * records appear until the attempt itself ends.
 *
 * The untrusted `:id` path parameter is resolved through `findAttempt`
 * **first**, before any filesystem path is built (T-4-15/T-4-07) — never a
 * path assembled from the parameter itself. An id that does not resolve is
 * a 404 with no filesystem read attempted.
 *
 * **Poll, don't only watch.** `04-RESEARCH.md`'s Assumption A2 records that
 * `fs.watch` behaviour differs enough across platforms that a missed
 * notification is plausible, and the failure it produces — a silently
 * stalled stream — is indistinguishable from a slow agent and therefore
 * worse than either losing or duplicating data. The loop below polls the
 * store at a named interval ({@link TRANSCRIPT_POLL_INTERVAL_MS}) instead of
 * relying on a filesystem watcher; polling is what makes progress
 * guaranteed. A watcher could be layered on top as a latency accelerator,
 * never as the sole delivery mechanism.
 *
 * **Four wire states, not an empty payload.** `readTranscriptFrom`'s three
 * outcomes (`read`/`absent`/`past-end`) map one-to-one onto three of the
 * event names in {@link LOG_STREAM_EVENTS}; the fourth, `ended`, is this
 * route's own addition, derived from the attempt's own recorded end
 * (`isAttemptEnded`) rather than from the file having stopped growing — a
 * quiet agent and a finished one look identical on disk (T-4-33, this
 * plan's prohibition P4). A reader that cannot tell the two apart would
 * treat a partial transcript as the agent's whole reasoning.
 *
 * **No curation.** Every record delivered here is the full `AgentEvent`
 * detail D-07 requires — no level filter, no kind filter, no default that
 * hides thinking deltas.
 */

export interface LogsRouteDeps {
  readonly db: Kysely<Database>;
  /** The directory transcripts live under — `logsRootFor(dbFilePath)`, computed once by `daemon.ts`. */
  readonly logsRoot: string;
  /**
   * Overrides {@link TRANSCRIPT_POLL_INTERVAL_MS} for this route instance —
   * a test seam so a follow-loop test does not have to wait a full
   * production interval to observe a poll. Production never sets this;
   * `daemon.ts` omits it and the named constant applies.
   */
  readonly pollIntervalMs?: number;
}

/**
 * The follow loop's named cadence, in milliseconds — exported rather than
 * buried as an inline number, per this plan's own action text: a poll
 * interval is a documented contract a reader can reason about, not an
 * incidental implementation detail.
 */
export const TRANSCRIPT_POLL_INTERVAL_MS = 250;

/**
 * The four wire event names a follower can branch on deterministically,
 * rather than inferring state from an empty payload. `records` always
 * carries the offset to resume from; `ended` is always the last event on a
 * follow stream that reaches it.
 */
export const LOG_STREAM_EVENTS = {
  /** Whole records were read from the requested offset. Payload: `{ records, nextOffset }`. */
  records: 'records',
  /** The requested offset is at or beyond the file's current length — nothing new right now. Payload: `{ offset }`. */
  idle: 'idle',
  /** The transcript file does not exist yet — ordinary for a follower attaching before the first event. Payload: `{}`. */
  pending: 'pending',
  /** The attempt has reached a terminal state; no further records will ever arrive. Payload: `{ offset }`. */
  ended: 'ended',
} as const;

export type LogStreamEventName =
  (typeof LOG_STREAM_EVENTS)[keyof typeof LOG_STREAM_EVENTS];

/** `true` only for a string that is exactly a non-negative integer — no leading `+`, no float, no whitespace-only input parsing as 0. */
function parseNonNegativeInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** `follow=1` or `follow=true` opts in; anything else (including absence) is history-only. */
function parseFollowFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

export function registerLogsRoute(app: Hono, deps: LogsRouteDeps): void {
  const pollIntervalMs = deps.pollIntervalMs ?? TRANSCRIPT_POLL_INTERVAL_MS;

  app.get('/stages/:id/logs', async (c) => {
    const stageAttemptId = c.req.param('id');
    // Resolved through the database FIRST — no filesystem read is attempted
    // for an id that does not resolve.
    const address = await findAttempt(deps.db, stageAttemptId);
    if (address === undefined) {
      return c.json({ error: 'not found' }, 404);
    }

    const offsetParam = c.req.query('offset');
    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = parseNonNegativeInt(offsetParam);
      if (parsed === undefined) {
        return c.json({ error: 'offset must be a non-negative integer' }, 400);
      }
      offset = parsed;
    }
    const follow = parseFollowFlag(c.req.query('follow'));

    const path = transcriptPathFor(deps.logsRoot, address);

    return streamSSE(c, async (stream) => {
      let cursor = offset;
      let stopped = false;
      // Set only while a poll delay is pending — the abort handler clears
      // the real timer through this closure and unblocks the loop
      // immediately, so a disconnected follower never leaves a timer
      // scheduled on the daemon (T-4-31).
      let cancelSleep: (() => void) | undefined;

      stream.onAbort(() => {
        stopped = true;
        cancelSleep?.();
      });

      function sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            cancelSleep = undefined;
            resolve();
          }, ms);
          cancelSleep = () => {
            clearTimeout(timer);
            cancelSleep = undefined;
            resolve();
          };
        });
      }

      /** One read-and-emit cycle. Advances `cursor` only on a `records` outcome. */
      async function emitOnce(): Promise<void> {
        const result = await readTranscriptFrom(path, cursor);
        if (result.outcome === 'read') {
          cursor = result.nextOffset;
          await stream.writeSSE({
            event: LOG_STREAM_EVENTS.records,
            data: JSON.stringify({
              records: result.records,
              nextOffset: result.nextOffset,
            }),
          });
          return;
        }
        if (result.outcome === 'past-end') {
          await stream.writeSSE({
            event: LOG_STREAM_EVENTS.idle,
            data: JSON.stringify({ offset: result.length }),
          });
          return;
        }
        // absent — the transcript does not exist yet.
        await stream.writeSSE({
          event: LOG_STREAM_EVENTS.pending,
          data: JSON.stringify({}),
        });
      }

      if (!follow) {
        // History only: one read from `offset`, then the response ends. It
        // never hangs waiting for more.
        await emitOnce();
        return;
      }

      while (!stopped) {
        await emitOnce();
        if (stopped) return;

        // Termination is read from the attempt's own recorded end, never
        // inferred from the file having stopped growing (T-4-33, P4).
        const ended = await isAttemptEnded(deps.db, stageAttemptId);
        if (ended) {
          // One more read catches anything written between the poll above
          // and the attempt's end becoming visible, so `ended` always
          // follows every record this attempt will ever produce.
          await emitOnce();
          if (stopped) return;
          await stream.writeSSE({
            event: LOG_STREAM_EVENTS.ended,
            data: JSON.stringify({ offset: cursor }),
          });
          return;
        }

        await sleep(pollIntervalMs);
      }
    });
  });
}
