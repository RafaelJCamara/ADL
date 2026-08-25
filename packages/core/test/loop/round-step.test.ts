import { describe, expect, it } from 'vitest';

import {
  planRoundStep,
  type RoundStep,
  type StageCompletion,
} from '../../src/loop/round-step.js';
import { OUTCOMES, type Verdict } from '../../src/verdict/verdict.js';
import {
  STAGE_ERROR_KINDS,
  stageErrorPolicy,
} from '../../src/stage/stage-error.js';
import type { Finding } from '../../src/verdict/finding.js';

/**
 * `planRoundStep` is pure and total, so its whole contract is a table.
 *
 * The cases that carry real weight, and would be cheap to lose:
 *
 * - **A pipeline of `develop` alone never reports green.** The developer
 *   contributes no verdict, so `aggregate` sees an empty list — the exact
 *   "pipeline ran zero gates and reported success" failure this project
 *   exists to prevent.
 * - **Green is reachable only when every gate ran and none objected.**
 * - **A `fail` stops the pipeline where it stands**, so a later gate is never
 *   paid to judge work already ruled unfixable by looping.
 * - **A retryable stage error is not a round.** It produces no `RoundOutcome`
 *   at all, because nothing was judged (CORE-06) — the property that keeps a
 *   provider outage from costing a round (LOOP-07).
 * - **`gate_passed` is emitted only when the stage did not stop the pipeline**,
 *   which is what keeps the audit trail from claiming a stage passed when it
 *   sent work back.
 */

const CRITERION = { kind: 'global', category: 'other' } as const;

function finding(title: string): Finding {
  return {
    fingerprint: 'a'.repeat(64),
    severity: 'blocker',
    title,
    detail: title,
    criterionRef: CRITERION,
  };
}

const PASS: Verdict = {
  outcome: 'pass',
  summary: 'the gate is satisfied',
  checked: [CRITERION],
};
const SEND_BACK: Verdict = {
  outcome: 'send_back',
  summary: 'two things to fix',
  findings: [finding('first'), finding('second')],
};
const FAIL: Verdict = {
  outcome: 'fail',
  summary: 'the harness binary is missing',
  reason: 'npm ci was never going to work',
};
const INCONCLUSIVE: Verdict = {
  outcome: 'inconclusive',
  summary: 'the app never started',
  reason: 'the readiness probe timed out',
};

function developerCommitted(sha = 'abc1234'): StageCompletion {
  return { kind: 'developer', outcome: { kind: 'committed', sha } };
}

function gate(verdict: Verdict): StageCompletion {
  return { kind: 'gate', verdict };
}

/** The four-entry pipeline this file reasons about: develop + three gates. */
function step(
  overrides: Partial<Parameters<typeof planRoundStep>[0]> & {
    completion: StageCompletion;
  },
): RoundStep {
  return planRoundStep({
    stageIndex: 0,
    pipelineLength: 4,
    stageId: 'develop',
    priorVerdicts: [],
    ...overrides,
  });
}

