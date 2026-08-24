#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { ScopeUsageError } from './confirm.js';
import {
  daemonStartCommand,
  daemonStopCommand,
  type DaemonStartDeps,
  type DaemonStartRunner,
} from './commands/daemon.js';
import { devRunCommand } from './commands/dev-run.js';
import { gcCommand } from './commands/gc.js';
import { killCommand } from './commands/kill.js';
import { InvalidLogsOffsetError, logsCommand } from './commands/logs.js';
import { pauseCommand } from './commands/pause.js';
import { resumeCommand } from './commands/resume.js';
import { statusCommand, type WriteSink } from './commands/status.js';
import {
  daemonClient,
  DaemonRequestError,
  DaemonUnreachableError,
  type DaemonClient,
} from './http-client.js';

// Re-exported so `@adl/manager`'s bin (5.7) can type its own real
// `DaemonStartRunner` against the exact same interface `buildProgram`
// injects into, rather than a second, hand-restated shape.
export type { DaemonStartDeps, DaemonStartRunner };

/**
 * `@adl/cli` — the full `adl` verb set over HTTP (D-18, D-20, D-21, D-29):
 * `status`, `pause`, `resume`, `kill`, `gc`, `daemon`. Structurally cannot
 * resolve `@adl/db` or `@adl/manager` — every verb reaches the daemon over
 * HTTP only. This package no longer ships the installed `adl` binary itself
 * (5.7): `@adl/manager` depends on this package as a library and owns the
 * real executable (`packages/manager/src/bin.ts`), injecting its own real
 * `startDaemon` runner into {@link buildProgram} — the one place `daemon
 * start` needs anything past HTTP, and the one dependency this package still
 * never carries.
 *
 * The daemon config file's shape and loader are `@adl/manager`'s
 * (`packages/manager/src/config/daemon-config.ts`, which `@adl/cli` cannot
 * depend on). This file reads the minimal `{ api: { host, port, token } }`
 * subset it needs directly, so every verb has a real default rather than a
 * stub; a later plan can replace this reader with the shared, fully-validated
 * loader without changing any command's shape.
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
  /**
   * The blast-radius confirmation seam (D-29) — injected so a test can drive
   * `adl pause|resume|kill --all` through both the interactive and
   * non-interactive branches without a real TTY.
   */
  readonly isInteractive?: () => boolean;
  readonly confirmInput?: NodeJS.ReadableStream;
  readonly confirmOutput?: NodeJS.WritableStream;
  /**
   * Constructs the `DaemonClient` for one invocation. Defaults to the real
   * `daemonClient(config)` — injected so a test can substitute a recording
   * fake without mocking the ESM module graph, the same seam `loadConfig`
   * already is for the config file.
   */
  readonly createClient?: (config: CliConfig) => DaemonClient;
  /**
   * `daemon start`'s behaviour (D-21, 5.7). Defaults to `daemonStartCommand`'s
   * honest gap — `@adl/cli` alone cannot boot the manager. The real `adl`
   * binary (`@adl/manager`'s `bin.ts`) injects its own real runner
   * (`createProductionDaemonStartRunner`) here; a test injects a spy.
   */
  readonly startDaemon?: DaemonStartRunner;
}

/**
 * Builds the commander program without invoking it — a test seam so every
 * verb can be driven with an injected config loader and captured streams,
 * never a real subprocess or a real config file.
 */
