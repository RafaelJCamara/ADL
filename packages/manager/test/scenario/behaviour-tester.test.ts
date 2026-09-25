/**
 * The behaviour tester, end to end (ROLE-05/06/07, M08 step 8.4).
 *
 * This is the first time all three of M08's mechanisms run together: a real daemon
 * builds and starts a real app on a port it allocated (8.2), composes a workspace
 * that is a `.git`-less copy of the declared allowlist outside every repository
 * (8.1), and dispatches an agent into it as the built-in `behaviour` stage (8.4).
 *
 * ## The evidence comes from the agent, not from ADL
 *
 * 7.5's, 7.9's, 8.1's and 8.2's pattern. The replay double reads the base URL out
 * of its own instructions, **really fetches it**, walks its own working directory,
 * and writes what it found to a file outside every workspace. It only reports a
 * `pass` if the app genuinely answered — a double that passed regardless would make
 * every assertion here about itself.
 *
 * So the two properties that matter are measured from opposite ends at once: the
 * app was reachable (the tester fetched it) and the implementation was not (the
 * tester walked its whole root and the marker is nowhere in it).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { migrateToLatest } from '@adl/db';
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

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_TESTER = fileURLToPath(
  new URL('../helpers/fake-claude-tester.mjs', import.meta.url),
);
const APP_START = fileURLToPath(
  new URL('../helpers/app-under-test-start.mjs', import.meta.url),
);

/** The string the tester must never be able to reach, by any route. */
const MARKER = 'SECRET_IMPLEMENTATION_MARKER';

interface TesterReport {
  readonly sawBaseUrl: string | null;
  readonly files: readonly string[];
  readonly instructionsMentionSrc: boolean;
  readonly toldSourceIsAbsent: boolean;
  readonly fetched: { readonly status: number; readonly body: string } | null;
  readonly fetchError: string | null;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 90_000, intervalMs = 50 } = {},
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

describe('scenario: a code-blind tester verifies a running app', () => {
  it(
    'reaches the app it cannot read, and reports a verdict the loop acts on',
    { timeout: 240_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `beh-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await mkdir(join(mainRepo, 'src'), { recursive: true });
          await mkdir(join(mainRepo, 'tests'), { recursive: true });

          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Health\n\nThe app reports its health.\n\n' +
              '## Acceptance Criteria\n\n- It answers /health with 200.\n',
            'utf8',
          );
          // Committed, so it is in the object store as well as on disk — which is
          // the half a sparse checkout fails to hide (step 8.0's P8a).
          await writeFile(
            join(mainRepo, 'src', 'impl.ts'),
            `export const ${MARKER} = 'the implementation';\n`,
            'utf8',
          );
          await writeFile(
            join(mainRepo, 'tests', 'existing.test.mjs'),
            "import { test } from 'node:test';\ntest('a test the tester can see', () => {});\n",
            'utf8',
          );
          await git.add('.');
          await git.raw(['commit', '-m', 'add feature, implementation, tests']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          const outside = join(scratchRoot, '..');
          const pidPath = join(outside, `pids-${folder}.json`);
          const reportPath = join(outside, `tester-${folder}.json`);

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: {
                argv: [process.execPath, APP_START, pidPath],
                env: { PORT: '${ADL_PORT}' },
                ready: {
                  kind: 'http',
                  url: 'http://127.0.0.1:${ADL_PORT}/health',
                  expect: 200,
                },
                ready_timeout: '60s',
              },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            pipeline: [
              'develop',
              {
                // The built-in tester, declaring exactly what any third party's
                // gate would have to declare: what its workspace contains, and
                // that it needs an app. ADL infers neither from the name.
                harness: 'behaviour',
                visible_paths: ['tests/**'],
                needs_app: true,
              },
            ],
          });

          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
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
                FAKE_CLAUDE_TESTER,
                '--adl-tester-report',
                reportPath,
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

            const report = JSON.parse(
              await readFile(reportPath, 'utf8'),
            ) as TesterReport;

            // ── 1. It was told the port ADL allocated ───────────────────
            // Through `GateContext.app`, the member this step added — an agent gate
            // has no command and therefore no interpolated `env` to read it from.
            const pids = JSON.parse(await readFile(pidPath, 'utf8')) as {
              port: number;
            };
            expect(report.sawBaseUrl).toBe(
              `http://127.0.0.1:${String(pids.port)}`,
            );

            // ── 2. And it really reached the app ───────────────────────
            // From inside a workspace with no `.git` and no source in it, over the
            // loopback interface. This is ROLE-05 and ROLE-07 holding at once.
            expect(report.fetchError).toBeNull();
            expect(report.fetched?.status).toBe(200);
            expect(report.fetched?.body).toBe(
              JSON.stringify({ ok: true, port: pids.port }),
            );

            // ── 3. While being unable to read the implementation ───────
            // Measured by the agent's own walk of its own root, not by ADL's
            // bookkeeping. `tests/**` is what it declared; `src/` is what it did
            // not, and the marker appears in no file it can open.
            expect(report.files).toContain('tests/existing.test.mjs');
            expect(report.files.some((file) => file.startsWith('src/'))).toBe(
              false,
            );
            expect(JSON.stringify(report.files)).not.toContain(MARKER);
            // The developer's own committed output is gone too — a tester reading
            // the worktree would see `agent-output.txt`.
            expect(report.files).not.toContain('agent-output.txt');

            // ── 4. Its prompt named no implementation file ─────────────
            // Step 8.1's carried disclosure, decided in 8.4: `diff.changedPaths`
            // stays on the contract and the prompt does not use it. A tester told
            // which module changed writes tests about a module.
            expect(report.instructionsMentionSrc).toBe(false);

            // ── 5. And it was told the blindness is deliberate ─────────
            // Step 8.0's insistence: a tester that does not know spends turns
            // hunting for source that is not there.
            expect(report.toldSourceIsAbsent).toBe(true);

            // ── 6. The loop acted on the verdict ──────────────────────
            // The round is green, which means the tester's `pass` reached
            // `aggregate` as a real verdict rather than as a StageError — and the
            // double only emits a `pass` when the app actually answered.
            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();
            expect(rounds).toHaveLength(1);
            expect(rounds[0]?.outcome).toBe('green');

            // ── 7. And the criterion it cited was recorded as covered ──
            // `verdict_checked_criteria` is the table M09's coverage section is
            // drawn from, and a citation naming a criterion the spec lacks would
            // have been refused as `unparseable` by ROLE-04's check instead.
            const covered = await db
              .selectFrom('verdict_checked_criteria')
              .innerJoin(
                'verdicts',
                'verdicts.id',
                'verdict_checked_criteria.verdict_id',
              )
              .innerJoin(
                'stage_attempts',
                'stage_attempts.id',
                'verdicts.stage_attempt_id',
              )
              .select('verdict_checked_criteria.criterion_id as id')
              .where('stage_attempts.stage_id', '=', 'behaviour')
              .execute();
            expect(covered.map((row) => row.id)).toEqual(['AC-1']);
          } finally {
            await handle.stop();
            // D-8-03-1's settle window; see `app-failure-modes.test.ts`.
            await delay(250);
          }
        });
      });
    },
  );
});
