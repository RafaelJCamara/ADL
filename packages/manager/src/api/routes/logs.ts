import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '@adl/db';
import { findAttempt } from '../../bookkeeping/attempt.js';
import { readTranscriptFrom } from '../../store/ndjson-log-store.js';
import { transcriptPathFor } from '../../store/transcript-path.js';

/**
 * `GET /stages/:id/logs?offset=N` — serves the transcript records already on
 * disk for one stage attempt, from a byte offset, over server-sent events.
 *
 * The untrusted `:id` path parameter is resolved through `findAttempt`
 * **first**, before any filesystem path is built (T-4-15/T-4-07) — never a
 * path assembled from the parameter itself. An id that does not resolve is a
 * 404 with no filesystem read attempted.
 *
 * This route serves HISTORY: one read from `offset`, streamed out, then the
 * response ends. It does not follow the file for new data as it is written —
 * the follow loop, the reconnect proof, and the absent-versus-past-end
 * distinction on the wire are a later plan's addition (this plan's own
 * `<action>` text names it explicitly). What this route already proves is
 * sufficient for the tracer: a client attaching while the run is still in
 * flight receives whatever complete records exist at that instant, which
 * is enough to observe "at least one event arrived before the stage result".
 */

export interface LogsRouteDeps {
  readonly db: Kysely<Database>;
  /** The directory transcripts live under — `logsRootFor(dbFilePath)`, computed once by `daemon.ts`. */
  readonly logsRoot: string;
}

/** `true` only for a string that is exactly a non-negative integer — no leading `+`, no float, no whitespace-only input parsing as 0. */
function parseNonNegativeInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function registerLogsRoute(app: Hono, deps: LogsRouteDeps): void {
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

    const path = transcriptPathFor(deps.logsRoot, address);

    return streamSSE(c, async (stream) => {
      const result = await readTranscriptFrom(path, offset);
      if (result.outcome === 'read') {
        for (const record of result.records) {
          await stream.writeSSE({
            event: 'record',
            data: JSON.stringify(record),
          });
        }
        await stream.writeSSE({
          event: 'offset',
          data: JSON.stringify({ nextOffset: result.nextOffset }),
        });
        return;
      }
      // `absent` (the file does not exist yet) and `past-end` (the offset is
      // at or beyond the current length) are both "no new data right now" —
      // an ordinary state for a reader attaching before the first event or
      // resuming from where it left off. Distinguishing the two ON THE WIRE
      // is `04-08`'s addition (see the module docblock); both resolve here
      // to the same offset event, echoing the caller's own offset back.
      await stream.writeSSE({
        event: 'offset',
        data: JSON.stringify({ nextOffset: offset }),
      });
    });
  });
}
