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

export interface UsageRepository {
  record(event: NewUsageEvent): Promise<void>;
  listForFeature(featureId: string): Promise<UsageEventsTable[]>;
  spendByCategory(featureId: string): Promise<SpendByCategory>;
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
