/**
 * `@adl/plugin-sdk` — the one small, stable package a third-party ADL gate
 * depends on.
 *
 * **Everything here is a re-export.** This package defines no schema of its own,
 * and that is the entire point. Two definitions of `Verdict` living in two
 * packages is a divergence waiting to happen: the day someone adds a field to
 * one and not the other, a harness starts emitting output that validates on its
 * side and fails on ADL's, and the error message will be about a missing
 * property rather than about the real cause. A re-export is one definition
 * reachable from two import paths (01-RESEARCH.md § Open Questions 4).
 *
 * `packages/plugin-sdk/test/reexport-identity.test.ts` asserts **reference
 * identity** — not structural equality — for exactly this reason. A structural
 * assertion would still pass after someone duplicated a definition.
 *
 * Why this package exists separately from `@adl/core` at all, and this early:
 * `@adl/core` is where eleven phases of internal contracts accumulate. A harness
 * author should not have to depend on the state machine, the config resolver, or
 * the spec loader to write a gate. Splitting now costs one file; splitting after
 * eleven phases have imported from `core` costs an audit of every import in the
 * repository (D-25).
 */

export {
  // Criterion identity — what a finding, or a pass verdict's coverage, points at.
  CriterionIdSchema,
  type CriterionId,
  GlobalCategorySchema,
  type GlobalCategory,
  CriterionRefSchema,
  type CriterionRef,

  // Waivers — a human's recorded acceptance that a gate was not satisfied.
  WaiverTargetSchema,
  type WaiverTarget,
  WaiverSchema,
  type Waiver,

  // Findings — one thing a gate found wrong, always tied to a criterion or a category.
  SeveritySchema,
  type Severity,
  FindingLocationSchema,
  type FindingLocation,
  FindingSchema,
  type Finding,
  fingerprintFinding,
  type FingerprintInput,
  sortFindings,

  // Verdicts — the six outcomes, and nothing else.
  OUTCOMES,
  type Outcome,
  VerdictSchema,
  type Verdict,
  PassVerdictSchema,
  type PassVerdict,
  SendBackVerdictSchema,
  type SendBackVerdict,
  FailVerdictSchema,
  type FailVerdict,
  InconclusiveVerdictSchema,
  type InconclusiveVerdict,
  WarnVerdictSchema,
  type WarnVerdict,
  SkipVerdictSchema,
  type SkipVerdict,
  consumesRound,
} from '@adl/core/verdict';

export {
  // The infrastructure-failure channel. Outside the verdict union, deliberately
  // and permanently (D-12, CORE-06): a gate that broke did not judge, and must
  // never cost the developer a round.
  StageErrorSchema,
  type StageError,
  StageErrorKindSchema,
  type StageErrorKind,
  STAGE_ERROR_KINDS,
  type StageOutcome,
  isStageError,
  stageErrorPolicy,
  type StageErrorPolicy,
  isTransientStageErrorKind,

  // The gate interface itself — what the built-in reviewer and behaviour tester
  // are also implemented against, with no special-casing (HARN-04).
  type Stage,
  type StageContext,
  type StageKind,
  type CostClass,
  type LogChunk,

  // `Workspace` is a forward declaration until Phase 2 lands the real interface.
  type Workspace,
  type FeatureView,
  type StageConfig,
  type AgentRunner,
  type ArtifactSink,
  type RoundSummary,
} from '@adl/core/stage';
