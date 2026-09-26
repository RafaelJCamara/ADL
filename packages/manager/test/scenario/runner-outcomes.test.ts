/**
 * Zero executed tests is not a pass, and it is told apart from a suite that ran
 * and passed by nothing but the runner's own report (ROLE-08, M08 step 8.5).
 *
 * Two features, one daemon, one app, one pipeline. **Both testers claim `pass`**
 * — the replay double claims a pass whenever the app answered, and it answers both
 * times. The only difference is the test each one writes: Feature A's is
 * `test.skip`, Feature B's is a real test. So if ADL judged the tester by its word,
 * both would pass; the runner's report is the only thing that can separate them,
 * which is exactly what the milestone's criterion 3 says has to be true.
 *
 * ## The evidence comes from outside ADL
 *
 * 7.5's, 7.9's, 8.1's and 8.2's pattern, three times over:
 *
 * 1. **A witness file** only ADL's suite run can write to. The test the double
 *    writes appends a line to `process.env.ADL_85_WITNESS` before it does anything
 *    else — and that variable exists only in the suite's declared env, never in the
 *    agent's. The double itself never runs a test. So a line in the file is proof
 *    that ADL executed the test, and its absence that nothing executed.
 * 2. **The double's own report** of what it claimed and what it wrote.
 * 3. **The runner's own words**, on each attempt's transcript: node's TAP, verbatim.
 *
 * ## And `behaviour` is not the last stage, deliberately
 *
 * A built-in `test` gate follows it. That puts Feature A's `inconclusive` in the
 * middle of the pipeline, which is exactly where it used to be written into
 * `feature_events` as `gate_passed` — "this gate was satisfied" — for a gate that
 * verified nothing (fixed by `fix(08-05)`, `gate_inconclusive`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { featuresRepository, migrateToLatest } from '@adl/db';
import type { Kysely } from 'kysely';
import type { Database } from '@adl/db';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { startDaemon } from '../../src/index.js';
import { findAttempt } from '../../src/bookkeeping/attempt.js';
import {
  logsRootFor,
  transcriptPathFor,
} from '../../src/store/transcript-path.js';
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

const NOTHING_EXECUTES = 'Health (nothing executes)';
const RAN_AND_PASSED = 'Health';

interface TesterReport {
  readonly title: string;
  readonly sawSuiteCommand: boolean;
  readonly wrote: readonly string[];
  readonly skip: boolean;
  readonly fetched: { readonly status: number } | null;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 120_000, intervalMs = 50 } = {},
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

/** The behaviour stage's verdict, round and events, read back off the database. */
async function recordFor(db: Kysely<Database>, featureId: string) {
  const rounds = await db
    .selectFrom('rounds')
    .selectAll()
    .where('feature_id', '=', featureId)
    .orderBy('number')
    .execute();
  const attempt = await db
    .selectFrom('stage_attempts')
    .select('id')
    .where('round_id', '=', rounds[0]!.id)
    .where('stage_id', '=', 'behaviour')
    .executeTakeFirstOrThrow();
  const verdict = await db
    .selectFrom('verdicts')
    .selectAll()
    .where('stage_attempt_id', '=', attempt.id)
    .executeTakeFirstOrThrow();
  const covered = await db
    .selectFrom('verdict_checked_criteria')
    .select([
      'ref_kind as refKind',
      'criterion_id as criterionId',
      'global_category as category',
    ])
    .where('verdict_id', '=', verdict.id)
    .execute();
  const events = (
    await db
      .selectFrom('feature_events')
      .select('event_json')
      .where('feature_id', '=', featureId)
      .orderBy('id')
      .execute()
  ).map((row) => JSON.parse(row.event_json) as { t: string; stageId?: string });
  const feature = await featuresRepository(db).findById(featureId);
  return { rounds, attemptId: attempt.id, verdict, covered, events, feature };
}

