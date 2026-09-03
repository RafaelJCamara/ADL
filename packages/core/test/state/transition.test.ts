import { describe, expect, it } from 'vitest';

import {
  FEATURE_EVENT_KINDS,
  FEATURE_STATES,
  TERMINAL_STATES,
  TRANSITION_CTX_FIELDS,
  transition,
  type FeatureEvent,
  type FeatureEventKind,
  type FeatureState,
  type TransitionCtx,
  type TransitionOutcome,
  type TransitionResult,
} from '../../src/state/index.js';

/**
 * One representative event per kind.
 *
 * Keyed by the discriminator and typed as a total mapping, so an event kind
 * added to the union without a sample here fails to compile in an editor and,
 * more importantly, is caught at runtime by the cross-product count below.
 */
const SAMPLE_EVENTS: {
  [K in FeatureEventKind]: Extract<FeatureEvent, { t: K }>;
} = {
  admit: { t: 'admit' },
  lease_acquired: { t: 'lease_acquired', workerId: 'worker-1' },
  workspace_ready: { t: 'workspace_ready' },
  dev_committed: { t: 'dev_committed', sha: 'a'.repeat(40) },
  gate_passed: { t: 'gate_passed', stageId: 'code_review' },
  gate_deferred: {
    t: 'gate_deferred',
    stageId: 'code_review',
    findingCount: 3,
  },
  gate_follow_ups: {
    t: 'gate_follow_ups',
    stageId: 'code_review',
    findingCount: 2,
  },
  all_gates_passed: { t: 'all_gates_passed' },
  send_back: { t: 'send_back', stageId: 'code_review', findingCount: 2 },
  cr_opened: {
    t: 'cr_opened',
    ref: { forge: 'github', number: 17, url: 'https://example.invalid/pr/17' },
  },
  cr_merged: { t: 'cr_merged' },
  cr_closed: { t: 'cr_closed' },
  lease_expired: { t: 'lease_expired' },
  limit_exceeded: { t: 'limit_exceeded', reason: 'budget_limit' },
  pause: { t: 'pause', by: 'alice' },
  resume: { t: 'resume', by: 'alice' },
  unrecoverable: { t: 'unrecoverable', reason: 'workspace destroyed' },
};

const ALL_EVENTS: readonly FeatureEvent[] = FEATURE_EVENT_KINDS.map(
  (kind) => SAMPLE_EVENTS[kind],
);

const NON_TERMINAL_STATES: readonly FeatureState[] = FEATURE_STATES.filter(
  (state) => !(TERMINAL_STATES as readonly FeatureState[]).includes(state),
);

/**
 * A context in the middle of everything: room left in the round budget, and the
 * stage index at the head of a three-stage pipeline. Deliberately chosen so no
 * edge in the cross product is suppressed by a ceiling.
 */
const BASE_CTX: TransitionCtx = {
  featureId: 'feat_01H0',
  stateVersion: 7,
  lastEventSeq: 4,
  round: 1,
  maxRounds: 3,
  pipelineLength: 3,
  currentStageIndex: 0,
  actor: 'manager',
  at: '2026-08-17T12:00:00.000Z',
};

function ctxWith(overrides: Partial<TransitionCtx>): TransitionCtx {
  return { ...BASE_CTX, ...overrides };
}

/** Narrows to an applied transition, failing the test with context if it is not. */
function applied(outcome: TransitionOutcome): TransitionResult {
  if (!outcome.ok) {
    throw new Error(
      `expected an applied transition from ${outcome.state} on ${outcome.event.t}, ` +
        `got: ${outcome.reason}`,
    );
  }
  return outcome;
}

/**
 * The lifecycle vocabulary, asserted as data.
 *
 * These assertions exist because the state list is a **one-way door**: every
 * name here becomes a value in a `features.state` column inside an adopter's
 * database that ADL cannot inspect or fix. A rename is not a refactor, it is a
 * forward migration run against every existing installation. Asserting the
 * constant's exact contents means a rename shows up as a deliberate diff in a
 * review rather than as a silent behaviour change.
 */
