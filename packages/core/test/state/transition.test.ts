import { describe, expect, it } from 'vitest';

import {
  FEATURE_EVENT_KINDS,
  FEATURE_STATES,
  TERMINAL_STATES,
  TRANSITION_CTX_FIELDS,
} from '../../src/state/index.js';

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
