import { describe, expect, it } from 'vitest';

import { aggregate } from '../../src/verdict/aggregate.js';
import { RoundOutcomeSchema } from '../../src/verdict/round-outcome.js';
import {
  fingerprintFinding,
  type Finding,
  type Severity,
} from '../../src/verdict/finding.js';
import {
  OUTCOMES,
  VerdictSchema,
  type Outcome,
  type Verdict,
} from '../../src/verdict/verdict.js';

/**
 * CORE-02's word *exhaustively*, made literally true.
 *
 * The enumeration is **multisets** — order-insensitive combinations with
 * repetition — over the six outcomes, for **every** pipeline length from 1 to
 * `MAX_STAGES` inclusive, plus the empty list handled as its own case.
 *
 * The counts, so a future reader can check them rather than trust them:
 *
 * | length n | count C(n+5,5) |
 * |----------|----------------|
 * | 1        | 6              |
 * | 2        | 21             |
 * | 3        | 56             |
 * | 4        | 126            |
 * | 5        | 252            |
 * | 6        | 462            |
 * | 7        | 792            |
 * | 8        | 1287           |
 * | **1..8** | **3002**       |
 *
 * Length exactly 8 alone is **1,287**. Enumerating only that — which is what
 * "~1,300 cases at 8 stages" in 01-CONTEXT.md invites — silently skips every
 * shorter pipeline, and a shorter pipeline is the common case. The two other
 * ways this proof is commonly wrong (01-RESEARCH.md § Pitfall 9) are enumerating
 * *ordered tuples* (6^8 = 1,679,616 — tractable but a weaker proof than
 * multisets + permutation invariance) and enumerating bare outcome *names*
 * without the payloads `aggregate` actually branches on. Every enumerated name
 * below is inflated into a real `Verdict` that has survived `VerdictSchema`.
 */
const MAX_STAGES = 8;

/** The per-length series above, asserted rather than assumed. */
const EXPECTED_PER_LENGTH = [6, 21, 56, 126, 252, 462, 792, 1287] as const;
const EXPECTED_TOTAL = 3002;
const EXPECTED_AT_EXACTLY_EIGHT = 1287;

/** Every multiset (order-insensitive combination with repetition) of length n. */
function multisets<T>(items: readonly T[], n: number): T[][] {
  if (n === 0) return [[]];
  const out: T[][] = [];
  const acc: T[] = [];
  const walk = (start: number): void => {
    if (acc.length === n) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i] as T);
      walk(i);
      acc.pop();
    }
  };
  walk(0);
  return out;
}

function makeFinding(
  stageId: string,
  title: string,
  severity: Severity,
): Finding {
  return {
    fingerprint: fingerprintFinding({ stageId, title }),
    severity,
    title,
    detail: `${title} — raised by ${stageId}`,
    criterionRef: { kind: 'criterion', id: 'AC-1' },
  };
}

const SEND_BACK_FINDING = makeFinding(
  'reviewer',
  'Password comparison is not constant-time',
  'blocker',
);
const WARN_FINDING = makeFinding(
  'reviewer',
  'This helper could be a one-liner',
  'nit',
);

/**
 * One real, schema-valid `Verdict` per outcome.
 *
 * Every payload here goes through `VerdictSchema.parse`, so a stub that would
 * not survive validation cannot silently enter the proof: a `pass` carries a
 * non-empty `checked`, a `send_back` carries a `Finding` with a real 64-char
 * fingerprint and a `criterionRef`, a `skip` carries a `reason`. The six are
 * parsed once and reused across all 3,002 multisets — the enumeration varies
 * *which* verdicts are in the round, and these six are the complete set of
 * payloads it draws from.
 */
const STUBS: Readonly<Record<Outcome, Verdict>> = Object.freeze({
  pass: VerdictSchema.parse({
    outcome: 'pass',
    summary: 'All cited criteria are satisfied',
    checked: [{ kind: 'criterion', id: 'AC-1' }],
  }),
  send_back: VerdictSchema.parse({
    outcome: 'send_back',
    summary: 'One blocking finding',
    findings: [SEND_BACK_FINDING],
  }),
  fail: VerdictSchema.parse({
    outcome: 'fail',
    summary: 'Not fixable by another round',
    reason: 'The feature spec contradicts itself',
  }),
  inconclusive: VerdictSchema.parse({
    outcome: 'inconclusive',
    summary: 'Could not tell',
    reason: 'The app never became ready, so no behaviour was observed',
  }),
  warn: VerdictSchema.parse({
    outcome: 'warn',
    summary: 'Non-blocking observations',
    findings: [WARN_FINDING],
  }),
  skip: VerdictSchema.parse({
    outcome: 'skip',
    reason: 'No security harness is configured for this repository',
  }),
});

