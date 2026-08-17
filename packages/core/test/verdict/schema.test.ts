import { describe, expect, it } from 'vitest';

import { consumesRound, OUTCOMES, VerdictSchema, type Outcome } from '../../src/verdict/verdict.js';

/** CORE-01: the six-outcome union, the seventh-outcome rejection shape, and `consumesRound`. */

/** One minimal, schema-valid payload per outcome. */
const MINIMAL: Readonly<Record<Outcome, unknown>> = Object.freeze({
  pass: { outcome: 'pass', summary: 'ok', checked: [{ kind: 'global', category: 'other' }] },
  send_back: {
    outcome: 'send_back',
    summary: 'needs work',
    findings: [
      {
        fingerprint: 'a'.repeat(64),
        severity: 'blocker',
        title: 'x',
        detail: 'y',
        criterionRef: { kind: 'criterion', id: 'AC-1' },
      },
    ],
  },
  fail: { outcome: 'fail', summary: 'unfixable', reason: 'contradicts the spec' },
  inconclusive: { outcome: 'inconclusive', summary: 'unclear', reason: 'app never became ready' },
  warn: { outcome: 'warn', summary: 'fyi', findings: [] },
  skip: { outcome: 'skip', reason: 'no harness configured' },
});

describe('VerdictSchema — CORE-01', () => {
  it.each(OUTCOMES)('parses the minimal payload for outcome "%s"', (outcome) => {
    const result = VerdictSchema.safeParse(MINIMAL[outcome]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.outcome).toBe(outcome);
  });

  it('rejects a seventh outcome with an invalid_union issue naming exactly the six', () => {
    const result = VerdictSchema.safeParse({ outcome: 'approved', summary: 'looks fine' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.code).toBe('invalid_union');
    expect((issue as { options?: unknown }).options).toEqual([...OUTCOMES]);
    expect((issue as { path?: unknown }).path).toEqual(['outcome']);
  });

  it('rejects a payload with no outcome field at all', () => {
    expect(VerdictSchema.safeParse({ summary: 'no outcome here' }).success).toBe(false);
  });

  it.each(OUTCOMES)('consumesRound is %s only for send_back — checked for "%s"', (outcome) => {
    const verdict = VerdictSchema.parse(MINIMAL[outcome]);
    expect(consumesRound(verdict)).toBe(outcome === 'send_back');
  });
});
