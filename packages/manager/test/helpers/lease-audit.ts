import type { FeatureEventsTable } from '@adl/db';

/**
 * The append-only-log half of D-32's fifth closing assertion — "no feature
 * was ever double-leased" — proven from `feature_events`, not from a final
 * `features` row snapshot.
 *
 * A snapshot cannot prove this: an overlap that opened and closed before the
 * assertions ran leaves no trace in the row a snapshot reads, and the
 * append-only log is the only place it is still visible. `unique (feature_id,
 * seq)` (`packages/db/src/schema.ts`) makes the log itself a real signal
 * rather than a formality — a duplicate or a gap in `seq` is a bug in its own
 * right, independent of lease overlap, which is why `collectLeaseIntervals`
 * never silently reorders or dedupes what it is given.
 */

/** One reconstructed span during which a feature held a lease. */
export interface LeaseInterval {
  readonly featureId: string;
  /** The `feature_events.seq` of the `lease_acquired` row that opened this interval. */
  readonly acquiredSeq: number;
  readonly acquiredAt: string;
  /**
   * The `feature_events.seq` of the `lease_expired` row that closed this
   * interval, or `undefined` if the log ends with the interval still open
   * (the feature is currently leased).
   */
  readonly expiredSeq: number | undefined;
  readonly expiredAt: string | undefined;
}

/** The parsed shape `collectLeaseIntervals` needs from `event_json` — nothing more. */
interface ParsedLeaseEvent {
  readonly t: string;
}

function parseEventKind(eventJson: string): string | undefined {
  try {
    const parsed = JSON.parse(eventJson) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      't' in parsed &&
      typeof (parsed as ParsedLeaseEvent).t === 'string'
    ) {
      return (parsed as ParsedLeaseEvent).t;
    }
  } catch {
    // Unparseable — treated as "not a lease event" below, never thrown. A
    // log-reconstruction helper that throws on one malformed row hides every
    // row after it, which is the opposite of what an audit is for.
  }
  return undefined;
}

/**
 * Reconstruct every feature's lease intervals from its `feature_events` rows.
 *
 * `events` may span multiple features and need not arrive sorted — this
 * function groups by `feature_id` and sorts by `seq` itself, so a caller can
 * hand it the flattened result of several `listEvents` calls directly.
 *
 * Deliberately naive about pairing: a `lease_acquired` opens an interval: if
 * one is already open for that feature, the OLD one is pushed as still-open
 * (`expiredSeq`/`expiredAt` left `undefined`) rather than silently closed at
 * the new acquisition's time — closing it there would erase exactly the
 * double-lease evidence `findOverlappingLeases` exists to catch. A
 * `lease_expired` closes the *oldest* currently-open interval for that
 * feature (FIFO), or is ignored if none is open. Any interval still open once
 * a feature's events are exhausted is returned with no `expiredSeq`/`expiredAt`
 * — a currently-held lease, not an anomaly.
 */
export function collectLeaseIntervals(
  events: readonly FeatureEventsTable[],
): readonly LeaseInterval[] {
  const byFeature = new Map<string, FeatureEventsTable[]>();
  for (const event of events) {
    const list = byFeature.get(event.feature_id) ?? [];
    list.push(event);
    byFeature.set(event.feature_id, list);
  }

  const intervals: LeaseInterval[] = [];

  for (const [featureId, rows] of byFeature) {
    const sorted = [...rows].sort((a, b) => a.seq - b.seq);
    const open: { acquiredSeq: number; acquiredAt: string }[] = [];

    for (const row of sorted) {
      const kind = parseEventKind(row.event_json);
      if (kind === 'lease_acquired') {
        open.push({ acquiredSeq: row.seq, acquiredAt: row.at });
      } else if (kind === 'lease_expired') {
        const opened = open.shift();
        if (opened !== undefined) {
          intervals.push({
            featureId,
            acquiredSeq: opened.acquiredSeq,
            acquiredAt: opened.acquiredAt,
            expiredSeq: row.seq,
            expiredAt: row.at,
          });
        }
        // A `lease_expired` with nothing open is not an overlap bug on its
        // own — ignored rather than flagged, matching `reapOne`'s own
        // `expectedLeaseToken` no-op for a lease already reassigned.
      }
    }

    for (const stillOpen of open) {
      intervals.push({
        featureId,
        acquiredSeq: stillOpen.acquiredSeq,
        acquiredAt: stillOpen.acquiredAt,
        expiredSeq: undefined,
        expiredAt: undefined,
      });
    }
  }

  return intervals;
}

/** One pair of overlapping intervals for the same feature, in acquisition order. */
export interface LeaseOverlap {
  readonly featureId: string;
  readonly first: LeaseInterval;
  readonly second: LeaseInterval;
}

/**
 * Find every pair of same-feature intervals whose time spans intersect.
 *
 * An interval with no `expiredAt` is treated as open-ended (still running, or
 * — the anomaly this whole module exists to catch — superseded without ever
 * being closed), so it overlaps with anything acquired after it. Comparison
 * is on `acquiredAt`/`expiredAt` (ISO-8601, lexicographically ordered), never
 * on `seq` — `seq` proves ordering; the timestamps are what "overlap in time"
 * literally means.
 */
export function findOverlappingLeases(
  intervals: readonly LeaseInterval[],
): readonly LeaseOverlap[] {
  const byFeature = new Map<string, LeaseInterval[]>();
  for (const interval of intervals) {
    const list = byFeature.get(interval.featureId) ?? [];
    list.push(interval);
    byFeature.set(interval.featureId, list);
  }

  const overlaps: LeaseOverlap[] = [];

  for (const [featureId, featureIntervals] of byFeature) {
    const sorted = [...featureIntervals].sort((a, b) =>
      a.acquiredAt < b.acquiredAt ? -1 : a.acquiredAt > b.acquiredAt ? 1 : 0,
    );

    for (let i = 0; i < sorted.length - 1; i += 1) {
      const first = sorted[i]!;
      const second = sorted[i + 1]!;
      const firstEndsBeforeSecondStarts =
        first.expiredAt !== undefined && first.expiredAt <= second.acquiredAt;
      if (!firstEndsBeforeSecondStarts) {
        overlaps.push({ featureId, first, second });
      }
    }
  }

  return overlaps;
}
