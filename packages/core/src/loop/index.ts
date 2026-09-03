/**
 * `@adl/core/loop` — the round loop's pure decision layer (LOOP-01).
 *
 * One function. Given the stage that just finished and what it reported, it
 * says which lifecycle events that raises and whether the round is over. The
 * database half lives in `@adl/manager`'s `loop/round-runner.ts`; the state
 * change itself still belongs to `@adl/core/state`'s `transition()`, which
 * this module feeds rather than replaces.
 */
export {
  planRoundStep,
  type AdvanceStep,
  type CompleteStep,
  type RetryStep,
  type RoundStep,
  type RoundStepInput,
  type StageCompletion,
} from './round-step.js';

// Protected-path enforcement (ROLE-11, M05 step 5.16) — pure, and the only
// half of the check `@adl/core` can own: it classifies a diff `@adl/manager`'s
// `loop/protected-paths-check.ts` computed, and reads no git history itself.
export {
  GATE_CONFIG_PATH,
  matchesGlob,
  violatedProtectedPaths,
  type ProtectedPathsInput,
} from './protected-paths.js';

// Stalemate detection over repeated finding fingerprints (LOOP-06, M06 step
// 6.6) — pure, and the only half `@adl/core` can own: it counts against a
// fingerprint-history read `@adl/manager`'s `loop/stalemate-check.ts`
// computed, and reads no database itself.
export {
  detectStalemate,
  type DetectStalemateInput,
  type StalledFinding,
} from './stalemate.js';

// Provider-failure backoff, decoupled from the crash-count ceiling (LOOP-07,
// M06 step 6.7) — pure, and the only half `@adl/core` can own: it decides from
// a `StageErrorKind` and a count `@adl/manager`'s `loop/transient-retry.ts`
// read off `stage_attempts`, and reads neither a database nor a clock itself.
export {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  TRANSIENT_BACKOFF_BASE_MS,
  TRANSIENT_BACKOFF_CEILING_MS,
  planTransientRetry,
  transientBackoffMs,
  type TransientRetryDecision,
  type TransientRetryInput,
} from './transient-retry.js';

// The `on_send_back` policy (HARN-03, M07 step 7.2) — cost-class defaults with
// an `adl.yml` override, and pure for the same reason every other module here
// is: it reads a `ResolvedStage` the caller already resolved, and no config
// file, database or clock of its own.
export {
  DEFAULT_COST_CLASS,
  costClassOf,
  onSendBackFor,
} from './send-back-policy.js';

// LOOP-09 (M07 step 7.8) — findings raised after a gate's own first look become
// follow-ups rather than fresh send-backs. Pure for the reason every module
// here is: the caller supplies the resolved stage and the fingerprint history
// it read, and this reads no database of its own.
export {
  DEFAULT_JUDGEMENT_KIND,
  applyFollowUpPolicy,
  judgementKindOf,
  type FollowUpDecision,
  type FollowUpPolicyInput,
  type JudgementKind,
} from './follow-up-policy.js';
