import { describe, expect, it } from 'vitest';

import {
  DEVELOPER_OUTCOME_KINDS,
  DEVELOPER_OUTCOME_ROUND_COST,
  DeveloperOutcomeSchema,
  DisputeSchema,
  type Dispute,
} from '../../src/stage/index.js';
import { fingerprintFinding } from '../../src/verdict/index.js';

/**
 * The developer's own result (D-05, D-06, CORE-03).
 *
 * The property under test is not "the developer is forbidden from approving
 * itself" — it is that **there is no way to say it**. Every assertion below
 * exists to keep self-approval unrepresentable rather than merely rejected.
 */

const FINGERPRINT = fingerprintFinding({
  stageId: 'review',
  title: 'AC-2 has no error path',
  location: { path: 'src/api/orders.ts' },
});

const COMPLETE_DISPUTE: Dispute = {
  criterionRef: { kind: 'criterion', id: 'AC-2' },
  target: { kind: 'finding', fingerprint: FINGERPRINT },
  argument:
    'The criterion says the endpoint returns 404 for an unknown order; the finding asks for a 400, which contradicts AC-2 as written.',
};

describe('DeveloperOutcomeSchema — self-approval is unrepresentable (D-05)', () => {
  it('declares exactly three members, and none of them is a pass', () => {
    expect(DEVELOPER_OUTCOME_KINDS).toEqual([
      'committed',
      'dispute',
      'blocked',
    ]);
    expect(DeveloperOutcomeSchema.options).toHaveLength(3);
    expect(DEVELOPER_OUTCOME_KINDS).not.toContain('pass');
  });

  it('rejects a pass in every shape it could be attempted', () => {
    // Not one runtime guard rejecting a known-bad value — there is simply no
    // member of the union that could accept any of these.
    const attempts: unknown[] = [
      { kind: 'pass' },
      { kind: 'pass', summary: 'looks good to me' },
      { kind: 'pass', checked: [{ kind: 'criterion', id: 'AC-1' }] },
      { kind: 'pass', sha: 'a'.repeat(40) },
      {
        outcome: 'pass',
        summary: 'looks good',
        checked: [{ kind: 'criterion', id: 'AC-1' }],
      },
    ];

    for (const attempt of attempts) {
      expect(
        DeveloperOutcomeSchema.safeParse(attempt).success,
        JSON.stringify(attempt),
      ).toBe(false);
    }
  });

  it('accepts committed with a commit sha', () => {
    const result = DeveloperOutcomeSchema.safeParse({
      kind: 'committed',
      sha: 'a1b2c3d4e5'.repeat(4),
    });
    expect(result.success).toBe(true);
  });

  it('rejects committed without a plausible sha', () => {
    expect(
      DeveloperOutcomeSchema.safeParse({ kind: 'committed' }).success,
    ).toBe(false);
    expect(
      DeveloperOutcomeSchema.safeParse({ kind: 'committed', sha: '' }).success,
    ).toBe(false);
    expect(
      DeveloperOutcomeSchema.safeParse({ kind: 'committed', sha: 'not a sha' })
        .success,
    ).toBe(false);
  });

  it('accepts blocked with a reason, and rejects one without', () => {
    expect(
      DeveloperOutcomeSchema.safeParse({
        kind: 'blocked',
        reason: 'the database migration will not apply',
      }).success,
    ).toBe(true);
    expect(DeveloperOutcomeSchema.safeParse({ kind: 'blocked' }).success).toBe(
      false,
    );
    expect(
      DeveloperOutcomeSchema.safeParse({ kind: 'blocked', reason: '' }).success,
    ).toBe(false);
  });

  it('accepts a complete dispute', () => {
    expect(
      DeveloperOutcomeSchema.safeParse({
        kind: 'dispute',
        dispute: COMPLETE_DISPUTE,
      }).success,
    ).toBe(true);
  });
});

describe('DisputeSchema — structure is what makes a dispute triageable (D-06)', () => {
  it('accepts a dispute naming a finding fingerprint', () => {
    expect(DisputeSchema.safeParse(COMPLETE_DISPUTE).success).toBe(true);
  });

  it('accepts a dispute naming a stage id', () => {
    expect(
      DisputeSchema.safeParse({
        ...COMPLETE_DISPUTE,
        target: { kind: 'stage', stageId: 'security-harness' },
      }).success,
    ).toBe(true);
  });

  it('rejects a dispute missing its criterionRef', () => {
    const { criterionRef: _dropped, ...withoutRef } = COMPLETE_DISPUTE;
    expect(DisputeSchema.safeParse(withoutRef).success).toBe(false);
  });

  it('rejects a dispute missing its target — never neither', () => {
    const { target: _dropped, ...withoutTarget } = COMPLETE_DISPUTE;
    expect(DisputeSchema.safeParse(withoutTarget).success).toBe(false);
  });

  it('rejects a target that names neither a fingerprint nor a stage id', () => {
    expect(
      DisputeSchema.safeParse({ ...COMPLETE_DISPUTE, target: {} }).success,
    ).toBe(false);
    expect(
      DisputeSchema.safeParse({
        ...COMPLETE_DISPUTE,
        target: { kind: 'finding' },
      }).success,
    ).toBe(false);
    expect(
      DisputeSchema.safeParse({
        ...COMPLETE_DISPUTE,
        target: { kind: 'stage' },
      }).success,
    ).toBe(false);
  });

  it('rejects a fingerprint that is not 64 characters', () => {
    expect(
      DisputeSchema.safeParse({
        ...COMPLETE_DISPUTE,
        target: { kind: 'finding', fingerprint: 'abc' },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing or empty argument', () => {
    const { argument: _dropped, ...withoutArgument } = COMPLETE_DISPUTE;
    expect(DisputeSchema.safeParse(withoutArgument).success).toBe(false);
    expect(
      DisputeSchema.safeParse({ ...COMPLETE_DISPUTE, argument: '' }).success,
    ).toBe(false);
  });

  it('makes a dispute malformed rather than partially valid when a field is missing', () => {
    // D-06 read literally: "missing any of those makes it malformed, not a
    // dispute". A half-dispute must not survive parsing in a degraded form.
    const { criterionRef: _a, ...noRef } = COMPLETE_DISPUTE;
    expect(
      DeveloperOutcomeSchema.safeParse({ kind: 'dispute', dispute: noRef })
        .success,
    ).toBe(false);
  });
});

describe('round accounting — the honest exit is never charged for', () => {
  it('reports zero rounds consumed for all three kinds', () => {
    expect(DEVELOPER_OUTCOME_ROUND_COST).toEqual({
      committed: 0,
      dispute: 0,
      blocked: 0,
    });
    for (const kind of DEVELOPER_OUTCOME_KINDS) {
      expect(DEVELOPER_OUTCOME_ROUND_COST[kind]).toBe(0);
    }
  });

  it('covers every declared kind, so a fourth cannot be added without a decision', () => {
    expect(Object.keys(DEVELOPER_OUTCOME_ROUND_COST).sort()).toEqual(
      [...DEVELOPER_OUTCOME_KINDS].sort(),
    );
  });
});
