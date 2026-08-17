import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
// Kysely 0.29 moved the migration API behind its own subpath. Importing these
// from the root entrypoint still typechecks as a `KyselyTypeError` that says so
// — a nice touch, but only if you read the error rather than casting past it.
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely/migration';
import type { Database } from './schema.js';

/**
 * Open a Kysely instance over a SQLite file.
 *
 * `better-sqlite3` is CJS, so it is imported as a **default** import under
 * `nodenext` (C-17). This is the only package in the repository that names the
 * driver at all — `@adl/core` never learns a database exists (D-28), which is
 * what keeps the contract layer's purity claim true where it matters and what
 * contains the eventual `node:sqlite` or Postgres swap to one package.
 *
 * @param filePath Path to the database file. `:memory:` works, but the
 *   migration tests deliberately use a real file (D-30) — file-backed
 *   behaviour is what adopters actually get.
 */
export function createDb(filePath: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({
      database: new SqliteDatabase(filePath),
    }),
  });
}

/**
 * Loads migrations from a directory.
 *
 * Kysely ships `FileMigrationProvider`, which builds a plain filesystem path
 * and hands it to `import()`. On Windows that produces `C:\...\0001_initial.ts`,
 * and Node's ESM loader rejects a bare drive path with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Converting through `pathToFileURL` is the
 * whole difference, so this provider exists rather than a platform caveat in
 * the README.
 */
class DirectoryMigrationProvider implements MigrationProvider {
  constructor(private readonly migrationFolder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = await readdir(this.migrationFolder);
    const migrations: Record<string, Migration> = {};

    for (const file of files.sort()) {
      // `.d.ts` would otherwise be picked up beside compiled output and
      // imported as an empty module, silently contributing a no-op migration.
      if (file.endsWith('.d.ts')) continue;
      if (!/\.(ts|js|mjs)$/.test(file)) continue;

      const url = pathToFileURL(join(this.migrationFolder, file)).href;
      const module = (await import(url)) as Migration;
      const name = file.replace(/\.(ts|js|mjs)$/, '');
      migrations[name] = module;
    }

    return migrations;
  }
}

export interface MigrateResult {
  /** Every migration the runner touched, applied or errored. Never swallowed. */
  readonly results: readonly MigrationResult[];
  /** The error the runner stopped on, if any. */
  readonly error: unknown;
}

/**
 * Apply every unapplied migration, in filename order.
 *
 * The full result set is **returned rather than logged and discarded**. A
 * migration runner that reports only success/failure gives the caller nothing
 * to put in front of a maintainer whose database stopped halfway, and this
 * code runs in other people's installations.
 *
 * Note what is deliberately absent: nothing here writes to Kysely's own
 * `kysely_migration` table beyond letting Kysely manage it. That table has
 * exactly two columns (`name`, `timestamp`) and **no checksum**, and Kysely
 * owns its shape. ADL's checksum guard (D-30) — which catches the genuinely
 * dangerous case of an already-shipped migration file being edited — lands in
 * plan 01-10 as a separate ADL-owned table.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  migrationsDir: string,
): Promise<MigrateResult> {
  const migrator = new Migrator({
    db,
    provider: new DirectoryMigrationProvider(migrationsDir),
  });

  const { error, results } = await migrator.migrateToLatest();
  return { results: results ?? [], error };
}
