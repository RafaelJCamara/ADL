#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { buildProgram, loadCliConfig } from '@adl/cli';
import { createProductionDaemonStartRunner } from './boot/cli-entry.js';

/**
 * The real, installed `adl` binary (D-21, 5.7's resolution of the
 * package-boundary decision the milestone left open).
 *
 * `@adl/cli` structurally cannot resolve `@adl/manager` (pnpm strict
 * `node_modules`) and cannot spawn a subprocess either (the repo-wide
 * `adl/no-direct-spawn` rule has no carve-out for it) — so the package that
 * CAN wire the two together has to own the executable. `@adl/manager`
 * depends on `@adl/cli` as a library (never the reverse: `@adl/cli`'s own
 * package.json still carries no dependency on this package or on
 * `@adl/db`), and this file is the one place that dependency is used: every
 * verb except `daemon start` is `@adl/cli`'s own HTTP-only `buildProgram`,
 * unchanged; `daemon start` alone gets the real, in-process boot sequence
 * (`createProductionDaemonStartRunner`, `./boot/cli-entry.js`) injected into
 * it, exactly the way `loadConfig`/`createClient` are already injected
 * there for tests.
 */

export async function runAdlBin(argv: string[]): Promise<void> {
  const program = buildProgram({
    loadConfig: loadCliConfig,
    startDaemon: createProductionDaemonStartRunner(),
  });
  await program.parseAsync(argv);
}

function isEntryPoint(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;
  return pathToFileURL(argvPath).href === import.meta.url;
}

if (isEntryPoint()) {
  void runAdlBin(process.argv);
}
