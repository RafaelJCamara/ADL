import { describe, expect, it } from 'vitest';

import {
  DurationSchema,
  MAX_DURATION_MS,
  parseDuration,
} from '../../src/config/duration.js';
import { LoadError } from '../../src/errors.js';

/**
 * `adl.yml` accepts durations as a closed vocabulary of digits-plus-unit
 * strings and nothing else. Every assertion here defends one of the two
 * failure modes the format exists to prevent: an ambiguous bare integer, and a
 * value so large the YAML parser rounds it before anyone can reject it
 * (01-RESEARCH.md § Pitfall 11).
 */

/** Milliseconds per unit — the arithmetic `parseDuration` must reproduce exactly. */
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

describe('DurationSchema', () => {
  it('accepts a value in each of the four units', () => {
    for (const value of ['250ms', '30s', '10m', '2h']) {
      expect(DurationSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects a bare integer, because an unlabelled number is exactly the ambiguity this format exists to remove', () => {
    expect(DurationSchema.safeParse('10').success).toBe(false);
    expect(DurationSchema.safeParse(10 as unknown).success).toBe(false);
  });

  it('rejects a negative value', () => {
    expect(DurationSchema.safeParse('-5m').success).toBe(false);
    expect(DurationSchema.safeParse('-1ms').success).toBe(false);
  });

  it('rejects a loose natural-language phrase, which a third-party duration parser would accept', () => {
    for (const value of ['5 minutes', 'two hours', '1h30m', '1.5h', 'PT10M']) {
      expect(DurationSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('rejects zero, because a zero timeout is always a mistake and "no timeout" must never be implicit', () => {
    for (const value of ['0ms', '0s', '0m', '0h', '00h']) {
      expect(DurationSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('rejects the empty string', () => {
    expect(DurationSchema.safeParse('').success).toBe(false);
  });

  it('rejects a unit it does not know', () => {
    for (const value of ['10d', '10w', '10S', '10M', '10sec']) {
      expect(DurationSchema.safeParse(value).success, value).toBe(false);
    }
  });

  /**
   * The ceiling is derived from `MAX_DURATION_MS` rather than hard-coded, so
   * the schema's pattern and the exported constant cannot drift apart
   * silently. If someone widens one and not the other, this fails.
   */
  it('validates at the documented ceiling in every unit and fails one step above it', () => {
    for (const [unit, ms] of Object.entries(UNIT_MS)) {
      const cap = MAX_DURATION_MS / ms;
      expect(Number.isInteger(cap), `${unit} cap is a whole number`).toBe(true);
      expect(
        DurationSchema.safeParse(`${cap}${unit}`).success,
        `${cap}${unit} is the ceiling`,
      ).toBe(true);
      expect(
        DurationSchema.safeParse(`${cap + 1}${unit}`).success,
        `${cap + 1}${unit} is one step above the ceiling`,
      ).toBe(false);
    }
  });

  it('rejects an absurd value rather than accepting it at a rounded magnitude', () => {
    for (const value of ['99999999999999999999ms', '999999h', '2147483647s']) {
      expect(DurationSchema.safeParse(value).success, value).toBe(false);
    }
  });

  /**
   * A brute-force sweep across every whole value either side of each unit's
   * boundary. The pattern encodes four numeric ranges by hand; this is what
   * makes "the regex is correct" an executed fact rather than a careful read.
   *
   * Mismatches are collected and asserted once rather than through ~90,000
   * `expect()` calls, which is the difference between a 200 ms test and one
   * that trips the 5 s timeout under a loaded suite.
   */
  it('agrees with the arithmetic across the whole accepted range of s, m, and h', () => {
    const mismatches: string[] = [];
    for (const [unit, ms] of Object.entries(UNIT_MS)) {
      if (unit === 'ms') continue; // swept separately below — 86.4M cases is not a unit test
      const cap = MAX_DURATION_MS / ms;
      for (let n = 0; n <= cap + 2; n++) {
        const value = `${n}${unit}`;
        const expected = n >= 1 && n * ms <= MAX_DURATION_MS;
        if (DurationSchema.safeParse(value).success !== expected) {
          mismatches.push(
            `${value} (expected ${expected ? 'accept' : 'reject'})`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees with the arithmetic at every decade boundary in milliseconds', () => {
    const samples = [
      0, 1, 9, 10, 99, 100, 999_999, 1_000_000, 9_999_999, 10_000_000,
      79_999_999, 80_000_000, 85_999_999, 86_000_000, 86_399_999, 86_400_000,
      86_400_001, 99_999_999, 100_000_000,
    ];
    for (const n of samples) {
      const expected = n >= 1 && n <= MAX_DURATION_MS;
      expect(DurationSchema.safeParse(`${n}ms`).success, `${n}ms`).toBe(
        expected,
      );
    }
  });
});

describe('parseDuration', () => {
  it('returns milliseconds, exactly, for each unit', () => {
    expect(parseDuration('1ms')).toBe(1);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('is exact at the ceiling in every unit', () => {
    for (const [unit, ms] of Object.entries(UNIT_MS)) {
      const cap = MAX_DURATION_MS / ms;
      expect(parseDuration(`${cap}${unit}`)).toBe(MAX_DURATION_MS);
    }
  });

  it('throws a LoadError naming the offending value rather than returning NaN', () => {
    for (const value of [
      '10',
      '-5m',
      '0m',
      '',
      '5 minutes',
      '86400001ms',
      '25h',
    ]) {
      expect(() => parseDuration(value), value).toThrow(LoadError);
      expect(() => parseDuration(value), value).toThrow(/duration/i);
    }
  });

  it('names the four accepted units in its error, so the message is actionable', () => {
    expect(() => parseDuration('10')).toThrow(/ms/);
    expect(() => parseDuration('10')).toThrow(/24h|86400000/);
  });
});

describe('MAX_DURATION_MS', () => {
  it('is 24 hours, the documented ceiling', () => {
    expect(MAX_DURATION_MS).toBe(86_400_000);
    expect(MAX_DURATION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
