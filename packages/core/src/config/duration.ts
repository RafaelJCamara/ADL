import * as z from 'zod';

import { LoadError } from '../errors.js';

/**
 * Durations in `adl.yml` are a closed vocabulary: a positive whole number of
 * milliseconds, seconds, minutes, or hours, written as digits immediately
 * followed by the unit — `250ms`, `30s`, `10m`, `2h`.
 *
 * **Why not a bare integer.** Every config format that accepted one has had to
 * answer "seconds or milliseconds?" in a bug report. The unit is not optional
 * because the ambiguity is not survivable: a `timeout: 10` read as
 * milliseconds kills a build a maintainer meant to give ten minutes.
 *
 * **Why not a duration library.** `ms` and its relatives accept natural
 * language, fractional values, and negatives. Repo-supplied config is
 * untrusted input under D-22, and a parser that tries to be helpful about what
 * a human might have meant is the wrong tool for validating it.
 *
 * **The ceiling.** {@link MAX_DURATION_MS} is 24 hours. It is enforced by the
 * *pattern* rather than by a refinement, so it survives if any field carrying
 * a duration is ever published as JSON Schema — `z.toJSONSchema()` emits
 * `pattern` and silently discards `.refine()` (01-RESEARCH.md § Pitfall 1).
 * A ceiling matters more here than it looks: `YAML.parse('a: 9'.repeat(20))`
 * silently rounds an oversized integer, so an unbounded field does not reject
 * an absurd value — it accepts a *different*, rounded one (§ Pitfall 11).
 *
 * **Zero is rejected.** A zero timeout is always a mistake, and reading it as
 * "no timeout" would be exactly the kind of implicit meaning this file format
 * exists to remove.
 */

/** 24 hours. The documented ceiling for every duration field in `adl.yml`. */
export const MAX_DURATION_MS = 86_400_000;

/** Milliseconds per accepted unit. */
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const satisfies Record<string, number>;

type DurationUnit = keyof typeof UNIT_MS;

/*
 * Each alternative below accepts exactly `1` through that unit's share of
 * MAX_DURATION_MS, and nothing else — no zero, no leading-zero padding to
 * zero, no value one step over. The ranges are written out rather than checked
 * arithmetically so the whole constraint is structural.
 *
 * They are unreadable, and that is a real hazard, so it is answered by test
 * rather than by comment: `duration.test.ts` sweeps every whole value either
 * side of each boundary and derives the expected answer from MAX_DURATION_MS.
 * If this pattern and that constant ever disagree, the sweep fails.
 *
 * Every quantifier is bounded and none is nested, so catastrophic backtracking
 * is not reachable (threat T-1-11).
 */

/** 1 – 86_400_000 ms */
const MILLISECONDS = '(?:[1-9]\\d{0,6}|[1-7]\\d{7}|8[0-5]\\d{6}|86[0-3]\\d{5}|86400000)ms';
/** 1 – 86_400 s */
const SECONDS = '(?:[1-9]\\d{0,3}|[1-7]\\d{4}|8[0-5]\\d{3}|86[0-3]\\d{2}|86400)s';
/** 1 – 1_440 m */
const MINUTES = '(?:[1-9]\\d{0,2}|1[0-3]\\d{2}|14[0-3]\\d|1440)m';
/** 1 – 24 h */
const HOURS = '(?:[1-9]|1\\d|2[0-4])h';

const DURATION_PATTERN = new RegExp(`^(?:${MILLISECONDS}|${SECONDS}|${MINUTES}|${HOURS})$`);

/** Splits an already-validated duration into its number and its unit. */
const DURATION_PARTS = /^(\d+)(ms|s|m|h)$/;

/**
 * A duration string: digits immediately followed by `ms`, `s`, `m`, or `h`,
 * strictly positive and no greater than {@link MAX_DURATION_MS}.
 */
export const DurationSchema = z
  .string()
  .regex(DURATION_PATTERN)
  .meta({
    id: 'Duration',
    description:
      'A duration as digits plus a unit — ms, s, m, or h. Strictly positive, and at most 24h.',
  });

export type Duration = z.infer<typeof DurationSchema>;

/**
 * Convert a duration string to milliseconds.
 *
 * @throws {LoadError} when the value is not an accepted duration — a bare
 * integer, a negative or zero value, a natural-language phrase, an unknown
 * unit, or a value above the ceiling.
 */
export function parseDuration(value: string): number {
  const parts = DurationSchema.safeParse(value).success ? DURATION_PARTS.exec(value) : null;
  if (!parts) {
    throw new LoadError(
      `Invalid duration ${JSON.stringify(value)}. Expected digits followed by a unit — ` +
        `ms, s, m, or h (for example "250ms", "30s", "10m", "2h") — ` +
        `greater than zero and no more than 24h (${MAX_DURATION_MS}ms).`,
    );
  }

  const milliseconds = Number(parts[1]) * UNIT_MS[parts[2] as DurationUnit];

  /* istanbul ignore next -- unreachable while the pattern and the ceiling agree */
  if (milliseconds > MAX_DURATION_MS) {
    // Defence in depth. The pattern already bounds every unit, so reaching
    // here means the pattern was widened without the ceiling being revisited.
    // Failing loudly beats returning a value the caller was promised was safe.
    throw new LoadError(
      `Duration ${JSON.stringify(value)} exceeds the ${MAX_DURATION_MS}ms ceiling.`,
    );
  }

  return milliseconds;
}
