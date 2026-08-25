import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { featuresRepository, migrateToLatest, type Database } from '@adl/db';
import type { Kysely } from 'kysely';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { startDaemon } from '../../src/index.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The round loop, turning, through a real daemon (LOOP-01, M05 step 5.13).
 *
 * Every part of this is production: a real `startDaemon`, the real HTTP
 * `dev-run` route, the real dispatcher, real forked worker processes — one per
 * stage — the real supervisor, and the real round loop deciding what happens
 * between them. The only double is the *stage runner inside the worker*
 * (`scripted-pipeline-worker-entry.ts`), because the agent it would otherwise
 * call is billed and the gate it would otherwise run is M05 step 5.14.
 *
 * Two properties, and the second is the one the milestone turns on:
 *
 * 1. **A pipeline runs to the end and a green round reaches `publishing`** —
 *    the first time anything in this project has produced an aggregate "every
 *    gate passed" verdict, which is what FORGE-05's promote-to-ready has been
 *    waiting for since step 5.9 built it.
 * 2. **A failing gate sends the developer back, and the next round runs** —
 *    `.planning`'s standing rule, restated in M05's AC2: *the loop is not
 *    considered proven by a feature that passes first try.* The feature must
 *    come back to `developing`, spend a round, run the developer a second
 *    time, and then pass.
 */

const API_TOKEN = `test-token-${ulid()}`;
const PIPELINE_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/scripted-pipeline-worker-entry.ts', import.meta.url),
);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${String(timeoutMs)}ms`,
      );
    }
    await delay(intervalMs);
  }
}

/** `develop` plus one built-in gate — the shortest pipeline that has a gate at all. */
const ADL_YML: AdlYml = AdlYmlSchema.parse({
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
  pipeline: ['develop', 'test'],
});

interface RunOptions {
  /** One entry per gate invocation, consumed in order across rounds. */
  readonly gateOutcomes: string;
  readonly assert: (ctx: {
    readonly db: Kysely<Database>;
    readonly featureId: string;
    readonly waitUntil: typeof waitUntil;
  }) => Promise<void>;
}

async function runLoop(options: RunOptions): Promise<void> {
  await withTempDb(async ({ db, filePath }) => {
    await migrateToLatest(db, MIGRATIONS_DIR);

    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `round-loop-${ulid()}`;
      const featureDir = `features/${featureId}`;
      await mkdir(join(mainRepo, featureDir), { recursive: true });
      await writeFile(
        join(mainRepo, featureDir, 'spec.md'),
        '# Title\n\nRun the loop\n\n## Acceptance Criteria\n\n- The loop turns.\n',
        'utf8',
      );
      await git.add(`${featureDir}/spec.md`);
      await git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await git.raw(['branch', '--show-current'])
      ).trim();

      const counterPath = join(scratchRoot, 'gate-cursor');
      await writeFile(counterPath, '0', 'utf8');

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
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 500,
        daemonConfig,
        resolveAdlYml: () => ADL_YML,
        mainRepo,
        scratchRoot,
        workerEntryPath: PIPELINE_WORKER_ENTRY,
        workerExecArgv: ['--import', 'tsx'],
        workerEnv: {
          ADL_TEST_GATE_OUTCOMES: options.gateOutcomes,
          ADL_TEST_GATE_COUNTER: counterPath,
        },
        dispatchIntervalMs: 20,
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${handle.port}/dev-run/${featureId}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${API_TOKEN}` },
          },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { featureId: string };

        await options.assert({ db, featureId: body.featureId, waitUntil });

        // The scripted gate really was consulted — without this, a loop that
        // silently skipped every gate would satisfy the assertions above by
        // never running one.
        expect(Number(await readFile(counterPath, 'utf8'))).toBeGreaterThan(0);
      } finally {
        await handle.stop();
      }
    });
  });
}

describe('scenario: the round loop turns', () => {
  it(
    'runs develop -> gate -> green, closing the round and reaching publishing',
    { timeout: 60_000 },
    async () => {
      await runLoop({
        gateOutcomes: 'pass',
        assert: async ({ db, featureId, waitUntil: until }) => {
          await until(async () => {
            const row = await featuresRepository(db).findById(featureId);
            return row?.state === 'publishing';
          });

          const row = (await featuresRepository(db).findById(featureId))!;
          // No forge is configured here, so nothing is promoted — the round
          // still completed and the lifecycle still reached the hand-off.
          expect(row.state).toBe('publishing');
          expect(row.lease_token).toBeNull();

          const rounds = await db
            .selectFrom('rounds')
            .selectAll()
            .where('feature_id', '=', featureId)
            .orderBy('number')
            .execute();
          expect(rounds).toHaveLength(1);
          expect(rounds[0]?.outcome).toBe('green');
          expect(JSON.parse(rounds[0]!.outcome_json!)).toEqual({
            kind: 'green',
          });

          // Two stage attempts in that one round: the developer, then the
          // gate — which is the whole claim "the pipeline ran".
          const attempts = await db
            .selectFrom('stage_attempts')
            .selectAll()
            .where('round_id', '=', rounds[0]!.id)
            .orderBy('stage_index')
            .execute();
          expect(attempts.map((a) => a.stage_id)).toEqual(['develop', 'test']);
        },
      });
    },
  );

  it(
    'sends the developer back on a failing gate and passes on the next round (AC2)',
    { timeout: 60_000 },
    async () => {
      await runLoop({
        // Round 1's gate objects; round 2's is satisfied. A feature that
        // passed first try would prove nothing about the loop.
        gateOutcomes: 'send_back,pass',
        assert: async ({ db, featureId, waitUntil: until }) => {
          await until(async () => {
            const row = await featuresRepository(db).findById(featureId);
            return row?.state === 'publishing';
          });

          const rounds = await db
            .selectFrom('rounds')
            .selectAll()
            .where('feature_id', '=', featureId)
            .orderBy('number')
            .execute();
          expect(rounds).toHaveLength(2);
          expect(rounds.map((round) => round.outcome)).toEqual([
            'send_back',
            'green',
          ]);
          // The brief the send-back carried is durable, in the column the
          // sticky comment re-derives a prior round from.
          expect(JSON.parse(rounds[0]!.outcome_json!)).toMatchObject({
            kind: 'send_back',
            brief: { findings: [{ severity: 'blocker' }] },
          });

          // The developer really ran a second time — the send-back's whole
          // point. Round 2 has its own developer attempt, not a re-used one.
          const attempts = await db
            .selectFrom('stage_attempts')
            .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
            .select([
              'rounds.number as round',
              'stage_attempts.stage_id as stageId',
            ])
            .where('rounds.feature_id', '=', featureId)
            .orderBy('rounds.number')
            .orderBy('stage_attempts.stage_index')
            .execute();
          expect(attempts).toEqual([
            { round: 1, stageId: 'develop' },
            { round: 1, stageId: 'test' },
            { round: 2, stageId: 'develop' },
            { round: 2, stageId: 'test' },
          ]);

          const row = (await featuresRepository(db).findById(featureId))!;
          // The send-back is the one thing that costs a round (CORE-01).
          expect(row.round).toBe(1);
        },
      });
    },
  );
});
