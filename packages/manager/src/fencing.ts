/**
 * The message-level half of D-06's fence (T-3-06).
 *
 * `03-02` landed the SQL half: every lease-scoped `UPDATE` in
 * `@adl/db`'s `featuresRepository` carries `WHERE lease_token = ?`, so a
 * stale write fails at the database regardless of what any caller does. This
 * module is the other half — a clean, loggable rejection *before* that write
 * is even attempted, with the context (both tokens) a bare `false` return
 * value cannot carry.
 *
 * `checkFence` returns; it does not throw. Phase 1 established that
 * `InvalidTransition` is returned rather than thrown precisely because a
 * benign race and a real bug are indistinguishable at the call site and an
 * exception forecloses the caller's judgement — the same reasoning applies
 * exactly here: a stale heartbeat from a zombie worker racing a legitimate
 * re-lease is expected, not exceptional.
 */

export interface FenceMatch {
  readonly kind: 'match';
}

/**
 * The presented token does not match the row's current one — including when
 * the row currently has no lease at all (`current: null`). A lease nobody
 * holds cannot be written through by a message claiming to hold it.
 */
export interface FenceStale {
  readonly kind: 'stale';
  readonly featureId: string;
  readonly presented: string;
  readonly current: string | null;
}

export type FenceVerdict = FenceMatch | FenceStale;

/**
 * Compare a message's presented lease token against the row's current one.
 *
 * `current === null` — nobody holds this lease — is stale by construction,
 * not a special case bolted on afterwards: the equality check below already
 * fails for `presented !== null`, since `presented` is always a non-empty
 * string (the IPC schema's `LeaseTokenSchema` guarantees that upstream) and
 * can never equal `null`.
 */
export function checkFence(
  featureId: string,
  presented: string,
  current: string | null,
): FenceVerdict {
  if (current !== null && presented === current) {
    return { kind: 'match' };
  }
  return { kind: 'stale', featureId, presented, current };
}

/**
 * D-09's rejection counter: total rejections, and a per-feature breakdown so
 * `GET /features` can surface `staleRejections` per row rather than only a
 * global number a specific feature's history would be lost inside.
 */
export interface StaleRejectionSnapshot {
  readonly total: number;
  readonly byFeature: ReadonlyMap<string, number>;
}

export interface StaleRejectionCounter {
  increment(featureId: string): void;
  forFeature(featureId: string): number;
  snapshot(): StaleRejectionSnapshot;
}

export function createStaleRejectionCounter(): StaleRejectionCounter {
  const byFeature = new Map<string, number>();
  let total = 0;

  return {
    increment(featureId) {
      total += 1;
      byFeature.set(featureId, (byFeature.get(featureId) ?? 0) + 1);
    },
    forFeature(featureId) {
      return byFeature.get(featureId) ?? 0;
    },
    snapshot() {
      return { total, byFeature: new Map(byFeature) };
    },
  };
}
