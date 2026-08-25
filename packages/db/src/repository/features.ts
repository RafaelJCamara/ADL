import type { Kysely } from 'kysely';
import type {
  Database,
  FeatureEventsTable,
  FeaturesTable,
  RoundsTable,
} from '../schema.js';
import { assertIsoTimestamp } from '../time.js';

/**
 * The narrow set of feature operations Phases 1 through 5 need.
 *
 * "Narrow" is the point (D-28). Every query in this package is a query the
 * eventual `node:sqlite` or Postgres swap has to reimplement, so the surface
 * that leaves this package is a handful of named functions rather than a
 * `Kysely` instance handed to the manager. `@adl/core` never sees any of it —
 * it does not learn a database exists.
 */

export type NewFeature = FeaturesTable;
export type NewFeatureEvent = FeatureEventsTable;
export type NewRound = RoundsTable;

/**
 * Acquire a lease on a feature.
 *
 * `leaseToken` is a ULID minted by the caller (D-07), never generated inside
 * the repository — the caller needs the value before the write succeeds, to
 * pass it to the worker it is about to fork. `leaseToken` is required rather
 * than optional on every lease-scoped input type (D-08): omitting the fence
 * is a compile error, not a runtime surprise.
 */
export interface AcquireLeaseInput {
  id: string;
  leaseOwner: string;
  leaseToken: string;
  /** Written to `lease_expires_at`; must be a `nowIso()`-shaped timestamp. */
  leaseExpiresAt: string;
  /**
   * Written to `heartbeat_at`, and doubles as the caller-supplied "now" the
   * guard compares an existing `lease_expires_at` against — `acquireLease`
   * takes an explicit instant rather than reading a clock, matching
   * `TransitionCtx.at`'s discipline.
   */
  heartbeatAt: string;
}

export interface RenewLeaseInput {
  id: string;
  leaseToken: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface ExpireLeaseInput {
  id: string;
  leaseToken: string;
}

export interface ReleaseLeaseInput {
  id: string;
  leaseToken: string;
}

export interface FeaturesRepository {
  insert(feature: NewFeature): Promise<void>;
  findById(id: string): Promise<FeaturesTable | undefined>;
  findByPath(repoId: string, path: string): Promise<FeaturesTable | undefined>;
  listByState(state: string): Promise<FeaturesTable[]>;
  /**
   * Advance a feature's state, asserting the version it was read at.
   *
   * The `state_version` predicate is the whole method. Two workers that both
   * read version 4 cannot both write version 5 — the second update matches no
   * row and reports `false`, which is a caller-visible loss rather than a
   * silent overwrite of the first worker's transition.
   */
  compareAndSwapState(input: {
    id: string;
    expectedVersion: number;
    state: string;
    currentStageIndex?: number;
    round?: number;
    updatedAt: string;
  }): Promise<boolean>;
  appendEvent(event: NewFeatureEvent): Promise<void>;
  listEvents(featureId: string): Promise<FeatureEventsTable[]>;
  insertRound(round: NewRound): Promise<void>;
  latestRound(featureId: string): Promise<RoundsTable | undefined>;

  /**
   * Record a round's terminal outcome — the write `openAttempt`'s own docblock
   * deferred to "the loop, which is Phase 5" (M05 step 5.13).
   *
   * `outcome` is the `RoundOutcome` **kind** and `outcomeJson` the whole
   * payload, kept as two columns for the reason `verdicts` is a table rather
   * than a blob: "which rounds sent back?" is a `WHERE`, not a scan that
   * parses every stored round in application code.
   *
   * Idempotent by construction, exactly like `bookkeeping/attempt.ts`'s
   * `closeAttempt`: the `UPDATE` is guarded by `ended_at is null`, so a
   * replayed round completion — an at-least-once worker report arriving twice
   * after a crash — matches zero rows and is a no-op rather than rewriting a
   * verdict a pull request has already been rendered from. Returns whether
   * this call is the one that closed it, so a caller can tell the two apart.
   */
  closeRound(input: {
    id: string;
    outcome: string;
    outcomeJson: string;
    endedAt: string;
  }): Promise<boolean>;

