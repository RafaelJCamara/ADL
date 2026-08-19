import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';

/**
 * The daemon's single key/value row set. `schema_version` gates startup
 * (D-37): `03-06`'s startup gate reads it before any other database access
 * and refuses to run against a schema newer than the running binary.
 */

/** The one key `03-06`'s startup gate reads. */
export const SCHEMA_VERSION_KEY = 'schema_version';

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
}

/** A value parses as the schema version's integer form: optional `-`, then only digits. */
const INTEGER_PATTERN = /^-?\d+$/;

export function metaRepository(db: Kysely<Database>): MetaRepository {
  async function get(key: string): Promise<string | undefined> {
    const row = await db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value;
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
  };
}
