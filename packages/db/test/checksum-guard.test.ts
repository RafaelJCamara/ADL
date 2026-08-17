import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHECKSUM_TABLE, migrateToLatest } from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * A checksum guard nobody has seen fail is a checksum guard nobody knows
 * works (D-30). This file migrates real database files, mutates a migration's
 * bytes on disk, and watches the guard refuse to run.
 *
 * Every mutation happens against a **copy** of the migrations directory in a
 * private temp location, never against `packages/db/migrations/` itself — a
 * failing assertion mid-test must not leave a real migration modified. The
 * `beforeAll`/`afterAll` digest comparison at the bottom of this file is what
 * proves that promise held, independent of git: the migrations this plan adds
 * are untracked in the commit that creates them, so `git diff --exit-code`
 * would report success unconditionally in exactly the run where a stray
 * mutation would matter most.
 */

/** sha256 hex of a migration file's exact bytes. */
function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every real migration file's digest, keyed by filename (extension included). */
async function digestRealMigrations(): Promise<Map<string, string>> {
  const files = await readdir(MIGRATIONS_DIR);
  const map = new Map<string, string>();
  for (const file of files.sort()) {
    if (file.endsWith('.d.ts')) continue;
    if (!/\.(ts|js|mjs)$/.test(file)) continue;
    map.set(file, digestBytes(await readFile(join(MIGRATIONS_DIR, file))));
  }
  return map;
}

/** Copy every real migration file into `dir`, verbatim. */
async function copyRealMigrationsInto(dir: string): Promise<void> {
  const files = await readdir(MIGRATIONS_DIR);
  for (const file of files) {
    if (file.endsWith('.d.ts')) continue;
    if (!/\.(ts|js|mjs)$/.test(file)) continue;
    await writeFile(
      join(dir, file),
      await readFile(join(MIGRATIONS_DIR, file)),
    );
  }
}

/** A minimal valid migration, for the "a new migration still applies" case. */
const EXTRA_MIGRATION_SOURCE = `import { sql } from 'kysely';
export async function up(db) {
  await db.transaction().execute(async (trx) => {
    await sql\`create table checksum_guard_probe (id text primary key)\`.execute(trx);
  });
}
export async function down(db) {
  await db.transaction().execute(async (trx) => {
    await sql\`drop table if exists checksum_guard_probe\`.execute(trx);
  });
}
`;

/** A migration that creates a table, then throws before its transaction commits. */
const BOOM_MIGRATION_SOURCE = `import { sql } from 'kysely';
export async function up(db) {
  await db.transaction().execute(async (trx) => {
    await sql\`create table checksum_guard_boom_probe (id text primary key)\`.execute(trx);
    throw new Error('simulated mid-migration failure');
  });
}
export async function down() {}
`;