export function buildProgram(deps: BuildProgramDeps): Command {
  const program = new Command('adl');
  program.option('--config <path>', 'Path to the daemon config file');
  program.option('--json', 'Print machine-readable JSON', false);

  const stderr = deps.stderr ?? process.stderr;

  function resolveConfig(): CliConfig {
    const configPath = program.opts<{ config?: string }>().config;
    return deps.loadConfig(configPath);
  }

  function buildClient(config: CliConfig): DaemonClient {
    return (deps.createClient ?? daemonClient)(config);
  }

  /**
   * Wraps a verb's async body so every one of the six verbs reports D-25's
   * daemon-down message the same way, and a usage error (mutually-exclusive
   * scope flags) is reported without ever having reached the network.
   */
  async function runVerb(body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      if (
        error instanceof DaemonUnreachableError ||
        error instanceof DaemonRequestError ||
        error instanceof ScopeUsageError ||
        error instanceof InvalidLogsOffsetError
      ) {
        stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  program
    .command('status')
    .description('Show every feature the daemon knows about')
    .action(async () => {
      const config = resolveConfig();
      const client = buildClient(config);
      const json = program.opts<{ json?: boolean }>().json;
      await runVerb(() =>
        statusCommand({ json: Boolean(json) }, { client, stdout: deps.stdout }),
      );
    });

  program
    .command('pause')
    .description(
      'Pause dispatch for a feature, a repository, or every repository',
    )
    .argument('[feature-id]', 'A single feature to pause')
    .option('--repo <id>', 'Pause every queued feature in one repository')
    .option('--all', 'Pause dispatch globally')
    .option('--yes', 'Skip the confirmation prompt for --all')
    .action(async (featureId: string | undefined, options) => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() =>
        pauseCommand(
          { featureId, repo: options.repo, all: options.all, yes: options.yes },
          {
            client,
            stdout: deps.stdout,
            isInteractive: deps.isInteractive,
            confirmInput: deps.confirmInput,
            confirmOutput: deps.confirmOutput,
          },
        ),
      );
    });

  program
    .command('resume')
    .description(
      'Resume dispatch for a feature, a repository, or every repository',
    )
    .argument('[feature-id]', 'A single feature to resume')
    .option('--repo <id>', 'Resume every paused feature in one repository')
    .option('--all', 'Resume dispatch globally')
    .option('--yes', 'Skip the confirmation prompt for --all')
    .action(async (featureId: string | undefined, options) => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() =>
        resumeCommand(
          { featureId, repo: options.repo, all: options.all, yes: options.yes },
          {
            client,
            stdout: deps.stdout,
            isInteractive: deps.isInteractive,
            confirmInput: deps.confirmInput,
            confirmOutput: deps.confirmOutput,
          },
        ),
      );
    });

  program
    .command('kill')
    .description('Stop a feature, a repository, or every in-flight feature')
    .argument('[feature-id]', 'A single feature to kill')
    .option(
      '--repo <id>',
      'Kill every in-flight/queued feature in one repository',
    )
    .option('--all', 'Kill every in-flight feature on this host')
    .option('--yes', 'Skip the confirmation prompt for --all')
    .action(async (featureId: string | undefined, options) => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() =>
        killCommand(
          { featureId, repo: options.repo, all: options.all, yes: options.yes },
          {
            client,
            stdout: deps.stdout,
            isInteractive: deps.isInteractive,
            confirmInput: deps.confirmInput,
            confirmOutput: deps.confirmOutput,
          },
        ),
      );
    });

  program
    .command('gc')
    .description('Run the orphan-worktree and scratch-home sweeps on demand')
    .action(async () => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() => gcCommand({ client, stdout: deps.stdout }));
    });

  program
    .command('dev-run')
    .description(
      'Exercise a real developer-agent commit against a real features/<id>/ folder (D-03)',
    )
    .argument('<feature-id>', 'The feature folder to dispatch')
    .action(async (featureId: string) => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() =>
        devRunCommand({ featureId }, { client, stdout: deps.stdout }),
      );
    });

  program
    .command('logs')
    .description("Stream a stage attempt's transcript")
    .argument('<stage-attempt-id>', 'The stage attempt to stream logs for')
    .option(
      '-f, --follow',
      'Stay attached and receive new records as the run continues',
      false,
    )
    .option('--offset <bytes>', 'Start (or resume) from a given byte offset')
    .action(
      async (
        stageAttemptId: string,
        options: { follow?: boolean; offset?: string },
      ) => {
        const config = resolveConfig();
        const client = buildClient(config);
        await runVerb(() =>
          logsCommand(
            {
              stageAttemptId,
              follow: Boolean(options.follow),
              offset: options.offset,
            },
            { client, stdout: deps.stdout },
          ),
        );
      },
    );

  const daemonProgram = program
    .command('daemon')
    .description('Start or stop the ADL manager daemon');

  daemonProgram
    .command('start')
    .description('Start the manager daemon in the foreground')
    .action(async () => {
      const configPath = program.opts<{ config?: string }>().config;
      await (deps.startDaemon ?? daemonStartCommand)({
        configPath,
        stderr: deps.stderr,
      });
    });

  daemonProgram
    .command('stop')
    .description('Ask a running manager daemon to shut down gracefully')
    .action(async () => {
      const config = resolveConfig();
      const client = buildClient(config);
      await runVerb(() => daemonStopCommand({ client, stdout: deps.stdout }));
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
