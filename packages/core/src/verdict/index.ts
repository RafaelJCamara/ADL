export { LoadError, type SourcePosition } from '../errors.js';
export { sha256Hex } from '../hash.js';

export {
  CriterionIdSchema,
  type CriterionId,
  GlobalCategorySchema,
  type GlobalCategory,
  CriterionRefSchema,
  type CriterionRef,
} from './criterion-ref.js';

export {
  WaiverTargetSchema,
  type WaiverTarget,
  WaiverSchema,
  type Waiver,
} from './waiver.js';

export {
  SeveritySchema,
  type Severity,
  FindingLocationSchema,
  type FindingLocation,
  FindingSchema,
  type Finding,
  type FingerprintInput,
  normaliseTitle,
  fingerprintFinding,
  sortFindings,
} from './finding.js';

export {
  OUTCOMES,
  type Outcome,
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
  VerdictSchema,
  type Verdict,
  consumesRound,
} from './verdict.js';

export {
  SendBackBriefSchema,
  type SendBackBrief,
  GreenOutcomeSchema,
  type GreenOutcome,
  SendBackOutcomeSchema,
  type SendBackOutcome,
  EscalateOutcomeSchema,
  type EscalateOutcome,
  UnverifiedOutcomeSchema,
  type UnverifiedOutcome,
  RoundOutcomeSchema,
  type RoundOutcome,
} from './round-outcome.js';

export { aggregate } from './aggregate.js';