describe('the feature lifecycle vocabulary', () => {
  it('is exactly the states in the architecture state diagram, in diagram order', () => {
    expect(FEATURE_STATES).toEqual([
      'discovered',
      'queued',
      'leased',
      'developing',
      'gating',
      'publishing',
      'pr_open',
      'merged',
      'escalated',
      'abandoned',
      'paused',
    ]);
  });

  it('is frozen, so the list cannot be edited at runtime', () => {
    expect(Object.isFrozen(FEATURE_STATES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_STATES)).toBe(true);
  });

  /**
   * EXEC-07, asserted structurally rather than documented.
   *
   * A pipeline of any length uses this same state set. If a future phase adds a
   * security harness by adding a `security_scanning` state, this test goes red —
   * which is the whole point: "harnesses are pluggable" and "harnesses are
   * pluggable if you redeploy the state machine" are different products.
   */
  it('contains no stage-specific state — no gate name appears in the lifecycle', () => {
    const stageFlavouredWords = [
      'review',
      'harness',
      'security',
      'behaviour',
      'behavior',
      'test',
      'lint',
      'typecheck',
      'build',
      'scan',
      'audit',
      'coverage',
      'e2e',
      'unit',
      'integration',
      'qa',
      'benchmark',
    ];

    const offenders = FEATURE_STATES.flatMap((state) =>
      stageFlavouredWords
        .filter((word) => state.toLowerCase().includes(word))
        .map((word) => `${state} (matched "${word}")`),
    );

    expect(offenders).toEqual([]);
  });

  it('marks exactly the two states with no outgoing edges as terminal', () => {
    expect(TERMINAL_STATES).toEqual(['merged', 'abandoned']);
  });

  it('draws every terminal state from the state list itself', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(FEATURE_STATES).toContain(terminal);
    }
    expect(TERMINAL_STATES.length).toBeLessThan(FEATURE_STATES.length);
  });

  it('names every labelled edge in the diagram as an event kind, and no others', () => {
    expect(FEATURE_EVENT_KINDS).toEqual([
      'admit',
      'lease_acquired',
      'workspace_ready',
      'dev_committed',
      'gate_passed',
      'gate_deferred',
      'gate_follow_ups',
      'all_gates_passed',
      'send_back',
      'cr_opened',
      'cr_merged',
      'cr_closed',
      'lease_expired',
      'limit_exceeded',
      'pause',
      'resume',
      'unrecoverable',
    ]);
    expect(Object.isFrozen(FEATURE_EVENT_KINDS)).toBe(true);
  });
});

/**
 * The transition context carries the pipeline as *data* — a length and an
 * index — and never as identity.
 *
 * `TRANSITION_CTX_FIELDS` is paired with a compile-time exhaustiveness
 * assertion in `feature-state.ts`, so a new field on `TransitionCtx` cannot be
 * added without appearing here. That is what gives this test teeth: adding
 * `stageId` to the context fails the build unless it is listed, and listing it
 * turns this test red.
 */
describe('the transition context', () => {
  it('carries the pipeline position as a length and an index', () => {
    expect(TRANSITION_CTX_FIELDS).toContain('pipelineLength');
    expect(TRANSITION_CTX_FIELDS).toContain('currentStageIndex');
  });

  it('carries no stage identity', () => {
    const identityFields = TRANSITION_CTX_FIELDS.filter((field) =>
      /stage[_-]?(id|ids|name|names|kind|kinds|type|types|slug)$/i.test(field),
    );

    expect(identityFields).toEqual([]);
  });

  it('carries the optimistic-concurrency token and the caller-supplied clock', () => {
    expect(TRANSITION_CTX_FIELDS).toContain('stateVersion');
    expect(TRANSITION_CTX_FIELDS).toContain('at');
  });
});

/**
 * Totality, over the whole cross product.
 *
 * The point is not that the happy path works — it is that there is no pair the
 * function has not considered. An unhandled state-and-event combination in a
 * state engine does not announce itself; it surfaces months later as a feature
 * frozen in a state nobody can explain.
 */
