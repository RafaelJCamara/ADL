import type { DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl logs [-f|--follow] <stage-attempt-id>` — consumes the server-sent
 * event stream added in `04-01` (`eventsource-parser`, via
 * `DaemonClient.streamStageLogs`) and writes each transcript record to
 * stdout as it arrives.
 *
 * `GET /stages/:id/logs` (this plan's own route, `04-06`) serves history —
 * one read from an offset, then the response ends; it does not push new
 * data as it is written (`04-08`'s addition). `--follow` is therefore
 * implemented HERE, client-side, as short-interval polling: each poll reads
 * from the `nextOffset` the previous poll reported, so a record is never
 * printed twice and never dropped between polls. Without `--follow`, one
 * poll runs and the command exits — the same history-only contract the
 * route itself has.
 */

export interface LogsCommandOptions {
  readonly stageAttemptId: string;
  readonly follow: boolean;
}

export interface LogsCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  /** Injected so a test can drive the follow loop without a real delay. Defaults to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected stop signal for `--follow`'s otherwise-unbounded loop — a test seam; production leaves this unset and relies on the process being interrupted (Ctrl-C). */
  readonly shouldStop?: () => boolean;
}

const POLL_INTERVAL_MS = 500;

interface OffsetPayload {
  readonly nextOffset: number;
}

function isOffsetPayload(value: unknown): value is OffsetPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nextOffset' in value &&
    typeof (value as { nextOffset: unknown }).nextOffset === 'number'
  );
}

export async function logsCommand(
  options: LogsCommandOptions,
  deps: LogsCommandDeps,
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shouldStop = deps.shouldStop ?? (() => false);

  let offset = 0;
  for (;;) {
    for await (const event of deps.client.streamStageLogs(
      options.stageAttemptId,
      offset,
    )) {
      if (event.event === 'record') {
        out.write(`${event.data}\n`);
        continue;
      }
      if (event.event === 'offset') {
        const parsed: unknown = JSON.parse(event.data);
        if (isOffsetPayload(parsed)) offset = parsed.nextOffset;
      }
    }
    if (!options.follow || shouldStop()) return;
    await sleep(POLL_INTERVAL_MS);
  }
}
