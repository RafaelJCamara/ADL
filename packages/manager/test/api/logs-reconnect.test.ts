import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateToLatest, nowIso } from '@adl/db';
import { ulid } from 'ulid';
import { createApi } from '../../src/api/app.js';
import { closeAttempt, openAttempt } from '../../src/bookkeeping/attempt.js';
import {
  openTranscriptWriter,
  readTranscriptFrom,
} from '../../src/store/ndjson-log-store.js';
import { transcriptPathFor } from '../../src/store/transcript-path.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * `04-08` — the follow loop, its four wire states, and the kill-and-reattach
 * proof OBS-02 itself names.
 *
 * The first `describe` exercises the route directly (`createApi` mounted on
 * an ephemeral port, a real `TranscriptWriter`, `pollIntervalMs` overridden
 * to a few milliseconds so a follow test never waits a production-length
 * interval) — Task 1's own acceptance criteria. The second proves the same
 * claim against a real growing file with two adversarial byte-offset cases
 * (a partial in-flight write, and a client reattaching behind its own
 * actual position) that make "no loss, no duplication" a checked property
 * rather than an assumption — Task 3's own acceptance criteria.
 */

const API_TOKEN = `test-token-${ulid()}`;
const FAST_POLL_MS = 15;

async function withTempLogsRoot<T>(
  fn: (logsRoot: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-logs-reconnect-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Seeded {
  readonly featureId: string;
  readonly path: string;
  readonly stageAttemptId: string;
}

/** One feature row, one round, one running stage attempt — the minimum a follow request can resolve against. */
async function seedRunningAttempt(
  db: Parameters<typeof openAttempt>[0]['db'],
  logsRoot: string,
): Promise<Seeded> {
  const featureId = ulid();
  const repoId = ulid();
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://example.invalid/repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'leased',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const attempt = await openAttempt(
    { db },
    { featureId, stageId: 'develop', stageIndex: 0 },
  );
  const address = {
    featureId,
    roundId: attempt.roundId,
    stageId: attempt.stageId,
    stageIndex: attempt.stageIndex,
    attempt: attempt.attempt,
  };
  const path = transcriptPathFor(logsRoot, address);

  return { featureId, path, stageAttemptId: attempt.stageAttemptId };
}

function record(seq: number) {
  return {
    seq,
    at: nowIso(),
    event: {
      kind: 'text' as const,
      messageId: `m${seq}`,
      delta: `line ${seq}`,
    },
  };
}

interface RecordsPayload {
  readonly records: readonly { seq: number }[];
  readonly nextOffset: number;
}

function recordSeqs(events: readonly ParsedSseEvent[]): number[] {
  return events
    .filter((e) => e.event === 'records')
    .flatMap((e) => (JSON.parse(e.data) as RecordsPayload).records)
    .map((r) => r.seq);
}

interface ParsedSseEvent {
  readonly event: string;
  readonly data: string;
}

interface SseCursor {
  /** Every event parsed so far, in arrival order — grows in place. */
  readonly events: ParsedSseEvent[];
  /** Reads until `predicate(this.events)` is true, or the stream ends, or `timeoutMs` elapses. */
  waitUntil(
    predicate: (events: readonly ParsedSseEvent[]) => boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<void>;
  /** Releases the underlying reader lock — call once no further reads are needed. */
  release(): void;
}

/**
 * A minimal, PERSISTENT SSE frame reader for one `Response` — sufficient for
 * this suite's single-line JSON payloads. Persistent, rather than
 * re-acquiring a fresh reader per wait, because a fresh reader per call
 * would discard any bytes already decoded into a call-local buffer that had
 * not yet formed a complete `\n\n`-terminated frame at the moment a
 * predicate became true — exactly the kind of silent loss this test suite
 * exists to rule out in the route under test, so the test harness itself
 * must not reintroduce it.
 */
function openSseCursor(response: Response): SseCursor {
  if (response.body === null) {
    throw new Error('openSseCursor: response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const events: ParsedSseEvent[] = [];

  function drain(): void {
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const eventMatch = /^event: (.+)$/m.exec(block);
      const dataMatch = /^data: (.+)$/m.exec(block);
      if (eventMatch && dataMatch) {
        events.push({ event: eventMatch[1]!, data: dataMatch[1]! });
      }
    }
  }

  return {
    events,
    async waitUntil(predicate, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (predicate(events)) return;
        if (ended) {
          throw new Error(
            `openSseCursor: stream ended before the predicate was satisfied (saw ${events.length} events: ${events.map((e) => e.event).join(',')})`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `openSseCursor: predicate not satisfied within ${timeoutMs}ms (saw ${events.length} events: ${events.map((e) => e.event).join(',')})`,
          );
        }
        const { done, value } = await reader.read();
        if (value !== undefined) {
          buffer += decoder.decode(value, { stream: true });
          drain();
        }
        if (done) ended = true;
      }
    },
    release() {
      try {
        reader.releaseLock();
      } catch {
        // Already released or the stream already errored on abort — fine,
        // this is best-effort cleanup, not an assertion.
      }
    },
  };
}

describe('GET /stages/:id/logs — the follow loop and its four wire states', () => {
  it('without follow, serves everything from the offset and ends rather than hanging', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);
        await writer.append(record(0));
        await writer.close();

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          expect(response.status).toBe(200);
          // response.text() only resolves once the body ends — proving this
          // request is not left open waiting for more.
          const text = await response.text();
          expect(text).toContain('event: records');
        });
      });
    });
  }, 10_000);

  it('with follow set, a record appended after the request began arrives on the open stream', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const controller = new AbortController();
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
            {
              headers: { Authorization: `Bearer ${API_TOKEN}` },
              signal: controller.signal,
            },
          );
          expect(response.status).toBe(200);
          const cursor = openSseCursor(response);
          try {
            // Give the follow loop at least one poll cycle at "nothing yet"
            // before the record exists.
            await delay(FAST_POLL_MS * 2);
            await writer.append(record(0));

            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );
            expect(recordSeqs(cursor.events)).toEqual([0]);
          } finally {
            // Always abort — an assertion failure above must not leave the
            // follow connection open, or `withEphemeralPort`'s own
            // `server.close()` teardown hangs waiting for it (Node's HTTP
            // server does not close while a connection is still open).
            controller.abort();
            cursor.release();
          }
          await writer.close();
        });
      });
    });
  }, 10_000);

  it('a follow request against a not-yet-created transcript stays open and delivers once the file appears', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const controller = new AbortController();
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
            {
              headers: { Authorization: `Bearer ${API_TOKEN}` },
              signal: controller.signal,
            },
          );
          const cursor = openSseCursor(response);
          let writer:
            Awaited<ReturnType<typeof openTranscriptWriter>> | undefined;
          try {
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'pending'),
            );

            writer = await openTranscriptWriter(seeded.path);
            await writer.append(record(0));

            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );
            expect(recordSeqs(cursor.events)).toEqual([0]);
          } finally {
            controller.abort();
            cursor.release();
          }
          await writer?.close();
        });
      });
    });
  }, 10_000);

  it('emits four distinguishable wire event names across the four states, and every records event carries the file length as its resume offset', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const controller = new AbortController();
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
            {
              headers: { Authorization: `Bearer ${API_TOKEN}` },
              signal: controller.signal,
            },
          );
          const cursor = openSseCursor(response);
          let writer:
            Awaited<ReturnType<typeof openTranscriptWriter>> | undefined;
          try {
            // pending: the file does not exist yet.
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'pending'),
            );

            writer = await openTranscriptWriter(seeded.path);
            await writer.append(record(0));

            // records: the first append.
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );
            const recordsEvent = cursor.events.find(
              (e) => e.event === 'records',
            )!;
            const recordsPayload = JSON.parse(
              recordsEvent.data,
            ) as RecordsPayload;
            const expectedOffset = await readTranscriptFrom(
              seeded.path,
              0,
            ).then((r) => (r.outcome === 'read' ? r.nextOffset : -1));
            expect(recordsPayload.nextOffset).toBe(expectedOffset);

            // idle: nothing new since the last records event.
            await cursor.waitUntil(
              (events) => events.filter((e) => e.event === 'idle').length > 0,
            );

            // ended: closing the attempt.
            await closeAttempt(
              { db },
              { stageAttemptId: seeded.stageAttemptId, status: 'verdict' },
            );
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'ended'),
            );

            const seenKinds = new Set(cursor.events.map((e) => e.event));
            expect(seenKinds).toEqual(
              new Set(['pending', 'records', 'idle', 'ended']),
            );
          } finally {
            controller.abort();
            cursor.release();
          }
          await writer?.close();
        });
      });
    });
  }, 10_000);

  it('when the attempt reaches a terminal state, emits ended after the final records and then closes the response', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );

          // A final record lands, then the attempt ends immediately after —
          // both must be observed before the response closes.
          await writer.append(record(0));
          await delay(FAST_POLL_MS * 2);
          await closeAttempt(
            { db },
            { stageAttemptId: seeded.stageAttemptId, status: 'verdict' },
          );

          // response.text() only resolves once the server ends the
          // response — proving it does close, not merely emit `ended`.
          const text = await response.text();
          const blocks = text
            .split('\n\n')
            .map((b) => b.trim())
            .filter(Boolean);
          const kinds = blocks.map((b) => /^event: (.+)$/m.exec(b)?.[1] ?? '');
          expect(kinds).toContain('records');
          expect(kinds).toContain('ended');
          expect(kinds.indexOf('ended')).toBe(kinds.length - 1);
          expect(kinds.indexOf('ended')).toBeGreaterThan(
            kinds.indexOf('records'),
          );

          await writer.close();
        });
      });
    });
  }, 10_000);

  it('rejects a negative, fractional, or non-numeric offset with 400 and reads no file', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          for (const bad of ['-1', '1.5', 'abc']) {
            const response = await fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?offset=${bad}`,
              { headers: { Authorization: `Bearer ${API_TOKEN}` } },
            );
            expect(response.status).toBe(400);
          }
          // No transcript file was ever created — a 400 for every case
          // above proves no read path was reached at all.
          const result = await readTranscriptFrom(seeded.path, 0);
          expect(result.outcome).toBe('absent');
        });
      });
    });
  }, 10_000);

  it('for an unresolvable stage attempt id responds 404 and reads no file', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/unknown-id/logs`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          expect(response.status).toBe(404);
        });
      });
    });
  });

  it('without a bearer token responds 401', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/any-id/logs`,
          );
          expect(response.status).toBe(401);
        });
      });
    });
  });

  it('aborting a follow request leaves no timer scheduled', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    try {
      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        await withTempLogsRoot(async (logsRoot) => {
          const seeded = await seedRunningAttempt(db, logsRoot);
          const writer = await openTranscriptWriter(seeded.path);
          await writer.append(record(0));

          const app = createApi({
            apiToken: API_TOKEN,
            schemaVersion: 1,
            listFeatureViews: async () => [],
            db,
            logsRoot,
            logsPollIntervalMs: FAST_POLL_MS,
          });

          await withEphemeralPort(app, async ({ port }) => {
            const controller = new AbortController();
            const response = await fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
              {
                headers: { Authorization: `Bearer ${API_TOKEN}` },
                signal: controller.signal,
              },
            );
            const cursor = openSseCursor(response);

            // Let the loop reach its poll-delay (idle) at least once, so a
            // real timer is pending when we abort.
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'idle'),
            );
            const callsBeforeAbort = clearTimeoutSpy.mock.calls.length;
            controller.abort();
            // Give the abort handler a beat to run.
            await delay(FAST_POLL_MS * 4);
            expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(
              callsBeforeAbort,
            );
            cursor.release();
          });

          await writer.close();
        });
      });
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  }, 10_000);

  it('two concurrent followers at different offsets each receive their own correct records', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);
        await writer.append(record(0));
        const offsetAfterFirst = writer.offset();
        await writer.append(record(1));
        await writer.close();

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const [fromStart, fromSecond] = await Promise.all([
            fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?offset=0`,
              { headers: { Authorization: `Bearer ${API_TOKEN}` } },
            ).then((r) => r.text()),
            fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?offset=${offsetAfterFirst}`,
              { headers: { Authorization: `Bearer ${API_TOKEN}` } },
            ).then((r) => r.text()),
          ]);

          expect(fromStart).toContain('"seq":0');
          expect(fromStart).toContain('"seq":1');
          expect(fromSecond).not.toContain('"seq":0');
          expect(fromSecond).toContain('"seq":1');
        });
      });
    });
  });
});

describe('the reconnect proof — kill and reattach against a real growing transcript', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('destroying the connection abruptly and reattaching at the consumed offset delivers every record exactly once, matching the file', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const firstController = new AbortController();
          const secondController = new AbortController();
          let firstCursor: SseCursor | undefined;
          let secondCursor: SseCursor | undefined;
          try {
            await writer.append(record(0));
            await writer.append(record(1));

            const firstResponse = await fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
              {
                headers: { Authorization: `Bearer ${API_TOKEN}` },
                signal: firstController.signal,
              },
            );
            firstCursor = openSseCursor(firstResponse);

            await firstCursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );
            const firstRecordsEvent = firstCursor.events.find(
              (e) => e.event === 'records',
            )!;
            const firstPayload = JSON.parse(
              firstRecordsEvent.data,
            ) as RecordsPayload;
            const lengthAtFirstRead = firstPayload.nextOffset;

            // Prove the transcript is demonstrably still growing while a
            // follower is attached, before the kill: two length reads taken
            // while attached, the second strictly greater. Waits for a
            // records event that actually carries record 2 — not merely a
            // second `records`-named event, which a housekeeping "nothing
            // new" read with an empty payload would also satisfy.
            await writer.append(record(2));
            await firstCursor.waitUntil((events) =>
              events.some(
                (e) =>
                  e.event === 'records' &&
                  (JSON.parse(e.data) as RecordsPayload).records.some(
                    (r) => r.seq === 2,
                  ),
              ),
            );
            const secondRecordsEvent = firstCursor.events.find(
              (e) =>
                e.event === 'records' &&
                (JSON.parse(e.data) as RecordsPayload).records.some(
                  (r) => r.seq === 2,
                ),
            )!;
            const secondPayload = JSON.parse(
              secondRecordsEvent.data,
            ) as RecordsPayload;
            expect(secondPayload.nextOffset).toBeGreaterThan(lengthAtFirstRead);

            const consumedOffset = secondPayload.nextOffset;

            // Destroy the connection abruptly — the server observes a
            // client that vanished, not one that said goodbye.
            firstController.abort();
            firstCursor.release();
            await delay(FAST_POLL_MS * 3);

            // One more record lands while no follower is attached.
            await writer.append(record(3));

            // Reattach with the offset the first connection had consumed.
            const secondResponse = await fetch(
              `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1&offset=${consumedOffset}`,
              {
                headers: { Authorization: `Bearer ${API_TOKEN}` },
                signal: secondController.signal,
              },
            );
            secondCursor = openSseCursor(secondResponse);
            await secondCursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );

            await closeAttempt(
              { db },
              { stageAttemptId: seeded.stageAttemptId, status: 'verdict' },
            );
            await secondCursor.waitUntil((events) =>
              events.some((e) => e.event === 'ended'),
            );

            // Ground truth: the transcript file's own records, read once,
            // fresh, from zero.
            const groundTruth = await readTranscriptFrom(seeded.path, 0);
            expect(groundTruth.outcome).toBe('read');
            const groundTruthSeqs =
              groundTruth.outcome === 'read'
                ? groundTruth.records.map((r) => (r as { seq: number }).seq)
                : [];

            const delivered = [
              ...recordSeqs(firstCursor.events),
              ...recordSeqs(secondCursor.events),
            ];
            expect(delivered).toEqual(groundTruthSeqs);
          } finally {
            firstController.abort();
            secondController.abort();
            firstCursor?.release();
            secondCursor?.release();
          }
          await writer.close();
        });
      });
    });
  }, 10_000);

  it('reconnecting with an offset behind the client’s actual position re-delivers the overlap rather than skipping it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);
        await writer.append(record(0));
        await writer.append(record(1));
        await writer.append(record(2));
        await writer.close();

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          // Reattaching from offset 0 even though a real client would have
          // already consumed further — a server that "knows better" and
          // skips ahead would be the worse failure (over-delivery on the
          // client's own stale offset is correct).
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?offset=0`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          const text = await response.text();
          expect(text).toContain('"seq":0');
          expect(text).toContain('"seq":1');
          expect(text).toContain('"seq":2');
        });
      });
    });
  });

  it('killing the connection while a record is partially written delivers the completing record exactly once after reconnect', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const seeded = await seedRunningAttempt(db, logsRoot);
        const writer = await openTranscriptWriter(seeded.path);
        await writer.append(record(0));

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
          logsPollIntervalMs: FAST_POLL_MS,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const controller = new AbortController();
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${seeded.stageAttemptId}/logs?follow=1`,
            {
              headers: { Authorization: `Bearer ${API_TOKEN}` },
              signal: controller.signal,
            },
          );
          const cursor = openSseCursor(response);
          try {
            await cursor.waitUntil((events) =>
              events.some((e) => e.event === 'records'),
            );

            // Flush a record's bytes WITHOUT its terminating newline — the
            // in-flight-write scenario a reader can land inside of.
            const partialLine = JSON.stringify(record(1));
            const partialHandle = await open(seeded.path, 'a');
            await partialHandle.appendFile(partialLine, 'utf8');
            await partialHandle.close();

            // The route must NOT deliver a partial line while it is
            // incomplete — several poll cycles pass with no seq:1 seen.
            // (`readTranscriptFrom` still reports the store's `read`
            // outcome each poll here, since the partial bytes make the
            // file longer than the last-consumed offset, but with an
            // EMPTY `records` array, never a record it cannot find a
            // full line for — so the wire event name alone is not what
            // distinguishes this case; the payload's content is.)
            await delay(FAST_POLL_MS * 4);
            expect(recordSeqs(cursor.events)).toEqual([0]);

            // Now complete the line.
            const completingHandle = await open(seeded.path, 'a');
            await completingHandle.appendFile('\n', 'utf8');
            await completingHandle.close();

            await cursor.waitUntil((events) =>
              events.some(
                (e) =>
                  e.event === 'records' &&
                  (JSON.parse(e.data) as RecordsPayload).records.some(
                    (r) => r.seq === 1,
                  ),
              ),
            );
            expect(recordSeqs(cursor.events)).toEqual([0, 1]);
          } finally {
            controller.abort();
            cursor.release();
          }
          await writer.close();
        });
      });
    });
  }, 10_000);
});
