import type { DaemonClient, StageLogEvent } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl logs [-f|--follow] [--offset <bytes>] <stage-attempt-id>` — a
 * resumable consumer of the manager's `GET /stages/:id/logs?offset=N&follow=1`
 * SSE route (`04-08`).
 *
 * As of `04-08` the manager's own route does the polling: with `--follow`,
 * the connection stays open and the manager pushes `records`/`idle`/
 * `pending` events until it emits `ended` and closes the response itself.
 * This command's job is therefore narrower than the `04-06` tracer's
 * version was — it no longer re-polls a history-only route on its own
 * interval. It reconnects only when the underlying connection actually
 * drops, resuming from the offset it last **wrote**, not merely received
 * (see `consumeOneConnection`'s docblock).
 */

export interface LogsCommandOptions {
  readonly stageAttemptId: string;
  readonly follow: boolean;
  /**
   * The raw `--offset` CLI value, if given. Validated here — before any
   * request is made — rather than by the caller, so one call site owns "a
   * malformed offset is rejected up front" for both interactive and
   * programmatic callers.
   */
  readonly offset?: string;
}

export interface LogsCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  /** Injected so a test can drive the reconnect delay without a real wait. Defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Overrides {@link MAX_CONSECUTIVE_RECONNECT_FAILURES} for this call — a test seam. */
  readonly maxConsecutiveReconnectFailures?: number;
}

/** The delay before a reconnect attempt after a dropped connection. */
const RECONNECT_DELAY_MS = 500;

/**
 * How many consecutive reconnect attempts that deliver NOTHING at all
 * `--follow` tolerates before it gives up and reports why, rather than
 * looping forever against a daemon that is gone. A reconnect that delivers
 * at least one event before dropping again resets this counter — the bound
 * exists for "the daemon is unreachable", not for "the connection drops
 * occasionally but keeps recovering".
 */
export const MAX_CONSECUTIVE_RECONNECT_FAILURES = 5;

/** Thrown by {@link logsCommand} for a `--offset` value that is not a non-negative integer. Handled by `index.ts`'s `runVerb`, matching every other CLI usage error. */
export class InvalidLogsOffsetError extends Error {
  override readonly name = 'InvalidLogsOffsetError';

  constructor(raw: string) {
    super(
      `--offset must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
}

function parseOffsetOption(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidLogsOffsetError(raw);
  }
  return Number(raw);
}

interface RecordsPayload {
  readonly records: readonly unknown[];
  readonly nextOffset: number;
}

function isRecordsPayload(value: unknown): value is RecordsPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { records: unknown }).records) &&
    typeof (value as { nextOffset: unknown }).nextOffset === 'number'
  );
}

interface FollowState {
  /** What THIS client has actually written to `out` so far — the offset the next reconnect resumes from. */
  writtenOffset: number;
}

/**
 * Consume one connection's worth of events, writing records as they arrive.
 *
 * `state.writtenOffset` advances only **after** a batch of records has been
 * written, never on receipt — a client that advanced its tracked offset on
 * receipt and then died before writing has silently dropped output on its
 * next reconnect, invisibly, because the offsets would still line up.
 *
 * `onEvent` fires for every event observed, INCLUDING one observed just
 * before the underlying stream throws (a dropped connection) — it is the
 * caller's only way to learn "this connection made progress" when the
 * function itself never returns normally. Returning a `sawAnyEvent` boolean
 * in a result object would not work for that case: a thrown `for await`
 * never reaches this function's own `return`, so any signal has to escape
 * through a side channel the caller already holds a reference to.
 */
async function consumeOneConnection(
  stream: AsyncIterable<StageLogEvent>,
  out: WriteSink,
  state: FollowState,
  onEvent: () => void,
): Promise<'ended' | 'dropped'> {
  for await (const event of stream) {
    onEvent();
    if (event.event === 'records') {
      const parsed: unknown = JSON.parse(event.data);
      if (!isRecordsPayload(parsed)) continue;
      for (const record of parsed.records) {
        out.write(`${JSON.stringify(record)}\n`);
      }
      // Write first, advance second.
      state.writtenOffset = parsed.nextOffset;
      continue;
    }
    if (event.event === 'idle' || event.event === 'pending') {
      // Ordinary follow states — keep waiting on the same connection.
      continue;
    }
    if (event.event === 'ended') {
      return 'ended';
    }
    // An unrecognised event name is ignored rather than treated as fatal —
    // forward compatibility with a future wire addition costs nothing here.
  }
  return 'dropped';
}

export async function logsCommand(
  options: LogsCommandOptions,
  deps: LogsCommandDeps,
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxFailures =
    deps.maxConsecutiveReconnectFailures ?? MAX_CONSECUTIVE_RECONNECT_FAILURES;

  // Validated before any request is made.
  const state: FollowState = {
    writtenOffset: parseOffsetOption(options.offset),
  };

  let hasConnectedOnce = false;
  let consecutiveFailures = 0;

  for (;;) {
    let sawAnyEvent = false;
    try {
      const stream = deps.client.streamStageLogs(options.stageAttemptId, {
        offset: state.writtenOffset,
        follow: options.follow,
      });
      const outcome = await consumeOneConnection(stream, out, state, () => {
        // Fires as soon as the first byte of the first connection arrives
        // — even if THIS connection later throws mid-stream, so a
        // connection that delivered data and then dropped is never
        // mistaken for "the daemon was never reachable" (see the catch
        // block below).
        hasConnectedOnce = true;
        sawAnyEvent = true;
      });
      if (outcome === 'ended') return;
    } catch (error) {
      if (!hasConnectedOnce) {
        // The first attach never got a byte back — this is the
        // daemon-down case, reported by the caller's own shared message
        // (D-25), never a second message with the same meaning.
        throw error;
      }
    }

    if (!options.follow) return;

    if (sawAnyEvent) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures > maxFailures) {
        out.write(
          `adl logs: lost the connection ${String(consecutiveFailures)} times in a row while following ${options.stageAttemptId}; giving up.\n`,
        );
        return;
      }
    }

    await sleep(RECONNECT_DELAY_MS);
  }
}
