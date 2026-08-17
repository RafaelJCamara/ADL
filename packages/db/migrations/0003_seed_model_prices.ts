import { sql, type Kysely } from 'kysely';
import { ulid } from 'ulid';

/**
 * Seeds `model_prices` (created by `0002_contracts.ts`) with the current
 * Anthropic price list.
 *
 * Source: the Claude API reference bundled with this research, cached
 * 2026-06-24 — a few weeks stale as of this plan (01-RESEARCH.md § Assumptions
 * Log A9), cross-checked against `.claude/CLAUDE.md` § Cost accounting. The
 * versioned table with `effective_from` is precisely what makes that
 * staleness recoverable: **the correction for a wrong figure is a new row
 * with a later `effective_from` date, never an edit to this file** — and the
 * checksum guard from `checksum.ts` refuses an edit to an applied migration
 * regardless.
 *
 * The two `claude-sonnet-5` rows below are deliberate, not incidental: its
 * introductory pricing ($2.00/$10.00 per MTok) lapses 2026-08-31 and reverts
 * to $3.00/$15.00 the next day. That is a real boundary, not a synthetic
 * fixture, and `model-prices.test.ts`'s headline case is two otherwise-
 * identical usage events priced across it. A seed where every row shared one
 * `effective_from` would leave that column present and never executed
 * (01-RESEARCH.md § Pitfall 7) — the first real price change would then be
 * the first time the temporal lookup ran at all, in an adopter's installation
 * rather than in CI.
 *
 * Bare model IDs only (C-15): a date-suffixed ID like
 * `claude-opus-5-20260708` 404s against the API. `model-prices.test.ts`
 * machine-checks this over every seeded row.
 *
 * Cache multipliers are columns on this table, not constants in `pricing.ts`
 * — the same reasoning C-14 applies to the base rates applies to them: a
 * multiplier changed in code silently rewrites historical spend the moment it
 * changes. This phase models a single 5-minute cache TTL tier (~1.25× write,
 * ~0.1× read) `[CITED: claude-api skill, Prompt Caching]`; a 1-hour TTL tier
 * with its own multipliers is a new row, not a code change, exactly like a
 * base-price correction.
 */

interface SeedRow {
  readonly modelId: string;
  readonly speed: 'standard' | 'fast';
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
  readonly effectiveFrom: string;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

const SEED_ROWS: readonly SeedRow[] = [
  {
    modelId: 'claude-fable-5',
    speed: 'standard',
    inputUsdPerMtok: 10.0,
    outputUsdPerMtok: 50.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-mythos-5',
    speed: 'standard',
    inputUsdPerMtok: 10.0,
    outputUsdPerMtok: 50.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-opus-5',
    speed: 'standard',
    inputUsdPerMtok: 5.0,
    outputUsdPerMtok: 25.0,
    effectiveFrom: '2026-01-01',
  },
  // Fast mode is separately priced.
  {
    modelId: 'claude-opus-5',
    speed: 'fast',
    inputUsdPerMtok: 10.0,
    outputUsdPerMtok: 50.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-opus-4-8',
    speed: 'standard',
    inputUsdPerMtok: 5.0,
    outputUsdPerMtok: 25.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-opus-4-7',
    speed: 'standard',
    inputUsdPerMtok: 5.0,
    outputUsdPerMtok: 25.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-opus-4-6',
    speed: 'standard',
    inputUsdPerMtok: 5.0,
    outputUsdPerMtok: 25.0,
    effectiveFrom: '2026-01-01',
  },
  // Introductory pricing — see the header comment. This row and the next are
  // what exercise the temporal lookup with real data.
  {
    modelId: 'claude-sonnet-5',
    speed: 'standard',
    inputUsdPerMtok: 2.0,
    outputUsdPerMtok: 10.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-sonnet-5',
    speed: 'standard',
    inputUsdPerMtok: 3.0,
    outputUsdPerMtok: 15.0,
    effectiveFrom: '2026-09-01',
  },
  {
    modelId: 'claude-sonnet-4-6',
    speed: 'standard',
    inputUsdPerMtok: 3.0,
    outputUsdPerMtok: 15.0,
    effectiveFrom: '2026-01-01',
  },
  {
    modelId: 'claude-haiku-4-5',
    speed: 'standard',
    inputUsdPerMtok: 1.0,
    outputUsdPerMtok: 5.0,
    effectiveFrom: '2026-01-01',
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const row of SEED_ROWS) {
      await sql`
        insert into model_prices
          (id, model_id, speed, input_usd_per_mtok, output_usd_per_mtok,
           cache_write_multiplier, cache_read_multiplier, effective_from)
        values (
          ${ulid()}, ${row.modelId}, ${row.speed}, ${row.inputUsdPerMtok}, ${row.outputUsdPerMtok},
          ${CACHE_WRITE_MULTIPLIER}, ${CACHE_READ_MULTIPLIER}, ${row.effectiveFrom}
        )
      `.execute(trx);
    }
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`delete from model_prices`.execute(trx);
  });
}