describe('transition() is total across every state-by-event pair', () => {
  it('covers exactly states × event kinds pairs, each returning a defined value', () => {
    const outcomes: TransitionOutcome[] = [];

    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        expect(outcome, `${state} + ${event.t} returned nothing`).toBeDefined();
        expect(
          typeof outcome.ok,
          `${state} + ${event.t} has no ok discriminator`,
        ).toBe('boolean');
        outcomes.push(outcome);
      }
    }

    expect(outcomes).toHaveLength(
      FEATURE_STATES.length * FEATURE_EVENT_KINDS.length,
    );
    // The literal is the vacuity control for the line above it: a
    // `FEATURE_STATES` or `FEATURE_EVENT_KINDS` emptied by a bad merge would
    // make the derived assertion pass over nothing. 11 states x 17 event kinds
    // — 17 since M07 step 7.8 added `gate_follow_ups`, up from 16, which 7.2
    // had raised from 15.
    expect(outcomes).toHaveLength(187);
  });

  it('never throws, for any pair', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const call = (): TransitionOutcome =>
          transition(state, event, BASE_CTX);
        expect(call, `${state} + ${event.t} threw`).not.toThrow();
      }
    }
  });

  it('only ever moves to a state that is in the state list', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        if (outcome.ok) {
          expect(
            FEATURE_STATES,
            `${state} + ${event.t} → ${outcome.next}`,
          ).toContain(outcome.next);
        }
      }
    }
  });

  it('names the offending state and event on every rejection', () => {
    let rejections = 0;

    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        if (!outcome.ok) {
          rejections += 1;
          expect(outcome.state).toBe(state);
          expect(outcome.event).toBe(event);
          expect(outcome.reason.length).toBeGreaterThan(0);
        }
      }
    }

    // Most of the cross product is undrawn — that is the shape of a small
    // lifecycle, and it is the reason rejection has to be a first-class result
    // rather than an exception nobody catches.
    expect(rejections).toBeGreaterThan(0);
  });
});