/** The `delta` of every transcript record whose `messageId` starts `suite:`. */
async function suiteRecords(
  db: Kysely<Database>,
  dbFilePath: string,
  attemptId: string,
): Promise<{ messageId: string; delta: string }[]> {
  const address = await findAttempt(db, attemptId);
  if (address === undefined) throw new Error(`no attempt ${attemptId}`);
  const text = await readFile(
    transcriptPathFor(logsRootFor(dbFilePath), address),
    'utf8',
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(
      (line) =>
        (
          JSON.parse(line) as {
            event: { kind: string; messageId?: string; delta?: string };
          }
        ).event,
    )
    .filter(
      (event): event is { kind: string; messageId: string; delta: string } =>
        event.kind === 'text' &&
        typeof event.messageId === 'string' &&
        event.messageId.startsWith('suite:'),
    )
    .map(({ messageId, delta }) => ({ messageId, delta }));
}

describe('scenario: two testers claim pass; the one whose suite executed nothing is inconclusive', () => {
  it(
    'tells "no test executed" apart from "ran and passed" by the runner’s report alone',
    { timeout: 300_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folders = {
            nothing: `nothing-${ulid()}`,
            ran: `ran-${ulid()}`,
          };
          for (const [folder, title] of [
            [folders.nothing, NOTHING_EXECUTES],
            [folders.ran, RAN_AND_PASSED],
          ] as const) {
            await mkdir(join(mainRepo, 'features', folder), {
              recursive: true,
            });
            await writeFile(
              join(mainRepo, 'features', folder, 'spec.md'),
              `# ${title}\n\nThe app reports its health.\n\n` +
                '## Acceptance Criteria\n\n- It answers /health with 200.\n',
              'utf8',
            );
          }
          // A test directory the tester can see, holding NO test — so the only
          // test that can execute is the one the tester writes (D-8-05-3 is the
          // other shape, and `behaviour-tester.test.ts` reproduces it).
          await mkdir(join(mainRepo, 'tests'), { recursive: true });
          await writeFile(
            join(mainRepo, 'tests', 'README.md'),
            'Behaviour tests live here.\n',
            'utf8',
          );
          await git.add('.');
          await git.raw(['commit', '-m', 'two features and an empty test dir']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          const outside = join(scratchRoot, '..');
          const pidPath = join(outside, 'pids.json');
          const reportDir = join(outside, 'tester-reports');
          const witness = join(outside, 'witness.txt');
          await writeFile(witness, '', 'utf8');

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
                harness: 'behaviour',
                visible_paths: ['tests/**'],
                needs_app: true,
                with: {
                  suite: {
                    command: {
                      argv: [process.execPath, '--test', '--test-reporter=tap'],
                      env: {
                        APP_URL: 'http://127.0.0.1:${ADL_PORT}',
                        ADL_85_WITNESS: witness,
                      },
                      timeout: '60s',
                    },
                    emits: 'tap',
                  },
                },
              },
              // Not the last stage, on purpose — see the module docblock.
              'test',
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
                '--adl-tester-writes',
                'by-title',
                '--adl-tester-report-dir',
                reportDir,
              ]),
            },
            dispatchIntervalMs: 20,
          });

          try {
            const featureIds: Record<keyof typeof folders, string> = {
              nothing: '',
              ran: '',
            };
            // One after the other: `dev-run` dispatches immediately, and the
            // default concurrency is one feature at a time.
            for (const key of ['nothing', 'ran'] as const) {
              const response = await fetch(
                `http://127.0.0.1:${handle.port}/dev-run/${folders[key]}`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${API_TOKEN}` },
                },
              );
              expect(response.status).toBe(200);
              const featureId = (
                (await response.json()) as { featureId: string }
              ).featureId;
              featureIds[key] = featureId;
              await waitUntil(async () => {
                const ended = await db
                  .selectFrom('rounds')
                  .select('feature_id')
                  .where('feature_id', '=', featureId)
                  .where('ended_at', 'is not', null)
                  .execute();
                const feature =
                  await featuresRepository(db).findById(featureId);
                return ended.length > 0 && feature?.lease_token === null;
              });
            }

            const reportOf = async (title: string): Promise<TesterReport> =>
              JSON.parse(
                await readFile(
                  join(
                    reportDir,
                    `${title
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')}.json`,
                  ),
                  'utf8',
                ),
              ) as TesterReport;
            const nothingReport = await reportOf(NOTHING_EXECUTES);
            const ranReport = await reportOf(RAN_AND_PASSED);

            // ── 1. Both testers CLAIMED pass, and both were told the suite ──
            // The app answered both, so the double claimed `pass` both times. If
            // ADL judged by the claim, both features would pass.
            for (const report of [nothingReport, ranReport]) {
              expect(report.fetched?.status, report.title).toBe(200);
              expect(report.sawSuiteCommand, report.title).toBe(true);
              expect(report.wrote, report.title).toEqual([
                'tests/health.test.mjs',
              ]);
            }
            expect(nothingReport.skip).toBe(true);
            expect(ranReport.skip).toBe(false);

            // ── 2. Only ADL's run executed a test, and only one ─────────
            // The witness path exists only in the SUITE's env. One line, from
            // Feature B's test; Feature A's test was skipped and never ran.
            const witnessed = (await readFile(witness, 'utf8'))
              .split('\n')
              .filter((line) => line !== '');
            expect(witnessed).toEqual([`executed: ${RAN_AND_PASSED}`]);

            const nothing = await recordFor(db, featureIds.nothing);
            const ran = await recordFor(db, featureIds.ran);

            // ── 3. The runner's own words, on each transcript ───────────
            const nothingSuite = await suiteRecords(
              db,
              filePath,
              nothing.attemptId,
            );
            const ranSuite = await suiteRecords(db, filePath, ran.attemptId);
            expect(
              nothingSuite.some((r) =>
                /^ok 1 - AC-1: GET \/health answers 200 # SKIP/.test(r.delta),
              ),
            ).toBe(true);
            expect(
              ranSuite.some((r) =>
                /^ok 1 - AC-1: GET \/health answers 200$/.test(r.delta),
              ),
            ).toBe(true);
            // Both runs exited 0 — so the exit code cannot be what told them apart.
            for (const suite of [nothingSuite, ranSuite]) {
              expect(
                suite.find((r) => r.messageId === 'suite:exit')?.delta,
              ).toMatch(/^exited 0 after \d+ms$/);
            }

            // ── 4. A: inconclusive, recorded as such, escalated ─────────
            expect(nothing.verdict.outcome).toBe('inconclusive');
            expect(nothing.verdict.reason).toContain('exited 0');
            expect(nothing.verdict.reason).toContain('no test executed');
            expect(nothing.verdict.reason).toContain('1 skipped');
            expect(nothing.verdict.reason).toContain(
              'the tester reported `pass`',
            );
            expect(nothing.covered).toEqual([]);
            expect(nothing.rounds[0]?.outcome).toBe('unverified');
            const nothingKinds = nothing.events.map(
              (e) => `${e.t}:${e.stageId ?? ''}`,
            );
            expect(nothingKinds).toContain('gate_inconclusive:behaviour');
            expect(
              nothingKinds,
              'an inconclusive gate was written into the audit trail as passed',
            ).not.toContain('gate_passed:behaviour');
            expect(nothing.events.map((e) => e.t)).toContain('unrecoverable');
            expect(nothing.feature?.state).toBe('escalated');

            // ── 5. B: a pass citing the suite, and a green round ────────
            expect(ran.verdict.outcome).toBe('pass');
            expect(ran.verdict.summary).toContain('exited 0');
            expect(ran.verdict.summary).toContain('1 executed test');
            expect(ran.covered).toEqual([
              { refKind: 'global', criterionId: null, category: 'build' },
            ]);
            expect(ran.rounds[0]?.outcome).toBe('green');
            expect(
              ran.events.map((e) => `${e.t}:${e.stageId ?? ''}`),
            ).toContain('gate_passed:behaviour');
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
