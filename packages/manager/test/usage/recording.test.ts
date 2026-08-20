import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
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
  usageRepository,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import {
  createStaleRejectionCounter,
  createSupervisor,
  dispatchOnce,
  findAttempt,
  IPC_MESSAGE_KINDS,
  parseWorkerMessage,
  startDaemon,
  type ActiveWorker,
  type SpawnCall,
} from '../../src/index.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * Phase 4 Plan 10, Task 2: the worker reports one agent invocation's spend
 * over the existing IPC channel, the manager writes it through the existing
 * `usageRepository` — never a second insert path — fenced exactly like every
 * other lease-scoped kind, and never deduplicated.
 */

const API_TOKEN = `test-token-${ulid()}`;
const USAGE_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/usage-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);

const DAEMON_CONFIG: DaemonConfig = DaemonConfigSchema.parse({});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 15 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    await delay(intervalMs);
  }
}

async function seedRepo(db: Kysely<Database>): Promise<string> {
  const id = ulid();
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

async function seedQueuedFeature(
  db: Kysely<Database>,
  repoId: string,
): Promise<string> {
  const featureId = ulid();
  const now = nowIso();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'queued',
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
  return featureId;
}

// ---------------------------------------------------------------------------
// The IPC contract itself
// ---------------------------------------------------------------------------

describe('the usage IPC kind', () => {
  it('the frozen IPC kind list has exactly 8 entries and includes "usage"', () => {
    expect(IPC_MESSAGE_KINDS).toHaveLength(8);
    expect(IPC_MESSAGE_KINDS).toContain('usage');
  });

  it('a usage payload without the lease token fails validation with a named reason', () => {
    const result = parseWorkerMessage({
      t: 'usage',
      modelId: 'claude-sonnet-5',
      speed: 'standard',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.01,
      costSource: 'reported',
      costCategory: 'feature',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('leaseToken');
    }
  });

  it('a message with an extra featureId key is rejected outright — the schema has no field a worker could use to name a feature', () => {
    // T-4-38's mitigation is structural, not a runtime check: `usage_events`
    // identity comes from the supervisor's own assignment, never the
    // message, because the message schema (`.strictObject`) has no
    // `featureId` field to smuggle one through in the first place.
    const result = parseWorkerMessage({
      t: 'usage',
      leaseToken: 'tok-1',
      featureId: 'someone-elses-feature',
      modelId: 'claude-sonnet-5',
      speed: 'standard',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.01,
      costSource: 'reported',
      costCategory: 'feature',
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The supervisor: fence, insert, no dedup, no row for no usage
// ---------------------------------------------------------------------------

describe('createSupervisor — usage message handling', () => {
  async function dispatchAndSpawn(
    db: Kysely<Database>,
    opts: {
      readonly leaseTtlMs?: number;
      readonly scriptedMessages?: readonly Record<string, unknown>[];
      readonly recordUsage?: Parameters<
        typeof createSupervisor
      >[0]['recordUsage'];
    } = {},
  ): Promise<{
    readonly featureId: string;
    readonly leaseToken: string;
    readonly roundId: string;
    readonly stageAttemptId: string;
    readonly child: ActiveWorker['worker']['child'];
  }> {
    const repoId = await seedRepo(db);
    const featureId = await seedQueuedFeature(db, repoId);
    const { logger } = createCapturingLogger();

    const supervisor = createSupervisor({
      entryPath: USAGE_WORKER_ENTRY,
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      workerEnv: {
        ADL_TEST_USAGE_MESSAGES_JSON: JSON.stringify(
          opts.scriptedMessages ?? [],
        ),
        ADL_TEST_STAGE_DELAY_MS: '80',
      },
      logger,
      leaseTtlMs: opts.leaseTtlMs ?? 60_000,
      renewLease: (params) => featuresRepository(db).renewLease(params),
      getCurrentLeaseToken: async (id) => {
        const row = await featuresRepository(db).findById(id);
        return row?.lease_token ?? null;
      },
      staleRejectionCounter: createStaleRejectionCounter(),
      recordUsage: opts.recordUsage,
    });

    let call: SpawnCall | undefined;
    const decision = await dispatchOnce({
      db,
      leaseTtlMs: opts.leaseTtlMs ?? 60_000,
      heartbeatIntervalMs: 200,
      daemonConfig: DAEMON_CONFIG,
      resolveAdlYml: () =>
        AdlYmlSchema.parse({
          version: 1,
          commands: {
            build: { argv: ['true'] },
            start: { argv: ['true'] },
            test: { argv: ['true'] },
            teardown: { argv: ['true'] },
          },
          pipeline: ['develop'],
        }) as AdlYml,
      mainRepo: '/main/repo',
      scratchRoot: '/main/repo/.adl/scratch',
      spawnWorker: (c) => {
        call = c;
      },
    });
    expect(decision.dispatched).toBe(true);
    if (call === undefined) throw new Error('dispatchOnce did not spawn');

    const entry = supervisor.spawn(call.feature, call.leaseToken, call.assign);

    return {
      featureId,
      leaseToken: call.leaseToken,
      roundId: call.assign.roundId,
      stageAttemptId: call.assign.stageAttemptId,
      child: entry.worker.child,
    };
  }

  async function waitForExit(
    child: ActiveWorker['worker']['child'],
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  it("a fence-matched usage message inserts exactly one row through the existing repository, carrying the assignment's join keys", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { featureId, roundId, stageAttemptId, child } =
        await dispatchAndSpawn(db, {
          scriptedMessages: [
            {
              modelId: 'claude-sonnet-5',
              speed: 'standard',
              inputTokens: 100,
              outputTokens: 20,
              cacheCreationInputTokens: null,
              cacheReadInputTokens: null,
              costUsd: 0.05,
              costSource: 'reported',
              costCategory: 'feature',
            },
          ],
          recordUsage: (params) =>
            usageRepository(db).record({
              id: ulid(),
              feature_id: params.featureId,
              round_id: params.roundId,
              stage_attempt_id: params.stageAttemptId,
              model_id: params.modelId,
              speed: params.speed,
              input_tokens: params.inputTokens,
              output_tokens: params.outputTokens,
              cache_creation_input_tokens: params.cacheCreationInputTokens,
              cache_read_input_tokens: params.cacheReadInputTokens,
              cost_usd: params.costUsd,
              cost_source: params.costSource,
              cost_category: params.costCategory,
              at: nowIso(),
            }),
        });

      await waitForExit(child);
      await waitUntil(async () => {
        const rows = await usageRepository(db).listForFeature(featureId);
        return rows.length >= 1;
      });

      const rows = await usageRepository(db).listForFeature(featureId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.round_id).toBe(roundId);
      expect(rows[0]?.stage_attempt_id).toBe(stageAttemptId);
      expect(rows[0]?.feature_id).toBe(featureId);
      expect(rows[0]?.cost_source).toBe('reported');
      expect(rows[0]?.input_tokens).toBe(100);
      expect(rows[0]?.cache_read_input_tokens).toBeNull();
    });
  }, 20_000);

  it('a usage message carrying a superseded lease token is dropped — no row is inserted', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      let recorded = 0;
      const { featureId, leaseToken, child } = await dispatchAndSpawn(db, {
        scriptedMessages: [
          {
            leaseToken: 'a-completely-different-and-stale-token',
            modelId: 'claude-sonnet-5',
            speed: 'standard',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            costUsd: 0.01,
            costSource: 'reported',
            costCategory: 'feature',
          },
        ],
        recordUsage: async () => {
          recorded += 1;
        },
      });
      void leaseToken;

      await waitForExit(child);
      // Give the async fence check inside the supervisor's message handler
      // a moment to run and (correctly) do nothing.
      await delay(200);

      expect(recorded).toBe(0);
      const rows = await usageRepository(db).listForFeature(featureId);
      expect(rows).toHaveLength(0);
    });
  }, 20_000);

  it('two usage messages for one attempt insert two rows — the manager does not deduplicate', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const scriptedOne = {
        modelId: 'claude-sonnet-5',
        speed: 'standard',
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: 0.01,
        costSource: 'reported',
        costCategory: 'feature',
      };
      const scriptedTwo = {
        ...scriptedOne,
        inputTokens: 20,
        costUsd: 0.02,
        costCategory: 'overhead',
      };
      const { featureId, child } = await dispatchAndSpawn(db, {
        scriptedMessages: [scriptedOne, scriptedTwo],
        recordUsage: (params) =>
          usageRepository(db).record({
            id: ulid(),
            feature_id: params.featureId,
            round_id: params.roundId,
            stage_attempt_id: params.stageAttemptId,
            model_id: params.modelId,
            speed: params.speed,
            input_tokens: params.inputTokens,
            output_tokens: params.outputTokens,
            cache_creation_input_tokens: params.cacheCreationInputTokens,
            cache_read_input_tokens: params.cacheReadInputTokens,
            cost_usd: params.costUsd,
            cost_source: params.costSource,
            cost_category: params.costCategory,
            at: nowIso(),
          }),
      });

      await waitForExit(child);
      await waitUntil(async () => {
        const rows = await usageRepository(db).listForFeature(featureId);
        return rows.length >= 2;
      });

      const rows = await usageRepository(db).listForFeature(featureId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.cost_category).sort()).toEqual(
        ['feature', 'overhead'].sort(),
      );
    });
  }, 20_000);

  it('an invocation whose backend reported no usage at all inserts no row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      let recorded = 0;
      const { featureId, child } = await dispatchAndSpawn(db, {
        scriptedMessages: [],
        recordUsage: async () => {
          recorded += 1;
        },
      });

      await waitForExit(child);
      await delay(150);

      expect(recorded).toBe(0);
      const rows = await usageRepository(db).listForFeature(featureId);
      expect(rows).toHaveLength(0);
    });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The worker entry's own module graph still contains no database import
