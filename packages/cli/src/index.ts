#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { statusCommand, type WriteSink } from './commands/status.js';
import { daemonClient, DaemonUnreachableError } from './http-client.js';

/**
 * `@adl/cli` — status, logs, pause, kill. Talks to the manager over HTTP
 * only (D-18, D-21); structurally cannot resolve `@adl/db` or `@adl/manager`.
 *
 * The daemon config file's shape and loader are a later plan's job
 * (`packages/manager/src/config/daemon-config.ts`, which `@adl/cli` cannot
 * depend on — it lives in `@adl/manager`). This file reads the minimal
 * `{ api: { host, port, token } }` subset it needs directly, so `adl status`
 * has a real default rather than a stub; a later plan replaces this reader
 * with the shared, fully-validated loader without changing this command's
 * shape.
 */

const DEFAULT_CONFIG_PATH = '.adl/daemon.json';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;

export interface CliConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

interface RawDaemonConfigFile {
  readonly api?: {
    readonly host?: string;
    readonly port?: number;
    readonly token?: string;
  };
}

/** The production default: read `--config` (or `.adl/daemon.json`) as JSON. */
export function loadCliConfig(path: string = DEFAULT_CONFIG_PATH): CliConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawDaemonConfigFile;
  return {
    host: raw.api?.host ?? DEFAULT_HOST,
    port: raw.api?.port ?? DEFAULT_PORT,
    token: raw.api?.token ?? '',
  };
}

export interface BuildProgramDeps {
  readonly loadConfig: (path?: string) => CliConfig;
  readonly stdout?: WriteSink;
  readonly stderr?: WriteSink;
}

/**
 * Builds the commander program without invoking it — a test seam so
 * `adl status` can be driven with an injected config loader and captured
 * streams, never a real subprocess or a real config file.
 */
export function buildProgram(deps: BuildProgramDeps): Command {
  const program = new Command('adl');
  program.option('--config <path>', 'Path to the daemon config file');

  program
    .command('status')
    .description('Show every feature the daemon knows about')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const configPath = program.opts<{ config?: string }>().config;
      const config = deps.loadConfig(configPath);
      const client = daemonClient(config);
      const stderr = deps.stderr ?? process.stderr;
      try {
        await statusCommand(
          { json: Boolean(options.json) },
          { client, stdout: deps.stdout },
        );
      } catch (error) {
        if (error instanceof DaemonUnreachableError) {
          stderr.write(`${error.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  return program;
}

function isEntryPoint(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;
  return pathToFileURL(argvPath).href === import.meta.url;
}

if (isEntryPoint()) {
  const program = buildProgram({ loadConfig: loadCliConfig });
  void program.parseAsync(process.argv);
}
