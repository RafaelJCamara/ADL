import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { migrateToLatest, nowIso, type Database } from '@adl/db';
import type { Kysely } from 'kysely';
import {
  createApi,
  resolveStageCell,
  type FeatureView,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';

/**
 * Phase 3 Plan 08, Task 1: the status view — stage resolution, the full
 * column set (D-22..25), and the empty state.
 */

const API_TOKEN = `test-token-${ulid()}`;

const EFFECTIVE_CONFIG_JSON = JSON.stringify({
  pipeline: ['develop', { harness: 'test' }, 'review', 'publish'],
});

async function seedRepo(
  db: Kysely<Database>,
  id: string = ulid(),
): Promise<string> {
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

interface SeedFeatureOptions {
  readonly repoId: string;
  readonly state?: string;
  readonly currentStageIndex?: number;
  readonly round?: number;
  readonly effectiveConfigJson?: string | null;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: options.repoId,
      path: `features/${featureId}`,
      state: options.state ?? 'queued',
      state_version: 1,
      round: options.round ?? 0,
      current_stage_index: options.currentStageIndex ?? 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: options.effectiveConfigJson ?? null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return featureId;
}

function apiFor(listFeatureViews: () => Promise<readonly FeatureView[]>) {
  return createApi({ apiToken: API_TOKEN, schemaVersion: 1, listFeatureViews });
}

describe('resolveStageCell', () => {
  it('renders state, one-based position, pipeline length, and the resolved name', () => {
    const cell = resolveStageCell({
      state: 'gating',
      current_stage_index: 1,
      effective_config_json: EFFECTIVE_CONFIG_JSON,
    });

    expect(cell.label).toBe('gating 2/4 (test)');
    expect(cell).toMatchObject({
      state: 'gating',
      position: 2,
      pipelineLength: 4,
      name: 'test',
    });
  });

  it('renders the state alone, with no position and no name, when there is no resolvable pipeline', () => {
    const cell = resolveStageCell({
      state: 'queued',
      current_stage_index: 0,
      effective_config_json: null,
    });

    expect(cell.label).toBe('queued');
    expect(cell.position).toBeUndefined();
    expect(cell.pipelineLength).toBeUndefined();
    expect(cell.name).toBeUndefined();
  });

  it('does not throw and never prints the literal "undefined" for a null effective_config_json', () => {
    const cell = resolveStageCell({
      state: 'discovered',
      current_stage_index: 0,
      effective_config_json: null,
    });

    expect(JSON.stringify(cell)).not.toContain('undefined');
  });
});

describe('GET /features', () => {
  it('returns every field the status view needs, spend included (OBS-05, M06 step 6.3)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        round: 2,
        effectiveConfigJson: EFFECTIVE_CONFIG_JSON,
      });

      async function listFeatureViews(): Promise<readonly FeatureView[]> {
        const rows = await db
          .selectFrom('features')
          .selectAll()
          .orderBy('id')
          .execute();
        const now = Date.now();
        return rows.map((row) => ({
          id: row.id,
          repoId: row.repo_id,
          path: row.path,
          state: row.state,
          stage: resolveStageCell(row),
          round: row.round,
          ageMs: now - Date.parse(row.updated_at),
          worker: null,
          staleRejections: 0,
          spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
        }));
      }

      const app = apiFor(listFeatureViews);
      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/features`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as Array<Record<string, unknown>>;
        expect(body).toHaveLength(1);
        const [row] = body;
        expect(row).toMatchObject({
          id: featureId,
          repoId,
          state: 'gating',
          round: 2,
          staleRejections: 0,
          spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
        });
        for (const field of [
          'id',
          'repoId',
          'path',
          'state',
          'stage',
          'round',
          'ageMs',
          'worker',
          'staleRejections',
          'spend',
        ]) {
          expect(row, `missing field ${field}`).toHaveProperty(field);
        }
      });
    });
  });

  it('never merges, dedupes, or collapses rows — two identical features produce two objects', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        round: 2,
        effectiveConfigJson: EFFECTIVE_CONFIG_JSON,
      });
      await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        round: 2,
        effectiveConfigJson: EFFECTIVE_CONFIG_JSON,
      });

      async function listFeatureViews(): Promise<readonly FeatureView[]> {
        const rows = await db
          .selectFrom('features')
          .selectAll()
          .orderBy('id')
          .execute();
        const now = Date.now();
        return rows.map((row) => ({
          id: row.id,
          repoId: row.repo_id,
          path: row.path,
          state: row.state,
          stage: resolveStageCell(row),
          round: row.round,
          ageMs: now - Date.parse(row.updated_at),
          worker: null,
          staleRejections: 0,
          spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
        }));
      }

      const app = apiFor(listFeatureViews);
      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/features`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        const body = (await response.json()) as unknown[];
        expect(body).toHaveLength(2);
      });
    });
  });

  it('orders by feature id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      // Seed out of id order isn't possible via ulid() (monotonic-ish), so
      // assert the response itself is sorted rather than relying on
      // insertion order.
      await seedFeature(db, { repoId });
      await seedFeature(db, { repoId });
      await seedFeature(db, { repoId });

      async function listFeatureViews(): Promise<readonly FeatureView[]> {
        const rows = await db
          .selectFrom('features')
          .selectAll()
          .orderBy('id')
          .execute();
        return rows.map((row) => ({
          id: row.id,
          repoId: row.repo_id,
          path: row.path,
          state: row.state,
          stage: resolveStageCell(row),
          round: row.round,
          ageMs: 0,
          worker: null,
          staleRejections: 0,
          spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
        }));
      }

      const app = apiFor(listFeatureViews);
      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/features`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        const body = (await response.json()) as Array<{ id: string }>;
        const ids = body.map((row) => row.id);
        expect(ids).toEqual([...ids].sort());
      });
    });
  });

  it('returns an empty array against zero features', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const app = apiFor(async () => []);

      await withEphemeralPort(app, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/features`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
      });
    });
  });

  it('produces byte-identical output across two calls with no intervening state change', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId });

      async function listFeatureViews(): Promise<readonly FeatureView[]> {
        const rows = await db
          .selectFrom('features')
          .selectAll()
          .orderBy('id')
          .execute();
        return rows.map((row) => ({
          id: row.id,
          repoId: row.repo_id,
          path: row.path,
          state: row.state,
          stage: resolveStageCell(row),
          round: row.round,
          ageMs: 1234,
          worker: null,
          staleRejections: 0,
          spend: { totalUsd: 0, unpricedEvents: 0, byRole: {} },
        }));
      }

      const app = apiFor(listFeatureViews);
      await withEphemeralPort(app, async ({ port }) => {
        const headers = { Authorization: `Bearer ${API_TOKEN}` };
        const first = await (
          await fetch(`http://127.0.0.1:${port}/features`, { headers })
        ).text();
        const second = await (
          await fetch(`http://127.0.0.1:${port}/features`, { headers })
        ).text();
        expect(first).toBe(second);
      });
    });
  });
});