function stubVerdict(outcome: Outcome): Verdict {
  return STUBS[outcome];
}

function round(outcomes: readonly Outcome[]): readonly Verdict[] {
  return outcomes.map(stubVerdict);
}

describe('aggregate() — CORE-02, exhaustively', () => {
  const perLength = Array.from({ length: MAX_STAGES }, (_, i) =>
    multisets(OUTCOMES, i + 1),
  );
  const all = perLength.flat();

  it('enumerates every multiset for lengths 1..8 — 3,002 of them', () => {
    // Asserted, not trusted. A generator bug that quietly halved the
    // enumeration would otherwise leave every safety assertion below passing
    // over a smaller universe, which is the failure this test exists to make
    // impossible.
    expect(perLength.map((bucket) => bucket.length)).toEqual([
      ...EXPECTED_PER_LENGTH,
    ]);
    expect(all).toHaveLength(EXPECTED_TOTAL);
    expect(perLength[MAX_STAGES - 1]).toHaveLength(EXPECTED_AT_EXACTLY_EIGHT);
  });

  it('no verdict set containing `inconclusive` can compute green', () => {
    const offenders: string[] = [];
    for (const combo of all) {
      if (!combo.includes('inconclusive')) continue;
      if (aggregate(round(combo)).kind === 'green')
        offenders.push(combo.join('+'));
    }
    expect(offenders).toEqual([]);
  });

  it('is invariant under permutation across all 3,002 cases', () => {
    const offenders: string[] = [];
    for (const combo of all) {
      const forward = aggregate(round(combo)).kind;
      const backward = aggregate(round([...combo].reverse())).kind;
      if (forward !== backward)
        offenders.push(`${combo.join('+')}: ${forward} vs ${backward}`);
    }
    expect(offenders).toEqual([]);
  });

  it('produces a schema-valid RoundOutcome for every enumerated case', () => {
    const offenders: string[] = [];
    for (const combo of all) {
      if (!RoundOutcomeSchema.safeParse(aggregate(round(combo))).success) {
        offenders.push(combo.join('+'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('handles the empty verdict list explicitly, without throwing', () => {
    expect(() => aggregate([])).not.toThrow();
    const outcome = aggregate([]);
    expect(outcome).toBeDefined();
    expect(RoundOutcomeSchema.safeParse(outcome).success).toBe(true);
    // Zero gates ran, so nothing was verified — green would be the purest form
    // of the failure this project exists to prevent, and `unverified` would
    // carry a vacuous empty payload. See 01-02-SUMMARY.md § Decisions Made 1.
    expect(outcome.kind).toBe('escalate');
  });
});

describe('aggregate() — D-10 precedence, as named tests', () => {
  // These are deliberately separate from the 3,002-case loops above so a
  // precedence regression reports as a precedence failure rather than as one
  // line in a bulk enumeration.

  it('escalates when any verdict is `fail`, whatever else is present', () => {
    for (const other of OUTCOMES) {
      expect(aggregate(round(['fail', other])).kind).toBe('escalate');
      expect(aggregate(round([other, 'fail'])).kind).toBe('escalate');
    }
  });

  it('sends back when `send_back` sits alongside `inconclusive` and no `fail`', () => {
    const outcome = aggregate(
      round(['inconclusive', 'send_back', 'warn', 'pass', 'skip']),
    );
    expect(outcome.kind).toBe('send_back');
    if (outcome.kind !== 'send_back') throw new Error('unreachable');
    const fingerprints = outcome.brief.findings.map((f) => f.fingerprint);
    // The brief carries every finding every gate raised this round — the
    // blocking one from `send_back` and the non-blocking one from `warn`.
    expect(fingerprints).toContain(SEND_BACK_FINDING.fingerprint);
    expect(fingerprints).toContain(WARN_FINDING.fingerprint);
    // Deterministically ordered: blocker before nit.
    expect(outcome.brief.findings.map((f) => f.severity)).toEqual([
      'blocker',
      'nit',
    ]);
  });

  it('is unverified when `inconclusive` has no `send_back` and no `fail` anywhere', () => {
    const outcome = aggregate(round(['pass', 'inconclusive', 'warn', 'skip']));
    expect(outcome.kind).toBe('unverified');
    if (outcome.kind !== 'unverified') throw new Error('unreachable');
    expect(outcome.inconclusive).toHaveLength(1);
    expect(outcome.inconclusive[0]?.outcome).toBe('inconclusive');
  });

  it('is green only when every verdict is `pass`, `warn`, or `skip`', () => {
    for (const combo of multisets(['pass', 'warn', 'skip'] as const, 3)) {
      expect(aggregate(round(combo)).kind).toBe('green');
    }
    expect(aggregate(round(['pass'])).kind).toBe('green');
    expect(aggregate(round(['warn', 'skip'])).kind).toBe('green');
  });
});
