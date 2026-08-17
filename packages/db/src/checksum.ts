import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * ADL's own migration checksum guard (D-30).
 *
 * Kysely's own bookkeeping table, `kysely_migration`, has exactly two columns
 * — `name` and `timestamp` — and records no digest (verified by reading
 * Kysely 0.29.5's source; see 01-RESEARCH.md § Pitfall 5). Nothing stops a
 * maintainer from editing an already-shipped migration file: CI stays green,
 * because CI always migrates from empty, but every existing installation has
 * the *old* schema recorded under the *same* migration name and will never
 * re-run it. The corruption lands in an adopter's database, invisibly.
 *
 * This module is what closes that gap, entirely in **ADL's own table** —
 * never a column added to Kysely's, because that table's shape belongs to
 * Kysely and could change under a version bump.
 */

/** ADL's own table. Never a column on Kysely's `kysely_migration`. */
export const CHECKSUM_TABLE = 'adl_migration_checksums';

/** Create ADL's checksum table if it does not already exist. Idempotent. */
export async function ensureChecksumTable<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    create table if not exists ${sql.raw(CHECKSUM_TABLE)} (
      name       text primary key,
      digest     text not null,
      applied_at text not null
    )
  `.execute(db);
}

/**
 * Record one migration's checksum.
 *
 * Called with the **same transaction** the migration's own statements ran
 * in, immediately before it commits — see {@link wrapMigrationWithChecksum}.
 * That is what makes the two records consistent under a crash: a digest
 * written afterwards can be lost while the migration stands recorded, and one
 * written beforehand could survive a rollback the migration itself did not.
 * Writing it inside the same transaction removes both failure modes.
 */
export async function recordMigrationChecksum<DB>(
  trx: Kysely<DB>,
  name: string,
  digest: string,
): Promise<void> {
  const appliedAt = new Date().toISOString();
  await sql`
    insert into ${sql.raw(CHECKSUM_TABLE)} (name, digest, applied_at)
    values (${name}, ${digest}, ${appliedAt})
  `.execute(trx);
}

/**
 * The filename-matching rule migrations are discovered by, shared with
 * `migrator.ts`'s `DirectoryMigrationProvider`. `.d.ts` is skipped so compiled
 * output does not contribute a phantom no-op alongside its declaration file;
 * `.ts`/`.js`/`.mjs` covers source and every compiled shape.
 */
function isMigrationFile(file: string): boolean {
  if (file.endsWith('.d.ts')) return false;
  return /\.(ts|js|mjs)$/.test(file);
}

function migrationNameFromFile(file: string): string {
  return file.replace(/\.(ts|js|mjs)$/, '');
}

/**
 * sha256 hex of every migration file in `migrationsDir`, keyed by migration
 * name (the same name {@link migrationNameFromFile} and the migration
 * provider both derive) — so a source-tree run and a `dist/migrations` run
 * digest under identical keys, preserving the dev/dist migration-name parity
 * plan 01-02 established.
 */
export async function digestMigrationFiles(
  migrationsDir: string,
): Promise<Map<string, string>> {
  const files = await readdir(migrationsDir);
  const digests = new Map<string, string>();

  for (const file of files.sort()) {
    if (!isMigrationFile(file)) continue;
    const bytes = await readFile(join(migrationsDir, file));
    digests.set(
      migrationNameFromFile(file),
      createHash('sha256').update(bytes).digest('hex'),
    );
  }

  return digests;
}

async function migrationsBookkeepingTableExists<DB>(
  db: Kysely<DB>,
): Promise<boolean> {
  const result = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name = 'kysely_migration'
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * Refuse to proceed if any applied migration's file has changed since it ran,
 * or if an applied migration has no recorded checksum at all.
 *
 * Must run **before** anything else migrates (see `migrator.ts`). On a
 * database where `kysely_migration` does not exist yet — the very first
 * migration run against a brand-new file — there is nothing applied and
 * therefore nothing to check; the guard is a deliberate no-op rather than an
 * error on "table does not exist yet".
 *
 * The two documented bypasses this closes: mutating an applied migration's
 * bytes, and deleting the checksum row that would have caught it. Both raise
 * the same class of error — the guard has no way to distinguish "someone
 * tampered with the file" from "someone tampered with the evidence", and
 * treats both as equally unacceptable.
 */
export async function assertMigrationsUnmodified<DB>(
  db: Kysely<DB>,
  migrationsDir: string,
): Promise<void> {
  if (!(await migrationsBookkeepingTableExists(db))) return;

  const applied = await sql<{
    name: string;
  }>`select name from kysely_migration`.execute(db);
  if (applied.rows.length === 0) return;

  await ensureChecksumTable(db);
  const recorded = await sql<{ name: string; digest: string }>`
    select name, digest from ${sql.raw(CHECKSUM_TABLE)}
  `.execute(db);
  const recordedByName = new Map(recorded.rows.map((r) => [r.name, r.digest]));

  const onDisk = await digestMigrationFiles(migrationsDir);

  for (const { name } of applied.rows) {
    const want = recordedByName.get(name);
    if (want === undefined) {
      throw new Error(
        `migration "${name}" is recorded as applied but has no recorded checksum. ` +
          'The guard cannot be bypassed by deleting its own evidence — restore the ' +
          'checksum row, or investigate how it was removed.',
      );
    }

    const got = onDisk.get(name);
    if (got === undefined) {
      throw new Error(
        `migration "${name}" is recorded as applied but no file named "${name}" exists ` +
          `under ${migrationsDir}.`,
      );
    }

    if (got !== want) {
      throw new Error(
        `migration "${name}" was modified after being applied ` +
          `(recorded ${want.slice(0, 12)}, found ${got.slice(0, 12)}). ` +
          'An applied migration must never be edited — add a new one instead.',
      );
    }
  }
}

/**
 * Wrap a migration so that, when it runs, its checksum is recorded inside the
 * **same transaction** its own statements ran in.
 *
 * Kysely's `Migrator` calls `migration.up(db)` with the plain database
 * handle, not a transaction — `SqliteAdapter.supportsTransactionalDdl` is
 * `false`, so Kysely never opens one itself. Every migration in this package
 * opens its own via `db.transaction().execute(trx => { ... })`, and a second,
 * *nested* `db.transaction()` call on the resulting `Transaction` throws
 * (verified against Kysely 0.29.5: "calling the transaction method for a
 * Transaction is not supported").
 *
 * This wrapper hands the migration a **proxy** of the database handle instead
 * of the real one. The proxy behaves identically for everything except
 * `.transaction()`: when the migration calls it, the proxy opens the real
 * transaction on the real handle, runs the migration's callback against the
 * real `Transaction` object it receives, and — still inside that same
 * transaction, immediately before it commits — inserts the checksum row.
 * A migration file therefore never needs to know the checksum guard exists;
 * the composition happens entirely at the runner boundary.
 *
 * Verified empirically before relying on it: the migration's own DDL and the
 * checksum insert commit together, and a throw from the migration's callback
 * rolls both back together, leaving neither an applied record nor a checksum
 * row (see `checksum-guard.test.ts`'s partial-failure case).
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
 * Kysely's own `Migration` interface (kysely/migration) is declared as
 * `up(db: Kysely<any>): Promise<void>` — not generic — so implementing it,
 * and building the proxy that stands in for that same `db` parameter, has no
 * narrower type available without violating the third-party interface these
 * two functions exist to satisfy. Verified against kysely@0.29.5's own
 * shipped `.d.ts` (see 01-REVIEW.md WR-02). The other four functions in this
 * module are ADL's own and are generic over `DB` instead.
 */
export function wrapMigrationWithChecksum(
  migration: Migration,
  name: string,
  digest: string,
): Migration {
  return {
    up: async (db: Kysely<any>) => {
      await migration.up(reentrantTransactionProxy(db, name, digest));
    },
    down: migration.down,
  };
}

function reentrantTransactionProxy(
  db: Kysely<any>,
  name: string,
  digest: string,
): Kysely<any> {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return () => ({
          execute: async (callback: (trx: Kysely<any>) => Promise<unknown>) => {
            return db.transaction().execute(async (trx: Kysely<any>) => {
              const result = await callback(trx);
              await recordMigrationChecksum(trx, name, digest);
              return result;
            });
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Kysely<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
