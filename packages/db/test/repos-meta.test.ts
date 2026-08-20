import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_PAUSE_KEY,
  metaRepository,
  migrateToLatest,
  reposRepository,
  SCHEMA_VERSION_KEY,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

const NOW = '2026-08-19T12:00:00.000Z';
const LATER = '2026-08-19T13:00:00.000Z';

describe('reposRepository', () => {
  it('upsert inserts a repo that does not exist', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = reposRepository(db);
      const id = ulid();

      await repo.upsert({
        id,
        remote_url: 'https://github.com/example/target-repo.git',
        default_branch: 'main',
        forge: 'github',
        features_dir: 'features',
        created_at: NOW,
        updated_at: NOW,
      });

      const row = await repo.findById(id);
      expect(row?.remote_url).toBe(
        'https://github.com/example/target-repo.git',
      );
      expect(row?.default_branch).toBe('main');
    });
  });

  it('upsert called twice with the same id leaves exactly one row, preserves created_at, and overwrites the rest', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = reposRepository(db);
      const id = ulid();

      await repo.upsert({
        id,
        remote_url: 'https://github.com/example/target-repo.git',
        default_branch: 'main',
        forge: 'github',
        features_dir: 'features',
        created_at: NOW,
        updated_at: NOW,
      });

      await repo.upsert({
        id,
        remote_url: 'https://github.com/example/renamed-repo.git',
        default_branch: 'develop',
        forge: 'github',
        features_dir: 'app/features',
        created_at: LATER, // a config reload should not rewrite the original created_at
        updated_at: LATER,
      });

      const all = await repo.list();
      expect(all).toHaveLength(1);

      const row = await repo.findById(id);
      expect(row?.remote_url).toBe(
        'https://github.com/example/renamed-repo.git',
      );
      expect(row?.default_branch).toBe('develop');
      expect(row?.features_dir).toBe('app/features');
      expect(row?.updated_at).toBe(LATER);
      expect(row?.created_at).toBe(NOW);
    });
  });

  it('list returns every repo ordered by id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = reposRepository(db);

      const first = ulid();
      const second = ulid();

      for (const id of [second, first]) {
        await repo.upsert({
          id,
          remote_url: `https://github.com/example/${id}.git`,
          default_branch: 'main',
          forge: 'github',
          features_dir: 'features',
          created_at: NOW,
          updated_at: NOW,
        });
      }

      const all = await repo.list();
      expect(all.map((r) => r.id)).toEqual([first, second].sort());
    });
  });
});

describe('metaRepository', () => {
  it('getSchemaVersion reports the absent case against a freshly migrated database — not 0, not a thrown error', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      const result = await meta.getSchemaVersion();
      expect(result).toEqual({ kind: 'absent' });
    });
  });

  it('get returns undefined for a key never written', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      expect(await meta.get('nonexistent-key')).toBeUndefined();
    });
  });

  it('set is idempotent — writing the same key twice leaves one row with the later updated_at', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.set('some-key', 'v1', NOW);
      await meta.set('some-key', 'v2', LATER);

      expect(await meta.get('some-key')).toBe('v2');

      const rows = await db
        .selectFrom('meta')
        .selectAll()
        .where('key', '=', 'some-key')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.updated_at).toBe(LATER);
    });
  });

  it('setSchemaVersion followed by getSchemaVersion round-trips as a valid integer', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.setSchemaVersion(3, NOW);

      const result = await meta.getSchemaVersion();
      expect(result).toEqual({ kind: 'valid', version: 3 });
    });
  });

  it('reports a non-integer stored schema_version as a distinguishable failure, never a numeric value', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.set(SCHEMA_VERSION_KEY, 'not-a-number', NOW);

      const result = await meta.getSchemaVersion();
      expect(result).toEqual({ kind: 'invalid', rawValue: 'not-a-number' });
      expect(result.kind).not.toBe('valid');
    });
  });

  it('getGlobalPause reports the absent case against a migrated database with no global_pause row (G-03-3)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      const result = await meta.getGlobalPause();
      expect(result).toEqual({ kind: 'absent' });
    });
  });

  it('getGlobalPause reports valid for each well-formed stored value', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.setGlobalPause(true, NOW);
      expect(await meta.getGlobalPause()).toEqual({
        kind: 'valid',
        paused: true,
      });

      await meta.setGlobalPause(false, LATER);
      expect(await meta.getGlobalPause()).toEqual({
        kind: 'valid',
        paused: false,
      });
    });
  });

  it('getGlobalPause reports invalid for arbitrary stored text, carrying it verbatim rather than coercing it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.set(GLOBAL_PAUSE_KEY, 'yes-please', NOW);

      const result = await meta.getGlobalPause();
      expect(result).toEqual({ kind: 'invalid', rawValue: 'yes-please' });
      expect(result.kind).not.toBe('valid');
    });
  });

  it('setGlobalPause is idempotent — writing the same value twice leaves one row with the later updated_at', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const meta = metaRepository(db);

      await meta.setGlobalPause(true, NOW);
      await meta.setGlobalPause(true, LATER);

      const rows = await db
        .selectFrom('meta')
        .selectAll()
        .where('key', '=', GLOBAL_PAUSE_KEY)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.updated_at).toBe(LATER);
      expect(await meta.getGlobalPause()).toEqual({
        kind: 'valid',
        paused: true,
      });
    });
  });
});