describe('every edge the architecture diagram draws', () => {
  it('discovered --admit--> queued', () => {
    expect(
      applied(transition('discovered', SAMPLE_EVENTS.admit, BASE_CTX)).next,
    ).toBe('queued');
  });

  it('queued --lease_acquired--> leased', () => {
    expect(
      applied(transition('queued', SAMPLE_EVENTS.lease_acquired, BASE_CTX))
        .next,
    ).toBe('leased');
  });

  it('leased --workspace_ready--> developing', () => {
    expect(
      applied(transition('leased', SAMPLE_EVENTS.workspace_ready, BASE_CTX))
        .next,
    ).toBe('developing');
  });

  it('developing --dev_committed--> gating, starting the pipeline at stage zero', () => {
    const result = applied(
      transition(
        'developing',
        SAMPLE_EVENTS.dev_committed,
        ctxWith({ currentStageIndex: 2 }),
      ),
    );

    expect(result.next).toBe('gating');
    expect(result.counters.currentStageIndex).toBe(-2);
    expect(result.counters.round).toBe(0);
  });

  /**
   * The EXEC-07 mechanism itself: a gate passing moves an index, not a state.
   * A pipeline of three stages and a pipeline of thirty use this one edge.
   */
  it('gating --gate_passed--> gating, advancing the stage index without spending a round', () => {
    const result = applied(
      transition(
        'gating',
        SAMPLE_EVENTS.gate_passed,
        ctxWith({ currentStageIndex: 1 }),
      ),
    );

    expect(result.next).toBe('gating');
    expect(result.counters.currentStageIndex).toBe(1);
    expect(result.counters.round).toBe(0);
  });

  it('gating --all_gates_passed--> publishing without spending a round', () => {
    const result = applied(
      transition('gating', SAMPLE_EVENTS.all_gates_passed, BASE_CTX),
    );

    expect(result.next).toBe('publishing');
    expect(result.counters.round).toBe(0);
  });

  it('gating --send_back--> developing, spending exactly one round', () => {
    const result = applied(
      transition(
        'gating',
        SAMPLE_EVENTS.send_back,
        ctxWith({ round: 1, currentStageIndex: 2 }),
      ),
    );

    expect(result.next).toBe('developing');
    expect(result.counters.round).toBe(1);
    // The next round's pipeline starts at the first gate again.
    expect(result.counters.currentStageIndex).toBe(-2);
  });

  it('publishing --cr_opened--> pr_open', () => {
    expect(
      applied(transition('publishing', SAMPLE_EVENTS.cr_opened, BASE_CTX)).next,
    ).toBe('pr_open');
  });

  it('pr_open --cr_merged--> merged', () => {
    expect(
      applied(transition('pr_open', SAMPLE_EVENTS.cr_merged, BASE_CTX)).next,
    ).toBe('merged');
  });

  it('pr_open --cr_closed--> abandoned', () => {
    const result = applied(
      transition('pr_open', SAMPLE_EVENTS.cr_closed, BASE_CTX),
    );
    expect(result.next).toBe('abandoned');
  });

  it('every leased state --lease_expired--> queued', () => {
    for (const state of [
      'leased',
      'developing',
      'gating',
      'publishing',
    ] as const) {
      const result = applied(
        transition(state, SAMPLE_EVENTS.lease_expired, BASE_CTX),
      );
      expect(result.next, `${state} + lease_expired`).toBe('queued');
      expect(
        result.counters.round,
        `${state} + lease_expired spent a round`,
      ).toBe(0);
    }
  });

  it('rejects lease_expired where no lease is held', () => {
    for (const state of [
      'discovered',
      'queued',
      'pr_open',
      'escalated',
      'paused',
    ] as const) {
      const outcome = transition(state, SAMPLE_EVENTS.lease_expired, BASE_CTX);
      expect(outcome.ok, `${state} + lease_expired was accepted`).toBe(false);
    }
  });

  it('any non-terminal state --limit_exceeded--> escalated', () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(
        applied(transition(state, SAMPLE_EVENTS.limit_exceeded, BASE_CTX)).next,
      ).toBe('escalated');
    }
  });

  it('any non-terminal state --unrecoverable--> escalated', () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(
        applied(transition(state, SAMPLE_EVENTS.unrecoverable, BASE_CTX)).next,
      ).toBe('escalated');
    }
  });

  it('any non-terminal state --pause--> paused', () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(
        applied(transition(state, SAMPLE_EVENTS.pause, BASE_CTX)).next,
      ).toBe('paused');
    }
  });

  it('rejects pause from every terminal state', () => {
    for (const state of TERMINAL_STATES) {
      const outcome = transition(state, SAMPLE_EVENTS.pause, BASE_CTX);
      expect(outcome.ok, `${state} accepted a pause`).toBe(false);
    }
  });

  it('paused --resume--> queued', () => {
    expect(
      applied(transition('paused', SAMPLE_EVENTS.resume, BASE_CTX)).next,
    ).toBe('queued');
  });

  /**
   * The human-retry edge out of `escalated`. Without it, the only way out of an
   * escalation is a hand-edited database row — and a system whose recovery path
   * is `sqlite3` is a system whose users corrupt their own state.
   */
  it('escalated --resume--> queued', () => {
    expect(
      applied(transition('escalated', SAMPLE_EVENTS.resume, BASE_CTX)).next,
    ).toBe('queued');
  });

  it('accepts nothing at all from a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        expect(outcome.ok, `${state} accepted ${event.t}`).toBe(false);
      }
    }
  });
});

describe('the ceilings, checked inside the transition', () => {
  /**
   * ARCHITECTURE.md §2: the admission check lives in the `gating → developing`
   * send-back transition, inside the transaction. Checking it anywhere later
   * means the feature has already been handed another round.
   */
  it('escalates instead of sending back when the next round would exceed the ceiling', () => {
    const result = applied(
      transition(
        'gating',
        SAMPLE_EVENTS.send_back,
        ctxWith({ round: 3, maxRounds: 3 }),
      ),
    );

    expect(result.next).toBe('escalated');
    expect(result.counters.round).toBe(0);
  });

  it('still sends back on the last round the ceiling allows', () => {
    const result = applied(
      transition(
        'gating',
        SAMPLE_EVENTS.send_back,
        ctxWith({ round: 2, maxRounds: 3 }),
      ),
    );

    expect(result.next).toBe('developing');
    expect(result.counters.round).toBe(1);
  });

  it('refuses to walk the stage index past the end of the pipeline', () => {
    const outcome = transition(
      'gating',
      SAMPLE_EVENTS.gate_passed,
      ctxWith({ pipelineLength: 3, currentStageIndex: 3 }),
    );

    expect(outcome.ok).toBe(false);
  });

  it('accepts the last gate in the pipeline', () => {
    const result = applied(
      transition(
        'gating',
        SAMPLE_EVENTS.gate_passed,
        ctxWith({ pipelineLength: 3, currentStageIndex: 2 }),
      ),
    );

    expect(result.next).toBe('gating');
    expect(result.counters.currentStageIndex).toBe(1);
  });
});

