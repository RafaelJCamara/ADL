/**
 * `@adl/manager` — the control plane.
 *
 * This package owns everything that must be singular: the lease queue, worker
 * supervision, the HTTP API, config, credentials, and round/budget accounting
 * (per `.planning/PROJECT.md` § Manager/worker shape). It is the only package
 * that writes to `@adl/db`.
 *
 * Later plans in this phase add the reaper, the fencing/recovery policy, the
 * daemon config loader, and the rest of the HTTP surface to this barrel, each
 * with a "why public" comment in the style `@adl/workspace`'s barrel
 * establishes.
 */

// Daemon lifecycle — startup wiring and the handle a caller stops.
export {
  startDaemon,
  stopDaemon,
  type DaemonHandle,
  type StartDaemonOptions,
} from './daemon.js';

// The Hono app factory — exported so a test can mount it directly (against an
// ephemeral port) without going through the full daemon startup sequence.
export { createApi, UNAUTHENTICATED_PATHS, type ApiDeps } from './api/app.js';
export type { FeatureView } from './api/routes/features.js';

// The control surface's request/response schemas and route registrar
// (D-20, D-26, D-27..29) — published so a CLI (`03-08`) or a test can
// construct requests against the exact same schema the routes validate.
export {
  ControlResultSchema,
  ControlScopeSchema,
  killFeature,
  KillRequestSchema,
  PauseRequestSchema,
  registerControlRoutes,
  type ControlResult,
  type ControlRoutesDeps,
  type ControlScope,
  type KillDeps,
  type KillRequest,
  type PauseRequest,
} from './api/routes/control.js';

// The worker-supervision seam — exported so a caller assembling its own
// daemon wiring (or a test) can construct one directly.
export {
  createSupervisor,
  type ActiveWorker,
  type GetCurrentLeaseToken,
  type RenewLease,
  type StaleMessage,
  type SupervisorDeps,
  type WorkerReady,
  type WorkerSupervisor,
} from './worker-supervisor/supervisor.js';

// D-06's message-level fence, and D-09's rejection counter. Published so a
// caller can construct the counter once and pass it to both `createSupervisor`
// and the status view — `daemon.ts` is that caller.
export {
  checkFence,
  createStaleRejectionCounter,
  type FenceMatch,
  type FenceStale,
  type FenceVerdict,
  type StaleRejectionCounter,
  type StaleRejectionSnapshot,
} from './fencing.js';

// The dispatch brake (D-26) and the shared pause/resume/kill transition
// helper — published so the routes, the round-boundary hook, and a test can
// all drive the same brake and apply the same write.
export {
  applyControlEvent,
  createControlState,
  GlobalPausePersistError,
  isDispatchPaused,
  parkOnRoundBoundary,
  type ControlState,
  type ControlStateDeps,
  type PauseScope,
} from './control/state.js';

// The scheduler — one dispatch attempt at a time (D-15..17).
export {
  dispatchOnce,
  type DispatchDecision,
  type DispatcherDeps,
  type SpawnCall,
} from './scheduler/dispatcher.js';

// The GC schedule (D-15, D-34, 03-08 Task 3) — discharging Phase 2's
// deferred backstop trigger. `runGcOnce`/`createFeatureStateLookup` are
// published so a test can drive one pass directly against a temp database,
// the same way `dispatchOnce` and `reapOne` already are.
export {
  createFeatureStateLookup,
  runGcOnce,
  startGcSchedule,
  type GcRunDeps,
  type GcRunSummary,
  type GcScheduleDeps,
  type GcScheduleHandle,
} from './scheduler/gc-schedule.js';

// `POST /control/gc`'s route registrar (03-08 Task 3) — published so a test
// can mount it directly, matching every other route module's own export.
export { registerGcRoute, type GcRouteDeps } from './api/routes/gc.js';

// The stage cell (D-22..25, 03-08 Task 1) — resolving a feature row's
// position in its own snapshotted pipeline into what `GET /features` and
// `adl status` render. Published so a test can drive it directly against a
// bare row, with no HTTP or database in the loop.
export {
  pipelineFromEffectiveConfig,
  resolveStageCell,
  type StageCell,
  type StageCellInput,
} from './stage-name.js';

