import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../../src/index.js';
import type { Database } from '../../src/index.js';

/** Absolute path to `packages/db/migrations`, resolved from this file. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

export interface TempDb {
  readonly db: Kysely<Database>;
  /** The database file's path, so a test can assert it is gone afterwards. */
  readonly filePath: string;
}

/**
 * Run `fn` against a freshly created SQLite database in a private temp
 * directory, then close the connection and delete the directory.
 *
 * A temp **file** rather than `:memory:` is required by D-30: migrations must
 * execute against a real file, because file-backed behaviour — journal files,
 * locking, `PRAGMA` semantics — is what adopters actually get, and an
 * in-memory database quietly differs on all three.
 *
 * Teardown is in a `finally` block so a failing assertion cannot leak a
 * database. That matters more than it sounds: a leaked file is invisible
 * locally and accumulates on the machine running CI.
 */
export async function withTempDb<T>(
  fn: (ctx: TempDb) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-db-'));
  const filePath = join(dir, 'adl.db');
  const db = createDb(filePath);

  try {
    return await fn({ db, filePath });
  } finally {
    // Destroy before removing: on Windows an open handle makes the unlink fail,
    // which would turn a passing test into a confusing teardown error.
    //
    // `createDb` opens every connection in WAL mode (`migrator.ts`), which
    // leaves `-wal` and `-shm` sidecar files beside the database file while a
    // connection is open. That does not change this ordering: `db.destroy()`
    // closes the connection first (checkpointing and removing the sidecars in
    // the common case), and the directory removal below deletes the whole
    // temp directory recursively regardless of which files remain in it.
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
