import { consumesRound, type Verdict } from '../verdict/verdict.js';
import {
  isTerminal,
  type CounterDeltas,
  type FeatureEvent,
  type FeatureState,
  type InvalidTransition,
  type TransitionCtx,
  type TransitionOutcome,
  type TransitionResult,
} from './feature-state.js';

/**
 * The lifecycle transition function — the **only** code allowed to decide that
 * a feature's state changes.
 *
 * Three properties this module holds, in descending order of how expensive they
 * are to lose:
 *
 * 1. **It is pure.** No input, no output, no clock, no randomness, no
 *    dependency beyond the state and verdict modules. Workers execute
 *    at-least-once, so the same event can arrive twice after a crash; a
 *    transition that consulted a clock or a random source would decide
 *    differently the second time and there would be no way to tell which
 *    decision was right.
 *
 * 2. **It is total.** Every state-by-event pair returns a value. Undrawn pairs
 *    return an `InvalidTransition` naming the state and the event rather than
 *    throwing, because "the manager already applied this event and the resumed
 *    worker is reporting it again" and "this is a bug" look identical from in
 *    here. The caller has the context to tell them apart; an exception would
 *    take that choice away from it.
 *
 * 3. **It does not know what the gates are.** There is no stage id in the
 *    context and no stage name in the state set. A gate passing moves an index;
 *    the pipeline's length is the only thing about it this file can see. Plan
 *    01-08 asserts that mechanically, by hashing this file's bytes across a
 *    pipeline that gained a stage — which is also why the whole function lives
 *    in this one file at this exact path.
 */

/** Nothing moved. The default for every edge that is not a counter edge. */
const NO_COUNTER_CHANGE: CounterDeltas = Object.freeze({
  round: 0,
  currentStageIndex: 0,
});

/**
 * A minimal, well-typed verdict used only to *ask* the verdict layer whether a
 * send-back consumes a round. It is never validated, never persisted, and never
 * leaves this module.
 *
 * The indirection is the point. `consumesRound` in `../verdict/verdict.ts` is
 * the single definition of the round-accounting rule; restating "send_back
 * increments the round" here would create a second definition, and the first
 * time the two disagreed a feature would either be charged for an honest exit
 * or handed a free retry. Asking the owner instead means the two cannot
 * diverge: if `consumesRound` stops returning true for `send_back`, this
 * transition stops incrementing the round in the same commit.
 */
const SEND_BACK_PROBE: Verdict = {
  outcome: 'send_back',
  summary: 'lifecycle round-accounting probe',
  findings: [],
};

const SEND_BACK_ROUND_DELTA = consumesRound(SEND_BACK_PROBE) ? 1 : 0;

/**
 * Build an applied transition, with the audit record and the concurrency guard
 * attached. Every accepted edge goes through here, so neither can be forgotten
 * on a new edge — forgetting is the failure mode, not disagreeing.
 */
function applied(
  from: FeatureState,
  next: FeatureState,
  event: FeatureEvent,
  ctx: TransitionCtx,
  counters: CounterDeltas = NO_COUNTER_CHANGE,
): TransitionResult {
  return {
    ok: true,
    from,
    next,
    effects: [
      {
        kind: 'feature_event',
        featureId: ctx.featureId,
        seq: ctx.lastEventSeq + 1,
        fromState: from,
        toState: next,
        event,
        actor: ctx.actor,
        at: ctx.at,
      },
    ],
    counters,
    expectedStateVersion: ctx.stateVersion,
  };
}

/** Reject the pair, naming both halves of it and why. */
function invalid(
  state: FeatureState,
  event: FeatureEvent,
  reason: string,
): InvalidTransition {
  return { ok: false, state, event, reason };
}

/** The reason string every undrawn pair gets. */
function noSuchEdge(
  state: FeatureState,
  event: FeatureEvent,
): InvalidTransition {
  return invalid(state, event, `no '${event.t}' edge leaves '${state}'`);
}

/**
 * Decide the next state.
 *
 * @param state The feature's state as read from the row.
 * @param event What happened.
 * @param ctx Everything else the decision needs — and nothing more.
 * @returns An applied transition, or an explicit rejection. Never throws,
 *   never returns `undefined`.
 */
