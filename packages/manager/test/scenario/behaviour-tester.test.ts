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
 *
 * ## And a tester that wrote nothing is credited with nothing (M08 step 8.6)
 *
 * Until 8.6 this scenario was `DEBT.md` D-8-05-3's reproduction: the double writes
 * no test, the suite ran the repository's own `tests/existing.test.mjs`, and the
 * round came out GREEN on a test the tester never wrote. The tester now declares
 * `owned_dir`, and ADL runs only this feature's files under it — so the same
 * double, against the same repository, is `inconclusive` and goes to a human.
 * Two decoys make the point: a test outside the owned directory, and one an
 * EARLIER feature committed inside it. Each appends to a witness file when it
 * runs, and neither may.
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
  /** Whether the instructions carried the suite ADL runs (M08 step 8.5). */
  readonly sawSuiteCommand: boolean;
  /** Where the instructions said tests go (M08 step 8.6). */
  readonly ownedDir: string | null;
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
    'reaches the app it cannot read, and is credited with no test it did not write',
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
          // Two decoys, each of which records that it ran (M08 step 8.6): one the
          // tester can see but does not own, and one an earlier feature's tester
          // committed INTO the owned directory before this feature branched.
          const decoyWitness = join(scratchRoot, '..', `decoys-${folder}`);
          const decoy = (name: string): string =>
            "import { test } from 'node:test';\n" +
            "import { appendFileSync } from 'node:fs';\n" +
            `test(${JSON.stringify(name)}, () => { appendFileSync(${JSON.stringify(decoyWitness)}, ${JSON.stringify(`${name}\n`)}); });\n`;
          await writeFile(
            join(mainRepo, 'tests', 'existing.test.mjs'),
            decoy('a test the tester can see'),
            'utf8',
          );
          await mkdir(join(mainRepo, 'tests', 'behaviour'), {
            recursive: true,
          });
          await writeFile(
            join(mainRepo, 'tests', 'behaviour', 'earlier-feature.test.mjs'),
            decoy('an earlier feature’s committed test'),
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
                // ROLE-09 (M08 step 8.6): where the tester's tests go and are kept
                // — and the only files its suite runs. The double writes no test
                // here, which before 8.6 meant the suite ran the repository's own
                // `tests/existing.test.mjs` and credited the tester with it
                // (D-8-05-3).
                owned_dir: 'tests/behaviour',
                // ROLE-08 (M08 step 8.5): the suite ADL runs after the agent, whose
                // report — not the agent's claim — decides the stage.
                with: {
                  suite: {
                    command: {
                      argv: [process.execPath, '--test', '--test-reporter=tap'],
                    },
                    emits: 'tap',
                  },
                },
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

            // ── 6. The loop acted on the verdict — and credited nothing ──
            // The double claimed `pass` (it really reached the app), and wrote no
            // test. Before M08 step 8.6 the round was GREEN here, on the decoy
            // outside the owned directory (D-8-05-3). Now the tester's own files
            // are what run, there are none, and the stage is `inconclusive`: the
            // round is `unverified` and a human decides.
            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();
            expect(rounds).toHaveLength(1);
            expect(rounds[0]?.outcome).toBe('unverified');
            expect(rounds[0]?.outcome_json).toContain('wrote no tests');
            // Neither decoy ran: not the one outside the owned directory, and
            // not the one an earlier feature committed inside it.
            await expect(readFile(decoyWitness, 'utf8')).rejects.toMatchObject({
              code: 'ENOENT',
            });
            // And it was told where its tests would have gone.
            expect(report.ownedDir).toBe('tests/behaviour');

            // ── 7. Nothing was recorded as covered ────────────────────
            // An `inconclusive` verdict checks nothing — and until 8.6 this was
            // `[{ global: build }]`, coverage recorded on another feature's test.
            // (What a passing tester's coverage looks like is
            // `tester-tests-committed.test.ts`'s to show.)
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
              .select([
                'verdict_checked_criteria.ref_kind as refKind',
                'verdict_checked_criteria.criterion_id as criterionId',
                'verdict_checked_criteria.global_category as category',
              ])
              .where('stage_attempts.stage_id', '=', 'behaviour')
              .execute();
            expect(covered).toEqual([]);

            // ── 8. And it was told how ADL would run its tests ─────────
            // The command that runs the suite, which step 8.0's spike said the
            // tester is given and which, until 8.5, its prompt did not contain.
            expect(report.sawSuiteCommand).toBe(true);
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
