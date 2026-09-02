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
export type { FeatureView, FeatureSpendView } from './api/routes/features.js';

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

// The polling detection loop (DETECT-03, M05 step 5.5) — the first
// production caller of 5.2's `undevelopedFeatures` and 5.3's
// `evaluateFeatureTrust`. `runPollOnce` is published so a test can drive one
// pass directly against a temp database, the same way `runGcOnce` already is.
export {
  runPollOnce,
  startPollSchedule,
  type PollFailure,
  type PollRejection,
  type PollRunDeps,
  type PollRunSummary,
  type PollScheduleDeps,
  type PollScheduleHandle,
} from './scheduler/poll-schedule.js';

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

// The production `resolveAdlYml` gate (05-04) — published so a test (or a
// future `adl doctor`-style entry point) can drive it directly without
// standing up a full `startDaemon`, mirroring the backend preflight gate's
// own export shape exactly.
export {
  ADL_YML_PATH,
  AdlYmlUnavailableError,
  resolveProductionAdlYml,
  type AdlYmlRefused,
  type AdlYmlResolutionOutcome,
  type AdlYmlResolutionRefusal,
  type AdlYmlResolved,
  type ResolveProductionAdlYmlDeps,
} from './config/resolve-adl-yml.js';

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

// The bookkeeping module (04-04 Task 2) — the one place a round and a stage
// attempt are opened and closed, and the DB-backed resolution a stage
// attempt id must go through before it becomes a filesystem path (T-4-15).
// Published so the dispatcher, the transcript route (04-08), and the usage
// writer (04-10) all call the same functions rather than each growing their
// own insert.
export {
  closeAttempt,
  findAttempt,
  isAttemptEnded,
  openAttempt,
  type AttemptAddress,
  type AttemptDeps,
  type CloseAttemptInput,
  type OpenAttempt,
  type OpenAttemptInput,
  type TerminalAttemptStatus,
} from './bookkeeping/attempt.js';

// The transcript path builder (04-05 Task 1) — the deterministic
// `logs/<feature>/<round>/<stage>/<attempt>.ndjson` location for one stage
// attempt (`ARCHITECTURE.md` §4). Published because both the worker (which
// writes a transcript) and the manager's HTTP route (04-08, which reads one)
// need the identical path for the identical address — a second computation
// of "the same" path is how the two end up disagreeing.
export {
  logsRootFor,
  transcriptPathFor,
  TRANSCRIPT_EXTENSION,
  TranscriptAddressError,
  type TranscriptAddress,
} from './store/transcript-path.js';

// The NDJSON transcript store (04-05 Task 2) — the byte-offset
// append/read primitive `ARCHITECTURE.md` §9's `?offset=N&follow=1` addressing
// depends on. Published for the same two consumers as `transcriptPathFor`
// above: the worker appends through `openTranscriptWriter` as `AgentEvent`s
// arrive, and the manager's transcript route (04-08) reads through
// `readTranscriptFrom`/`transcriptLength`. They must agree on what an offset
// means, which is exactly what sharing this one implementation guarantees.
// `readTranscriptTail` (M06 step 6.8) joins them as a third reader with a
// different question — "the end of this file", not "everything after this
// offset" — for the escalation comment's transcript excerpt. It lives beside
// the other two rather than in `publish/` for the reason this whole module
// exists: one implementation of what a transcript line is, shared by everyone
// who reads one.
export {
  openTranscriptWriter,
  readTranscriptFrom,
  readTranscriptTail,
  transcriptLength,
  TranscriptOffsetError,
  type TranscriptRead,
  type TranscriptWriter,
} from './store/ndjson-log-store.js';

// The worker entry module's internals (`runWorker`, `StageRunner`,
// `createProductionStageRunner`, ...) are deliberately NOT exported here —
// same reasoning as `env.ts` being unexported from `@adl/workspace`'s
// barrel: they are implementation details of the one caller that forks the
// module by path, not something that is imported.

// `PromptBuilder` (04-06, extended 04-09 Task 1 with the declared-context-files
// surface) — the one module that renders a developer prompt; adapters never
// build prompts (`ARCHITECTURE.md` §4). Published so a test (and `04-09`'s
// persisted-artefact/byte-identity proof) can call it directly without going
// through a full stage run.
export {
  buildDeveloperPrompt,
  DEVELOPER_SYSTEM_PROMPT,
  PromptContextFileError,
  PromptContextOverflowError,
  type DeveloperPromptInput,
  type RenderedPrompt,
} from './prompt/build.js';

