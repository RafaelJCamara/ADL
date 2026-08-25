import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { ulid } from 'ulid';
import {
  createDb,
  featuresRepository,
  nowIso,
  usageRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import {
  DEFAULT_CONFIG,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import type { Kysely } from 'kysely';
import pino, { type Logger } from 'pino';
import { hostGitWorkspace } from '@adl/workspace';
import type { ForgeAdapter, ForgeRepoRef } from '@adl/core/forge';
import { createApi } from './api/app.js';
import type { FeatureView } from './api/routes/features.js';
import { closeAttempt } from './bookkeeping/attempt.js';
import {
  BackendUnavailableError,
  runBackendPreflight,
  SUPPORTED_BACKEND_ID,
  type BackendVersionCheckResult,
} from './boot/backend-preflight.js';
import {
  encodeLeaseOwner,
  killBootOrphans,
  readProcessStartTime,
} from './boot/orphans.js';
import { gracefulShutdown } from './boot/shutdown.js';
import {
  DAEMON_SCHEMA_VERSION,
  reconcileRepos,
  resolveMigrationsDir,
  restoreGlobalPause,
  runStartupGate,
  SchemaVersionRefusalError,
} from './boot/startup.js';
import {
  ADL_YML_PATH,
  AdlYmlUnavailableError,
  resolveProductionAdlYml,
} from './config/resolve-adl-yml.js';
import { createControlState, parkOnRoundBoundary } from './control/state.js';
import { createStaleRejectionCounter } from './fencing.js';
import { onStageCompleted } from './loop/round-runner.js';
import { publishOnDeveloperCommitted } from './publish/on-developer-committed.js';
import { dispatchOnce } from './scheduler/dispatcher.js';
import { startGcSchedule } from './scheduler/gc-schedule.js';
import { startPollSchedule } from './scheduler/poll-schedule.js';
import {
  createFastPathRecovery,
  reapOne,
  startReaper,
} from './scheduler/reaper.js';
import { resolveStageCell } from './stage-name.js';
import { logsRootFor } from './store/transcript-path.js';
import {
  createSupervisor,
  type WorkerReady,
  type WorkerSupervisor,
} from './worker-supervisor/supervisor.js';

/**
 * `startDaemon`/`stopDaemon` — the one function that wires the database, the
 * supervisor, the dispatcher, and the Hono API together, and returns a
 * handle a caller (production `adl daemon start`, or a test) can stop.
 *
 * The startup order is fixed by D-37: schema gate (refuse newer,
 * copy-then-migrate an older or unseeded database, inside
 * `runStartupGate`), then the scratch root a workspace backend creates
 * per-feature workspaces under (04-04), then repository reconciliation
 * (`reconcileRepos`, D-35), then the production `adl.yml` gate (05-04 —
 * `resolveProductionAdlYml`, skipped entirely when `options.resolveAdlYml`
 * is supplied), then lease expiry and the boot orphan kill (D-13,
 * `./boot/orphans.js`), then the backend preflight gate (04-07,
 * D-01/D-02 — `runBackendPreflight`, when `options.agentBackendVersionCheck`
 * is supplied), then dispatch. A refusal from any gate exits before the
 * API server binds —
 * `startDaemon` throws {@link SchemaVersionRefusalError} or
 * {@link AdlYmlUnavailableError} rather than returning a handle.
 */

/** The compiled worker entry's default location, relative to this module. */
const DEFAULT_WORKER_ENTRY_PATH = fileURLToPath(
  new URL('./worker-entry/index.js', import.meta.url),
);

export interface StartDaemonOptions {
  readonly dbFilePath: string;
  readonly host?: string;
  /** `0` lets the OS assign a free port — read back from `DaemonHandle.port`. */
  readonly port: number;
  readonly apiToken: string;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly daemonConfig: DaemonConfig;
  /**
   * Resolves the watched repository's effective `adl.yml` for a feature.
   * Required, synchronous, injected-dependency shape kept exactly as M03
   * left it (`boot/startup.ts`'s docblock names it as the precedent other
   * gates follow) — the real I/O happens once, at boot, before this
   * closure exists.
   *
   * Optional here: absent, `startDaemon` resolves the production default
   * itself (05-04, `resolveProductionAdlYml`) by reading `adl.yml` off
   * `mainRepo`'s own working tree and refusing to start
   * ({@link AdlYmlUnavailableError}) when it is missing or invalid. Supply
   * this explicitly to bypass that read entirely — every test fixture that
   * predates 05-04 keeps doing exactly that, unchanged.
   */
  readonly resolveAdlYml?: (feature: FeaturesTable) => AdlYml;
  /**
   * The directory a workspace backend may create a per-feature workspace
   * under (04-04). Defaults to a `scratch` directory beside the database
   * file. Created at startup if it does not already exist —
   * `WorkspaceSpec.scratchRoot` documents that it must, and the daemon is
   * the component that knows where ADL's state lives.
   */
  readonly scratchRoot?: string;
  /**
   * The migrations directory `runStartupGate` applies. Defaults to
   * `@adl/db`'s own shipped `migrations/` (via `resolveMigrationsDir()`,
   * matching `DAEMON_SCHEMA_VERSION`'s own derivation) — override only for a
   * test that needs to control exactly which directory's bytes the
   * checksum guard records against.
   */
  readonly migrationsDir?: string;
  /** Defaults to this package's own compiled worker entry. */
  readonly workerEntryPath?: string;
  /**
   * The forked worker CHILD PROCESS's own `cwd` — where `execArgv`'s loader
   * (e.g. `--import tsx`, used by every scripted test double) resolves from.
   * Defaults to this daemon process's own `process.cwd()`.
   *
   * Deliberately NOT the same option as {@link StartDaemonOptions.mainRepo}
   * (04-06): a test daemon commonly needs its worker's `cwd` to stay inside
   * the real package (so `tsx` resolves) while `mainRepo` points at an
   * unrelated temp repository — coupling the two, as this option alone used
   * to, made that combination impossible to express.
   */
  readonly workerCwd?: string;
  /**
   * Absolute path to the repository ADL is running against — `WorkspaceSpec.mainRepo`,
   * `dispatchOnce`'s `mainRepo`, and `POST /dev-run/:featureId`'s repository
   * root, all in one place (04-06). Defaults to {@link StartDaemonOptions.workerCwd}
   * (or, if that is also absent, `process.cwd()`) — the pre-04-06 behaviour,
   * unchanged for every caller that never needed the two decoupled.
   */
  readonly mainRepo?: string;
  readonly workerExecArgv?: readonly string[];
  /** How often `dispatchOnce` is called. Default: 25ms. */
  readonly dispatchIntervalMs?: number;
  readonly logger?: Logger;
  /** Test/observability seam: fires whenever a forked worker reports `ready`. */
  readonly onWorkerReady?: (ready: WorkerReady) => void;
  /**
   * Explicit environment values every forked worker receives (04-06), merged
   * over `SupervisorDeps.workerEnv`'s own platform allowlist. `ANTHROPIC_API_KEY`
   * — read once from the daemon's own environment below — always travels
   * this way; a caller may add test-only overrides (e.g. a scripted agent
   * CLI's path) on top of it.
   */
  readonly workerEnv?: Readonly<Record<string, string>>;
  /**
   * The version-check invocation for the configured agent backend (04-07,
   * D-01/D-02) — invoked exactly once, before the dispatch timer starts and
   * before the API server binds. `runBackendPreflight` (`./boot/backend-preflight.js`)
   * turns a refusal into a thrown {@link BackendUnavailableError}, exactly as
   * a schema refusal already becomes {@link SchemaVersionRefusalError}.
   *
   * **Absent means the backend preflight gate is skipped entirely** — every
   * `startDaemon()` call site that predates this plan (none of which is in
   * this plan's own file list) continues to start exactly as it did before,
   * with no dependency on a real, pinned `claude` CLI being on the daemon's
   * `PATH`. A caller that wants D-02's hard-block behaviour supplies this
   * explicitly; `claudeVersionCheckRunner` (also `./boot/backend-preflight.js`)
   * is the real, production constructor — a `claude --version` invocation
   * through the ADL-owned exec boundary — for the future `adl daemon start`
   * entry point (not yet built) to wire unconditionally.
   */
  readonly agentBackendVersionCheck?: () => Promise<BackendVersionCheckResult>;
  /**
   * The forge dependency the polling detection loop (05-05, DETECT-03) uses
   * to call `ForgeAdapter.listOpenChangeRequests` (5.2's `undevelopedFeatures`)
   * and `ForgeAdapter.authorPermission` (5.3's `evaluateFeatureTrust`) —
   * both read-only calls; the credentialed push a real draft CR needs is a
   * later step's concern (`docs/plan/DEBT.md` D-5-R-1).
   *
   * **Absent means the poll schedule does not start at all** — the same
   * "absent means skip" shape {@link StartDaemonOptions.agentBackendVersionCheck}
   * already uses. No live GitHub App credentials exist in this project yet
   * (`docs/plan/DEBT.md` item 1.7); a caller with real (or, in a test,
   * mock-server-backed) forge credentials supplies this explicitly.
   */
  readonly forge?: {
    readonly adapter: ForgeAdapter;
    readonly repo: ForgeRepoRef;
    /**
     * Mints a fresh, short-lived, already-credentialed push URL (M05 step
     * 5.10) — threaded into every dispatch (`dispatchOnce`'s own `forge.pushCredential`)
     * and, once a real commit is reported, is also what makes
     * `onDeveloperCommitted` below safe to open a change request from: a
     * push failure is reported as a `stage_error`, never a `committed`
     * outcome, so by the time that callback fires the branch is already on
     * the remote. Absent: `adapter`/`repo` still drive the read-only poll
     * schedule (5.5), but nothing is ever pushed or published.
     */
    readonly pushCredential?: () => Promise<string>;
  };
}

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly supervisor: WorkerSupervisor;
  stop(): Promise<void>;
}

/**
 * D-13's other half: after {@link killBootOrphans} has had a chance to act
 * on it, expire every held lease unconditionally (`reapOne`, the same
 * function the reaper's own tick and the child-exit fast path both call) —
 * not only ones past `lease_expires_at`. Boot is a deterministic clean
 * slate: nothing from a previous daemon process is left holding a lease.
 */
async function expireAllLeasesAtBoot(
  db: Kysely<Database>,
  logger: Logger,
): Promise<void> {
  const leased = await featuresRepository(db).listLeased();
  const now = nowIso();
  for (const feature of leased) {
    await reapOne({ db, logger }, feature, now);
  }
}

/**
 * Read the just-forked worker's real process start time and persist the
 * D-14 encoded `{pid, startTime}` record into `lease_owner`, fenced by the
 * lease token so a late-arriving `ready` from an already-superseded lease
 * cannot overwrite a newer holder's record. Bound to the supervisor's
 * `onReady` hook — the earliest point the manager knows the worker's real
 * OS pid; the worker's own self-reported `startedAt` (wall-clock) is not
 * used here because D-14's comparison is boot-relative clock ticks, a
 * different value entirely, which only the manager itself can read.
 */
async function recordLeaseOwnerOnReady(
  db: Kysely<Database>,
  ready: WorkerReady,
  logger: Logger,
): Promise<void> {
  const startTimeResult = readProcessStartTime(ready.pid);
  const record = {
    pid: ready.pid,
    startTime:
      startTimeResult.kind === 'available' ? startTimeResult.startTime : null,
  };
  try {
    await db
      .updateTable('features')
      .set({ lease_owner: encodeLeaseOwner(record) })
      .where('id', '=', ready.featureId)
      .where('lease_token', '=', ready.leaseToken)
      .execute();
  } catch (error) {
    logger.error(
      { err: error, featureId: ready.featureId },
      'failed to record lease_owner PID/start-time on worker ready',
    );
  }
}

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonHandle> {
  const db: Kysely<Database> = createDb(options.dbFilePath);
  const logger = options.logger ?? pino({ level: 'info' });
  const host = options.host ?? '127.0.0.1';
  const migrationsDir = options.migrationsDir ?? resolveMigrationsDir();
  // 04-06: decoupled from the worker child process's own `cwd` — see
  // `StartDaemonOptions.mainRepo`'s docblock.
  const mainRepo = options.mainRepo ?? options.workerCwd ?? process.cwd();

  // D-37's fixed order: schema gate (refuse newer, copy-then-migrate an
  // older or unseeded database) before any other database access beyond
  // the gate's own.
  const gateResult = await runStartupGate({
    db,
    dbFilePath: options.dbFilePath,
    migrationsDir,
    logger,
  });
  if (gateResult.kind === 'refused') {
    await db.destroy();
    throw new SchemaVersionRefusalError(gateResult.refusal);
  }

  // 04-04: the scratch root a workspace backend creates per-feature
  // workspaces under. Defaulted beside the database file so an existing
  // caller keeps working with no config change, and created here — after
  // the schema gate, before the first dispatch tick — because `daemon.ts`
  // is the one component that knows where ADL's own state lives.
  // `WorkspaceSpec.scratchRoot` documents that it must already exist by the
  // time a worker is assigned it.
  const scratchRoot =
    options.scratchRoot ?? join(dirname(options.dbFilePath), 'scratch');
  await mkdir(scratchRoot, { recursive: true });

  // D-35: reconcile watched repositories next.
  await reconcileRepos({ db, repos: options.daemonConfig.repos, logger });

  // 05-04: the production `adl.yml` gate. Skipped entirely when the caller
  // supplied its own `resolveAdlYml` (every pre-05-04 test fixture, and any
  // caller that wants to bypass the read for its own reasons) — matching
  // the backend preflight gate's own "absent means skip" precedent below,
  // except this one has no boolean switch: the injected function's own
  // presence IS the switch. Real I/O happens exactly once, here, through a
  // host-rooted workspace over `mainRepo` — never a per-dispatch read, and
  // never a git-ref lookup (`resolveProductionAdlYml`'s own docblock
  // explains why a plain working-tree read is correct for this root
  // specifically).
  async function resolveProductionAdlYmlOrThrow(): Promise<
    (feature: FeaturesTable) => AdlYml
  > {
    const hostWorkspace = await hostGitWorkspace({
      featureId: 'adl-daemon-boot',
      mainRepo,
      scratchRoot,
      baseRef: 'HEAD',
    });
    const outcome = await resolveProductionAdlYml({
      readFile: (path) => hostWorkspace.read(path),
    });
    if (outcome.kind === 'refused') {
      logger.error(outcome.refusal, 'adl.yml gate: refusing to start');
      await db.destroy();
      throw new AdlYmlUnavailableError(outcome.refusal);
    }
    logger.info(
      { path: ADL_YML_PATH },
      'adl.yml gate: resolved a production configuration',
    );
    const config = outcome.config;
    return () => config;
  }

  // A `const` of a definite (non-optional) function type, resolved once —
  // never a `let` narrowed by an `if`: `runDispatchOnce` below closes over
  // this across an `await` boundary, and TypeScript does not carry a
  // mutable binding's narrowing into a nested closure.
  const resolveAdlYml: (feature: FeaturesTable) => AdlYml =
    options.resolveAdlYml ?? (await resolveProductionAdlYmlOrThrow());

  // D-13: kill any still-running orphan from a previous daemon process
  // *before* expiring leases — `killBootOrphans` needs `lease_owner`'s PID
  // while it is still populated; expiring first would lose it.
  await killBootOrphans({ db, logger });
  await expireAllLeasesAtBoot(db, logger);

  const staleRejectionCounter = createStaleRejectionCounter();
  // The dispatch brake (D-26, 03-07 Task 2) — one instance for this daemon
  // process's lifetime. The global flag is restored here (G-03-3,
  // 03-10-PLAN.md), after the schema gate and repo reconciliation and
  // before the supervisor is created, the API binds, or the first dispatch
  // tick runs — a restore landing after the first tick would dispatch
  // exactly the work the operator stopped.
  const initialGlobalPause = await restoreGlobalPause({ db, logger });
  const controlState = createControlState({ db, initialGlobalPause });

  // 04-06: the model credential, read once from the daemon's own environment
  // and forwarded to every forked worker — the one place `process.env` is
  // read for this purpose, so `worker-entry/stage-runner.ts` never has to
  // (WORK-06's discipline, extended to the manager<->worker seam). Absent
  // when unset, matching every other optional credential path in this
  // codebase — a missing key surfaces as an honest `auth` StageError from
  // the agent's own invocation, never a silent skip.
  const workerEnv: Record<string, string> = { ...options.workerEnv };
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) {
    workerEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
  }

  // 04-07 (D-01, D-02): the backend startup gate. Runs exactly once, after
  // the schema gate and repo reconciliation, and — the one placement
  // constraint that actually matters — strictly BEFORE the supervisor is
  // created, the API server binds, or `dispatchTimer` starts, so a refused
  // daemon never leases and forks a feature against a backend that cannot
  // work. `options.agentBackendVersionCheck` absent skips this gate
  // entirely (see the option's own docblock for why that is the safe
  // default rather than an unconditional real `claude --version` call).
  const configuredBackendId =
    options.daemonConfig.agents.developer?.backend ??
    DEFAULT_CONFIG.agents.developer.backend;
  if (options.agentBackendVersionCheck !== undefined) {
    const backendPreflight = await runBackendPreflight({
      backendId: configuredBackendId,
      runVersionCheck:
        configuredBackendId === SUPPORTED_BACKEND_ID
          ? options.agentBackendVersionCheck
          : undefined,
      logger,
    });
    if (backendPreflight.kind === 'refused') {
      await db.destroy();
      throw new BackendUnavailableError(backendPreflight.refusal);
    }
  }

  // Captured once, in this scope, so the closures below (`onDeveloperCommitted`
  // and `runDispatchOnce`'s own `forge` field) both see a narrowed, defined
  // value — a plain `options.forge !== undefined` check inline in an object
  // literal does not narrow `options.forge` itself inside a nested closure.
  const configuredForge = options.forge;

  const supervisor = createSupervisor({
    entryPath: options.workerEntryPath ?? DEFAULT_WORKER_ENTRY_PATH,
    cwd: options.workerCwd ?? process.cwd(),
    execArgv: options.workerExecArgv,
    workerEnv,
    logger,
    leaseTtlMs: options.leaseTtlMs,
    renewLease: (params) => featuresRepository(db).renewLease(params),
    getCurrentLeaseToken: async (featureId) => {
      const row = await featuresRepository(db).findById(featureId);
      return row?.lease_token ?? null;
    },
    staleRejectionCounter,
    onReady: (ready) => {
      void recordLeaseOwnerOnReady(db, ready, logger);
      options.onWorkerReady?.(ready);
    },
    // D-04's fast path: a forked worker exited without an accepted result.
    // `createFastPathRecovery` re-reads the row (it may have moved since the
    // fork started) and hands it to `reapOne` — the same function the
    // reaper's own tick calls — whose `expectedLeaseToken` guard makes this a
    // safe no-op if the lease was already reassigned by the time this exit
    // is observed.
    onUnexpectedExit: createFastPathRecovery({ db, logger }),
    // D-26's round boundary: an accepted stage_result means the round is
    // done; if dispatch is paused for this feature's repository right now,
    // park it there rather than mid-round.
    onRoundBoundary: (params) => {
      void parkOnRoundBoundary(
        db,
        controlState,
        params.featureId,
        params.repoId,
        'pause-park',
      );
    },
    // M05 steps 5.10 and 5.11: a real commit reported for a feature, with a
    // forge configured — open (or confirm already-open) its draft change
    // request, then republish the developer's sticky comment against it.
    // Absent `options.forge`, no callback at all: the same "absent means
    // skip" shape the poll schedule below already uses, and this daemon's
    // only forge-aware callback besides it.
    ...(configuredForge !== undefined
      ? {
          onDeveloperCommitted: (params: {
            feature: FeaturesTable;
            roundId: string;
            stageId: string;
            sha: string;
          }) => {
            void publishOnDeveloperCommitted(
              {
                db,
                logger,
                forge: configuredForge.adapter,
                forgeRepo: configuredForge.repo,
              },
              params,
            );
          },
        }
      : {}),
    // M05 step 5.13: the round loop. Wired unconditionally — unlike the
    // publish hooks above, advancing a round is not a forge-dependent bonus
    // but the loop itself, and a daemon that leased a feature and ran a stage
    // owes that feature a decision whether or not a forge is configured.
    // `options.forge` only decides whether a green round can also promote its
    // change request to ready (FORGE-05).
    onStageCompleted: (params) =>
      onStageCompleted(
        {
          db,
          logger,
          ...(configuredForge !== undefined
            ? {
                forge: {
                  adapter: configuredForge.adapter,
                  repo: configuredForge.repo,
                },
              }
            : {}),
        },
        params,
      ),
    // 04-10, D-06: the one INSERT path for a `usage_events` row — through
    // the existing `usageRepository(db).record`, never a second writer. The
    // supervisor has already fenced the message and resolved the feature id
    // from its own assignment before this is called.
    recordUsage: async (params) => {
      await usageRepository(db).record({
        id: ulid(),
        feature_id: params.featureId,
        round_id: params.roundId,
        stage_attempt_id: params.stageAttemptId,
        model_id: params.modelId,
        speed: params.speed,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        cache_creation_input_tokens: params.cacheCreationInputTokens,
        cache_read_input_tokens: params.cacheReadInputTokens,
        cost_usd: params.costUsd,
        cost_source: params.costSource,
        cost_category: params.costCategory,
        at: nowIso(),
      });
    },
    // CR-01: the one place `stage_attempts.ended_at`/terminal `status` is
    // written from production, through `bookkeeping/attempt.ts`'s
    // `closeAttempt` — never a second writer. Without this, `GET
    // /stages/:id/logs?follow=1`'s `isAttemptEnded` gate can never see a
    // real run finish, and `adl logs -f` never terminates on its own.
    closeAttempt: (params) =>
      closeAttempt(
        { db },
        { stageAttemptId: params.stageAttemptId, status: params.status },
      ),
  });

  const reaper = startReaper({
    db,
    logger,
    intervalMs: options.heartbeatIntervalMs,
  });

  // Phase 2's deferred D-15 backstop, on a schedule of its own (D-34): a
  // separate, much longer cadence than the reaper's, sharing only the
  // scheduling mechanism (croner) — never the interval.
  const gcSchedule = startGcSchedule({
    mainRepo,
    db,
    logger,
    intervalMs: options.daemonConfig.gc.interval_ms,
  });

  // 05-05 (DETECT-03): the polling detection loop, on a schedule of its own
  // — a much shorter cadence than the GC sweep's, sharing only the
  // scheduling mechanism (croner), never the interval. Skipped entirely when
  // `options.forge` is absent — see that option's own docblock for why that
  // is the safe default rather than requiring live GitHub App credentials
  // every `startDaemon()` call site would otherwise need.
  const pollSchedule =
    options.forge !== undefined
      ? startPollSchedule({
          mainRepo,
          scratchRoot,
          db,
          logger,
          forge: options.forge.adapter,
          forgeRepo: options.forge.repo,
          intervalMs: options.daemonConfig.poll.interval_ms,
        })
      : undefined;

  async function listFeatureViews(): Promise<readonly FeatureView[]> {
    // One clock read for the whole request (D-24) — every row's `ageMs` in
    // this response is computed against the exact same instant, so a
    // feature's age is never a moving target within one `GET /features`.
    const now = Date.now();
    const rows = await db
      .selectFrom('features')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((row): FeatureView => {
      const active = supervisor.get(row.id);
      return {
        id: row.id,
        repoId: row.repo_id,
        path: row.path,
        state: row.state,
        stage: resolveStageCell(row),
        round: row.round,
        ageMs: now - Date.parse(row.updated_at),
        worker: active ? { pid: active.worker.pid } : null,
        staleRejections: staleRejectionCounter.forFeature(row.id),
      };
    });
  }

  // Set below, once `stop` itself exists — the HTTP route needs to trigger
  // the exact same shutdown sequence `DaemonHandle.stop()` does, and `stop`
  // is declared after the app it is wired into (it closes `server`). A
  // holder object rather than a reassigned `let`, so the binding itself
  // stays a `const` — only `.current` ever changes.
  const shutdownRef: { current?: () => void } = {};

  // 04-06: the directory transcripts live under — computed once, beside the
  // database file, and threaded onto every assign message (`DispatcherDeps.logsRoot`)
  // so the worker (which cannot import `@adl/db` and therefore cannot see
  // `dbFilePath` itself) resolves the IDENTICAL root the manager's own
  // `GET /stages/:id/logs` route reads from below — real regardless of
  // whether `scratchRoot` happens to be colocated with the database file.
  const logsRoot = logsRootFor(options.dbFilePath);

  // 04-06: one dispatch attempt, built once so `tick()`'s background timer
  // and `POST /dev-run/:featureId`'s synchronous call are the SAME function
  // — never two assemblies of `DispatcherDeps` that could drift apart.
  async function runDispatchOnce() {
    return dispatchOnce({
      db,
      leaseTtlMs: options.leaseTtlMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      daemonConfig: options.daemonConfig,
      resolveAdlYml,
      controlState,
      logger,
      mainRepo,
      scratchRoot,
      logsRoot,
      spawnWorker: ({ feature, leaseToken, assign }) => {
        supervisor.spawn(feature, leaseToken, assign);
      },
      // M05 step 5.10: absent unless the configured forge also carries a
      // `pushCredential` — `adapter`/`repo` alone (5.5's read-only poll
      // schedule) are not enough to publish anything.
      ...(configuredForge?.pushCredential !== undefined
        ? { forge: { pushCredential: configuredForge.pushCredential } }
        : {}),
    });
  }

  const app = createApi({
    apiToken: options.apiToken,
    schemaVersion: DAEMON_SCHEMA_VERSION,
    listFeatureViews,
    db,
    controlState,
    supervisor,
    workerStopGraceMs: options.daemonConfig.worker_stop_grace_ms,
    logger,
    mainRepo,
    onShutdownRequested: () => shutdownRef.current?.(),
    dispatchOnce: runDispatchOnce,
    logsRoot,
  });

  const server: ServerType = await new Promise((resolve) => {
    const instance = serve(
      { fetch: app.fetch, hostname: host, port: options.port },
      () => resolve(instance),
    );
  });
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null
      ? address.port
      : options.port;

  async function tick(): Promise<void> {
    try {
      await runDispatchOnce();
    } catch (error) {
      logger.error({ err: error }, 'dispatch tick failed');
    }
  }

  const dispatchTimer = setInterval(() => {
    void tick();
  }, options.dispatchIntervalMs ?? 25);

  async function stop(): Promise<void> {
    gcSchedule.stop();
    pollSchedule?.stop();
    // D-37: stop dispatch, then every worker with a real grace window
    // (soft_stop over IPC, SIGKILL after worker_stop_grace_ms — Pattern 2,
    // never an OS SIGTERM), then close the server, then flush.
    await gracefulShutdown({
      supervisor,
      reaper,
      dispatchTimer,
      server,
      db,
      workerStopGraceMs: options.daemonConfig.worker_stop_grace_ms,
      logger,
    });
  }

  shutdownRef.current = () => void stop();

  return { host, port: boundPort, supervisor, stop };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  await handle.stop();
}
