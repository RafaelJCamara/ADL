---
phase: 04-first-agent-backend-live-transcripts
plan: 08
subsystem: observability
tags: [sse, follow-loop, byte-offset, reconnect, hono-streaming, cli]

dependency-graph:
  requires:
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-06: GET /stages/:id/logs (history-only), openAttempt/closeAttempt/findAttempt, readTranscriptFrom/openTranscriptWriter/transcriptLength, adl logs -f (client-side polling)"
  provides:
    - "The follow loop on GET /stages/:id/logs?offset=N&follow=1: polls readTranscriptFrom at TRANSCRIPT_POLL_INTERVAL_MS, terminates on isAttemptEnded rather than file quiescence"
    - "LOG_STREAM_EVENTS: four wire event names (records/idle/pending/ended) a client branches on deterministically"
    - "isAttemptEnded(db, stageAttemptId) — the DB-backed termination check the follow loop and any future consumer share"
    - "DaemonClient.streamStageLogs(id, { offset, follow }) and adl logs -f — a resumable client that reconnects on a dropped connection with the offset it last WROTE"
  affects: [04-09-prompt-persistence-and-byte-identity, phase-05-loop-runner, phase-17-dashboard]

tech-stack:
  added: []
  patterns:
    - "Poll, never rely solely on fs.watch, for a growing file a client must never silently stall against (04-RESEARCH.md Assumption A2) — a named interval constant (TRANSCRIPT_POLL_INTERVAL_MS), overridable per app instance only for tests"
    - "Termination read from the row (isAttemptEnded / stage_attempts.ended_at), never inferred from the file going quiet — a quiet agent and a finished one are indistinguishable on disk"
    - "stream.onAbort() (hono's StreamingApi) is the abort-cleanup seam — a client-disconnect-triggered cancel() on the response ReadableStream, not a manually wired AbortSignal listener"
    - "CLI resume-offset tracking: advance the tracked offset only AFTER a batch is written to the sink, never on receipt — a client that advances on receipt and dies before writing silently drops output on its next reconnect"
    - "CLI reconnect-failure counting resets on any connection that delivers at least one event before dropping — the bound exists for 'daemon unreachable', not for 'the connection drops occasionally but keeps recovering'"

key-files:
  created:
    - packages/manager/test/api/logs-reconnect.test.ts
    - packages/cli/test/commands/logs.test.ts
  modified:
    - packages/manager/src/api/routes/logs.ts
    - packages/manager/src/api/app.ts
    - packages/manager/src/bookkeeping/attempt.ts
    - packages/manager/src/index.ts
    - packages/manager/src/store/ndjson-log-store.ts
    - packages/cli/src/commands/logs.ts
    - packages/cli/src/http-client.ts
    - packages/cli/src/index.ts
  deleted:
    - packages/manager/test/api/routes/logs.test.ts
    - packages/cli/test/logs.test.ts

decisions:
  - "Every records-delivered SSE event carries its own {records, nextOffset} payload rather than a separate offset event following a batch of individual record events — a client branches on the event's own payload, never has to correlate two consecutive SSE frames to know where to resume."
  - "Task 3's kill-and-reattach proof runs against createApi()+withEphemeralPort (the same production route/store code, over real HTTP, against a real on-disk transcript file) rather than a full startDaemon()+forked-worker+real-agent-CLI-double pipeline. The byte-precise adversarial cases (a record flushed without its terminating newline, a client reattaching behind its own actual position) need deterministic control over exactly when bytes land on disk — a real agent subprocess's output cadence cannot give that without becoming a flaky test. 04-06's tracer already proves the full daemon/worker/agent pipeline separately; this plan's own claim is about the follow loop and the store, which the lighter harness exercises unchanged. Recorded in .planning/WINDOWS.md (kind: deviation) for visibility at ship time."
  - "CLI reconnect-failure counting: a connection that delivers at least one event before dropping resets the consecutive-failure counter to zero, rather than every drop counting toward the bound unconditionally. The bound (MAX_CONSECUTIVE_RECONNECT_FAILURES) exists to stop a truly unreachable daemon; a connection that keeps recovering after brief drops would otherwise eventually exhaust the same bound even though the daemon is fine."

metrics:
  duration: "single session"
  completed: "2026-08-20"

status: complete

actuals:
  tokens: 21850
  tasks: 3
  commits: 2
---

# Phase 04 Plan 08: The Follow Loop and the Kill-and-Reattach Proof Summary

**`GET /stages/:id/logs` now polls a growing transcript at a named cadence and reports four wire states (records/idle/pending/ended) a client can branch on deterministically; `adl logs -f` is a resumable follower that reconnects on a dropped connection using the offset it actually wrote, proven end to end by a real HTTP server destroying and reattaching mid-stream against a real growing file.**

## What Was Built

### The manager's follow loop (`packages/manager/src/api/routes/logs.ts`)

`registerLogsRoute` now serves two contracts on the same `GET /stages/:id/logs` route, distinguished by `?follow=1`:

- **Without `follow`:** unchanged from `04-06` in spirit — one read from `offset`, one SSE event, the response ends. Never hangs.
- **With `follow`:** the route polls `readTranscriptFrom` at `TRANSCRIPT_POLL_INTERVAL_MS` (a named, exported constant — 250ms in production, overridable per `createApi()` instance only for tests via `logsPollIntervalMs`) instead of relying on `fs.watch`. `04-RESEARCH.md`'s Assumption A2 records that a filesystem watcher's platform inconsistencies could produce a silently stalled stream — worse than losing or duplicating data, because it looks exactly like an idle agent. The poll is what guarantees progress; nothing in this route watches the filesystem.

Four wire event names (`LOG_STREAM_EVENTS`: `records` / `idle` / `pending` / `ended`) map one-to-one onto `readTranscriptFrom`'s three outcomes (`read` / `past-end` / `absent`) plus a fourth the route itself derives: **termination is read from the attempt's own recorded end** (`isAttemptEnded`, a new query in `bookkeeping/attempt.ts`), never inferred from the file having stopped growing — a quiet agent and a finished one are indistinguishable on disk, and prohibition P4 in this plan's `must_haves` is exactly that a still-growing transcript must never be presented as complete. Every `records` event carries its own `{records, nextOffset}` payload — a client never has to correlate a separate "offset" event with the batch it followed.

An abort handler (`stream.onAbort()`, hono's `StreamingApi`) clears the pending poll timer and unblocks the loop the moment a follower disconnects — a follow route that leaked a timer per abandoned connection would degrade a long-running daemon rather than fail visibly (T-4-31). Proven directly: a test spies on `clearTimeout`, opens a follow connection, lets it reach a pending poll delay, aborts, and asserts `clearTimeout` fired.

`offset`/`follow` query parameters are validated per-route exactly as before (negative, fractional, or non-numeric `offset` is a 400 with no file read attempted) — this plan added no new validation surface, only the `follow` flag's parse.

### The kill-and-reattach proof (`packages/manager/test/api/logs-reconnect.test.ts`)

One file houses both this plan's unit-level route tests and the integration proof, since Task 3's own acceptance criteria describe extending the same file Task 1 creates. 13 tests, two `describe` blocks:

- **The follow loop and its four wire states** — history-only ends rather than hanging; a record appended after a follow request began arrives on the open stream; a follow request against a transcript that doesn't exist yet delivers once the file appears; all four event names are observed and every `records` event's `nextOffset` matches the file's actual length; `ended` follows the final records and the response then closes; offset validation (400, no read); 404/401 preserved from `04-06`; abort leaves no scheduled timer; two concurrent followers at different offsets each get their own correct records.
- **The reconnect proof** — destroying a connection abruptly (via `AbortController.abort()`, which cancels the response `ReadableStream` the way a real dropped TCP connection does) mid-growth and reattaching at the consumed offset delivers the concatenation of both connections' records, compared record-by-record against the transcript file's own contents (never a hard-coded count); reattaching with an offset *behind* the client's actual position re-delivers the overlap rather than skipping it (over-delivery on a client's own stale offset is correct — a server that "knows better" would be the worse failure); killing the connection while a record is flushed without its terminating newline delivers that record exactly once after the completing bytes land, never a partial line.

### `adl logs -f` — the resumable client (`packages/cli/src/commands/logs.ts`, `http-client.ts`)

`DaemonClient.streamStageLogs` now takes `{ offset, follow }` and speaks the manager's four-event vocabulary directly over one persistent follow connection — the CLI no longer re-polls a history-only route on its own interval (the manager does that now).

`logsCommand` tracks the resume offset as **what this client has actually written to its output sink**, not what it merely received: a batch of records is written first, and only then does the tracked offset advance. A client that advanced on receipt and then died before writing would silently drop output on its next reconnect, invisibly, because the offsets would still appear to line up. On a dropped connection, it reconnects with that tracked offset, bounded by `MAX_CONSECUTIVE_RECONNECT_FAILURES` (5) — but the counter resets to zero on any reconnect that delivers at least one event before dropping again, so a connection that keeps recovering from brief network blips is never mistaken for a genuinely unreachable daemon. Exhausting the bound writes a message naming the count and stops, rather than looping forever.

A daemon unreachable at the very first attach still propagates the existing `DaemonUnreachableError` untouched — reported by `runVerb`'s existing daemon-down message, never a second message with the same meaning. `--offset <bytes>` is validated (`InvalidLogsOffsetError`, wired into `runVerb`'s catch list alongside `ScopeUsageError`) before any request is made.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `hasConnectedOnce` was only set after a connection resolved successfully, never during a connection that later threw**
- **Found during:** Task 2, writing the reconnect-bound test.
- **Issue:** `logsCommand`'s first design set `hasConnectedOnce = true` only after `consumeOneConnection` *returned*. A connection that delivered real data and then dropped (threw mid-stream, the realistic "network blip" case) never reached that assignment, so the very next drop would incorrectly take the "daemon was never reachable" path and rethrow — even though the daemon had just proven reachable.
- **Fix:** `consumeOneConnection` takes an `onEvent` callback invoked on every event observed, including one observed immediately before the stream throws; the callback sets `hasConnectedOnce`/`sawAnyEvent` as a side channel the caller retains a reference to, since a thrown `for await` never reaches the function's own return.
- **Files:** `packages/cli/src/commands/logs.ts`. **Verification:** the "reconnects with the offset of the last written event" and "stops after the stated maximum" tests in `test/commands/logs.test.ts`.

