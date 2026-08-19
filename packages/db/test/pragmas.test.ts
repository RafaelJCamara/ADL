import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { createDb, DEFAULT_PRAGMAS, migrateToLatest } from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

const NOW = '2026-08-19T12:00:00.000Z';

/** `PRAGMA synchronous` reports the numeric level, not the name (0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA). */
const SYNCHRONOUS_NORMAL_LEVEL = 1;

describe('createDb: connection pragmas', () => {
  it('opens in WAL journal mode', async () => {
    await withTempDb(async ({ db }) => {
      const result = await sql<{
        journal_mode: string;
      }>`pragma journal_mode`.execute(db);
      expect(result.rows[0]?.journal_mode).toBe(
        DEFAULT_PRAGMAS.journal_mode.toLowerCase(),
      );
    });
  });

  it('reports the configured busy_timeout', async () => {
    await withTempDb(async ({ db }) => {
      const result = await sql<{ timeout: number }>`pragma busy_timeout`.execute(
        db,
      );
      expect(result.rows[0]?.timeout).toBe(DEFAULT_PRAGMAS.busy_timeout);
    });
  });

  it('reports synchronous at the NORMAL level', async () => {
    await withTempDb(async ({ db }) => {
      const result = await sql<{
        synchronous: number;
      }>`pragma synchronous`.execute(db);
      expect(result.rows[0]?.synchronous).toBe(SYNCHRONOUS_NORMAL_LEVEL);
    });
  });

  it('lets a second connection read while a write transaction is open on the first — the concrete behaviour WAL buys', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const db2 = createDb(filePath);
      try {
        let releaseWrite: () => void = () => {};
        const writeGate = new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });

        const writeTxn = db.transaction().execute(async (trx) => {
          await trx
            .insertInto('repos')
            .values({
              id: 'repo-1',
              remote_url: 'https://github.com/example/target-repo.git',
              default_branch: 'main',
              forge: 'github',
              features_dir: 'features',
              created_at: NOW,
              updated_at: NOW,
            })
            .execute();
          // Hold the transaction open until the assertion below has run its
          // read against the second connection.
          await writeGate;
        });

        // Give the transaction time to actually begin before reading.
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Without WAL this read would block behind the open writer (and, if
        // it ever timed out, throw SQLITE_BUSY) rather than returning.
        const duringWrite = await db2
          .selectFrom('repos')
          .selectAll()
          .execute();
        expect(duringWrite).toEqual([]);

        releaseWrite();
        await writeTxn;

        const afterCommit = await db2
          .selectFrom('repos')
          .selectAll()
          .execute();
        expect(afterCommit).toHaveLength(1);
      } finally {
        // Close before withTempDb's own teardown removes the directory — the
        // same Windows open-handle concern `temp-db.ts` documents for `db`.
        await db2.destroy();
      }
    });
  });
});
