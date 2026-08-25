import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import pino, { type Logger } from 'pino';
import type { DaemonStartDeps, DaemonStartRunner } from '@adl/cli';
import type { DaemonConfig } from '@adl/core/config';
import {
  githubForgeAdapter,
  githubPushUrl,
  parseGithubRemoteUrl,
} from '@adl/forge-github';
import {
  claudeVersionCheckRunner,
  BackendUnavailableError,
  type BackendVersionCheckResult,
} from './backend-preflight.js';
import {
  ensureDaemonConfig,
  mintApiToken,
  resolveDaemonConfigPath,
  type DaemonConfigInvalid,
  type DaemonConfigLoaded,
} from '../config/daemon-config.js';
import { AdlYmlUnavailableError } from '../config/resolve-adl-yml.js';
import { SchemaVersionRefusalError } from './startup.js';
import {
  startDaemon,
  type DaemonHandle,
  type StartDaemonOptions,
} from '../daemon.js';

/**
 * The real `DaemonStartRunner` — `@adl/manager`'s answer to the
 * package-boundary decision (D-21) 5.7 closes. `@adl/cli` structurally
 * cannot resolve `@adl/manager`, so the code that turns `.adl/daemon.json`
 * plus a `--config` flag into a real, running `startDaemon()` call has to
 * live here, and `packages/manager/src/bin.ts` — the real, installed `adl`
 * binary — is its one production caller, injected into `@adl/cli`'s own
 * `buildProgram({ startDaemon: createProductionDaemonStartRunner() })`
 * exactly the way `loadConfig`/`createClient` are already injected there.
 *
 * `DaemonStartRunner` never throws (see that type's own docblock in
 * `@adl/cli`): every refusal this module can produce — an invalid daemon
 * config, or one of `startDaemon`'s own three named refusal errors — is
 * caught here and reported to `stderr` with `process.exitCode = 1`, never
 * an uncaught exception reaching commander's own error handling.
 *
 * `.adl/adl.db` — colocated with `.adl/daemon.json`, matching
 * `packages/db/src/schema.ts`'s own docblock ("readable in `sqlite3
 * .adl/adl.db`") — is fixed, always relative to the working directory the
 * daemon is started from, deliberately independent of `--config`: that flag
 * relocates where the *connection settings* are read from, not where ADL's
 * own state directory lives.
 */

/** `.adl/adl.db`, colocated with `.adl/daemon.json` (see module docblock). */
const DB_RELATIVE_PATH = ['.adl', 'adl.db'] as const;

export interface DaemonStartRunnerDeps {
  /** Defaults to `process.cwd`. Test seam — avoids a real `process.chdir()`. */
  readonly cwd?: () => string;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to a real `pino({ level: 'info' })`. */
  readonly logger?: Logger;
  /** Defaults to `ensureDaemonConfig` — zero-config first run, token never regenerated. */
  readonly loadConfig?: (
    path: string,
  ) => Promise<DaemonConfigLoaded | DaemonConfigInvalid>;
  /** Defaults to the real `startDaemon`. */
  readonly startDaemonFn?: (
    options: StartDaemonOptions,
  ) => Promise<DaemonHandle>;
  /** Defaults to the real `claudeVersionCheckRunner` (a real `claude --version` probe). */
  readonly buildAgentBackendVersionCheck?: (deps: {
    cwd: string;
    path: string;
    scratchHome: string;
  }) => () => Promise<BackendVersionCheckResult>;
  /** Test seam: fires with the real handle once `startDaemon` has actually returned one. */
  readonly onStarted?: (handle: DaemonHandle) => void;
}

/**
 * Build the real, credentialed `StartDaemonOptions.forge` from the
 * configured repository's `github_app` block (M05 step 5.10) — the same
 * "absent means skip" shape {@link StartDaemonOptions.agentBackendVersionCheck}
 * already uses. v1 watches exactly one physical repository
 * (`resolveProductionAdlYml`'s own scope note, `daemon.ts`), so this reads
 * `daemonConfig.repos[0]` — the same single-configured-repository
 * assumption every other production call site already makes.
 *
 * A `remote_url` {@link parseGithubRemoteUrl} cannot resolve to
 * `{owner, repo}` is logged and skipped, never a hard refusal: forge wiring
 * is a capability this entry point gains when configured, not a startup
 * precondition like the schema/adl.yml/backend gates above, none of which
 * this function touches.
 */
function buildForgeOption(
  daemonConfig: DaemonConfig,
  logger: Logger,
): StartDaemonOptions['forge'] {
  const repoConfig = daemonConfig.repos[0];
  if (repoConfig?.github_app === undefined) return undefined;

  const repo = parseGithubRemoteUrl(repoConfig.remote_url);
  if (repo === undefined) {
    logger.warn(
      { remoteUrl: repoConfig.remote_url },
      'daemon config: repos[0].github_app is set, but remote_url does not ' +
        'parse as a GitHub repository — no ForgeAdapter wired',
    );
    return undefined;
  }

  const { app_id, private_key, installation_id } = repoConfig.github_app;
  const adapter = githubForgeAdapter({
    appId: app_id,
    privateKey: private_key,
    installationId: installation_id,
  });

  return {
    adapter,
    repo,
    pushCredential: async () => {
      const pushToken = await adapter.getPushToken();
      return githubPushUrl({
        token: pushToken.token,
        owner: repo.owner,
        repo: repo.repo,
      });
    },
  };
}

