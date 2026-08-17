/**
 * `@adl/core/state` — the feature lifecycle.
 *
 * One small fixed state machine plus one pure transition function. The gate
 * pipeline is deliberately absent from both: see the header of
 * `feature-state.ts` for why, and `transition.ts` for the mechanism.
 */
export {
  FEATURE_EVENT_KINDS,
  FEATURE_STATES,
  isTerminal,
  TERMINAL_STATES,
  TRANSITION_CTX_FIELDS,
  type ChangeRequestRef,
  type CounterDeltas,
  type FeatureEvent,
  type FeatureEventEffect,
  type FeatureEventKind,
  type FeatureState,
  type InvalidTransition,
  type LimitReason,
  type TerminalState,
  type TransitionCtx,
  type TransitionEffect,
  type TransitionOutcome,
  type TransitionResult,
} from './feature-state.js';

export { transition } from './transition.js';
