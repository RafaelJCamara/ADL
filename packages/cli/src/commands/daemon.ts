import type { DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl daemon` — `start`/`stop`. `@adl/cli` has no dependency on
 * `@adl/manager` (D-18, D-21): `stop` reaches the running manager over the
 * same HTTP surface every other verb does (`POST /control/shutdown`,
 * `daemon.ts`'s `onShutdownRequested` hook, mirroring `03-06`'s
 * `gracefulShutdown`).
 *
 * `start` cannot cross that boundary the same way: booting the manager
 * in-process would need `@adl/manager` as a real dependency, which is
 * exactly the resolve-time failure D-21 is designed to make structural
 * rather than a review convention. It is also not yet functionally
 * possible: `startDaemon` requires a `resolveAdlYml` implementation, and
 * feature detection — the thing that supplies one — is Phase 5's job, not
 * this plan's. Printed here as an honest gap rather than a fabricated
 * success, per D-24's "a status view that crashes or fakes a result is
 * worse than one that shows less."
 */

export interface DaemonStartDeps {
  readonly host: string;
  readonly port: number;
  readonly stderr?: WriteSink;
}

export function daemonStartCommand(deps: DaemonStartDeps): void {
  const stderr = deps.stderr ?? process.stderr;
  stderr.write(
    `adl daemon start does not yet boot the manager in-process. Configured target: ` +
      `${deps.host}:${deps.port}. In-process bootstrap needs feature detection ` +
      `(resolveAdlYml) from Phase 5, which has not landed. Run @adl/manager's own ` +
      `daemon entry directly in the meantime.\n`,
  );
  process.exitCode = 1;
}

export interface DaemonStopDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

export async function daemonStopCommand(deps: DaemonStopDeps): Promise<void> {
  await deps.client.postShutdown();
  const out = deps.stdout ?? process.stdout;
  out.write('Shutdown requested.\n');
}
