import type { DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl daemon` — `start`/`stop` (D-18, D-21, 5.7's resolution of the
 * package-boundary decision the milestone left open).
 *
 * `stop` reaches the running manager over the same HTTP surface every other
 * verb does (`POST /control/shutdown`, `daemon.ts`'s `onShutdownRequested`
 * hook, mirroring `03-06`'s `gracefulShutdown`).
 *
 * `start` cannot cross that boundary the same way, and never will:
 * `@adl/cli` structurally cannot resolve `@adl/manager` (pnpm strict
 * `node_modules`) and cannot spawn a subprocess either (the repo-wide
 * `adl/no-direct-spawn` rule has no carve-out for this package). Booting the
 * manager in-process therefore has to happen from a package that CAN import
 * `@adl/manager` — 5.7's answer is `@adl/manager` itself, which now ships
 * the real, installed `adl` binary (`packages/manager/src/bin.ts`) and
 * depends on `@adl/cli` as a library, never the reverse. That binary
 * constructs `buildProgram`'s `startDaemon` dependency from
 * `@adl/manager`'s `createProductionDaemonStartRunner` — the one and only
 * real implementation of {@link DaemonStartRunner}.
 *
 * `daemonStartCommand` below is only ever the DEFAULT `buildProgram` falls
 * back to. It fires exactly when `@adl/cli`'s own program is built and run
 * directly, bypassing the real `adl` binary — an honest gap, not a stub
 * pretending to work, per D-24's "a status view that crashes or fakes a
 * result is worse than one that shows less."
 */

export interface DaemonStartDeps {
  /**
   * The raw `--config` flag value, unparsed — a real runner resolves it
   * itself (`@adl/manager`'s `resolveDaemonConfigPath`); `@adl/cli` has no
   * daemon-config schema of its own to validate it against.
   */
  readonly configPath?: string;
  readonly stderr?: WriteSink;
}

/**
 * Never throws — reports its own failure to `stderr` and sets
 * `process.exitCode` rather than letting `buildProgram`'s caller decide how
 * to present a boot refusal. `daemon start`'s commander action awaits this
 * directly, with no `runVerb` wrapping, on that guarantee.
 */
export type DaemonStartRunner = (deps: DaemonStartDeps) => void | Promise<void>;

export const daemonStartCommand: DaemonStartRunner = (deps) => {
  const stderr = deps.stderr ?? process.stderr;
  stderr.write(
    "adl daemon start: @adl/cli's own program cannot boot the manager — " +
      'it structurally cannot resolve @adl/manager (D-21). Run the real ' +
      '`adl` binary (published by @adl/manager) instead, or call ' +
      "@adl/manager's startDaemon(...) programmatically.\n",
  );
  process.exitCode = 1;
};

export interface DaemonStopDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

export async function daemonStopCommand(deps: DaemonStopDeps): Promise<void> {
  await deps.client.postShutdown();
  const out = deps.stdout ?? process.stdout;
  out.write('Shutdown requested.\n');
}
