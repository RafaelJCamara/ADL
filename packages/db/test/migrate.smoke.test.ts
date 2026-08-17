import { existsSync } from 'node:fs';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  FEATURES_COLUMNS,
  INITIAL_TABLES,
  migrateToLatest,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/** Kysely's own bookkeeping, which it creates on the first migration run. */
const KYSELY_TABLES = ['kysely_migration', 'kysely_migration_lock'];

async function tableNames(
  db: Parameters<Parameters<typeof withTempDb>[0]>[0]['db'],
) {
  const result = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' order by name
  `.execute(db);
  return result.rows.map((r) => r.name);
}

describe('0001_initial applied to a real temp SQLite file', () => {
  it('applies exactly once, and a second run applies nothing further', async () => {
    await withTempDb(async ({ db }) => {
      const first = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(first.error).toBeUndefined();
      // `0001_initial` is applied first and applied once. The count of
      // migrations in the chain is not this file's business — it grows with
      // every additive migration, and `migrate.test.ts` asserts the whole
      // chain against the files on disk.
      expect(first.results[0]?.migrationName).toBe('0001_initial');
      expect(first.results[0]?.status).toBe('Success');
      expect(first.results[0]?.direction).toBe('Up');
      expect(
        first.results.filter((r) => r.migrationName === '0001_initial'),
      ).toHaveLength(1);

      // Re-running is the normal path — the daemon migrates on every startup.
      // If this ever applied a second time, an adopter's database would be
      // rebuilt underneath them on every restart.
      const second = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(second.error).toBeUndefined();
      expect(second.results).toHaveLength(0);
    });
  });

  it('creates the four ADL tables it is responsible for, plus Kysely bookkeeping', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const names = await tableNames(db);
      for (const table of [...INITIAL_TABLES, ...KYSELY_TABLES]) {
        expect(names).toContain(table);
      }
    });
  });

  it('gives features exactly the columns the hand-written Database interface declares', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const info = await sql<{
        name: string;
      }>`pragma table_info(features)`.execute(db);
      const actual = info.rows.map((r) => r.name).sort();

      // This is the drift check in its cheapest form. Plan 01-10 adds the
      // generator-based CI version; this one already fails if a migration and
      // the interface disagree, which is the failure that matters.
      expect(actual).toEqual([...FEATURES_COLUMNS].sort());
    });
  });

  it('deletes the temp database file when the helper tears down', async () => {
    let capturedPath = '';

    await withTempDb(async ({ db, filePath }) => {
      capturedPath = filePath;
      await migrateToLatest(db, MIGRATIONS_DIR);
      expect(existsSync(filePath)).toBe(true);
    });

    expect(capturedPath).not.toBe('');
    expect(existsSync(capturedPath)).toBe(false);
  });
});