// ---------------------------------------------------------------------------

describe('worker-entry stays database-free', () => {
  it('stage-runner.ts and usage-worker-entry.ts import no @adl/db', async () => {
    const stageRunnerPath = fileURLToPath(
      new URL('../../src/worker-entry/stage-runner.ts', import.meta.url),
    );
    const stageRunnerSource = await readFile(stageRunnerPath, 'utf8');
    expect(stageRunnerSource).not.toContain("'@adl/db'");

    const usageWorkerEntrySource = await readFile(USAGE_WORKER_ENTRY, 'utf8');
    expect(usageWorkerEntrySource).not.toContain("'@adl/db'");
  });
});

// ---------------------------------------------------------------------------
// End to end: a real dev-run through the replay double produces one row
// ---------------------------------------------------------------------------

describe('a full dev-run against the replay double', () => {
  it('exactly one usage row exists for the feature, joined to the attempt the run opened', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureId = `usage-recording-${ulid()}`;
        const featureDir = `features/${featureId}`;
        await mkdir(join(mainRepo, featureDir), { recursive: true });
        await writeFile(
          join(mainRepo, featureDir, 'spec.md'),
          '# Title\n\nRecord usage\n\n## Acceptance Criteria\n\n- Usage is recorded.\n',
          'utf8',
        );
        await git.add(`${featureDir}/spec.md`);
        await git.raw(['commit', '-m', 'add feature']);

        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

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
        const adlYml: AdlYml = AdlYmlSchema.parse({
          version: 1,
          commands: {
            build: { argv: ['true'] },
            start: { argv: ['true'] },
            test: { argv: ['true'] },
            teardown: { argv: ['true'] },
          },
          pipeline: ['develop'],
        });

        const handle = await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          migrationsDir: MIGRATIONS_DIR,
          leaseTtlMs: 10_000,
          heartbeatIntervalMs: 100,
          daemonConfig,
          resolveAdlYml: () => adlYml,
          mainRepo,
          scratchRoot,
          workerEntryPath: TRACER_WORKER_ENTRY,
          workerExecArgv: ['--import', 'tsx'],
          workerEnv: {
            ADL_TRACER_CLAUDE_BINARY_JSON: JSON.stringify([
              process.execPath,
              FAKE_CLAUDE_SUCCESS,
            ]),
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

          const address = await (async () => {
            const deadline = Date.now() + 5000;
            for (;;) {
              const a = await findAttempt(db, devRunBody.stageAttemptId);
              if (a !== undefined) return a;
              if (Date.now() >= deadline) {
                throw new Error('attempt never resolved');
              }
              await delay(15);
            }
          })();

          await waitUntil(
            async () => {
              const rows = await usageRepository(db).listForFeature(
                devRunBody.featureId,
              );
              return rows.length >= 1;
            },
            { timeoutMs: 10_000 },
          );

          const rows = await usageRepository(db).listForFeature(
            devRunBody.featureId,
          );
          expect(rows).toHaveLength(1);
          const row = rows[0]!;
          expect(row.round_id).toBe(address.roundId);
          expect(row.stage_attempt_id).toBe(devRunBody.stageAttemptId);
          expect(row.cost_source).toBe('reported');
          expect(row.cost_usd).toBe(0.001);
          expect(row.input_tokens).toBe(10);
          expect(row.output_tokens).toBe(5);
          // fake-claude-success.mjs's usage object omits the cache
          // fields — proving null-not-zero against a real run, not only
          // a unit fixture.
          expect(row.cache_creation_input_tokens).toBeNull();
          expect(row.cache_read_input_tokens).toBeNull();
        } finally {
          await handle.stop();
        }
      });
    });
  }, 30_000);
});
