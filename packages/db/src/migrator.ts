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
import {
  assertMigrationsUnmodified,
  digestMigrationFiles,
  ensureChecksumTable,
  wrapMigrationWithChecksum,
} from './checksum.js';
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
 * Before anything runs: ADL's checksum table is ensured and every already-
 * applied migration is checked against the bytes on disk (D-30,
 * `src/checksum.ts`). Nothing here writes to Kysely's own `kysely_migration`
 * table beyond letting Kysely manage it — that table has exactly two columns
 * (`name`, `timestamp`) and no checksum, and Kysely owns its shape. Take a
 * file copy of the database before calling this, in whatever the daemon's
 * startup path is (Phase 3) — the checksum guard catches an edited migration,
 * but a copy is the recovery path if a migration fails partway on this
 * driver's non-transactional-DDL adapter.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  migrationsDir: string,
): Promise<MigrateResult> {
  await ensureChecksumTable(db);
  await assertMigrationsUnmodified(db, migrationsDir);

  const digests = await digestMigrationFiles(migrationsDir);
  const baseProvider = new DirectoryMigrationProvider(migrationsDir);

  // Every migration is handed a checksum-recording proxy of the database in
  // place of the real one, so its own transaction records its own digest —
  // see `wrapMigrationWithChecksum`'s doc comment for why this has to be a
  // proxy rather than a second, nested `db.transaction()` call.
  const provider: MigrationProvider = {
    async getMigrations() {
      const raw = await baseProvider.getMigrations();
      const wrapped: Record<string, Migration> = {};

      for (const [name, migration] of Object.entries(raw)) {
        const digest = digests.get(name);
        if (digest === undefined) {
          // `digestMigrationFiles` and `DirectoryMigrationProvider` share the
          // same file-matching rule, so this should be unreachable. Guarding
          // anyway: silently applying a migration with no digest is exactly
          // the gap this whole module exists to close.
          throw new Error(
            `no digest computed for migration "${name}" — cannot record checksum`,
          );
        }
        wrapped[name] = wrapMigrationWithChecksum(migration, name, digest);
      }

      return wrapped;
    },
  };

  const migrator = new Migrator({ db, provider });

  const { error, results } = await migrator.migrateToLatest();
  return { results: results ?? [], error };
}
