import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';

/**
 * The daemon's single key/value row set. `schema_version` gates startup
 * (D-37): `03-06`'s startup gate reads it before any other database access
 * and refuses to run against a schema newer than the running binary.
 *
 * `global_pause` (G-03-3) is the second key: `03-10`'s boot-time restore
 * reads it before the API binds and before the first dispatch tick, so a
 * maintainer's `adl pause` survives a daemon restart rather than silently
 * resuming dispatch.
 */

/** The one key `03-06`'s startup gate reads. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/** The key `03-10`'s boot-time restore reads (G-03-3). */
export const GLOBAL_PAUSE_KEY = 'global_pause';

/**
 * The three ways `getSchemaVersion` can end.
 *
 * A bare `number | undefined` return would collapse "never written" and "an
 * unparseable value" into the same falsy-ish signal, and comparing `NaN`
 * against a version lets the gate through on a corrupt database — precisely
 * the outcome D-37 exists to prevent. Each case is distinguished so the
 * caller cannot mistake one for another.
 */
export type SchemaVersionResult =
  | { kind: 'absent' }
  | { kind: 'valid'; version: number }
  | { kind: 'invalid'; rawValue: string };

/**
 * The three ways `getGlobalPause` can end — the same discriminated shape as
 * {@link SchemaVersionResult}, and for the same reason: a bare
 * `boolean | undefined` would collapse "never written" (every database from
 * before G-03-3) into the same falsy signal as "written false", and a
 * coerced garbage value would compare as something. The stored value is
 * exactly the string `'true'` or `'false'`; anything else is `invalid`,
 * carried verbatim rather than coerced.
 */
export type GlobalPauseResult =
  | { kind: 'absent' }
  | { kind: 'valid'; paused: boolean }
  | { kind: 'invalid'; rawValue: string };

export interface MetaRepository {
  get(key: string): Promise<string | undefined>;
  /** Idempotent: writing the same key twice leaves one row with the later `updated_at`. */
  set(key: string, value: string, updatedAt: string): Promise<void>;
  /**
   * The stored `schema_version`, discriminated (see {@link SchemaVersionResult}).
   * Absent against a freshly migrated database — migration `0001` creates
   * `meta` without seeding it; the daemon owns writing this the first time.
   */
  getSchemaVersion(): Promise<SchemaVersionResult>;
  setSchemaVersion(version: number, updatedAt: string): Promise<void>;
  /**
   * The stored `global_pause` flag (G-03-3), discriminated (see
   * {@link GlobalPauseResult}). Absent against a database that has never
   * had a global pause set — every database written before this change.
   */
  getGlobalPause(): Promise<GlobalPauseResult>;
  setGlobalPause(paused: boolean, updatedAt: string): Promise<void>;
}

/** A value parses as the schema version's integer form: optional `-`, then only digits. */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Whether `error` is SQLite's own "no such table" — better-sqlite3 has no
 * distinguishable error *code* for this (it shares `SQLITE_ERROR` with
 * every other query-compile failure), so the message text is the only
 * signal, matching `daemon-config.ts`'s own `isEnoent()` precedent for
 * classifying a raw driver error by its one stable, well-known shape.
 */
function isMissingTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'SQLITE_ERROR' &&
    error.message.includes('no such table')
  );
}

export function metaRepository(db: Kysely<Database>): MetaRepository {
  async function get(key: string): Promise<string | undefined> {
    try {
      const row = await db
        .selectFrom('meta')
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      return row?.value;
    } catch (error) {
      // A truly virgin database file — zero tables, migration 0001 never
      // applied — is a more extreme case of exactly what `absent` already
      // means (`getSchemaVersion`'s own docblock: "a freshly migrated
      // database"). Every caller of `metaRepository` up to and including
      // `runStartupGate`'s first read treats `absent` as "take the
      // pre-migration copy, then migrate" — the correct, self-healing
      // action here too, regardless of whether the table is missing
      // because this is a fresh install or because it was dropped.
      if (isMissingTableError(error)) return undefined;
      throw error;
    }
  }

  async function set(
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    await db
      .insertInto('meta')
      .values({ key, value, updated_at: updatedAt })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value, updated_at: updatedAt }),
      )
      .execute();
  }

  return {
    get,
    set,

    async getSchemaVersion() {
      const rawValue = await get(SCHEMA_VERSION_KEY);
      if (rawValue === undefined) {
        return { kind: 'absent' };
      }
      if (!INTEGER_PATTERN.test(rawValue)) {
        return { kind: 'invalid', rawValue };
      }
      return { kind: 'valid', version: Number(rawValue) };
    },

    async setSchemaVersion(version, updatedAt) {
      await set(SCHEMA_VERSION_KEY, String(version), updatedAt);
    },

    async getGlobalPause() {
      const rawValue = await get(GLOBAL_PAUSE_KEY);
      if (rawValue === undefined) {
        return { kind: 'absent' };
      }
      if (rawValue === 'true') {
        return { kind: 'valid', paused: true };
      }
      if (rawValue === 'false') {
        return { kind: 'valid', paused: false };
      }
      return { kind: 'invalid', rawValue };
    },

    async setGlobalPause(paused, updatedAt) {
      await set(GLOBAL_PAUSE_KEY, paused ? 'true' : 'false', updatedAt);
    },
  };
}
