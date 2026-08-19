import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  BOOKKEEPING_TABLES,
  TABLE_COLUMNS,
  migrateToLatest,
  type Database,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * The hand-written `Database` interface versus the schema the migrations
 * actually produce, compared **in both directions**.
 *
 * Hand-writing the interface (01-RESEARCH.md § Alternatives Considered) buys a
 * dependency-free build and costs the risk of silent drift. This file is the
 * payment. It introspects the migrated database's own catalogue rather than
 * running a code generator, for two reasons: no generator lands in the runtime
 * or the CI dependency graph, and the failure message can name the specific
 * table or column that drifted instead of printing a diff of two generated
 * files.
 *
 * Kysely's `kysely_migration` and `kysely_migration_lock` are excluded by
 * name. Their shape belongs to Kysely and could change under a version bump —
 * which is the same reason D-30's checksum guard owns its own table rather
 * than adding a column to Kysely's.
 */

async function liveTables(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name not like 'sqlite_%'
    order by name
  `.execute(db);
  return result.rows
    .filter((r) => !BOOKKEEPING_TABLES.includes(r.name))
    .map((r) => r.name);
}

async function liveColumns(
  db: Kysely<Database>,
  table: string,
): Promise<string[]> {
  const result = await sql<{
    name: string;
  }>`pragma table_info(${sql.raw(table)})`.execute(db);
  return result.rows.map((r) => r.name);
}

describe('the hand-written Database interface matches the live schema', () => {
  it('declares every table the migrations create', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const live = await liveTables(db);
      const declared = Object.keys(TABLE_COLUMNS);

      const undeclared = live.filter((t) => !declared.includes(t));
      expect(
        undeclared,
        `these tables exist in the database but not in the Database interface: ${undeclared.join(', ')}`,
      ).toEqual([]);
    });
  });

  it('creates every table the interface declares', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const live = await liveTables(db);
      const missing = Object.keys(TABLE_COLUMNS).filter(
        (t) => !live.includes(t),
      );
      expect(
        missing,
        `these tables are declared in the Database interface but no migration creates them: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  });

  it('matches every column of every table, name by name', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const drift: string[] = [];

      for (const [table, declared] of Object.entries(TABLE_COLUMNS) as [
        string,
        readonly string[],
      ][]) {
        const live = await liveColumns(db, table);

        for (const column of live) {
          if (!declared.includes(column)) {
            drift.push(
              `${table}.${column} exists in the database but not in the interface`,
            );
          }
        }
        for (const column of declared) {
          if (!live.includes(column)) {
            drift.push(
              `${table}.${column} is declared in the interface but no column exists`,
            );
          }
        }
      }

      // A migration that adds a column without updating the types fails here,
      // naming the column — which is the failure that would otherwise surface
      // as a runtime `no such column` in an adopter's installation.
      expect(drift, drift.join('\n')).toEqual([]);
    });
  });
});
