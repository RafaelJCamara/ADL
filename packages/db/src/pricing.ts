import type { Kysely } from 'kysely';
import type { Database } from './schema.js';
import { usageRepository } from './repository/usage.js';

/**
 * The temporal price lookup that degrades visibly (D-31).
 *
 * Every rate this file uses comes from `model_prices`, read through
 * {@link usageRepository}'s `priceAt`. There is deliberately no numeric
 * literal anywhere below — `model-prices.test.ts` machine-checks that — for
 * the same reason `.claude/CLAUDE.md`'s "Hardcoded model prices in code"
 * prohibition exists: a rate written here would silently rewrite historical
 * spend the moment it changed, and no later migration could recover which
 * events were priced at the old figure and which at the new one.
 */

/**
 * Where a usage event's recorded cost came from.
 *
 * `reported` — the backend said what it cost; recorded verbatim, never
 * recomputed. `computed` — no report; priced from `model_prices`. `unknown`
 * — neither: no price row matched, and the event is recorded as unpriced
 * rather than free. A budget that prices an unknown model at zero has stopped
 * enforcing without saying so; `unknown` is what "stopped enforcing, and says
 * so" looks like as data.
 */
export type CostSource = 'reported' | 'computed' | 'unknown';

/** Whether spend counts against the feature's own budget or against overhead. */
export type CostCategory = 'feature' | 'overhead';

/** The token counts and identity a usage event needs to be priced. */
export interface UsageForPricing {
  readonly modelId: string;
  readonly speed: string;
  /** ISO-8601 instant the usage occurred — what the temporal lookup keys on. */
  readonly at: string;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheCreationInputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  /**
   * The backend's own reported cost, when it has one (`claude -p
   * --output-format json`'s `total_cost_usd`, for example). Preferred over
   * computing — `.claude/CLAUDE.md` § Cost accounting and 01-RESEARCH.md both
   * say so, and a backend's own number is closer to what it actually charged
   * than a reconstruction from a possibly-stale price table.
   */
  readonly reportedCostUsd?: number | null;
}

/** The priced result: a cost, or an honest admission that there is none. */
export interface PricedUsage {
  /** Null when {@link PricedUsage.costSource} is `unknown` — never zero. */
  readonly costUsd: number | null;
  readonly costSource: CostSource;
}

/**
 * Price one usage event.
 *
 * Precedence, in order:
 * 1. The backend reported a cost → record it verbatim, `costSource: 'reported'`.
 * 2. `model_prices` has a row for this model, speed tier, and date → compute
 *    from the table, `costSource: 'computed'`.
 * 3. Neither → `costUsd: null`, `costSource: 'unknown'`. This covers both an
 *    unrecognised model id and an event whose date predates every price row
 *    for an otherwise-known model — pricing at the earliest available rate
 *    would fabricate a number for a period the table never priced, which is
 *    worse than admitting the gap.
 */
export async function priceUsageEvent(
  db: Kysely<Database>,
  event: UsageForPricing,
): Promise<PricedUsage> {
  if (event.reportedCostUsd !== undefined && event.reportedCostUsd !== null) {
    return { costUsd: event.reportedCostUsd, costSource: 'reported' };
  }

  const price = await usageRepository(db).priceAt({
    modelId: event.modelId,
    speed: event.speed,
    at: event.at,
  });

  if (!price) {
    return { costUsd: null, costSource: 'unknown' };
  }

  const perTokenInput = price.input_usd_per_mtok / 1_000_000;
  const perTokenOutput = price.output_usd_per_mtok / 1_000_000;

  const inputCost = (event.inputTokens ?? 0) * perTokenInput;
  const outputCost = (event.outputTokens ?? 0) * perTokenOutput;
  const cacheWriteCost =
    (event.cacheCreationInputTokens ?? 0) *
    perTokenInput *
    price.cache_write_multiplier;
  const cacheReadCost =
    (event.cacheReadInputTokens ?? 0) *
    perTokenInput *
    price.cache_read_multiplier;

  return {
    costUsd: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    costSource: 'computed',
  };
}
