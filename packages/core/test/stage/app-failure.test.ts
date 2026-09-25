/**
 * The failure-mode table (ROLE-07, M08 step 8.3).
 *
 * M08's acceptance criterion 2 says an app that never becomes ready yields
 * *"`inconclusive`, never `pass`"*. The load-bearing half is the second, and the
 * first two cases below are what make it a property of the code rather than a
 * claim: `AppFailureAnswer` has no member through which any `Outcome` can travel,
 * so there is no value of that type that says `pass`.
 */
import { describe, expect, it } from 'vitest';
import {
  answerForAppFailure,
  APP_FAILURE_KINDS,
  isTransientStageErrorKind,
  stageErrorPolicy,
  STAGE_ERROR_KINDS,
  type AppFailureAnswer,
} from '../../src/stage/index.js';
import { OUTCOMES } from '../../src/verdict/verdict.js';

/** Every answer the table produces, paired with the failure it answers. */
const ANSWERS = APP_FAILURE_KINDS.map(
  (kind) => [kind, answerForAppFailure(kind)] as const,
);

describe('no failure mode can reach pass', () => {
  it('has no answer channel that carries an outcome at all', () => {
    // The structural half. Every channel is one of three names, none of which is
    // an `Outcome`, and the `send_back` channel carries a severity and a category
    // rather than a verdict — so the WORDS `pass` and `inconclusive` cannot appear
    // in any answer, let alone be returned as one.
    const channels = new Set(ANSWERS.map(([, answer]) => answer.channel));
    expect([...channels].sort()).toEqual([
      'report_only',
      'send_back',
      'stage_error',
    ]);
    for (const outcome of OUTCOMES) {
      if (outcome === 'send_back') continue;
      expect([...channels]).not.toContain(outcome);
    }
  });

  it('answers every declared failure, and nothing it does not declare', () => {
    // Anti-vacuity for every case in this file: a `Record<AppFailureKind, …>`
    // refuses a missing key at compile time, and this refuses a kind list that
    // quietly shrank.
    expect(APP_FAILURE_KINDS.length).toBe(7);
    expect(ANSWERS.every(([, answer]) => answer !== undefined)).toBe(true);
  });

  it('only names stage-error kinds that exist', () => {
    for (const [kind, answer] of ANSWERS) {
      if (answer.channel !== 'stage_error') continue;
      expect(
        STAGE_ERROR_KINDS,
        `${kind} names a stage-error kind that does not exist`,
      ).toContain(answer.errorKind);
    }
  });
});

describe('a never-ready app is retried before a human is woken', () => {
  it('rides a TRANSIENT stage-error kind, so the retry budget applies', () => {
    // M08's audit finding 6 in one assertion. The sketch said `inconclusive`,
    // which `aggregate` turns into `unverified` and `round-step.ts` turns into
    // `complete` plus `unrecoverable` — a human woken irrecoverably, on the first
    // slow boot. `timeout` is retryable, so `planTransientRetry` spends a real
    // backoff budget first and escalates NAMING WHAT WAS TRIED.
    const answer = answerForAppFailure('never-ready');
    expect(answer.channel).toBe('stage_error');
    if (answer.channel === 'stage_error') {
      expect(isTransientStageErrorKind(answer.errorKind)).toBe(true);
    }
  });

  it('costs the feature neither a round nor budget while it retries', () => {
    // Not restated here — read back out of `stageErrorPolicy`, which is the one
    // definition (rule 8). CORE-06: a stage that broke did not judge, so there is
    // nothing for the developer to have got wrong.
    for (const [, answer] of ANSWERS) {
      if (answer.channel !== 'stage_error') continue;
      const policy = stageErrorPolicy(answer.errorKind);
      expect(policy.consumesRound).toBe(false);
    }
  });

  it('gives a port race a retry and a bad interpolation none', () => {
    // The two extremes of the machine/configuration half of the table. A port
    // that could not be bound may well bind next time; a command naming a
    // variable ADL does not supply will not interpolate next time either, so it
    // escalates rather than spinning.
    const port = answerForAppFailure('port-unavailable');
    const config = answerForAppFailure('config-invalid');
    expect(port.channel).toBe('stage_error');
    expect(config.channel).toBe('stage_error');
    if (port.channel === 'stage_error' && config.channel === 'stage_error') {
      expect(stageErrorPolicy(port.errorKind).retryable).toBe(true);
      expect(stageErrorPolicy(config.errorKind).retryable).toBe(false);
    }
  });
});

describe('exactly the failures that are evidence about the WORK cost a round', () => {
  it('sends back a build that will not build and an app that dies on boot', () => {
    // The only two rows that charge the developer, and both are defects in the
    // work under judgement. Every other row is the machine, the configuration or
    // the operator.
    const sendBacks = ANSWERS.filter(
      ([, answer]) => answer.channel === 'send_back',
    ).map(([kind]) => kind);
    expect(sendBacks.sort()).toEqual([
      'app-exited-before-ready',
      'build-failed',
    ]);
  });

  it('marks both as blockers against the build category', () => {
    for (const kind of ['build-failed', 'app-exited-before-ready'] as const) {
      const answer: AppFailureAnswer = answerForAppFailure(kind);
      expect(answer.channel).toBe('send_back');
      if (answer.channel === 'send_back') {
        // A blocker, not a warning: `aggregate` lets a `warn` through without a
        // send-back, and an app that does not start is not a matter of taste.
        expect(answer.severity).toBe('blocker');
        expect(answer.category).toBe('build');
      }
    }
  });
});

describe('a failed teardown changes no verdict', () => {
  it('is report_only, because the gate had already judged', () => {
    // The row that exists to make a non-decision explicit. Converting it into a
    // failure would let a leaked container overturn a correct approval — and the
    // app's own process tree is already reaped by then, so what leaks is whatever
    // the repository built for itself.
    expect(answerForAppFailure('teardown-failed')).toEqual({
      channel: 'report_only',
    });
  });

  it('is the ONLY report_only row', () => {
    // Anti-creep: `report_only` is the channel that reports nothing to the loop,
    // so a second row acquiring it is how a real failure becomes invisible.
    const reportOnly = ANSWERS.filter(
      ([, answer]) => answer.channel === 'report_only',
    ).map(([kind]) => kind);
    expect(reportOnly).toEqual(['teardown-failed']);
  });
});