// The persisted prompt artefact (04-09 Task 2) — a sibling of the
// transcript, written before the agent is launched. Published for the same
// two reasons `transcriptPathFor`/`openTranscriptWriter` are: the
// determinism test (Task 3) compares two attempts' artefacts directly off
// disk, and Phase 9's pull-request rollup will want the same pointer.
export {
  PROMPT_ARTIFACT_EXTENSION,
  PromptArtifactConflictError,
  promptArtifactPathFor,
  writePromptArtifact,
  type PromptArtifactContent,
} from './prompt/artifact.js';

// `POST /dev-run/:featureId` (04-06, D-03) — published so a test can mount
// it directly, matching every other route module's own export.
export {
  DevRunResultSchema,
  registerDevRunRoutes,
  type DevRunResult,
  type DevRunRoutesDeps,
} from './api/routes/dev-run.js';

// The features/ scanner's I/O half (5.1, DETECT-01) — published so a test can
// drive it directly against a real ManagerGitClient, and so 5.2's undeveloped
// predicate can consume its output.
export { listFeatureFolders } from './detect/scanner.js';

// The undeveloped predicate's I/O half (5.2, DETECT-01) — published so a
// test can drive it directly against a real FeaturesRepository and
// ForgeAdapter, and so 5.5's polling loop (not yet built) has a stable
// import path.
export {
  undevelopedFeatures,
  type UndevelopedFeaturesInput,
} from './detect/undeveloped.js';

// The trusted-path filter's I/O half (5.3, SPEC-06) — published so a test
// can drive it directly against a real ForgeAdapter, and so 5.5's polling
// loop (not yet built) has a stable import path.
export {
  evaluateFeatureTrust,
  type EvaluateFeatureTrustInput,
  type FolderTrustResult,
} from './detect/trust.js';

// The publish hook's I/O half (5.10, FORGE-05) — published so a test can
// drive it directly against a real ForgeAdapter, and so `daemon.ts`'s
// `onDeveloperCommitted` wiring has a stable import path.
export {
  publishDraftChangeRequest,
  type PublishDraftChangeRequestDeps,
} from './publish/draft-cr.js';

// The branch every publish-side "which change request is this feature's?"
// question joins on (5.10, 5.13) — one definition, two callers.
export { changeRequestBranchFor } from './publish/branch.js';

// The escalation publish path (6.8, LOOP-08) — what reaches the change request
// when ADL stops and asks for a human. Published for the same reason
// `publishDraftChangeRequest` is: a test drives it directly against a real
// `ForgeAdapter`, and its two production callers (the round loop and the
// dispatcher's budget escalation) get a stable import path.
export {
  publishOnEscalation,
  type PublishOnEscalationDeps,
  type PublishOnEscalationParams,
} from './publish/on-escalation.js';
export {
  ESCALATION_COMMENT_KEY,
  ESCALATION_COMMENT_TITLE,
  MAX_TRANSCRIPT_EVENTS,
  renderEscalationComment,
  TRANSCRIPT_TAIL_BYTES,
  type EscalationCommentInput,
  type TranscriptExcerpt,
} from './publish/escalation-comment.js';
export {
  readEscalations,
  type Escalation,
} from './publish/escalation-history.js';

// FORGE-05's second half (5.13): promote the draft once a round comes back
// green. Published for the same reason `publishDraftChangeRequest` is.
export { promoteChangeRequestToReady } from './publish/promote.js';

// The round loop (5.13, LOOP-01) — the database half of `@adl/core/loop`'s
// decision, published so a test can drive one turn of the loop directly and
// so `daemon.ts`'s `onStageCompleted` wiring has a stable import path.
export {
  onStageCompleted,
  type RoundRunnerDeps,
  type StageCompletedParams,
} from './loop/round-runner.js';

// `resolvePipeline`'s one production caller (5.13) — the snapshotted pipeline
// both `dispatchOnce` and the round loop read, resolved the same way once.
export { resolveSnapshotPipeline, type SnapshotPipeline } from './pipeline.js';

// The `stage_result` wire envelope and its validated reader (5.13). Published
// so a scripted worker double in a test builds the SAME shape a real worker
// sends, rather than a hand-written object that could drift from it.
export {
  parseStageRunnerVerdict,
  StageRunnerVerdictSchema,
  type StageRunnerVerdict,
  type StageRunnerVerdictParseResult,
} from './ipc/stage-verdict.js';

// `GET /stages/:id/logs?offset=N&follow=1` (04-06 history, 04-08 follow loop)
// — published for the same reason every other route module is: so a test can
// mount it directly. `TRANSCRIPT_POLL_INTERVAL_MS`/`LOG_STREAM_EVENTS` are
// published because a CLI client (04-08's `adl logs -f`) branches on the
// exact same wire vocabulary the route emits — one definition, not two.
export {
  LOG_STREAM_EVENTS,
  registerLogsRoute,
  TRANSCRIPT_POLL_INTERVAL_MS,
  type LogsRouteDeps,
  type LogStreamEventName,
} from './api/routes/logs.js';
