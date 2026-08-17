import { describe, expect, it } from 'vitest';

import {
  FindingSchema,
  fingerprintFinding,
  normaliseTitle,
  sortFindings,
  type Finding,
} from '../../src/verdict/finding.js';

/** CORE-04: `criterionRef`, `fingerprint`, `location`, and `sortFindings`. */

function makeFinding(overrides: Partial<Record<keyof Finding, unknown>> = {}): unknown {
  return {
    fingerprint: fingerprintFinding({ stageId: 'reviewer', title: 'Missing input validation' }),
    severity: 'major',
    title: 'Missing input validation',
    detail: 'The handler trusts req.body without checking its shape.',
    criterionRef: { kind: 'criterion', id: 'AC-1' },
    ...overrides,
  };
}

describe('FindingSchema — CORE-04', () => {
  it('requires criterionRef', () => {
    const { criterionRef: _drop, ...withoutCriterionRef } = makeFinding() as Record<
      string,
      unknown
    >;
    const result = FindingSchema.safeParse(withoutCriterionRef);
    expect(result.success).toBe(false);
  });

  it('enforces a 64-character fingerprint — too short and too long both fail', () => {
    expect(FindingSchema.safeParse(makeFinding({ fingerprint: 'a'.repeat(63) })).success).toBe(
      false,
    );
    expect(FindingSchema.safeParse(makeFinding({ fingerprint: 'a'.repeat(65) })).success).toBe(
      false,
    );
    expect(FindingSchema.safeParse(makeFinding({ fingerprint: 'a'.repeat(64) })).success).toBe(
      true,
    );
  });

  it('accepts a Finding with no location — location is optional', () => {
    const result = FindingSchema.safeParse(makeFinding());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.location).toBeUndefined();
  });

  it('location.path is documented as workspace-relative; every fixture in this suite honours it', () => {
    const result = FindingSchema.safeParse(
      makeFinding({ location: { path: 'src/handlers/create.ts', line: 12 } }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.data.location) {
      expect(result.data.location.path.startsWith('/')).toBe(false);
      expect(result.data.location.path).not.toMatch(/^[A-Za-z]:[\\/]/);
    }
  });

  it('sortFindings is deterministic across repeat calls over the same set', () => {
    const a = makeFinding({
      fingerprint: fingerprintFinding({ stageId: 'reviewer', title: 'A blocker' }),
      severity: 'blocker',
      title: 'A blocker',
    }) as Finding;
    const b = makeFinding({
      fingerprint: fingerprintFinding({ stageId: 'reviewer', title: 'A nit' }),
      severity: 'nit',
      title: 'A nit',
    }) as Finding;
    const c = makeFinding({
      fingerprint: fingerprintFinding({ stageId: 'reviewer', title: 'A major' }),
      severity: 'major',
      title: 'A major',
    }) as Finding;

    const set = [b, c, a];
    const first = sortFindings(set).map((f) => f.fingerprint);
    const second = sortFindings(set).map((f) => f.fingerprint);
    expect(first).toEqual(second);
    // blocker before major before nit
    expect(sortFindings(set).map((f) => f.severity)).toEqual(['blocker', 'major', 'nit']);
  });

  it('sortFindings does not mutate its input', () => {
    const original: Finding[] = [
      makeFinding({ severity: 'nit', title: 'Z' }) as Finding,
      makeFinding({ severity: 'blocker', title: 'A' }) as Finding,
    ];
    const before = original.map((f) => f.title);
    sortFindings(original);
    expect(original.map((f) => f.title)).toEqual(before);
  });
});

/**
 * Fingerprint normalisation pair corpus (01-RESEARCH.md § Open Questions 1).
 *
 * Pairs that should collapse to one fingerprint (rephrasings), and pairs that
 * should not (genuinely different findings). This corpus pins today's
 * behaviour so it cannot drift by accident — it is not a claim that the
 * normalisation strength is finally right. 01-RESEARCH.md is explicit that
 * tuning it is deferred to Phase 6 evidence.
 */
describe('fingerprint normalisation — pinned behaviour, tuning deferred to Phase 6', () => {
  const STAGE = 'reviewer';

  it.each([
    ['same title differing only in letter case', 'Missing Null Check', 'missing null check'],
    [
      'same title differing only in collapsed whitespace',
      'Missing   null    check',
      'Missing null check',
    ],
    [
      'same title differing only in a trailing "(line N)" reference',
      'Missing null check (line 42)',
      'Missing null check',
    ],
    [
      'same title differing only in a trailing "(lines N-M)" reference',
      'Missing null check (lines 42-47)',
      'Missing null check',
    ],
    [
      'same title differing only in a trailing "(at line N)" reference',
      'Missing null check (at line 42)',
      'Missing null check',
    ],
  ])('collapse: %s', (_label, titleA, titleB) => {
    const a = fingerprintFinding({ stageId: STAGE, title: titleA });
    const b = fingerprintFinding({ stageId: STAGE, title: titleB });
    expect(a).toBe(b);
    expect(normaliseTitle(titleA)).toBe(normaliseTitle(titleB));
  });

  it.each([
    ['titles naming different code identifiers', "`foo` is unvalidated", "`bar` is unvalidated"],
    [
      'titles describing different problems entirely',
      'Missing null check',
      'SQL injection via string concatenation',
    ],
    [
      'titles naming different files in the trailing reference position',
      'Handler does not validate req.body',
      'Handler does not validate req.query',
    ],
    [
      'same normalised title but different stage id',
      // Same title, verified below with two different stageId values instead.
      'Missing null check',
      'Missing null check',
    ],
  ])('do not collapse: %s', (label, titleA, titleB) => {
    if (label === 'same normalised title but different stage id') {
      const a = fingerprintFinding({ stageId: 'reviewer', title: titleA });
      const b = fingerprintFinding({ stageId: 'security', title: titleB });
      expect(a).not.toBe(b);
      return;
    }
    const a = fingerprintFinding({ stageId: STAGE, title: titleA });
    const b = fingerprintFinding({ stageId: STAGE, title: titleB });
    expect(a).not.toBe(b);
  });

  it('does not collapse findings that differ only in location.path', () => {
    const a = fingerprintFinding({
      stageId: STAGE,
      title: 'Missing null check',
      location: { path: 'src/a.ts' },
    });
    const b = fingerprintFinding({
      stageId: STAGE,
      title: 'Missing null check',
      location: { path: 'src/b.ts' },
    });
    expect(a).not.toBe(b);
  });
});
