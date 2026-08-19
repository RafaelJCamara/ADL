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

// The scheduler — one dispatch attempt at a time (D-15..17).
export {
  dispatchOnce,
  type DispatchDecision,
  type DispatcherDeps,
  type SpawnCall,
} from './scheduler/dispatcher.js';

// The lease-expiry backstop and the child-exit fast path's shared
// implementation (D-03, D-04). Exported so a test can drive `reapOne` and
// `reapExpiredLeases` directly against a temp database, the same way
// `dispatchOnce` already is.
export {
  createFastPathRecovery,
  reapExpiredLeases,
  reapOne,
  startReaper,
  type ReapedFeature,
  type ReaperDeps,
  type ReaperHandle,
  type ReapOutcome,
  type StartReaperDeps,
} from './scheduler/reaper.js';

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

// The worker entry module's internals (`runWorker`, `StageRunner`, ...) are
// deliberately NOT exported here — same reasoning as `env.ts` being
// unexported from `@adl/workspace`'s barrel: it is an implementation detail
// of the one caller that forks it by path, not something that is imported.
