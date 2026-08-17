import type { Kysely } from 'kysely';
import type {
  Database,
  FeatureEventsTable,
  FeaturesTable,
  RoundsTable,
} from '../schema.js';

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
  };
}
