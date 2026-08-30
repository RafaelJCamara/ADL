import { describe, expect, it } from 'vitest';

import { detectStalemate } from '../../src/loop/stalemate.js';
import { fingerprintFinding } from '../../src/verdict/finding.js';
import type { Finding } from '../../src/verdict/finding.js';

const CRITERION = { kind: 'global', category: 'other' } as const;

function finding(title: string, path?: string): Finding {
  return {
    fingerprint: fingerprintFinding({
      stageId: 'review',
      title,
      location: path === undefined ? undefined : { path },
    }),
    severity: 'blocker',
    title,
    detail: title,
    criterionRef: CRITERION,
  };
}

describe('detectStalemate', () => {
  it('reports nothing when every finding is under the threshold', () => {
    const f = finding('unvalidated input');
    const stalled = detectStalemate({
      currentFindings: [f],
      fingerprintCounts: new Map([[f.fingerprint, 1]]),
      threshold: 2,
    });
    expect(stalled).toEqual([]);
  });

  it('flags a finding whose count has reached the threshold', () => {
    const f = finding('unvalidated input');
    const stalled = detectStalemate({
      currentFindings: [f],
      fingerprintCounts: new Map([[f.fingerprint, 2]]),
      threshold: 2,
    });
    expect(stalled).toEqual([{ finding: f, occurrences: 2 }]);
  });

  it('flags a finding whose count has exceeded the threshold, not only exactly matched it', () => {
    const f = finding('unvalidated input');
    const stalled = detectStalemate({
      currentFindings: [f],
      fingerprintCounts: new Map([[f.fingerprint, 5]]),
      threshold: 2,
    });
    expect(stalled).toEqual([{ finding: f, occurrences: 5 }]);
  });

  it('a fingerprint absent from the count map has occurred zero times, never assumed present', () => {
    const f = finding('unvalidated input');
    const stalled = detectStalemate({
      currentFindings: [f],
      fingerprintCounts: new Map(),
      threshold: 1,
    });
    // threshold 1 means "one occurrence is already too many" — 0 is still
    // under it, so a fingerprint the map has never seen does not stall.
    expect(stalled).toEqual([]);
  });

  it('flags only the findings that individually cross the threshold, preserving currentFindings order', () => {
    const stale = finding('unvalidated input');
    const fresh = finding('missing null check');
    const stalled = detectStalemate({
      currentFindings: [fresh, stale],
      fingerprintCounts: new Map([
        [stale.fingerprint, 3],
        [fresh.fingerprint, 1],
      ]),
      threshold: 2,
    });
    expect(stalled).toEqual([{ finding: stale, occurrences: 3 }]);
  });

  it('de-duplicates by fingerprint — the same finding listed twice in one round does not inflate the report', () => {
    const f = finding('unvalidated input');
    const stalled = detectStalemate({
      currentFindings: [f, { ...f }],
      fingerprintCounts: new Map([[f.fingerprint, 2]]),
      threshold: 2,
    });
    expect(stalled).toEqual([{ finding: f, occurrences: 2 }]);
  });

  it('two findings with different titles fingerprint differently and are tracked independently', () => {
    const a = finding('unvalidated input');
    const b = finding('missing null check');
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('the same title at a different path fingerprints differently', () => {
    const a = finding('unvalidated input', 'src/a.ts');
    const b = finding('unvalidated input', 'src/b.ts');
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('no findings at all reports no stalemate, even with a hot fingerprint history', () => {
    const stalled = detectStalemate({
      currentFindings: [],
      fingerprintCounts: new Map([['a'.repeat(64), 99]]),
      threshold: 1,
    });
    expect(stalled).toEqual([]);
  });
});
