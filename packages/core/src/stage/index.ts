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