describe('planRoundStep — the developer slot (index 0)', () => {
  it('a commit advances to the first gate and records the sha on the event', () => {
    const result = step({ completion: developerCommitted('deadbee') });

    expect(result).toEqual({
      kind: 'advance',
      events: [{ t: 'dev_committed', sha: 'deadbee' }],
      nextStageIndex: 1,
    });
  });

  it('a pipeline of develop alone escalates rather than reporting green', () => {
    const result = step({
      pipelineLength: 1,
      completion: developerCommitted(),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    // The commit still happened and still belongs on the audit trail.
    expect(result.events[0]).toEqual({ t: 'dev_committed', sha: 'abc1234' });
    expect(result.events[1]?.t).toBe('unrecoverable');
    expect(result.outcome.kind).toBe('escalate');
  });

  it('blocked escalates and carries the developer’s own reason', () => {
    const result = step({
      completion: {
        kind: 'developer',
        outcome: { kind: 'blocked', reason: 'the spec contradicts itself' },
      },
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome).toEqual({
      kind: 'escalate',
      reason: expect.stringContaining('the spec contradicts itself') as string,
    });
  });

  it('a dispute escalates to a human and buys no reconsideration round (D-06)', () => {
    const result = step({
      completion: {
        kind: 'developer',
        outcome: {
          kind: 'dispute',
          dispute: {
            criterionRef: CRITERION,
            target: { kind: 'stage', stageId: 'review' },
            argument: 'the reviewer misread the spec',
          },
        },
      },
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('escalate');
    // No `send_back` anywhere: a dispute must never buy another round.
    expect(result.events.some((event) => event.t === 'send_back')).toBe(false);
  });
});

describe('planRoundStep — gates', () => {
  it('a passing gate mid-pipeline advances and emits gate_passed', () => {
    const result = step({
      stageIndex: 1,
      stageId: 'review',
      completion: gate(PASS),
    });

    expect(result).toEqual({
      kind: 'advance',
      events: [{ t: 'gate_passed', stageId: 'review' }],
      nextStageIndex: 2,
    });
  });

  it('green is reached only at the last stage, with every gate passing', () => {
    const result = step({
      stageIndex: 3,
      stageId: 'test',
      priorVerdicts: [PASS, PASS],
      completion: gate(PASS),
    });

    expect(result).toEqual({
      kind: 'complete',
      events: [{ t: 'all_gates_passed' }],
      outcome: { kind: 'green' },
    });
  });

  it('a send_back stops the pipeline where it stands and never claims gate_passed', () => {
    const result = step({
      stageIndex: 1,
      stageId: 'review',
      completion: gate(SEND_BACK),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.events).toEqual([
      { t: 'send_back', stageId: 'review', findingCount: 2 },
    ]);
    expect(result.outcome.kind).toBe('send_back');
    expect(result.events.some((event) => event.t === 'gate_passed')).toBe(
      false,
    );
  });

  it('a fail stops immediately, without paying the remaining gates', () => {
    const result = step({
      stageIndex: 1,
      stageId: 'review',
      completion: gate(FAIL),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('escalate');
  });

  it('an inconclusive does NOT stop the pipeline — a later gate may still find something actionable', () => {
    const result = step({
      stageIndex: 1,
      stageId: 'review',
      completion: gate(INCONCLUSIVE),
    });

    expect(result.kind).toBe('advance');
  });

  it('an inconclusive carried to the end with nothing actionable escalates as unverified', () => {
    const result = step({
      stageIndex: 3,
      stageId: 'test',
      priorVerdicts: [PASS, INCONCLUSIVE],
      completion: gate(PASS),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('unverified');
    expect(result.events[0]).toEqual({
      t: 'unrecoverable',
      reason: 'the readiness probe timed out',
    });
  });

  it('an inconclusive alongside a real send_back sends back rather than escalating', () => {
    const result = step({
      stageIndex: 3,
      stageId: 'test',
      priorVerdicts: [INCONCLUSIVE],
      completion: gate(SEND_BACK),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('send_back');
  });

  it('every gate outcome is classified — no outcome falls through unhandled', () => {
    const byOutcome: Record<string, Verdict> = {
      pass: PASS,
      send_back: SEND_BACK,
      fail: FAIL,
      inconclusive: INCONCLUSIVE,
      warn: { outcome: 'warn', summary: 'a nit', findings: [] },
      skip: { outcome: 'skip', reason: 'not configured' },
    };

    for (const outcome of OUTCOMES) {
      const verdict = byOutcome[outcome];
      expect(verdict, `no fixture for outcome "${outcome}"`).toBeDefined();
      const result = step({
        stageIndex: 1,
        stageId: 'review',
        completion: gate(verdict as Verdict),
      });
      expect(['advance', 'complete']).toContain(result.kind);
    }
  });
});

describe('planRoundStep — stage errors (CORE-06)', () => {
  it('routes every kind by its policy, not by the retryable flag on the wire', () => {
    for (const kind of STAGE_ERROR_KINDS) {
      const result = step({
        stageIndex: 1,
        stageId: 'review',
        completion: {
          kind: 'error',
          // Deliberately the OPPOSITE of the policy's own answer: a stage
          // written in another language could state this wrongly, and the
          // table is the authority (rule 8 — derive, never restate).
          error: {
            kind,
            retryable: !stageErrorPolicy(kind).retryable,
            detail: 'something broke',
          },
        },
      });

      expect(result.kind, kind).toBe(
        stageErrorPolicy(kind).retryable ? 'retry' : 'complete',
      );
    }
  });

  it('a retryable error produces no RoundOutcome at all — nothing was judged', () => {
    const result = step({
      stageIndex: 1,
      stageId: 'review',
      completion: {
        kind: 'error',
        error: { kind: 'provider_error', retryable: true, detail: '503' },
      },
    });

    expect(result).toEqual({
      kind: 'retry',
      reason: expect.stringContaining('503') as string,
    });
    expect(result).not.toHaveProperty('outcome');
  });

  it('a non-retryable error escalates and names the stage that broke', () => {
    const result = step({
      stageIndex: 2,
      stageId: 'security',
      completion: {
        kind: 'error',
        error: { kind: 'auth', retryable: false, detail: 'key rejected' },
      },
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome).toEqual({
      kind: 'escalate',
      reason: expect.stringContaining('security') as string,
    });
  });
});

describe('planRoundStep — the index-0 asymmetry is enforced, not assumed', () => {
  it('a gate verdict arriving in the developer slot escalates rather than counting', () => {
    const result = step({ stageIndex: 0, completion: gate(PASS) });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('escalate');
  });

  it('a developer outcome arriving in a gate slot escalates — self-approval never counts as coverage', () => {
    const result = step({
      stageIndex: 2,
      stageId: 'security',
      completion: developerCommitted(),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.outcome.kind).toBe('escalate');
  });
});