export function transition(
  state: FeatureState,
  event: FeatureEvent,
  ctx: TransitionCtx,
): TransitionOutcome {
  // A terminal state accepts nothing at all — including a pause. `merged` and
  // `abandoned` are the end of the feature's life, and re-opening one by event
  // would make the audit trail describe a history that did not happen.
  if (isTerminal(state)) {
    return invalid(state, event, `'${state}' is terminal: no event moves it`);
  }

  // The edges the diagram draws from *any* non-terminal state, handled once.
  // Repeating them inside each of the nine cases below would be nine places for
  // them to drift apart, and the ninth is always the one that gets missed.
  switch (event.t) {
    case 'pause':
      return applied(state, 'paused', event, ctx);
    case 'limit_exceeded':
    case 'unrecoverable':
      return applied(state, 'escalated', event, ctx);
    default:
      break;
  }

  switch (state) {
    case 'discovered':
      return event.t === 'admit'
        ? applied(state, 'queued', event, ctx)
        : noSuchEdge(state, event);

    case 'queued':
      return event.t === 'lease_acquired'
        ? applied(state, 'leased', event, ctx)
        : noSuchEdge(state, event);

    case 'leased':
      switch (event.t) {
        case 'workspace_ready':
          return applied(state, 'developing', event, ctx);
        case 'lease_expired':
          return applied(state, 'queued', event, ctx);
        default:
          return noSuchEdge(state, event);
      }

    case 'developing':
      switch (event.t) {
        case 'dev_committed':
          // The pipeline restarts at its first stage for this round.
          return applied(state, 'gating', event, ctx, {
            round: 0,
            currentStageIndex: -ctx.currentStageIndex,
          });
        case 'lease_expired':
          return applied(state, 'queued', event, ctx);
        default:
          return noSuchEdge(state, event);
      }

    case 'gating':
      switch (event.t) {
        case 'gate_passed':
        case 'gate_deferred':
        case 'gate_follow_ups':
          // EXEC-07 in one line: a gate passing moves an index, and the state
          // stays `gating`. This edge is identical for a pipeline of three
          // stages and a pipeline of thirty.
          //
          // `gate_deferred` shares it exactly (M07 step 7.2): a gate whose
          // `on_send_back` is `continue` raised findings and the pipeline moved
          // on, which is the *same* lifecycle move — one index, no round. The
          // two are separate event kinds because they mean different things to
          // a reader of `feature_events` and to the pull request, not because
          // the state machine treats them differently. Deliberately NOT folded
          // into one kind with a boolean: `gate_passed` is what an audit trail
          // reads as "this gate was satisfied", and a flag on it would make
          // that reading depend on remembering to check the flag.
          //
          // `gate_follow_ups` shares the same edge for the same reason (M07
          // step 7.8): a gate whose findings were all raised for the first time
          // after its own first look moved one index and spent no round. Three
          // kinds, one edge — they differ in what they mean to a reader, never
          // in what they do to the state machine.
          if (ctx.currentStageIndex + 1 > ctx.pipelineLength) {
            return invalid(
              state,
              event,
              `stage index ${ctx.currentStageIndex} is already at the end of a ` +
                `${ctx.pipelineLength}-stage pipeline`,
            );
          }
          return applied(state, 'gating', event, ctx, {
            round: 0,
            currentStageIndex: 1,
          });

        case 'all_gates_passed':
          return applied(state, 'publishing', event, ctx);

        case 'send_back':
          // The hard admission check, in the transition and therefore inside
          // the caller's transaction. Checked *before* the round is handed out:
          // a check that runs after the developer has been dispatched has
          // already spent the round it was meant to withhold.
          if (ctx.round + SEND_BACK_ROUND_DELTA > ctx.maxRounds) {
            return applied(state, 'escalated', event, ctx);
          }
          return applied(state, 'developing', event, ctx, {
            round: SEND_BACK_ROUND_DELTA,
            currentStageIndex: -ctx.currentStageIndex,
          });

        case 'lease_expired':
          return applied(state, 'queued', event, ctx);

        default:
          return noSuchEdge(state, event);
      }

    case 'publishing':
      switch (event.t) {
        case 'cr_opened':
          return applied(state, 'pr_open', event, ctx);
        case 'lease_expired':
          return applied(state, 'queued', event, ctx);
        default:
          return noSuchEdge(state, event);
      }

    case 'pr_open':
      // Human territory: ADL holds no lease here and only observes, so
      // `lease_expired` is not an edge out of this state.
      switch (event.t) {
        case 'cr_merged':
          return applied(state, 'merged', event, ctx);
        case 'cr_closed':
          return applied(state, 'abandoned', event, ctx);
        default:
          return noSuchEdge(state, event);
      }

    case 'escalated':
      // The human-retry edge. An escalation a human cannot clear without
      // editing the database is an escalation that gets cleared by editing the
      // database.
      return event.t === 'resume'
        ? applied(state, 'queued', event, ctx)
        : noSuchEdge(state, event);

    case 'paused':
      return event.t === 'resume'
        ? applied(state, 'queued', event, ctx)
        : noSuchEdge(state, event);

    default: {
      // Exhaustiveness: a state added to `FEATURE_STATES` without a case here
      // fails the build rather than falling silently into a rejection.
      const unhandled: never = state;
      return invalid(unhandled, event, 'unhandled state');
    }
  }
}
