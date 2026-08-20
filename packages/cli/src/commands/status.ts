import { renderStatusTable, type FeatureRow } from '../render/status-table.js';
import type { DaemonClient } from '../http-client.js';

/**
 * `adl status` — the shape `GET /features` returns, restated on the CLI side
 * (D-20). `--json` emits the array from the API verbatim so a test asserts
 * on structured fields rather than string-matching a table any cosmetic
 * change breaks; the default renders `renderStatusTable`'s table.
 */

export interface StatusCommandOptions {
  readonly json: boolean;
}

/** A minimal write sink — real `process.stdout`, or a captured stream in tests. */
export interface WriteSink {
  write(chunk: string): void;
}

export interface StatusCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

/**
 * `statusCommand` prints `GET /features`. The row set is exactly what the
 * manager persisted and observed — this command computes nothing of its
 * own, including no derived "about to expire" state; that is what keeps a
 * feature whose lease has just passed its expiry still reading `leased`
 * until the reaper's next tick actually changes it (D-24's prohibition).
 */
export async function statusCommand(
  options: StatusCommandOptions,
  deps: StatusCommandDeps,
): Promise<void> {
  const features = (await deps.client.getFeatures()) as readonly FeatureRow[];
  const out = deps.stdout ?? process.stdout;

  if (options.json) {
    out.write(`${JSON.stringify(features)}\n`);
    return;
  }

  out.write(renderStatusTable(features));
}
