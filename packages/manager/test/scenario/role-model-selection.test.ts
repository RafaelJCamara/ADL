import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { featuresRepository, migrateToLatest, usageRepository } from '@adl/db';
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
 * BACK-10 end to end (M06 step 6.10): the configured model reaches the agent
 * CLI, and the ledger prices what actually ran.
 *
 * `protected-paths-loop.test.ts` and `command-gate-loop.test.ts` are this
 * file's precedents and every layer here matches them — a real `startDaemon`,
 * the real dispatcher, real forked workers, the real
 * `createProductionStageRunner` — with only the `claude` binary replaced by
 * `fake-claude-success.mjs` through the existing `tracer-worker-entry.ts`
 * seam.
 *
 * **Why this needs a real daemon and not another unit test.** The unit tests
 * in `test/worker-entry/stage-runner.test.ts` prove the `AgentTask` carries
 * the right model, and `packages/agent-claude-code/test/argv.test.ts` proves
 * `--model` is emitted for a task that carries one. Neither proves the two
 * are connected to each other through `mergeConfig`, the effective-config
 * snapshot on the assign message, the fork, and a real exec — and that chain
 * is precisely what was broken before 6.9: every layer had a test, and
 * configuring a model still selected nothing.
 *
 * So the double records its own argv (see its header) and echoes the model it
 * was given, exactly as the real CLI does. The assertion is a closed loop:
 * daemon config -> argv on a real process -> reported model -> a
 * `usage_events` row `model_prices` can actually price. A break anywhere
 * along it shows up as an unpriced row, which is the accounting defect this
 * step owns.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);

/**
 * A model that is NOT the double's own fallback and IS in the seeded price
 * table. Both halves matter: if it were the fallback, the run would look
 * identical whether or not `--model` arrived; if it were unpriced, the
 * pricing assertion below could not tell a working selection path from a
 * broken one.
 */
const SELECTED_MODEL = 'claude-haiku-4-5';

/**
 * What the repository asks for in the 6.11 case below — distinct from
 * {@link SELECTED_MODEL}, which is what the daemon would otherwise have
 * chosen, so "the repo's request won" and "nothing happened" cannot look
 * alike. Also priceable, for the same reason.
 */
const REPO_REQUESTED_MODEL = 'claude-sonnet-5';

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 40_000, intervalMs = 25 } = {},
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

describe('scenario: the model configured for a role reaches the agent CLI and prices the ledger (BACK-10)', () => {
  it(
    'puts --model on the real argv, and records a priceable usage row for it',
    { timeout: 120_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `role-model-${ulid()}`;
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

          // Outside the worktree the double runs in, so a workspace teardown
          // cannot take the evidence with it. Same shape as
          // `protected-paths-loop.test.ts`'s own marker file.
          const argvLog = join(scratchRoot, '..', 'claude-argv.log');

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

          // All three roles named, all three different — the developer's is
          // the only one this dispatch may use. `reviewer` and `tester` have
          // no producer until M07/M08, so their presence here is not a second
          // dispatch: it is the negative control for the role index.
          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            agents: {
              developer: { backend: 'claude-code', model: SELECTED_MODEL },
              reviewer: { backend: 'claude-code', model: 'claude-opus-5' },
              tester: { backend: 'claude-code', model: 'claude-sonnet-5' },
            },
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
                '--adl-argv-log',
                argvLog,
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
              const rows = await usageRepository(db).listForFeature(featureId);
              return rows.length > 0;
            });

            // -- 1. The model reached the real process --------------------
            const argvLines = (await readFile(argvLog, 'utf8'))
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as string[]);
            expect(argvLines.length).toBeGreaterThan(0);

            const argv = argvLines[0]!;
            const modelFlag = argv.indexOf('--model');
            expect(modelFlag).toBeGreaterThanOrEqual(0);
            expect(argv[modelFlag + 1]).toBe(SELECTED_MODEL);
            // The other two roles' models were configured and must not be on
            // a developer dispatch's command line at all.
            expect(argv).not.toContain('claude-opus-5');
            expect(argv).not.toContain('claude-sonnet-5');

            // -- 2. The ledger priced what actually ran -------------------
            const usage = await usageRepository(db).listForFeature(featureId);
            expect(usage).toHaveLength(1);
            expect(usage[0]?.model_id).toBe(SELECTED_MODEL);
            // Not the "we could not resolve a model" placeholder, which is
            // what a run whose selection never arrived would leave behind.
            expect(usage[0]?.model_id).not.toBe('unknown-model');

            // And the id it recorded is one `model_prices` can actually
            // price — the property that keeps this spend inside 6.4's
            // per-feature budget and 6.5's global cap instead of being
            // silently excluded by D-31.
            const price = await usageRepository(db).priceAt({
              modelId: usage[0]!.model_id,
              speed: usage[0]!.speed,
              at: usage[0]!.at,
            });
            expect(price).toBeDefined();

            const row = await featuresRepository(db).findById(featureId);
            expect(row).not.toBeNull();
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );

  /**
   * The D-22 amendment, end to end (M06 step 6.11).
   *
   * `packages/core/test/config/effective-config.test.ts` proves `mergeConfig`
   * honours an allowlisted model. This proves the honoured value survives the
   * effective-config snapshot, the fork, and the exec — which is the same
   * chain 6.9 found broken with every individual layer green.
   */
  it(
    'lets a repository request an allowlisted model, and that model reaches the CLI',
    { timeout: 120_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `repo-model-${ulid()}`;
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

          const argvLog = join(scratchRoot, '..', 'claude-argv-repo.log');

          // The repository asks for a model. Note it names no `backend` —
          // which it could not have done before 6.11 made both fields
          // optional, and which is the point: requesting a permitted thing
          // must not require also requesting a forbidden one.
          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            pipeline: ['develop'],
            agents: { developer: { model: REPO_REQUESTED_MODEL } },
          });

          // The daemon's own choice for this role is something else, so a
          // pass-through that ignored the repo would produce a visibly
          // different argv rather than an identical one.
          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            agents: {
              developer: { backend: 'claude-code', model: SELECTED_MODEL },
            },
            repo_model_allowlist: [REPO_REQUESTED_MODEL],
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
                '--adl-argv-log',
                argvLog,
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
              const rows = await usageRepository(db).listForFeature(featureId);
              return rows.length > 0;
            });

            const argv = (await readFile(argvLog, 'utf8'))
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as string[])[0]!;

            const modelFlag = argv.indexOf('--model');
            expect(modelFlag).toBeGreaterThanOrEqual(0);
            expect(argv[modelFlag + 1]).toBe(REPO_REQUESTED_MODEL);
            // The daemon's own value lost to the repository's request, which
            // only happens because the allowlist named it.
            expect(argv).not.toContain(SELECTED_MODEL);

            const usage = await usageRepository(db).listForFeature(featureId);
            expect(usage[0]?.model_id).toBe(REPO_REQUESTED_MODEL);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
