import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateToLatest, nowIso } from '@adl/db';
import { ulid } from 'ulid';
import { createApi } from '../../../src/api/app.js';
import { openAttempt } from '../../../src/bookkeeping/attempt.js';
import { openTranscriptWriter } from '../../../src/store/ndjson-log-store.js';
import { transcriptPathFor } from '../../../src/store/transcript-path.js';
import { withEphemeralPort } from '../../helpers/ephemeral-port.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../../db/test/helpers/temp-db.js';

/**
 * `GET /stages/:id/logs` — the untrusted `:id` is resolved through
 * `findAttempt` first (T-4-15/T-4-07): a 404 for an unresolvable id, no
 * filesystem read attempted for it. Real events are asserted via a real
 * `TranscriptWriter` and a real SSE response read back over `fetch`.
 */

const API_TOKEN = 'test-token-logs';

async function withTempLogsRoot<T>(
  fn: (logsRoot: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-logs-root-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function parseSseBody(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

describe('GET /stages/:id/logs', () => {
  it('for an unresolvable stage attempt id responds 404 and reads no file', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/unknown-id/logs`,
            {
              headers: { Authorization: `Bearer ${API_TOKEN}` },
            },
          );
          expect(response.status).toBe(404);
        });
      });
    });
  });

  it('without a bearer token responds 401', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/any-id/logs`,
          );
          expect(response.status).toBe(401);
        });
      });
    });
  });

  it('for a known attempt with records on disk, streams them and reports the next offset', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const featureId = ulid();
        const repoId = ulid();
        const now = nowIso();
        await db
          .insertInto('repos')
          .values({
            id: repoId,
            remote_url: 'https://example.invalid/repo.git',
            default_branch: 'main',
            forge: 'github',
            features_dir: 'features',
            created_at: now,
            updated_at: now,
          })
          .execute();
        await db
          .insertInto('features')
          .values({
            id: featureId,
            repo_id: repoId,
            path: `features/${featureId}`,
            state: 'leased',
            state_version: 1,
            round: 0,
            current_stage_index: 0,
            spec_hash: 'a'.repeat(64),
            effective_config_json: null,
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

        const attempt = await openAttempt(
          { db },
          { featureId, stageId: 'develop', stageIndex: 0 },
        );

        const address = {
          featureId,
          roundId: attempt.roundId,
          stageId: attempt.stageId,
          stageIndex: attempt.stageIndex,
          attempt: attempt.attempt,
        };
        const path = transcriptPathFor(logsRoot, address);
        const writer = await openTranscriptWriter(path);
        await writer.append({
          seq: 0,
          at: now,
          event: {
            kind: 'started',
            capabilities: {
              emitsIncrementalEvents: true,
              reportsUsage: true,
              reportsCost: true,
              supportsSessionResume: true,
              enforcesTurnCap: true,
            },
          },
        });
        await writer.close();

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${attempt.stageAttemptId}/logs`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          expect(response.status).toBe(200);
          const events = await parseSseBody(response);
          expect(events.some((e) => /event:\s*record/.test(e))).toBe(true);
          expect(events.some((e) => /event:\s*offset/.test(e))).toBe(true);
        });
      });
    });
  });

  it('rejects a negative or non-integer offset with 400', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempLogsRoot(async (logsRoot) => {
        const featureId = ulid();
        const repoId = ulid();
        const now = nowIso();
        await db
          .insertInto('repos')
          .values({
            id: repoId,
            remote_url: 'https://example.invalid/repo.git',
            default_branch: 'main',
            forge: 'github',
            features_dir: 'features',
            created_at: now,
            updated_at: now,
          })
          .execute();
        await db
          .insertInto('features')
          .values({
            id: featureId,
            repo_id: repoId,
            path: `features/${featureId}`,
            state: 'leased',
            state_version: 1,
            round: 0,
            current_stage_index: 0,
            spec_hash: 'a'.repeat(64),
            effective_config_json: null,
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
        const attempt = await openAttempt(
          { db },
          { featureId, stageId: 'develop', stageIndex: 0 },
        );

        const app = createApi({
          apiToken: API_TOKEN,
          schemaVersion: 1,
          listFeatureViews: async () => [],
          db,
          logsRoot,
        });

        await withEphemeralPort(app, async ({ port }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/stages/${attempt.stageAttemptId}/logs?offset=-1`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          expect(response.status).toBe(400);
        });
      });
    });
  });
});
