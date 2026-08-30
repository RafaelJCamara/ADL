import { sql, type Kysely } from 'kysely';
import type {
  Database,
  ModelPricesTable,
  UsageEventsTable,
} from '../schema.js';

/**
 * The spend ledger and the price table behind it.
 *
 * Note the shape of {@link UsageRepository.spendByCategory}: it returns the
 * **unpriced count** alongside the totals, rather than summing `cost_usd` and
 * letting the nulls disappear. A budget that silently drops the rows it could
 * not price has stopped enforcing without saying so (D-31); a caller that can
 * see a nonzero unpriced count can report confirmed spend and unpriced spend
 * as two separate, honest numbers instead of one number that quietly excludes
 * some of them.
 */

export type NewUsageEvent = UsageEventsTable;

export interface SpendByCategory {
  /** Spend attributable to the feature's own work. */
  feature: number;
  /** Repair retries and failed parses — counted, and shown separately (D-14). */
  overhead: number;
  total: number;
  /** Rows with no `cost_usd`. Never folded into the totals as zero. */
  unpricedEvents: number;
}

/**
 * One feature's spend, broken down by role (OBS-05, M06 step 6.3).
 *
 * "Role" is a `stage_attempts.stage_id` — `'develop'`, `'test'`, and so on —
 * the same vocabulary the sticky comment already addresses a round by
 * (`publish/role-rounds.ts`). A row whose `stage_attempt_id` cannot be
 * resolved to one (deleted, or never set) folds into `'unknown'` rather than
 * being silently dropped from `total` — the totals-vs-per-role split must
 * agree with each other, the same discipline `SpendByCategory` already holds
 * `feature`/`overhead` to.
 */
export interface SpendByRole {
  readonly total: number;
  /** Rows with no `cost_usd`. Never folded into `total` as zero (D-31). */
  readonly unpricedEvents: number;
  readonly byRole: Readonly<Record<string, number>>;
}

/**
 * Every feature's spend, summed into one fleet-wide total (LOOP-05, M06 step
 * 6.5) — the number the global spend cap is checked against, before per-role
 * or per-feature attribution.
 */
export interface TotalSpend {
  readonly total: number;
  /** Rows with no `cost_usd`. Never folded into `total` as zero (D-31). */
  readonly unpricedEvents: number;
}

export interface UsageRepository {
  record(event: NewUsageEvent): Promise<void>;
  listForFeature(featureId: string): Promise<UsageEventsTable[]>;
  spendByCategory(featureId: string): Promise<SpendByCategory>;
  /**
   * Every feature's spend, broken down by role, in one query — the shape
   * `GET /features` needs (D-24: one read for the whole response, never one
   * query per row). A feature with no usage rows simply has no entry; the
   * caller supplies its own zeroed default, the same convention
   * `staleRejectionCounter.forFeature` already uses for an unseen feature.
   */
  spendByFeature(): Promise<ReadonlyMap<string, SpendByRole>>;
  /**
   * Every `usage_events` row across every feature, summed into one total
   * (LOOP-05, M06 step 6.5) — what `dispatchOnce`'s global spend cap checks
   * against, once per tick, before any feature-specific reasoning.
   */
  totalSpend(): Promise<TotalSpend>;
  /**
   * The price row in force for a model and speed tier at an instant.
   *
   * "In force" means the latest row whose `effective_from` is at or before the
   * event's date. An event predating every row for a model resolves to
   * `undefined` rather than falling back to the earliest price — pricing a
   * January event at a March rate is a fabricated number, and a fabricated
   * number in a spend audit is worse than a missing one.
   */
  priceAt(input: {
    modelId: string;
    speed: string;
    at: string;
  }): Promise<ModelPricesTable | undefined>;
  listPrices(): Promise<ModelPricesTable[]>;
}

export function usageRepository(db: Kysely<Database>): UsageRepository {
  return {
    async record(event) {
      await db.insertInto('usage_events').values(event).execute();
    },

    listForFeature(featureId) {
      return db
        .selectFrom('usage_events')
        .selectAll()
        .where('feature_id', '=', featureId)
        .orderBy('at')
        .execute();
    },

    async spendByCategory(featureId) {
      const rows = await db
        .selectFrom('usage_events')
        .select(['cost_category', 'cost_usd'])
        .where('feature_id', '=', featureId)
        .execute();

      const totals: SpendByCategory = {
        feature: 0,
        overhead: 0,
        total: 0,
        unpricedEvents: 0,
      };

      for (const row of rows) {
        if (row.cost_usd === null) {
          totals.unpricedEvents += 1;
          continue;
        }
        if (row.cost_category === 'overhead') {
          totals.overhead += row.cost_usd;
        } else {
          totals.feature += row.cost_usd;
        }
        totals.total += row.cost_usd;
      }

      return totals;
    },

    async spendByFeature() {
      const rows = await db
        .selectFrom('usage_events')
        .leftJoin(
          'stage_attempts',
          'stage_attempts.id',
          'usage_events.stage_attempt_id',
        )
        .select([
          'usage_events.feature_id as featureId',
          'stage_attempts.stage_id as stageId',
          'usage_events.cost_usd as costUsd',
        ])
        .execute();

      const byFeature = new Map<string, SpendByRole>();
      for (const row of rows) {
        const existing = byFeature.get(row.featureId) ?? {
          total: 0,
          unpricedEvents: 0,
          byRole: {},
        };
        const role = row.stageId ?? 'unknown';
        const byRole = { ...existing.byRole };

        if (row.costUsd === null) {
          byFeature.set(row.featureId, {
            ...existing,
            unpricedEvents: existing.unpricedEvents + 1,
          });
          continue;
        }

        byRole[role] = (byRole[role] ?? 0) + row.costUsd;
        byFeature.set(row.featureId, {
          ...existing,
          total: existing.total + row.costUsd,
          byRole,
        });
      }

      return byFeature;
    },

    async totalSpend() {
      const rows = await db
        .selectFrom('usage_events')
        .select('cost_usd')
        .execute();

      let total = 0;
      let unpricedEvents = 0;
      for (const row of rows) {
        if (row.cost_usd === null) {
          unpricedEvents += 1;
          continue;
        }
        total += row.cost_usd;
      }

      return { total, unpricedEvents };
    },

    priceAt({ modelId, speed, at }) {
      // `effective_from` is a `YYYY-MM-DD` date and `at` an ISO-8601 instant,
      // so the comparison is against the instant's date prefix. Both are
      // zero-padded fixed-width text, which makes lexicographic ordering and
      // chronological ordering the same ordering.
      const onDate = at.slice(0, 10);
      return db
        .selectFrom('model_prices')
        .selectAll()
        .where('model_id', '=', modelId)
        .where('speed', '=', speed)
        .where(sql<boolean>`effective_from <= ${onDate}`)
        .orderBy('effective_from', 'desc')
        .limit(1)
        .executeTakeFirst();
    },

    listPrices() {
      return db
        .selectFrom('model_prices')
        .selectAll()
        .orderBy('model_id')
        .orderBy('speed')
        .orderBy('effective_from')
        .execute();
    },
  };
}
