import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateToLatest, nowIso } from '@adl/db';
import { createApi } from '../../../src/api/app.js';
import type { DispatchDecision } from '../../../src/scheduler/dispatcher.js';
import { withEphemeralPort } from '../../helpers/ephemeral-port.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../../db/test/helpers/temp-db.js';

/**
 * `POST /dev-run/:featureId` — unit-level coverage against a temp database
 * and a temp `mainRepo` directory (never a real workspace/worker; that is
 * the tracer test's job). `dispatchOnce` is a controllable stub so these
 * cases can assert the route's own request-handling logic — 404/400/409
 * mapping, the bridge to whatever `dispatchOnce` decides — independently of
 * the scheduler's own behaviour, which `test/scheduler/dispatcher.test.ts`
 * already covers.
 */

const API_TOKEN = 'test-token-dev-run';

async function withTempMainRepo<T>(
  fn: (mainRepo: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-devrun-mainrepo-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSpec(mainRepo: string, featureId: string): Promise<void> {
  const dir = join(mainRepo, 'features', featureId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'spec.md'),
    '# Title\n\nExport widgets\n\n## Acceptance Criteria\n\n- It exports.\n',
    'utf8',
  );
}

describe('POST /dev-run/:featureId', () => {
  it('for a folder with no spec.md/*.feature responds 404 and calls dispatchOnce zero times', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempMainRepo(async (mainRepo) => {
        let calls = 0;
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          mainRepo,
          dispatchOnce: async () => {
            calls += 1;
            return { dispatched: false };
          },
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/dev-run/missing-feature`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(404);
        });
        expect(calls).toBe(0);
      });
    });
  });

  it('for a spec that fails to load responds 400 naming the load error', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempMainRepo(async (mainRepo) => {
        const featureId = 'broken-feature';
        const dir = join(mainRepo, 'features', featureId);
        await mkdir(dir, { recursive: true });
        // No "## Acceptance Criteria" heading — a structural LoadError.
        await writeFile(
          join(dir, 'spec.md'),
          '# Title\n\nno criteria here\n',
          'utf8',
        );

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          mainRepo,
          dispatchOnce: async () => ({ dispatched: false }),
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/dev-run/${featureId}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(400);
          const body = (await response.json()) as { error: string };
          expect(body.error).toContain('Acceptance Criteria');
        });
      });
    });
  });

  it('without a bearer token responds 401', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempMainRepo(async (mainRepo) => {
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          mainRepo,
          dispatchOnce: async () => ({ dispatched: false }),
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/dev-run/any-id`,
            {
              method: 'POST',
            },
          );
          expect(response.status).toBe(401);
        });
      });
    });
  });

  it('for a valid feature that dispatches, upserts the row and responds with the feature id and stage attempt id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempMainRepo(async (mainRepo) => {
        const featureId = 'export-widgets';
        await writeSpec(mainRepo, featureId);

        await db
          .insertInto('repos')
          .values({
            id: 'repo-1',
            remote_url: 'https://example.invalid/repo.git',
            default_branch: 'main',
            forge: 'github',
            features_dir: 'features',
            created_at: nowIso(),
            updated_at: nowIso(),
          })
          .execute();

        // A real dispatchOnce dispatches by the row's own ULID primary key,
        // not the human-readable `features/<id>` folder name the route
        // received on the URL — the stub reflects that by reading the row
        // this route JUST inserted back out, matching the row lookup the
        // route itself performs before calling dispatchOnce.
        const dispatchOnce = async (): Promise<DispatchDecision> => {
          const row = await db
            .selectFrom('features')
            .selectAll()
            .where('path', '=', `features/${featureId}`)
            .executeTakeFirst();
          if (row === undefined) return { dispatched: false };
          return {
            dispatched: true,
            featureId: row.id,
            leaseToken: 'lease-1',
            stageAttemptId: 'attempt-1',
          };
        };

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          mainRepo,
          dispatchOnce,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/dev-run/${featureId}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            featureId: string;
            stageAttemptId: string;
          };
          expect(body.featureId).toMatch(/^[0-9A-Z]{26}$/); // ULID shape — the row's own id
          expect(body.stageAttemptId).toBe('attempt-1');
        });

        const row = await db
          .selectFrom('features')
          .selectAll()
          .where('path', '=', `features/${featureId}`)
          .executeTakeFirst();
        expect(row).toBeDefined();
        expect(row?.state).toBe('queued');
      });
    });
  });

  it('when dispatchOnce cannot proceed responds 409', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempMainRepo(async (mainRepo) => {
        const featureId = 'export-widgets-2';
        await writeSpec(mainRepo, featureId);
        await db
          .insertInto('repos')
          .values({
            id: 'repo-2',
            remote_url: 'https://example.invalid/repo2.git',
            default_branch: 'main',
            forge: 'github',
            features_dir: 'features',
            created_at: nowIso(),
            updated_at: nowIso(),
          })
          .execute();

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          mainRepo,
          dispatchOnce: async () => ({ dispatched: false }),
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/dev-run/${featureId}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(409);
        });
      });
    });
  });
});