  /**
   * Acquire a lease on an unheld or expired feature.
   *
   * The guard admits a row whose `lease_token` is null (never leased) or
   * whose `lease_expires_at` is strictly before `heartbeatAt` (the caller's
   * "now"). A row with a live lease — including one held by the same owner —
   * is not admitted; this method is not reentrant. Returns `false` rather
   * than throwing when the race is lost, matching `compareAndSwapState`: a
   * lost lease race is a caller-visible outcome, not an exceptional one.
   */
  acquireLease(input: AcquireLeaseInput): Promise<boolean>;

  /**
   * Extend a held lease's expiry and heartbeat.
   *
   * Guarded by `.where('lease_token', '=', leaseToken)`. A stale token — one
   * that no longer matches the row because the lease was reaped and
   * re-acquired by someone else — updates zero rows and returns `false`. This
   * is D-06's data-layer fence: it holds even if a caller reaches this method
   * without going through the manager's message handler.
   */
  renewLease(input: RenewLeaseInput): Promise<boolean>;

  /**
   * Clear a lease whose holder timed out.
   *
   * Same token guard as `renewLease`. Nulls `lease_owner`, `lease_token`, and
   * `lease_expires_at`; `heartbeat_at` is left as the last-known liveness
   * timestamp rather than erased.
   */
  expireLease(input: ExpireLeaseInput): Promise<boolean>;

  /**
   * Clear a lease whose holder finished cleanly.
   *
   * Identical predicate and effect to `expireLease` — the separate name
   * exists so a log line can distinguish "the worker finished" from "the
   * lease timed out" without inspecting the row's prior state.
   */
  releaseLease(input: ReleaseLeaseInput): Promise<boolean>;

  /** Rows whose lease has expired as of `now`, ordered by `id`. */
  listExpiredLeases(now: string): Promise<FeaturesTable[]>;

  /** Every currently-leased row, ordered by `id`. */
  listLeased(): Promise<FeaturesTable[]>;

  /** Every `queued` row, ordered by `id` — ULID order is FIFO (D-17). */
  listQueued(): Promise<FeaturesTable[]>;