// The lease-expiry backstop and the child-exit fast path's shared
// implementation (D-03, D-04). Exported so a test can drive `reapOne` and
// `reapExpiredLeases` directly against a temp database, the same way
// `dispatchOnce` already is.
export {
  createFastPathRecovery,
  reapExpiredLeases,
  reapOne,
  resetCrashCountOnSuccess,
  startReaper,
  type ReapedFeature,
  type ReaperDeps,
  type ReaperHandle,
  type ReapOutcome,
  type StartReaperDeps,
} from './scheduler/reaper.js';

// The crash-recovery policy (D-10, D-11) — a pure decision, published so a
// test (or a later plan's stage-completion write site) can drive it
// directly without going through the reaper.
export {
  MAX_CONSECUTIVE_CRASHES,
  planRecovery,
  type EscalateDecision,
  type RecoverDecision,
  type RecoveryDecision,
  type RecoveryInput,
} from './recovery/policy.js';

// The manager<->worker IPC contract (D-01, D-06). Published because the
// worker entry, the supervisor, and any out-of-tree test double all need the
// same message shapes — the schemas are the one definition, not three.
export {
  AssignMessageSchema,
  FatalMessageSchema,
  HeartbeatMessageSchema,
  IPC_MESSAGE_KINDS,
  LeaseLostMessageSchema,
  ManagerToWorkerMessageSchema,
  parseManagerMessage,
  parseWorkerMessage,
  ReadyMessageSchema,
  SoftStopMessageSchema,
  StageResultMessageSchema,
  WorkerToManagerMessageSchema,
  type AssignMessage,
  type FatalMessage,
  type HeartbeatMessage,
  type IpcMessageKind,
  type IpcParseFailure,
  type LeaseLostMessage,
  type ManagerMessageParseResult,
  type ManagerToWorkerMessage,
  type ReadyMessage,
  type SoftStopMessage,
  type StageResultMessage,
  type WorkerMessageParseResult,
  type WorkerToManagerMessage,
} from './ipc/protocol.js';

// The daemon config loader (D-19, D-36 as amended by 03-04's checkpoint) —
// file I/O around the extended `DaemonConfigSchema`, published so a CLI
// entry point (a later plan) can call it directly.
export {
  DaemonConfigError,
  DaemonConfigSchema,
  DEFAULT_DAEMON_CONFIG_PATH,
  ensureDaemonConfig,
  loadDaemonConfig,
  mintApiToken,
  resolveDaemonConfigPath,
  type DaemonConfigInvalid,
  type DaemonConfigLoaded,
  type DaemonConfigLoadResult,
  type DaemonConfigNotFound,
} from './config/daemon-config.js';

// The startup gate (D-37) — schema-version refuse/copy-then-migrate, and
// repository reconciliation (D-35). Published so a CLI entry point (a later
// plan's `adl daemon start`) can inspect `DAEMON_SCHEMA_VERSION` directly
// (e.g. for `adl --version`-style output) without going through the full
// `startDaemon` sequence.
export {
  DAEMON_SCHEMA_VERSION,
  reconcileRepos,
  resolveMigrationsDir,
  restoreGlobalPause,
  runStartupGate,
  SchemaVersionRefusalError,
  type ReconcileReposDeps,
  type RestoreGlobalPauseDeps,
  type SchemaVersionRefusal,
  type StartupGateDeps,
  type StartupGateProceeded,
  type StartupGateRefused,
  type StartupGateResult,
} from './boot/startup.js';

// The boot-time orphan kill (D-13, D-14) — `lease_owner`'s PID+start-time
// encoding, published so a test double or a future status view can decode
// it without re-deriving the shape.
export {
  decodeLeaseOwner,
  encodeLeaseOwner,
  killBootOrphans,
  readProcessStartTime,
  type KillBootOrphansDeps,
  type LeaseOwnerRecord,
  type OrphanKillOutcome,
  type ProcessStartTimeResult,
} from './boot/orphans.js';

// Graceful shutdown (D-37, D-28).
export { gracefulShutdown, type ShutdownDeps } from './boot/shutdown.js';

// The per-worker stop escalation (D-28 as amended) — the single
// implementation `gracefulShutdown` and `adl kill` (D-27..29, 03-07 Task 3)
// both share, so the soft_stop-then-SIGKILL behaviour cannot drift apart.
export {
  stopAllWorkers,
  stopWorker,
  type StopOutcome,
} from './worker-supervisor/lifecycle.js';

// The worker entry module's internals (`runWorker`, `StageRunner`, ...) are
// deliberately NOT exported here — same reasoning as `env.ts` being
// unexported from `@adl/workspace`'s barrel: it is an implementation detail
// of the one caller that forks it by path, not something that is imported.