/**
 * Build the production `DaemonStartRunner`. Every dependency above defaults
 * to the real thing; a test overrides only the ones it needs to control,
 * matching this package's own `StartDaemonOptions` injection style.
 */
export function createProductionDaemonStartRunner(
  runnerDeps: DaemonStartRunnerDeps = {},
): DaemonStartRunner {
  const cwd = runnerDeps.cwd ?? (() => process.cwd());
  const env = runnerDeps.env ?? process.env;
  const loadConfig = runnerDeps.loadConfig ?? ensureDaemonConfig;
  const startDaemonFn = runnerDeps.startDaemonFn ?? startDaemon;
  const buildAgentBackendVersionCheck =
    runnerDeps.buildAgentBackendVersionCheck ?? claudeVersionCheckRunner;

  return async (deps: DaemonStartDeps): Promise<void> => {
    const stderr = deps.stderr ?? process.stderr;
    const logger = runnerDeps.logger ?? pino({ level: 'info' });
    const mainRepo = cwd();
    // `resolve`, never `join`: a relative default resolves against the
    // injected `cwd()` (production: `process.cwd()`, matching every relative
    // file read in this codebase); an absolute `--config` value is used
    // as-is, which `join(mainRepo, absolutePath)` would NOT do correctly.
    const configFilePath = resolve(
      mainRepo,
      resolveDaemonConfigPath(deps.configPath),
    );

    const loaded = await loadConfig(configFilePath);
    if (loaded.kind === 'invalid') {
      stderr.write(
        `invalid daemon config at ${loaded.path}: ${loaded.message}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const dbFilePath = join(mainRepo, ...DB_RELATIVE_PATH);
    const scratchRoot = join(dirname(dbFilePath), 'scratch');
    await mkdir(dirname(dbFilePath), { recursive: true });

    // `ApiConfigSchema.token` has no default (its own docblock: "the daemon
    // mints one ... when absent") — `ensureDaemonConfig` only mints on a
    // FRESH file, so a pre-existing file that predates the token field (or
    // was hand-edited) can still reach here without one. Minted in memory
    // only, for this boot alone: writing it back would need re-serialising
    // fields this module has no business restating, and this path is only
    // ever reachable outside `ensureDaemonConfig`'s own zero-config
    // guarantee.
    let apiToken = loaded.config.api.token;
    if (apiToken === undefined) {
      apiToken = mintApiToken();
      logger.warn(
        { path: loaded.path },
        'daemon config has no api.token — minted one for this boot only; ' +
          'edit the file to persist a token across restarts.',
      );
    }

    const path = env['PATH'] ?? '';
    const forgeOption = buildForgeOption(loaded.config, logger);
    const options: StartDaemonOptions = {
      dbFilePath,
      host: loaded.config.api.host,
      port: loaded.config.api.port,
      apiToken,
      leaseTtlMs: loaded.config.lease_ttl_ms,
      heartbeatIntervalMs: loaded.config.heartbeat_interval_ms,
      daemonConfig: loaded.config,
      mainRepo,
      scratchRoot,
      logger,
      // D-01/D-02, wired unconditionally per `daemon.ts`'s own `agentBackendVersionCheck`
      // docblock: the real `adl daemon start` entry point never skips this gate.
      agentBackendVersionCheck: buildAgentBackendVersionCheck({
        cwd: mainRepo,
        path,
        scratchHome: scratchRoot,
      }),
      // M05 step 5.10: absent unless `repos[0].github_app` is configured —
      // see `buildForgeOption`'s own docblock.
      ...(forgeOption !== undefined ? { forge: forgeOption } : {}),
    };

    let handle: DaemonHandle;
    try {
      handle = await startDaemonFn(options);
    } catch (error) {
      if (
        error instanceof SchemaVersionRefusalError ||
        error instanceof AdlYmlUnavailableError ||
        error instanceof BackendUnavailableError
      ) {
        stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    runnerDeps.onStarted?.(handle);
    logger.info(
      { host: handle.host, port: handle.port },
      'adl daemon: listening',
    );

    // No further `await` here, deliberately: the HTTP server and the
    // dispatch/reaper/GC timers `startDaemon` just created are real active
    // handles that keep the process alive on their own — exactly how any
    // ordinary long-running Node server script "runs in the foreground"
    // with no explicit blocking promise. `handle.stop()` (from a signal
    // below, or remotely via `adl daemon stop`'s `/control/shutdown`) tears
    // all of them down, and the process then exits naturally once nothing
    // is left keeping the event loop alive.
    //
    // `stopping` guards against BOTH SIGINT-then-SIGTERM arriving in quick
    // succession (`process.once` only deregisters the event it fired on,
    // not its sibling) AND a stop already in flight over HTTP (`adl daemon
    // stop`'s `/control/shutdown`, which calls `handle.stop()` directly,
    // never through this closure). Either way, `gracefulShutdown`
    // (`./shutdown.js`) is not idempotent — a second `server.close()` on an
    // already-closed server rejects — so a duplicate call is caught and
    // logged rather than left as an unhandled rejection that would crash an
    // otherwise-successful shutdown.
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, 'adl daemon: shutting down');
      handle.stop().catch((error: unknown) => {
        logger.error(
          { err: error, signal },
          'adl daemon: shutdown reported an error — the daemon may already ' +
            'have been stopping (e.g. via a concurrent `adl daemon stop`)',
        );
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  };
}