describe('the migration checksum guard', () => {
  let realDigestsAtSetup: Map<string, string>;

  beforeAll(async () => {
    realDigestsAtSetup = await digestRealMigrations();
  });

  afterAll(async () => {
    const realDigestsAtTeardown = await digestRealMigrations();
    // This is the containment proof, not `git diff --exit-code`: it depends on
    // nothing git knows, and it fails in the same run that caused the problem.
    expect([...realDigestsAtTeardown.entries()]).toEqual([
      ...realDigestsAtSetup.entries(),
    ]);
  });

  it('passes trivially on a fresh database and records one checksum row per applied migration', async () => {
    await withTempDb(async ({ db }) => {
      const result = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(result.error).toBeUndefined();
      expect(result.results.length).toBeGreaterThan(0);

      const rows = await sql<{
        name: string;
      }>`select name from ${sql.raw(CHECKSUM_TABLE)}`.execute(db);
      expect(rows.rows.map((r) => r.name).sort()).toEqual(
        result.results.map((r) => r.migrationName).sort(),
      );
    });
  });

  it('the runner records no column on kysely_migration beyond its original two', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const info = await sql<{
        name: string;
      }>`pragma table_info(kysely_migration)`.execute(db);
      expect(info.rows.map((r) => r.name).sort()).toEqual([
        'name',
        'timestamp',
      ]);
    });
  });

  it('refuses to run when an applied migration file was mutated afterwards, naming the migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-migrations-mutate-'));
    // Prove the mutation target before writing a single byte.
    expect(dir).not.toBe(MIGRATIONS_DIR);

    try {
      await copyRealMigrationsInto(dir);

      await withTempDb(async ({ db }) => {
        const first = await migrateToLatest(db, dir);
        expect(first.error).toBeUndefined();
        expect(first.results.length).toBeGreaterThan(0);

        const appliedName = first.results[0]!.migrationName;
        await appendFile(
          join(dir, `${appliedName}.ts`),
          '\n// mutated after being applied\n',
        );

        await expect(migrateToLatest(db, dir)).rejects.toThrow(
          new RegExp(`"${appliedName}"[\\s\\S]*modified after being applied`),
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names both the recorded and the found digest, truncated, in the failure message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-migrations-mutate-digest-'));
    expect(dir).not.toBe(MIGRATIONS_DIR);

    try {
      await copyRealMigrationsInto(dir);

      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, dir);
        const files = await readdir(dir);
        const target = files.find(
          (f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'),
        )!;
        await appendFile(join(dir, target), '\n// one more byte\n');

        let caught: unknown;
        try {
          await migrateToLatest(db, dir);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toMatch(/recorded [0-9a-f]{12}/);
        expect(message).toMatch(/found [0-9a-f]{12}/);
        // Truncated, not the full 64-character digest.
        expect(message).not.toMatch(/[0-9a-f]{64}/);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run when a checksum row for an applied migration was deleted', async () => {
    const dir = await mkdtemp(
      join(tmpdir(), 'adl-migrations-delete-checksum-'),
    );
    expect(dir).not.toBe(MIGRATIONS_DIR);

    try {
      await copyRealMigrationsInto(dir);

      await withTempDb(async ({ db }) => {
        const first = await migrateToLatest(db, dir);
        const appliedName = first.results[0]!.migrationName;

        // The bypass this proves impossible: removing the guard's own
        // evidence rather than the migration's evidence.
        await sql`delete from ${sql.raw(CHECKSUM_TABLE)} where name = ${appliedName}`.execute(
          db,
        );

        await expect(migrateToLatest(db, dir)).rejects.toThrow(
          new RegExp(`"${appliedName}"[\\s\\S]*no recorded checksum`),
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies a new migration normally after the guard has run, and records its checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-migrations-add-'));
    expect(dir).not.toBe(MIGRATIONS_DIR);

    try {
      await copyRealMigrationsInto(dir);

      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, dir);

        await writeFile(join(dir, '9999_extra.ts'), EXTRA_MIGRATION_SOURCE);

        const second = await migrateToLatest(db, dir);
        expect(second.error).toBeUndefined();
        expect(second.results.map((r) => r.migrationName)).toContain(
          '9999_extra',
        );

        const rows = await sql<{ name: string }>`
          select name from ${sql.raw(CHECKSUM_TABLE)} where name = '9999_extra'
        `.execute(db);
        expect(rows.rows).toHaveLength(1);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves neither an applied record nor a checksum row when a migration fails partway', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-migrations-partial-fail-'));
    expect(dir).not.toBe(MIGRATIONS_DIR);

    try {
      await writeFile(join(dir, '0001_boom.ts'), BOOM_MIGRATION_SOURCE);

      await withTempDb(async ({ db }) => {
        const result = await migrateToLatest(db, dir);
        expect(result.error).toBeDefined();

        // The migration's own DDL rolled back...
        const tables = await sql<{ name: string }>`
          select name from sqlite_master where type = 'table' and name = 'checksum_guard_boom_probe'
        `.execute(db);
        expect(tables.rows).toHaveLength(0);

        // ...and neither bookkeeping table recorded it, because the checksum
        // insert and the migration's statements share one transaction.
        const applied = await sql<{
          name: string;
        }>`select name from kysely_migration`.execute(db);
        expect(applied.rows.map((r) => r.name)).not.toContain('0001_boom');

        const checksums = await sql<{ name: string }>`
          select name from ${sql.raw(CHECKSUM_TABLE)}
        `.execute(db);
        expect(checksums.rows.map((r) => r.name)).not.toContain('0001_boom');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