**2. [Rule 1 — Bug] The "partial write" reconnect test's own wait condition was satisfied by empty-payload housekeeping events, not the completing record**
- **Found during:** Task 3, writing the partial-write adversarial test — it hung for the full test timeout rather than failing fast.
- **Issue:** `readTranscriptFrom` correctly reports `{outcome: 'read', records: [], nextOffset: unchanged}` while a record's bytes are present but its terminating newline has not yet arrived (confirmed directly against the store). The route therefore emits a `records` SSE event with an *empty* array during that window — a real and desired behavior. My first test predicate waited for "a second `records`-named event", which several empty-payload polls satisfied well before the completing write happened, so the test's own assertion of the delivered payload failed — and because that failure occurred *before* the test's cleanup lines (`controller.abort()`), the still-open follow connection kept `withEphemeralPort`'s `server.close()` teardown hanging for the rest of the test's timeout (Node's HTTP server does not close while a connection remains open).
- **Fix:** the wait predicate now checks the *payload* for the specific `seq` expected, not merely the event name's count; every follow-connection test wraps its assertions in `try/finally` so an assertion failure still aborts the connection and releases the reader, preventing the same class of hang anywhere else in the suite.
- **Files:** `packages/manager/test/api/logs-reconnect.test.ts`. **Verification:** the fixed test passes in ~5s; the whole file (13 tests) completes in ~5s total with no timeouts.

No deviation required a checkpoint (Rule 4) — both were bugs in this plan's own new code (the CLI's failure-tracking logic, and the test suite's own wait conditions and cleanup discipline), caught and fixed within the deviation rules' existing scope. The one deviation that changed a *design choice* rather than fixing a bug (Task 3's test harness, see `decisions` above) is documented there and in `.planning/WINDOWS.md`.

## Known Gaps

- **The kill-and-reattach integration test's cross-platform claim (Linux CI leg) is unverified in this session** — developed and run on Windows only. Nothing in the test uses a POSIX-only API (paths via `node:path`'s `join`, no shell invocation), so no specific risk is flagged, but the plan's own verification item ("The suite passes on both CI legs") rests on CI actually running it, not on anything demonstrated here.
- **Task 3's proof runs against `createApi()` directly, not a full `startDaemon()` + forked worker + real agent CLI double.** See the `decisions` entry above and the `.planning/WINDOWS.md` deviation entry for the reasoning; the production route/store code under test is identical either way.

## Self-Check: PASSED

- FOUND: `packages/manager/src/api/routes/logs.ts`
- FOUND: `packages/manager/src/api/app.ts`
- FOUND: `packages/manager/src/bookkeeping/attempt.ts`
- FOUND: `packages/manager/src/store/ndjson-log-store.ts`
- FOUND: `packages/manager/test/api/logs-reconnect.test.ts`
- FOUND: `packages/cli/src/commands/logs.ts`
- FOUND: `packages/cli/src/http-client.ts`
- FOUND: `packages/cli/test/commands/logs.test.ts`
- FOUND commit `c88fe71` in `git log --oneline`
- FOUND commit `477ca0e` in `git log --oneline`

## Verification

- `pnpm --filter @adl/manager test`: 218/218 passed (26 test files), including `logs-reconnect.test.ts` (13/13).
- `pnpm --filter @adl/cli test`: 33/33 passed (5 test files), including `test/commands/logs.test.ts` (11/11).
- `pnpm -r test` (whole workspace): all packages pass, exit code 0.
- `pnpm -r typecheck`: all packages pass with no errors.
- `pnpm lint`: 0 errors, 0 warnings.
- `pnpm format` (`prettier --check .`): all matched files use Prettier code style.

## Next Phase Readiness

- `LOG_STREAM_EVENTS`/`TRANSCRIPT_POLL_INTERVAL_MS`/`isAttemptEnded` are published from `@adl/manager`'s barrel — Phase 5's loop runner or Phase 17's dashboard can consume the same follow route without redefining its wire vocabulary.
- `04-09` (prompt persistence and byte-identity) has no dependency on this plan's changes beyond the unchanged `transcriptPathFor`/`readTranscriptFrom` contracts, which this plan did not alter.
- The `.planning/WINDOWS.md` deviation entry recorded here should be revisited if a future phase needs the full daemon/worker/agent pipeline exercised for this route specifically (e.g. a real cross-platform CI run against a real Claude Code CLI invocation).

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
