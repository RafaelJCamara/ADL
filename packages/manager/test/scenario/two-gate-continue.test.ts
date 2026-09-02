import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { featuresRepository, migrateToLatest } from '@adl/db';
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
 * Two gates in one pipeline (HARN-02/03, M07 steps 7.2 and 7.3).
 *
 * This is the end-to-end proof 7.2 could not write. `on_send_back: continue`
 * only changes anything when a gate that is **not last** sends back, and until
 * 7.3 this build had exactly one gate implementation — `resolvePipeline`
 * refuses a duplicate stage id, so a two-gate pipeline was unbuildable. A
 * plain-command gate carries its own program, so two of them can coexist, and
 * the property finally has somewhere to be observed.
 *
 * Every layer is production, matching `command-gate-loop.test.ts`'s precedent:
 * a real `startDaemon`, the real dispatcher, real forked workers, the real
 * `createProductionStageRunner`, with only the `claude` binary replaced.
 *
 * **What is asserted, and why each half matters:**
 *
 * 1. **The second gate ran at all.** With `stop` — v1's behaviour and still the
 *    default — the pipeline would have ended at the first gate and the second
 *    marker file would not exist. Its existence is the whole of `continue`.
 * 2. **Both gates ran inside ONE round.** Under `stop`, round 1 has attempts
 *    at index 0 and 1 only, and the second gate does not run until round 2 —
 *    after the developer has already spent a round fixing the first without
 *    ever being told what the second thinks. That saved round is the benefit
 *    the policy exists to deliver.
 * 3. **Neither gate's findings were dropped.** `continue` changes *when* the
 *    round is decided, never *what* it decides on.
 *
 * Note what is deliberately NOT asserted: that the feature stops at one round.
 * A `send_back` sends the developer back — that is what it means — so a second
 * round opening is correct, and an assertion against it would be asserting the
 * loop is broken.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 25 } = {},
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

describe('scenario: a continue gate lets the next gate run, and both findings land in one round', () => {
  it(
    'runs both gates inside one round, and keeps both verdicts',
    { timeout: 180_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `two-gate-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nA feature.\n\n## Acceptance Criteria\n\n- It builds.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          // Outside the worktree, so a workspace teardown cannot take the
          // evidence with it — `protected-paths-loop.test.ts`'s own pattern.
          const secondGateMarker = join(scratchRoot, '..', 'second-gate-ran');

          // Gate 1 fails and says "carry on". Gate 2 records that it ran, then
          // fails too. Both are plain-command gates carrying their own argv:
          // no built-in id, no registry entry, no loader (HARN-02).
          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            pipeline: [
              'develop',
              {
                harness: 'lint',
                with: {
                  command: {
                    argv: [process.execPath, '-e', 'process.exit(3)'],
                  },
                },
                on_send_back: 'continue',
              },
              {
                harness: 'audit',
                with: {
                  command: {
                    argv: [
                      process.execPath,
                      '-e',
                      `require('node:fs').writeFileSync(${JSON.stringify(secondGateMarker)}, 'ran'); process.exit(4)`,
                    ],
                  },
                },
              },
            ],
          });

          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            // Low, so the run settles quickly: the send-back this produces
            // starts a second round (that is what a send-back IS), and there
            // is nothing further to observe once round 1 has closed.
            limits: { max_rounds: 2 },
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
            leaseTtlMs: 60_000,
            heartbeatIntervalMs: 500,
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
            const response = await fetch(
              `http://127.0.0.1:${handle.port}/dev-run/${folder}`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${API_TOKEN}` },
              },
            );
            expect(response.status).toBe(200);
            const { featureId } = (await response.json()) as {
              featureId: string;
            };

            await waitUntil(async () => {
              const rounds = await db
                .selectFrom('rounds')
                .selectAll()
                .where('feature_id', '=', featureId)
                .execute();
              return rounds.some((round) => round.ended_at !== null);
            });

            // ── 1. The second gate ran ─────────────────────────────────
            // Under `stop` the pipeline ends at `lint` and this file never
            // exists. This assertion IS the policy.
            await expect(readFile(secondGateMarker, 'utf8')).resolves.toBe(
              'ran',
            );

            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();

            const first = rounds[0]!;
            expect(first.outcome).toBe('send_back');

            // ── 2. BOTH gates ran inside that ONE round ────────────────
            // This is the assertion the whole file exists for. Under `stop`,
            // round 1 has attempts at index 0 and 1 only, and `audit` does not
            // run until round 2 — after the developer has already spent a
            // round fixing `lint` without ever being told what `audit` thinks.
            const attempts = await db
              .selectFrom('stage_attempts')
              .selectAll()
              .where('round_id', '=', first.id)
              .orderBy('stage_index')
              .execute();
            expect(attempts.map((attempt) => attempt.stage_index)).toEqual([
              0, 1, 2,
            ]);

            // ── 3. Neither gate's findings were dropped ────────────────
            // `continue` changes WHEN the round is decided, never WHAT it
            // decides on. A policy that let the second gate run and then threw
            // the first's verdict away would satisfy the assertion above and
            // lose half the developer's work list.
            // Joined through `stage_attempt_id` — `verdicts` has no round of
            // its own, because a verdict belongs to the attempt that produced
            // it and the attempt is what belongs to a round.
            const verdicts = await db
              .selectFrom('verdicts')
              .selectAll()
              .where(
                'stage_attempt_id',
                'in',
                attempts.map((attempt) => attempt.id),
              )
              .execute();
            expect(verdicts).toHaveLength(2);
            expect(verdicts.every((v) => v.outcome === 'send_back')).toBe(true);

            // ── 4. The audit trail is honest about which gate did what ──
            // `lint` raised blockers and the pipeline continued, so it must
            // appear as `gate_deferred` and never as `gate_passed` (7.2).
            const events = await db
              .selectFrom('feature_events')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('seq')
              .execute();
            const kinds = events.map(
              (row) => (JSON.parse(row.event_json) as { t: string }).t,
            );
            expect(kinds).toContain('gate_deferred');
            expect(kinds).not.toContain('gate_passed');

            const row = await featuresRepository(db).findById(featureId);
            expect(row).not.toBeNull();
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
