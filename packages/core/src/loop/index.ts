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
