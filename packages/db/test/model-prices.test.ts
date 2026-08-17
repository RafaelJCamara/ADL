import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  migrateToLatest,
  usageRepository,
  type CostSource,
} from '../src/index.js';
import { priceUsageEvent } from '../src/pricing.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * The seed's real boundary — Claude Sonnet 5's introductory pricing lapses
 * 2026-08-31 (01-RESEARCH.md § Pitfall 7, § Code Examples 6; `.claude/CLAUDE.md`
 * § Cost accounting). One event on each side is the headline case: it is what
 * makes the temporal column real rather than aspirational.
 */
const AT_BEFORE_BOUNDARY = '2026-08-15T00:00:00.000Z';
const AT_AFTER_BOUNDARY = '2026-09-15T00:00:00.000Z';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('model_prices seed', () => {
  it('gives every seeded model id a bare alias with no date suffix', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const rows = await usageRepository(db).listPrices();

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // Bare alias: lowercase letters, digits, and hyphens only.
        expect(row.model_id).toMatch(/^[a-z][a-z0-9-]*$/);
        // Date-suffixed IDs 404 (C-15). A YYYYMMDD-shaped run of 8 digits is
        // the shape a date-suffixed ID would have.
        expect(row.model_id).not.toMatch(/\d{8}/);
      }
    });
  });

  it('seeds at least two rows for the model whose introductory price lapses, with different effective-from dates', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const rows = await usageRepository(db).listPrices();

      const sonnetStandard = rows.filter(
        (r) => r.model_id === 'claude-sonnet-5' && r.speed === 'standard',
      );
      expect(sonnetStandard.length).toBeGreaterThanOrEqual(2);

      const effectiveFromDates = new Set(
        sonnetStandard.map((r) => r.effective_from),
      );
      // A seed where every row shares one date leaves this column present and
      // never executed (Pitfall 7) — the whole point of this assertion.
      expect(effectiveFromDates.size).toBeGreaterThanOrEqual(2);
    });
  });

  it('seeds a separately-priced fast tier as its own row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const rows = await usageRepository(db).listPrices();

      const fastRows = rows.filter((r) => r.speed === 'fast');
      expect(fastRows.length).toBeGreaterThan(0);
    });
  });
});

describe('priceUsageEvent: the temporal lookup', () => {
  it('prices an event before the introductory boundary differently from one after it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const base = {
        modelId: 'claude-sonnet-5',
        speed: 'standard',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      } as const;

      const before = await priceUsageEvent(db, {
        ...base,
        at: AT_BEFORE_BOUNDARY,
      });
      const after = await priceUsageEvent(db, {
        ...base,
        at: AT_AFTER_BOUNDARY,
      });

      expect(before.costSource).toBe<CostSource>('computed');
      expect(after.costSource).toBe<CostSource>('computed');
      expect(before.costUsd).not.toBeNull();
      expect(after.costUsd).not.toBeNull();
      expect(before.costUsd).not.toBe(after.costUsd);
    });
  });

  it('picks the row matching the event speed tier', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const base = {
        modelId: 'claude-opus-5',
        at: AT_AFTER_BOUNDARY,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      } as const;

      const standard = await priceUsageEvent(db, {
        ...base,
        speed: 'standard',
      });
      const fast = await priceUsageEvent(db, { ...base, speed: 'fast' });

      expect(standard.costUsd).not.toBeNull();
      expect(fast.costUsd).not.toBeNull();
      expect(fast.costUsd).not.toBe(standard.costUsd);
    });
  });

  it('records an unrecognised model id as unknown, with no cost — never zero', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const priced = await priceUsageEvent(db, {
        modelId: 'claude-does-not-exist-9',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      });

      expect(priced.costSource).toBe<CostSource>('unknown');
      expect(priced.costUsd).toBeNull();
    });
  });

  it('records an event predating every price row for a known model as unknown, not the earliest price', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const priced = await priceUsageEvent(db, {
        modelId: 'claude-sonnet-5',
        speed: 'standard',
        at: '2020-01-01T00:00:00.000Z',
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      });

      expect(priced.costSource).toBe<CostSource>('unknown');
      expect(priced.costUsd).toBeNull();
    });
  });

  it('prefers a reported cost and does not recompute it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const priced = await priceUsageEvent(db, {
        modelId: 'claude-sonnet-5',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        reportedCostUsd: 4.2,
      });

      expect(priced.costSource).toBe<CostSource>('reported');
      expect(priced.costUsd).toBe(4.2);
    });
  });

  it('computes from the table and records computed when the backend reported no cost', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const price = await usageRepository(db).priceAt({
        modelId: 'claude-haiku-4-5',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
      });
      expect(price).toBeDefined();

      const priced = await priceUsageEvent(db, {
        modelId: 'claude-haiku-4-5',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      });

      const expected = price!.input_usd_per_mtok + price!.output_usd_per_mtok;
      expect(priced.costSource).toBe<CostSource>('computed');
      expect(priced.costUsd).toBeCloseTo(expected, 6);
    });
  });

  it('prices cache-read and cache-write tokens by the table multipliers, not by constants in code', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const price = await usageRepository(db).priceAt({
        modelId: 'claude-haiku-4-5',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
      });
      expect(price).toBeDefined();

      const priced = await priceUsageEvent(db, {
        modelId: 'claude-haiku-4-5',
        speed: 'standard',
        at: AT_AFTER_BOUNDARY,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      });

      const expected =
        price!.input_usd_per_mtok * price!.cache_write_multiplier +
        price!.input_usd_per_mtok * price!.cache_read_multiplier;

      expect(priced.costSource).toBe<CostSource>('computed');
      expect(priced.costUsd).toBeCloseTo(expected, 6);
    });
  });
});

describe('prices never live in TypeScript source', () => {
  it('has no literal dollar figure anywhere under src/', () => {
    const offenders: string[] = [];
    const DOLLAR_FIGURE = /\$\d/;

    for (const file of listTsFiles(SRC_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (DOLLAR_FIGURE.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('pricing.ts contains no decimal numeric literal at all — every rate comes from the table', () => {
    const pricingSource = readFileSync(join(SRC_DIR, 'pricing.ts'), 'utf8');
    const DECIMAL_LITERAL = /\b\d+\.\d+\b/;
    const offendingLines = pricingSource
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => DECIMAL_LITERAL.test(line));

    expect(offendingLines, JSON.stringify(offendingLines)).toEqual([]);
  });
});