describe('what every applied transition must carry', () => {
  it('emits exactly one feature-event effect whose from-state and to-state match', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        if (!outcome.ok) continue;

        expect(outcome.effects, `${state} + ${event.t}`).toHaveLength(1);
        const [effect] = outcome.effects;
        expect(effect?.kind).toBe('feature_event');
        expect(effect?.fromState).toBe(state);
        expect(effect?.fromState).toBe(outcome.from);
        expect(effect?.toState).toBe(outcome.next);
        expect(effect?.event).toBe(event);
        expect(effect?.featureId).toBe(BASE_CTX.featureId);
        expect(effect?.actor).toBe(BASE_CTX.actor);
        expect(effect?.at).toBe(BASE_CTX.at);
        expect(effect?.seq).toBe(BASE_CTX.lastEventSeq + 1);
      }
    }
  });

  it('carries the version the caller must guard the write on', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, ctxWith({ stateVersion: 42 }));
        if (!outcome.ok) continue;
        expect(outcome.expectedStateVersion, `${state} + ${event.t}`).toBe(42);
      }
    }
  });

  /**
   * The round is the feature's finite budget, so exactly one edge is allowed to
   * spend it. This sweeps the whole cross product rather than asserting the
   * send-back case alone: the claim is about every *other* transition too.
   */
  it('changes the round on the send-back edge and on nothing else', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const outcome = transition(state, event, BASE_CTX);
        if (!outcome.ok) continue;

        const isSendBackToDeveloping =
          state === 'gating' &&
          event.t === 'send_back' &&
          outcome.next === 'developing';

        const expected = isSendBackToDeveloping ? 1 : 0;
        expect(outcome.counters.round, `${state} + ${event.t}`).toBe(expected);
      }
    }
  });
});

describe('transition() is pure', () => {
  it('returns deeply equal results for identical inputs', () => {
    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const first = transition(state, event, BASE_CTX);
        const second = transition(state, event, { ...BASE_CTX });
        expect(second, `${state} + ${event.t}`).toEqual(first);
      }
    }
  });

  it('mutates neither argument', () => {
    const ctxBefore = structuredClone(BASE_CTX);

    for (const state of FEATURE_STATES) {
      for (const event of ALL_EVENTS) {
        const eventBefore = structuredClone(event);
        transition(state, event, BASE_CTX);
        expect(event, `${state} + ${event.t} mutated its event`).toEqual(
          eventBefore,
        );
      }
    }

    expect(BASE_CTX).toEqual(ctxBefore);
  });

  /**
   * The clock lives in the context, never in the function. A transition that
   * read `Date.now()` would produce a different audit row on replay than it did
   * on the original attempt — and at-least-once execution makes replay normal,
   * not exceptional.
   */
  it('reads no clock — one context, one result, at two different real times', async () => {
    const first = transition('gating', SAMPLE_EVENTS.send_back, BASE_CTX);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = transition('gating', SAMPLE_EVENTS.send_back, BASE_CTX);

    expect(second).toEqual(first);
    expect(applied(first).effects[0]?.at).toBe(BASE_CTX.at);
  });

  it('derives the result only from its inputs, not from call order', () => {
    const forwards = FEATURE_STATES.map((state) =>
      transition(state, SAMPLE_EVENTS.pause, BASE_CTX),
    );
    const backwards = [...FEATURE_STATES]
      .reverse()
      .map((state) => transition(state, SAMPLE_EVENTS.pause, BASE_CTX))
      .reverse();

    expect(backwards).toEqual(forwards);
  });
});
