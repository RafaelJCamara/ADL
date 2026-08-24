import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';

import { startDaemon } from '../../src/daemon.js';
import { AdlYmlUnavailableError } from '../../src/config/resolve-adl-yml.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * M05 step 5.4 — `startDaemon`'s own wiring of the production `adl.yml`
 * gate. `test/config/resolve-adl-yml.test.ts` covers the read/parse/refuse
 * logic in isolation; this file proves `startDaemon` actually calls it
 * (refuses to boot, or boots and reaches a real dispatch), matching the
 * shape `test/boot/backend-preflight.test.ts` already established for the
 * sibling gate.
 */

const API_TOKEN = `test-token-${ulid()}`;
const FAKE_CLAUDE_SLOW_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-slow-success.mjs', import.meta.url),
);
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);

const VALID_ADL_YML = `
version: 1
commands:
  build: { argv: ["true"] }
  start: { argv: ["true"] }
  test: { argv: ["true"] }
  teardown: { argv: ["true"] }
pipeline: [develop]
limits:
  budget_usd: 7
`;

const INVALID_ADL_YML = `
version: 1
commands: {}
pipeline: [develop]
`;

function daemonConfigFixture(
  overrides: Partial<DaemonConfig> = {},
): DaemonConfig {
  return {
    limits: {},
    agents: {},
    lease_ttl_ms: 30_000,
    heartbeat_interval_ms: 10_000,
    worker_stop_grace_ms: 200,
    concurrency: { global: 1 },
    api: { host: '127.0.0.1', port: 0, token: API_TOKEN },
    gc: { interval_ms: 1_800_000 },
    poll: { interval_ms: 60_000 },
    repos: [],
    ...overrides,
  };
}

async function seedRepo(db: Kysely<Database>, id: string): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://example.invalid/repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedQueuedFeature(
  db: Kysely<Database>,
  repoId: string,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  await featuresRepository(db).insert({
    id: featureId,
    repo_id: repoId,
    path: `features/${featureId}`,
    state: 'queued',
    state_version: 1,
    round: 0,
    current_stage_index: 0,
    spec_hash: 'x',
    effective_config_json: null,
    workspace_handle: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    heartbeat_at: now,
    crash_count: 0,
    created_at: now,
    updated_at: now,
  });
  return featureId;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

describe('startDaemon — production adl.yml gate (05-04)', () => {
  it('refuses when mainRepo has no adl.yml at all — reason "unreadable"', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        let caught: unknown;
        try {
          await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: daemonConfigFixture(),
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AdlYmlUnavailableError);
        const err = caught as AdlYmlUnavailableError;
        expect(err.refusal.reason).toBe('unreadable');
      });
    });
  });

  it('refuses when adl.yml exists but fails schema validation — reason "invalid"', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        await writeFile(join(mainRepo, 'adl.yml'), INVALID_ADL_YML, 'utf8');

        await expect(
          startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: daemonConfigFixture(),
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
          }),
        ).rejects.toThrow(AdlYmlUnavailableError);
      });
    });
  });

  it('when the gate refuses, a pre-seeded queued feature stays queued and no worker was forked', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        const repoId = 'repo-1';
        await seedRepo(db, repoId);
        const featureId = await seedQueuedFeature(db, repoId);

        await expect(
          startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: daemonConfigFixture({
              repos: [
                {
                  id: repoId,
                  remote_url: 'https://example.invalid/repo.git',
                  default_branch: 'main',
                  forge: 'github',
                  features_dir: 'features',
                },
              ],
            }),
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
          }),
        ).rejects.toThrow(AdlYmlUnavailableError);

        // `startDaemon` throws before `createSupervisor` is even
        // constructed — the feature row is the observable proof.
        const row = await featuresRepository(db).findById(featureId);
        expect(row?.state).toBe('queued');
        expect(row?.lease_token).toBeNull();
      });
    });
  });

  it('when the gate refuses, no server is left listening on the requested port', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        const port = await freePort();

        await expect(
          startDaemon({
            dbFilePath: filePath,
            port,
            apiToken: API_TOKEN,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: daemonConfigFixture(),
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
          }),
        ).rejects.toThrow(AdlYmlUnavailableError);

        expect(await canBind(port)).toBe(true);
      });
    });
  });

  it('an explicit resolveAdlYml bypasses the gate entirely — boots with no adl.yml on disk', async () => {
    const ADL_YML_FIXTURE: AdlYml = AdlYmlSchema.parse({
      version: 1,
      commands: {
        build: { argv: ['true'] },
        start: { argv: ['true'] },
        test: { argv: ['true'] },
        teardown: { argv: ['true'] },
      },
      pipeline: ['develop'],
    });

    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        const handle = await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig: daemonConfigFixture(),
          resolveAdlYml: () => ADL_YML_FIXTURE,
          migrationsDir: MIGRATIONS_DIR,
          mainRepo,
          scratchRoot,
        });
        try {
          expect(handle.port).toBeGreaterThan(0);
        } finally {
          await handle.stop();
        }
      });
    });
  });

  it(
    'boots from a real adl.yml on mainRepo when none is supplied, and the resolved ' +
      'configuration reaches a real dispatch',
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          await writeFile(join(mainRepo, 'adl.yml'), VALID_ADL_YML, 'utf8');
          await git.add('adl.yml');
          await git.raw(['commit', '-m', 'add adl.yml']);

          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          const featureId = `gate-tracer-${ulid()}`;
          const featureDir = `features/${featureId}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nGate tracer\n\n## Acceptance Criteria\n\n- Works.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);

          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            repos: [
              {
                id: 'repo-1',
                remote_url: 'https://example.invalid/repo.git',
                default_branch: defaultBranch,
                forge: 'github',
                features_dir: 'features',
              },
            ],
          });

          const handle = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            migrationsDir: MIGRATIONS_DIR,
            leaseTtlMs: 10_000,
            heartbeatIntervalMs: 100,
            daemonConfig,
            // Deliberately no `resolveAdlYml` — the whole point of this test.
            mainRepo,
            scratchRoot,
            workerEntryPath: TRACER_WORKER_ENTRY,
            workerExecArgv: ['--import', 'tsx'],
            workerEnv: {
              ADL_TRACER_CLAUDE_BINARY_JSON: JSON.stringify([
                process.execPath,
                FAKE_CLAUDE_SLOW_SUCCESS,
              ]),
              ADL_TRACER_STAGE_DELAY_MS: '50',
            },
            dispatchIntervalMs: 20,
          });

          try {
            const devRunResponse = await fetch(
              `http://127.0.0.1:${handle.port}/dev-run/${featureId}`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${API_TOKEN}` },
              },
            );
            expect(devRunResponse.status).toBe(200);
            const devRunBody = (await devRunResponse.json()) as {
              featureId: string;
              stageAttemptId: string;
            };

            // The row `dispatchOnce` snapshotted `effective_config_json`
            // into carries the FILE's own distinctive value (budget_usd: 7,
            // below the 15 default so nothing clamps it) — not a
            // coincidence, not a fallback default.
            const row = await featuresRepository(db).findById(
              devRunBody.featureId,
            );
            expect(row?.effective_config_json).toBeTruthy();
            const effective = JSON.parse(
              row?.effective_config_json ?? '{}',
            ) as { limits: { budget_usd: number }; pipeline: string[] };
            expect(effective.limits.budget_usd).toBe(7);
            expect(effective.pipeline).toEqual(['develop']);

            // Let the scripted worker finish so no child is left running
            // when the daemon stops.
            await delay(300);
          } finally {
            await handle.stop();
          }
        });
      });
    },
    30_000,
  );
});