  /**
   * Every row a dispatch may pick up: `queued`, plus a feature already inside
   * the loop (`developing` or `gating`) whose lease has been released because
   * the stage that held it finished (M05 step 5.13).
   *
   * The second half is what makes the loop turn. `transition()` draws no edge
   * from `gating` back to `queued` other than `lease_expired` — deliberately,
   * because a feature midway through its pipeline has not lost its position
   * and must not be re-admitted as if it had. So the round loop leaves it in
   * the state it reached, with its `current_stage_index` pointing at the stage
   * that runs next, and the dispatcher leases it again from there.
   *
   * `publishing` is **not** included. A feature that reached it has passed
   * every gate and is waiting on the forge, not on a stage; re-leasing it
   * would run a pipeline entry against work that is already done.
   */
  listDispatchable(): Promise<FeaturesTable[]>;
}

export function featuresRepository(db: Kysely<Database>): FeaturesRepository {
  return {
    async insert(feature) {
      await db.insertInto('features').values(feature).execute();
    },

    findById(id) {
      return db
        .selectFrom('features')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
    },

    findByPath(repoId, path) {
      return db
        .selectFrom('features')
        .selectAll()
        .where('repo_id', '=', repoId)
        .where('path', '=', path)
        .executeTakeFirst();
    },

    listByState(state) {
      return db
        .selectFrom('features')
        .selectAll()
        .where('state', '=', state)
        .orderBy('id')
        .execute();
    },

    async compareAndSwapState({
      id,
      expectedVersion,
      state,
      currentStageIndex,
      round,
      updatedAt,
    }) {
      let query = db
        .updateTable('features')
        .set({
          state,
          state_version: expectedVersion + 1,
          updated_at: updatedAt,
        })
        .where('id', '=', id)
        .where('state_version', '=', expectedVersion);

      if (currentStageIndex !== undefined) {
        query = query.set({ current_stage_index: currentStageIndex });
      }
      if (round !== undefined) {
        query = query.set({ round });
      }

      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async appendEvent(event) {
      // Append-only by discipline *and* by schema: `unique (feature_id, seq)`
      // means a replayed transition collides rather than duplicating.
      await db.insertInto('feature_events').values(event).execute();
    },

    listEvents(featureId) {
      return db
        .selectFrom('feature_events')
        .selectAll()
        .where('feature_id', '=', featureId)
        .orderBy('seq')
        .execute();
    },

    async insertRound(round) {
      await db.insertInto('rounds').values(round).execute();
    },

    latestRound(featureId) {
      return db
        .selectFrom('rounds')
        .selectAll()
        .where('feature_id', '=', featureId)
        .orderBy('number', 'desc')
        .limit(1)
        .executeTakeFirst();
    },

    async closeRound({ id, outcome, outcomeJson, endedAt }) {
      assertIsoTimestamp(endedAt, 'endedAt');

      const result = await db
        .updateTable('rounds')
        .set({ outcome, outcome_json: outcomeJson, ended_at: endedAt })
        .where('id', '=', id)
        .where('ended_at', 'is', null)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    async acquireLease({
      id,
      leaseOwner,
      leaseToken,
      leaseExpiresAt,
      heartbeatAt,
    }) {
      assertIsoTimestamp(leaseExpiresAt, 'leaseExpiresAt');
      assertIsoTimestamp(heartbeatAt, 'heartbeatAt');

      const result = await db
        .updateTable('features')
        .set({
          lease_owner: leaseOwner,
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt,
          heartbeat_at: heartbeatAt,
        })
        .where('id', '=', id)
        .where((eb) =>
          eb.or([
            eb('lease_token', 'is', null),
            eb('lease_expires_at', '<', heartbeatAt),
          ]),
        )
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    async renewLease({ id, leaseToken, heartbeatAt, leaseExpiresAt }) {
      assertIsoTimestamp(heartbeatAt, 'heartbeatAt');
      assertIsoTimestamp(leaseExpiresAt, 'leaseExpiresAt');

      const result = await db
        .updateTable('features')
        .set({
          heartbeat_at: heartbeatAt,
          lease_expires_at: leaseExpiresAt,
        })
        .where('id', '=', id)
        .where('lease_token', '=', leaseToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    async expireLease({ id, leaseToken }) {
      const result = await db
        .updateTable('features')
        .set({
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
        })
        .where('id', '=', id)
        .where('lease_token', '=', leaseToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    async releaseLease({ id, leaseToken }) {
      const result = await db
        .updateTable('features')
        .set({
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
        })
        .where('id', '=', id)
        .where('lease_token', '=', leaseToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    listExpiredLeases(now) {
      assertIsoTimestamp(now, 'now');
      return db
        .selectFrom('features')
        .selectAll()
        .where('lease_token', 'is not', null)
        .where('lease_expires_at', '<', now)
        .orderBy('id')
        .execute();
    },

    listLeased() {
      return db
        .selectFrom('features')
        .selectAll()
        .where('lease_token', 'is not', null)
        .orderBy('id')
        .execute();
    },

    listQueued() {
      return db
        .selectFrom('features')
        .selectAll()
        .where('state', '=', 'queued')
        .orderBy('id')
        .execute();
    },

    listDispatchable() {
      return db
        .selectFrom('features')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('state', '=', 'queued'),
            eb.and([
              eb('state', 'in', ['developing', 'gating']),
              eb('lease_token', 'is', null),
            ]),
          ]),
        )
        .orderBy('id')
        .execute();
    },
  };
}
