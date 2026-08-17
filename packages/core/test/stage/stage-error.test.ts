import { describe, expect, it } from 'vitest';

import {
  capRawOutput,
  isTransientStageErrorKind,
  NON_TRANSIENT_ESCALATION_THRESHOLD,
  parseStageOutput,
  RAW_REF_HEAD_BYTES,
  RAW_REF_TAIL_BYTES,
  rawRefElisionMarker,
  reconcileCriterionRefs,
  shouldEscalate,
  STAGE_ERROR_KINDS,
  StageErrorSchema,
  stageErrorPolicy,
  type StageErrorKind,
} from '../../src/stage/index.js';
import {
  fingerprintFinding,
  VerdictSchema,
  type Finding,
  type PassVerdict,
} from '../../src/verdict/index.js';

/**
 * The infrastructure-failure channel (D-12, CORE-06).
 *
 * The single property every assertion here defends: **"the gate broke" can
 * never be recorded as "the gate judged"**. The compile-time half of that proof
 * lives in `type-boundary.test-d.ts`; this file is the runtime half.
 */

const WELL_FORMED_STAGE_ERROR = {
  kind: 'timeout',
  retryable: true,
  detail: 'the reviewer agent exceeded its 600s wall clock',
  rawRef: 'artifact://run-01/stage-review/raw.txt',
} as const;

const WELL_FORMED_VERDICT = {
  outcome: 'pass',
  summary: 'every acceptance criterion is covered by a passing test',
  checked: [{ kind: 'criterion', id: 'AC-1' }],
} as const;

function findingCiting(id: string): Finding {
  return {
    fingerprint: fingerprintFinding({
      stageId: 'review',
      title: `AC ${id} is unimplemented`,
    }),
    severity: 'blocker',
    title: `AC ${id} is unimplemented`,
    detail: 'no handler exists for the described request',
    criterionRef: { kind: 'criterion', id },
  };
}

function passCiting(...ids: string[]): PassVerdict {
  return {
    outcome: 'pass',
    summary: 'checked every criterion',
    checked: ids.map((id) => ({ kind: 'criterion', id }) as const),
  };
}

