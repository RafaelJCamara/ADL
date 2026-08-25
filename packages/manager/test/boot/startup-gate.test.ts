import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { metaRepository, migrateToLatest, reposRepository } from '@adl/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  DAEMON_SCHEMA_VERSION,
  reconcileRepos,
  runStartupGate,
} from '../../src/boot/startup.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
// Reused directly, per 03-CONTEXT.md's read_first list — the temp-SQLite
// helper `@adl/db`'s own suite already relies on, not re-derived here.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

async function digestFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Checkpoint the WAL and read the file's digest — the "at rest" byte
 * snapshot a real pre-migration copy is compared against. Without this, a
 * digest read straight off the main file can miss committed pages still
 * held in the `-wal` sidecar (WAL mode, `03-02`), making the "before" and
 * "after the gate's own checkpoint" digests differ for reasons that have
 * nothing to do with the gate's copy step itself.
 */
async function checkpointAndDigest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper, any Database shape
  db: Kysely<any>,
  filePath: string,
): Promise<string> {
  await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
  return digestFile(filePath);
}

describe('DAEMON_SCHEMA_VERSION', () => {
  it('is derived from the migrations directory — 5, matching the 5 shipped migrations', () => {
    // Deliberately a literal rather than a re-derivation: `DAEMON_SCHEMA_VERSION`
    // IS the derivation (rule 8), so asserting it against a second count of the
    // same directory would agree with itself no matter what either did. Bumped
    // by `0005_rounds_head_sha.ts` (M05 step 5.14), which is what a migration
    // landing is supposed to look like in a diff.
    expect(DAEMON_SCHEMA_VERSION).toBe(5);
  });
});

describe('runStartupGate — refuse newer', () => {
  it('refuses a schema_version greater than DAEMON_SCHEMA_VERSION and leaves the database file byte-identical', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await metaRepository(db).setSchemaVersion(
        DAEMON_SCHEMA_VERSION + 1,
        new Date().toISOString(),
      );

      const before = await digestFile(filePath);
      const { logger } = createCapturingLogger();

      const result = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });

      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.refusal.reason).toBe('newer-schema');
      }

      const after = await digestFile(filePath);
      expect(after).toBe(before);
    });
  });

  it('refuses a non-integer schema_version rather than coercing it', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await db
        .insertInto('meta')
        .values({
          key: 'schema_version',
          value: 'not-a-number',
          updated_at: new Date().toISOString(),
        })
        .execute();

      const { logger } = createCapturingLogger();
      const result = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });

      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.refusal.reason).toBe('invalid-schema-version');
      }
    });
  });
});

describe('runStartupGate — copy before migrating', () => {
  it('against an absent schema_version (fresh, migrated-but-unseeded), takes a copy, migrates, and seeds schema_version', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // meta.schema_version is absent: migration 0001 creates `meta` empty.

      const preGateDigest = await checkpointAndDigest(db, filePath);
      const { logger } = createCapturingLogger();

      const result = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });

      expect(result.kind).toBe('proceeded');
      if (result.kind === 'proceeded') {
        expect(result.copyPath).toBeDefined();
        const copyDigest = await digestFile(result.copyPath!);
        expect(copyDigest).toBe(preGateDigest);
      }

      const version = await metaRepository(db).getSchemaVersion();
      expect(version).toEqual({
        kind: 'valid',
        version: DAEMON_SCHEMA_VERSION,
      });
    });
  });

  it('against an older schema_version, the copy is taken first and its bytes equal the pre-migration original', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await metaRepository(db).setSchemaVersion(1, new Date().toISOString());

      const preGateDigest = await checkpointAndDigest(db, filePath);
      const { logger } = createCapturingLogger();

      const result = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });

      expect(result.kind).toBe('proceeded');
      if (result.kind === 'proceeded') {
        const copyDigest = await digestFile(result.copyPath!);
        expect(copyDigest).toBe(preGateDigest);
      }
    });
  });

  it('when the copy cannot be written, refuses and applies no migration (kysely_migration gains no row)', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // meta.schema_version is absent — the copy-then-migrate path.

      const { logger } = createCapturingLogger();
      const failingCopy = async (): Promise<void> => {
        throw new Error('simulated: destination is unwritable');
      };

      const result = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
        copyFile: failingCopy,
      });

      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.refusal.reason).toBe('copy-failed');
      }

      const version = await metaRepository(db).getSchemaVersion();
      expect(version).toEqual({ kind: 'absent' });
    });
  });

  it('re-running the gate against an already-current database is a no-op that writes no new copy', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger } = createCapturingLogger();

      const first = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });
      expect(first.kind).toBe('proceeded');

      const second = await runStartupGate({
        db,
        dbFilePath: filePath,
        migrationsDir: MIGRATIONS_DIR,
        logger,
      });
      expect(second.kind).toBe('proceeded');
      if (second.kind === 'proceeded') {
        expect(second.copyPath).toBeUndefined();
      }

      const siblings = await readdir(dirname(filePath));
      const copies = siblings.filter((name) => name.includes('.pre-'));
      expect(copies).toHaveLength(1); // only the first call's copy exists
    });
  });
});

describe('reconcileRepos', () => {
  it('upserts every configured repository, and leaves a table row absent from the config in place', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      // A row already present but not in the config this time.
      const now = new Date().toISOString();
      await reposRepository(db).upsert({
        id: 'orphan-repo',
        remote_url: 'git@example.com:orphan/repo.git',
        default_branch: 'main',
        forge: 'github',
        features_dir: 'features',
        created_at: now,
        updated_at: now,
      });

      const { logger } = createCapturingLogger();
      await reconcileRepos({
        db,
        repos: [
          {
            id: 'configured-repo',
            remote_url: 'git@example.com:configured/repo.git',
            default_branch: 'main',
            forge: 'github',
            features_dir: 'features',
          },
        ],
        logger,
      });

      const all = await reposRepository(db).list();
      const ids = all.map((r) => r.id).sort();
      expect(ids).toEqual(['configured-repo', 'orphan-repo']);
    });
  });
});
