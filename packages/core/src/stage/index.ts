/**
 * `@adl/core/stage` — what a gate is, what it may return, and what it means
 * when it breaks.
 *
 * Three things live here, and they are deliberately three:
 *
 * - `Verdict` (in `../verdict/`) — the gate judged.
 * - `StageError` — the gate broke. Outside the verdict union entirely (D-12).
 * - `DeveloperOutcome` — the developer reported on its own work, and structurally
 *   cannot approve it (D-05).
 *
 * `@adl/plugin-sdk` republishes this surface; it defines nothing of its own.
 */
export {
  STAGE_ERROR_KINDS,
  type StageErrorKind,
  StageErrorKindSchema,
  StageErrorSchema,
  type StageError,
  type StageOutcome,
  isStageError,
  type StageErrorPolicy,
  isTransientStageErrorKind,
  stageErrorPolicy,
  NON_TRANSIENT_ESCALATION_THRESHOLD,
  shouldEscalate,
  RAW_REF_HEAD_BYTES,
  RAW_REF_TAIL_BYTES,
  rawRefElisionMarker,
  capRawOutput,
  MAX_REPAIR_ATTEMPTS,
  type RepairReprompt,
  type ParseStageOutputResult,
  parseStageOutput,
  type CriterionRefTarget,
  type UnknownCriterionFlag,
  type CriterionRefReconciliation,
  reconcileCriterionRefs,
} from './stage-error.js';

export {
  DEVELOPER_OUTCOME_KINDS,
  type DeveloperOutcomeKind,
  DisputeTargetSchema,
  type DisputeTarget,
  DisputeSchema,
  type Dispute,
  CommittedOutcomeSchema,
  type CommittedOutcome,
  DisputeOutcomeSchema,
  type DisputeOutcome,
  BlockedOutcomeSchema,
  type BlockedOutcome,
  DeveloperOutcomeSchema,
  type DeveloperOutcome,
  DEVELOPER_OUTCOME_ROUND_COST,
} from './developer-outcome.js';

// The workspace a stage runs inside — exec, read, write, snapshot — plus the
// shape of one process run. Declared in `./workspace.ts` and re-exported through
// `./stage.ts`, so `@adl/core/stage` stays the single import path (D-01).
export {
  NETWORK_POLICIES,
  type NetworkPolicy,
  type ResourceLimits,
  type ExecSpec,
  type ExecResult,
  type RestoreHandle,
} from './workspace.js';

// The AgentRunner port — the only way a stage calls a model (BACK-01). Real
// interfaces and schemas live in `./agent.ts`; declared here (not in
// `./stage.ts`) for the same reason `Workspace` is, and re-exported through
// `./stage.ts` so `StageContext.agents` needs no edit. Published through
// `@adl/plugin-sdk` alongside the rest of the gate surface a harness author
// depends on.
export {
  AGENT_EVENT_KINDS,
  type AgentEventKind,
  AgentCapabilitiesSchema,
  type AgentCapabilities,
  StartedEventSchema,
  type AgentStartedEvent,
  TextEventSchema,
  type AgentTextEvent,
  ThinkingEventSchema,
  type AgentThinkingEvent,
  ToolCallEventSchema,
  type AgentToolCallEvent,
  ToolResultEventSchema,
  type AgentToolResultEvent,
  AgentUsageSchema,
  type AgentUsage,
  UsageEventSchema,
  type AgentUsageEvent,
  AGENT_RESULT_OUTCOMES,
  type AgentResultOutcome,
  AgentResultOutcomeSchema,
  ResultEventSchema,
  type AgentResultEvent,
  ErrorEventSchema,
  type AgentErrorEvent,
  AgentEventSchema,
  type AgentEvent,
  AgentTaskSchema,
  type AgentTask,
  AgentRunResultSchema,
  type AgentRunResult,
  AgentProbeSchema,
  type AgentProbe,
  type AgentRunContext,
  TranscriptRecordSchema,
  type TranscriptRecord,
} from './agent.js';

// The backend side of the same port. A harness never sees these — it receives a
// `Workspace` — so they are deliberately NOT added to `@adl/plugin-sdk`, whose
// surface is scoped to what a third-party gate needs. An out-of-tree workspace
// backend implements `WorkspaceBackend` from here.
export type {
  WorkspaceSpec,
  WorkspaceBackend,
  ManagedWorkspace,
  WorkspaceTeardownReport,
} from './workspace.js';

export type {
  StageKind,
  CostClass,
  LogChunk,
  Workspace,
  FeatureView,
  StageConfig,
  AgentRunner,
  ArtifactSink,
  RoundSummary,
  StageContext,
  Stage,
} from './stage.js';

// What a GATE is given, and ROLE-03's guarantee that the list ends there (M05
// step 5.17). Deliberately NOT re-exported through `@adl/plugin-sdk`: that
// surface is the published third-party contract, and `StageContext` is its
// context type. See `./gate-context.ts`'s own docblock for why the two are not
// the same thing yet.
export {
  GATE_CONTEXT_MEMBERS,
  type GateContextMember,
  GATE_DIFF_MEMBERS,
  type GateDiffMember,
  type GateDiff,
  type GateContext,
} from './gate-context.js';