describe('StageErrorSchema', () => {
  it('accepts each of the five kinds and rejects a sixth', () => {
    expect(STAGE_ERROR_KINDS).toEqual([
      'unparseable',
      'provider_error',
      'timeout',
      'binary_missing',
      'auth',
    ]);

    for (const kind of STAGE_ERROR_KINDS) {
      const result = StageErrorSchema.safeParse({
        kind,
        retryable: stageErrorPolicy(kind).retryable,
        detail: `the ${kind} path`,
      });
      expect(result.success, `kind ${kind} should validate`).toBe(true);
    }

    expect(
      StageErrorSchema.safeParse({
        kind: 'flaky',
        retryable: true,
        detail: 'x',
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty detail and rejects an empty one', () => {
    expect(
      StageErrorSchema.safeParse({ kind: 'auth', retryable: false, detail: '' })
        .success,
    ).toBe(false);
  });

  it('is disjoint from Verdict at runtime, in both directions', () => {
    // The compiler refuses the confusion (type-boundary.test-d.ts); the schemas
    // refuse it too, so a payload crossing a process boundary cannot smuggle a
    // broken gate in as a judging one.
    expect(VerdictSchema.safeParse(WELL_FORMED_STAGE_ERROR).success).toBe(
      false,
    );
    expect(StageErrorSchema.safeParse(WELL_FORMED_VERDICT).success).toBe(false);

    // Sanity: each really is well-formed for its own schema.
    expect(StageErrorSchema.safeParse(WELL_FORMED_STAGE_ERROR).success).toBe(
      true,
    );
    expect(VerdictSchema.safeParse(WELL_FORMED_VERDICT).success).toBe(true);
  });
});

describe('stageErrorPolicy', () => {
  // Asserted for all five kinds, not sampled — a table, so adding a sixth kind
  // without deciding its policy fails here rather than defaulting silently.
  const EXPECTED: Readonly<
    Record<
      StageErrorKind,
      { retryable: boolean; consumesRound: boolean; consumesBudget: boolean }
    >
  > = {
    provider_error: {
      retryable: true,
      consumesRound: false,
      consumesBudget: false,
    },
    timeout: { retryable: true, consumesRound: false, consumesBudget: false },
    unparseable: {
      retryable: false,
      consumesRound: false,
      consumesBudget: true,
    },
    binary_missing: {
      retryable: false,
      consumesRound: false,
      consumesBudget: false,
    },
    auth: { retryable: false, consumesRound: false, consumesBudget: false },
  };

  it.each(STAGE_ERROR_KINDS)('routes %s exactly as decided', (kind) => {
    expect(stageErrorPolicy(kind)).toEqual(EXPECTED[kind]);
  });

  it('never lets an infrastructure failure cost the developer a round', () => {
    // CORE-06's whole promise, asserted over the entire kind space at once.
    for (const kind of STAGE_ERROR_KINDS) {
      expect(stageErrorPolicy(kind).consumesRound).toBe(false);
    }
  });

  it('marks exactly provider_error and timeout as transient', () => {
    const transient = STAGE_ERROR_KINDS.filter(isTransientStageErrorKind);
    expect(transient).toEqual(['provider_error', 'timeout']);
  });
});

describe('non-transient escalation threshold (D-15)', () => {
  it('is a named constant with the value 2', () => {
    expect(NON_TRANSIENT_ESCALATION_THRESHOLD).toBe(2);
  });

  it('does not escalate at one consecutive error and does at two', () => {
    expect(shouldEscalate(0)).toBe(false);
    expect(shouldEscalate(1)).toBe(false);
    expect(shouldEscalate(2)).toBe(true);
    expect(shouldEscalate(3)).toBe(true);
  });
});

describe('capRawOutput (T-1-21)', () => {
  it('names both halves of the cap as 16384-byte constants', () => {
    expect(RAW_REF_HEAD_BYTES).toBe(16_384);
    expect(RAW_REF_TAIL_BYTES).toBe(16_384);
  });

  it('returns an input at exactly the cap untouched', () => {
    const raw = 'a'.repeat(RAW_REF_HEAD_BYTES + RAW_REF_TAIL_BYTES);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(32_768);
    expect(capRawOutput(raw)).toBe(raw);
  });

  it('returns head + marker + tail for an input above the cap', () => {
    const size = 33_792; // 32 KB + 1 KB
    const raw =
      'h'.repeat(RAW_REF_HEAD_BYTES) +
      'x'.repeat(1024) +
      't'.repeat(RAW_REF_TAIL_BYTES);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(size);

    const capped = capRawOutput(raw);
    const marker = rawRefElisionMarker(1024);

    expect(capped).toBe(
      'h'.repeat(RAW_REF_HEAD_BYTES) + marker + 't'.repeat(RAW_REF_TAIL_BYTES),
    );
    expect(Buffer.byteLength(capped, 'utf8')).toBe(
      32_768 + Buffer.byteLength(marker, 'utf8'),
    );
    // The marker names how much went missing, so a reader is never misled about
    // what they are looking at.
    expect(marker).toContain('1024');
  });

  it('never splits a multi-byte character at either seam', () => {
    // A 4-byte body with a 3-byte ASCII prefix and a 1-byte suffix, sized so a
    // naive byte slice lands mid-sequence at BOTH the head cut and the tail cut
    // and would emit U+FFFD at each.
    const raw = '###' + '𐍈'.repeat(12_000) + '#';
    expect(Buffer.byteLength(raw, 'utf8')).toBe(48_004);
    expect((16_384 - 3) % 4).not.toBe(0);
    expect((48_004 - 16_384 - 3) % 4).not.toBe(0);

    const capped = capRawOutput(raw);
    expect(capped).not.toContain('�');
    // Backing off a seam costs at most three bytes per side.
    expect(Buffer.byteLength(capped, 'utf8')).toBeGreaterThanOrEqual(
      32_768 - 6,
    );
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(
      32_768 + Buffer.byteLength(rawRefElisionMarker(48_004), 'utf8'),
    );
  });
});

describe('parseStageOutput — the ladder is bounded at one repair (D-13)', () => {
  it('parses a first-attempt payload with zero reprompts', () => {
    const result = parseStageOutput(JSON.stringify(WELL_FORMED_VERDICT), 0);
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(0);
    expect(result.verdict.outcome).toBe('pass');
  });

  it('recovers valid JSON wrapped in prose with zero reprompts', () => {
    const raw = [
      'Sure! Here is my verdict:',
      '```json',
      JSON.stringify(WELL_FORMED_VERDICT),
      '```',
      'Let me know if you need anything else.',
    ].join('\n');

    const result = parseStageOutput(raw, 0);
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(0);
  });

  it('warrants exactly one repair, quoting back the six valid outcome names', () => {
    const result = parseStageOutput(
      JSON.stringify({ outcome: 'looks_good', summary: 'lgtm' }),
      0,
    );

    expect(result.kind).toBe('repair');
    if (result.kind !== 'repair') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    // The cheapest possible repair prompt: the model guessed a seventh outcome,
    // so hand it the six that exist.
    expect(result.reprompt.validOutcomes).toEqual([
      'pass',
      'send_back',
      'fail',
      'inconclusive',
      'warn',
      'skip',
    ]);
    // …and the list really is lifted from Zod's own issue, not hardcoded twice.
    expect(result.reprompt.issues.map((issue) => issue.code)).toContain(
      'invalid_union',
    );
  });

  it('parses on the repaired attempt and reports exactly one repair', () => {
    const result = parseStageOutput(JSON.stringify(WELL_FORMED_VERDICT), 1);
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
  });

  it('yields StageError{unparseable} after one repair, never a second', () => {
    const result = parseStageOutput('I could not produce a verdict, sorry.', 1);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    expect(result.error.kind).toBe('unparseable');
    expect(StageErrorSchema.safeParse(result.error).success).toBe(true);
    // It is an infrastructure failure, never any Verdict.
    expect(VerdictSchema.safeParse(result.error).success).toBe(false);
  });

  it('refuses to climb past the bound even if asked', () => {
    const result = parseStageOutput('still not a verdict', 5);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    expect(result.error.kind).toBe('unparseable');
  });
});

describe('reconcileCriterionRefs — D-04 asymmetry by direction', () => {
  const KNOWN = ['AC-1', 'AC-2', 'AC-3'];

  it('returns a finding citing only known ids unchanged, with no repair', () => {
    const finding = findingCiting('AC-2');
    const result = reconcileCriterionRefs(
      { kind: 'finding', finding },
      KNOWN,
      0,
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(0);
    expect(result.target).toEqual({ kind: 'finding', finding });
  });

  it('returns a pass verdict citing only known ids unchanged, with no repair', () => {
    const verdict = passCiting('AC-1', 'AC-3');
    const result = reconcileCriterionRefs({ kind: 'pass', verdict }, KNOWN, 0);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(0);
    expect(result.target).toEqual({ kind: 'pass', verdict });
  });

  it('a global reference is always known — it names no criterion to be wrong about', () => {
    const finding: Finding = {
      ...findingCiting('AC-1'),
      criterionRef: { kind: 'global', category: 'code_quality' },
    };
    expect(
      reconcileCriterionRefs({ kind: 'finding', finding }, KNOWN, 0).kind,
    ).toBe('ok');
  });

  it('warrants one repair for an unknown id on a finding', () => {
    const result = reconcileCriterionRefs(
      { kind: 'finding', finding: findingCiting('AC-9') },
      KNOWN,
      0,
    );

    expect(result.kind).toBe('repair');
    if (result.kind !== 'repair') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    expect(result.unknownIds).toEqual(['AC-9']);
    expect(result.knownIds).toEqual(KNOWN);
  });

  it('demotes a still-unknown finding reference to global, flagged loudly', () => {
    const finding = findingCiting('AC-9');
    const result = reconcileCriterionRefs(
      { kind: 'finding', finding },
      KNOWN,
      1,
    );

    expect(result.kind).toBe('demoted');
    if (result.kind !== 'demoted') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    expect(result.finding.criterionRef).toEqual({
      kind: 'global',
      category: 'other',
    });
    // Demoting a complaint is safe — but it must never be silent.
    expect(result.flag.originalCriterionId).toBe('AC-9');
    expect(result.flag.notice).toContain('AC-9');
    // The complaint itself survives intact; only its reference moved.
    expect(result.finding.title).toBe(finding.title);
    expect(result.finding.detail).toBe(finding.detail);
  });

  it('warrants one repair for an unknown id in a pass verdict', () => {
    const result = reconcileCriterionRefs(
      { kind: 'pass', verdict: passCiting('AC-1', 'AC-9') },
      KNOWN,
      0,
    );

    expect(result.kind).toBe('repair');
    if (result.kind !== 'repair') throw new Error('unreachable');
    expect(result.unknownIds).toEqual(['AC-9']);
  });

  it('sends a still-unknown pass citation down the infrastructure-failure path, never demoting it', () => {
    const result = reconcileCriterionRefs(
      { kind: 'pass', verdict: passCiting('AC-1', 'AC-9') },
      KNOWN,
      1,
    );

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.repairAttempts).toBe(1);
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('AC-9');
    expect(StageErrorSchema.safeParse(result.error).success).toBe(true);
  });

  it('never demotes a pass verdict — the asymmetry is the point', () => {
    // Fabricated evidence that a criterion was checked is the silently-wrong-
    // but-green failure this project exists to prevent. There is deliberately
    // no attempt count at which a pass citation gets demoted.
    for (const attempt of [0, 1, 2, 3]) {
      const result = reconcileCriterionRefs(
        { kind: 'pass', verdict: passCiting('AC-9') },
        KNOWN,
        attempt,
      );
      expect(result.kind).not.toBe('demoted');
      expect(result.kind).not.toBe('ok');
    }
  });
});
