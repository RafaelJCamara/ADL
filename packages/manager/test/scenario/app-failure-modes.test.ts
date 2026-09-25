/**
 * The failure-mode table, through a real daemon (ROLE-07, M08 step 8.3).
 *
 * `packages/core/test/stage/app-failure.test.ts` proves the table itself — that
 * no row reaches `pass`, that only the two rows which are evidence about the WORK
 * cost a round, that a never-ready app rides a transient kind. This proves the two
 * things a pure test cannot: that the classification actually reaches the round
 * loop, and that the loop then does the different things the table promises.
 *
 * Two cases, and they are the two ends of the table:
 *
 *  1. **A build that will not build is the developer's round.** 8.2 shipped a
 *     single conservative `provider_error` for every app failure, which meant a
 *     broken build was retried eight times on the provider budget and then
 *     escalated to a human — while the agent that could have fixed it was never
 *     told. That is the defect this case exists to keep fixed.
 *  2. **An app that never becomes ready is retried before anybody is woken.** The
 *     step sketch said `inconclusive`, which `aggregate` turns into `unverified`
 *     and `round-step.ts` turns into `complete` plus `unrecoverable` — a human
 *     woken irrecoverably on the first slow boot (audit finding 6).
 *  3. **A failed teardown changes no verdict.** The table's third channel,
 *     `report_only`, and the only row whose correctness is an ABSENCE: the gate
 *     had already judged by the time `commands.teardown` ran, so a leaked
 *     container must not be able to overturn a correct approval.
 */
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
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);
const APP_GATE_PROBE = fileURLToPath(
  new URL('../helpers/app-gate-probe.mjs', import.meta.url),
);

/** A node one-liner, so a fixture needs no file on disk. */
function inline(source: string): readonly string[] {
  return [process.execPath, '-e', source];
}

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

/** Everything both cases share: a repo with one feature, a daemon, a `needs_app` gate. */
async function withFailingApp<T>(
  commands: Record<string, unknown>,
  body: (ctx: {
    readonly db: Awaited<Parameters<Parameters<typeof withTempDb>[0]>[0]>['db'];
    readonly featureId: string;
    readonly reportPath: string;
    readonly dbFilePath: string;
  }) => Promise<T>,
): Promise<T> {
  return await withTempDb(async ({ db, filePath }) => {
    await migrateToLatest(db, MIGRATIONS_DIR);

    return await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const folder = `fail-${ulid()}`;
      const featureDir = `features/${folder}`;
      await mkdir(join(mainRepo, featureDir), { recursive: true });
      await writeFile(
        join(mainRepo, featureDir, 'spec.md'),
        '# Title\n\nA feature.\n\n## Acceptance Criteria\n\n- It answers /health.\n',
        'utf8',
      );
      await git.add('.');
      await git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await git.raw(['branch', '--show-current'])
      ).trim();

      const reportPath = join(scratchRoot, '..', `report-${folder}.json`);

      const adlYml: AdlYml = AdlYmlSchema.parse({
        version: 1,
        commands,
        pipeline: [
          'develop',
          {
            harness: 'behaviour',
            with: {
              command: {
                argv: [process.execPath, APP_GATE_PROBE, reportPath],
                env: { APP_PORT: '${ADL_PORT}' },
              },
            },
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
        const { featureId } = (await response.json()) as { featureId: string };
        return await body({ db, featureId, reportPath, dbFilePath: filePath });
      } finally {
        await handle.stop();
        // A settle window, and it is a MITIGATION for a real defect rather than
        // tidiness: `gracefulShutdown` clears the dispatch interval and destroys
        // the database, but does not await a dispatch already in flight — so a
        // daemon stopped while the round loop is mid-retry can reject with
        // `driver has already been destroyed` after the test has finished.
        // Observed intermittently against the never-ready case here, which is the
        // first test to stop a daemon during a transient-retry backoff. Recorded
        // as `DEBT.md`'s D-8-03-1.
        await delay(250);
      }
    });
  });
}

describe('scenario: a build that will not build is the developer’s round', () => {
  it(
    'sends the round back with a blocker finding rather than escalating',
    { timeout: 180_000 },
    async () => {
      await withFailingApp(
        {
          // The only failing piece. `build-failed` is one of exactly two rows in
          // the table that charge the developer a round.
          build: {
            argv: inline(
              "console.error('TS2304: Cannot find name \\'thing\\''); process.exit(2);",
            ),
          },
          // A `start.timeout` shorter than the gate it has to survive, so this
          // case also carries D-8-02-2's warning end to end. It costs nothing
          // here and cannot race: the build fails, so the app never starts.
          start: { argv: ['true'], timeout: '1s' },
          test: { argv: ['true'] },
          teardown: { argv: ['true'] },
        },
        async ({ db, featureId, reportPath, dbFilePath }) => {
          await waitUntil(async () => {
            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .execute();
            return rounds.some((round) => round.ended_at !== null);
          });

          const rounds = await db
            .selectFrom('rounds')
            .selectAll()
            .where('feature_id', '=', featureId)
            .orderBy('number')
            .execute();

          // ── 1. A send_back, not a StageError ──────────────────────────
          // With 8.2's conservative mapping this was `provider_error`, which
          // costs no round and retries eight times before waking a human — so
          // the agent that could have fixed the build was never told.
          expect(rounds[0]?.outcome).toBe('send_back');

          // ── 2. Carrying a finding the developer can act on ───────────
          const findings = await db
            .selectFrom('findings')
            .innerJoin('verdicts', 'verdicts.id', 'findings.verdict_id')
            .innerJoin(
              'stage_attempts',
              'stage_attempts.id',
              'verdicts.stage_attempt_id',
            )
            .select([
              'findings.title as title',
              'findings.detail as detail',
              'findings.severity as severity',
            ])
            .where('stage_attempts.round_id', '=', rounds[0]!.id)
            .execute();

          expect(findings).toHaveLength(1);
          expect(findings[0]?.severity).toBe('blocker');
          expect(findings[0]?.title).toContain('build-failed');
          // The exit code is on the title, because it is stable for a given
          // defect and is therefore part of the fingerprint stalemate detection
          // recognises across rounds.
          expect(findings[0]?.title).toContain('exit 2');
          // And the compiler's own words reached the developer, which is the
          // difference between an actionable send-back and "something broke".
          expect(findings[0]?.detail).toContain('exited 2');

          // ── 3. The gate never ran ────────────────────────────────────
          // The build failed before the app started, so there was nothing to
          // judge. If the gate HAD run it would have written this file.
          await expect(readFile(reportPath, 'utf8')).rejects.toThrow();

          // ── 4. And D-8-02-2's warning reached the transcript ────────
          // The warning is computed before the build runs and is returned on the
          // failure path too, so this case carries it for free. Without this
          // assertion the `lifecycle.warnings` loop in `stage-runner.ts` had no
          // end-to-end coverage at all — deleting it left every other case in
          // this file green, which is how the gap was found.
          const gateAttempt = await db
            .selectFrom('stage_attempts')
            .select('id')
            .where('round_id', '=', rounds[0]!.id)
            .where('stage_id', '=', 'behaviour')
            .executeTakeFirstOrThrow();
          const address = await findAttempt(db, gateAttempt.id);
          expect(address).toBeDefined();
          const transcript = await readFile(
            transcriptPathFor(logsRootFor(dbFilePath), address!),
            'utf8',
          );
          expect(transcript).toContain('[ADL][ROLE-07]');
          expect(transcript).toContain('commands.start.timeout is 1000ms');
        },
      );
    },
  );
});

describe('scenario: an app that never becomes ready is retried, not escalated', () => {
  it(
    'spends the transient budget on more than one attempt before anybody is woken',
    { timeout: 180_000 },
    async () => {
      await withFailingApp(
        {
          build: { argv: ['true'] },
          // A process that lives forever and never listens on anything, so the
          // `http` probe can only ever time out. Distinct from an app that EXITS,
          // which is `app-exited-before-ready` and a send_back.
          start: {
            argv: inline('setInterval(() => {}, 1000);'),
            env: { PORT: '${ADL_PORT}' },
            ready: {
              kind: 'http',
              url: 'http://127.0.0.1:${ADL_PORT}/health',
              expect: 200,
            },
            // Short on purpose: this case is about what happens AFTER the probe
            // gives up, and the transient backoff is what costs the wall-clock.
            ready_timeout: '1s',
          },
          test: { argv: ['true'] },
          teardown: { argv: ['true'] },
        },
        async ({ db, featureId }) => {
          // ── 1. It is tried more than once ────────────────────────────
          // `planTransientRetry`'s first backoff is 5s, so a second attempt is
          // real evidence of a retry rather than of one slow attempt.
          await waitUntil(
            async () => {
              const attempts = await db
                .selectFrom('stage_attempts')
                .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
                .select('stage_attempts.id as id')
                .where('rounds.feature_id', '=', featureId)
                .where('stage_attempts.stage_id', '=', 'behaviour')
                .execute();
              return attempts.length >= 2;
            },
            { timeoutMs: 90_000, intervalMs: 200 },
          );

          // ── 2. And nobody has been woken ─────────────────────────────
          // The assertion that would have been FALSE under the step sketch's
          // `inconclusive`: `aggregate` maps an `inconclusive` with no send_back
          // to `unverified`, and `round-step.ts` turns that into a completed,
          // unrecoverable feature — on the first timeout, with no retry.
          const feature = await featuresRepository(db).findById(featureId);
          expect(feature?.state).not.toBe('complete');

          // `feature_events` records the transition, and the event itself is JSON
          // in `event_json` — there is no `kind` column, deliberately: the
          // lifecycle never branches on a `FeatureEvent`'s payload, so the payload
          // is opaque to the table.
          const events = await db
            .selectFrom('feature_events')
            .select(['event_json', 'to_state'])
            .where('feature_id', '=', featureId)
            .execute();
          expect(
            events.map(
              (row) => (JSON.parse(row.event_json) as { t: string }).t,
            ),
          ).not.toContain('unrecoverable');
          expect(events.map((row) => row.to_state)).not.toContain('complete');

          // ── 3. No round was charged for it ──────────────────────────
          // `stageErrorPolicy` promises `consumesRound: false` for every kind,
          // which is CORE-06. Read off the database rather than the policy, so
          // this measures the loop honouring it rather than the table stating it.
          const rounds = await db
            .selectFrom('rounds')
            .selectAll()
            .where('feature_id', '=', featureId)
            .execute();
          expect(rounds).toHaveLength(1);
          expect(rounds[0]?.ended_at).toBeNull();
        },
      );
    },
  );
});

describe('scenario: a failed teardown changes no verdict', () => {
  it(
    'still passes the gate, and says so where an operator will find it',
    { timeout: 180_000 },
    async () => {
      await withFailingApp(
        {
          build: { argv: ['true'] },
          // A real app that really becomes ready, so the gate really passes —
          // which is what makes the absence below meaningful. An app that failed
          // would prove nothing about whether teardown can overturn a PASS.
          start: {
            argv: inline(
              "require('node:http').createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
            ),
            env: { PORT: '${ADL_PORT}' },
            ready: {
              kind: 'http',
              url: 'http://127.0.0.1:${ADL_PORT}/health',
            },
            ready_timeout: '30s',
          },
          test: { argv: ['true'] },
          // The failing piece, and the only one.
          teardown: {
            argv: inline(
              "console.error('could not remove volume adl-test'); process.exit(3);",
            ),
          },
        },
        async ({ db, featureId, reportPath, dbFilePath }) => {
          await waitUntil(async () => {
            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .execute();
            return rounds.some((round) => round.ended_at !== null);
          });

          // ── 1. The gate really ran against a really-live app ─────────
          const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
            status: number | null;
          };
          expect(report.status).toBe(200);

          // ── 2. And the round is GREEN ───────────────────────────────
          // The `report_only` channel, measured as an absence. A teardown that
          // could produce a `send_back` or a `StageError` would turn this round
          // into one of those instead, and a correct approval would have been
          // overturned by a cleanup command.
          const rounds = await db
            .selectFrom('rounds')
            .selectAll()
            .where('feature_id', '=', featureId)
            .orderBy('number')
            .execute();
          expect(rounds[0]?.outcome).toBe('green');

          // ── 3. And no finding was invented for it ───────────────────
          const findings = await db
            .selectFrom('findings')
            .innerJoin('verdicts', 'verdicts.id', 'findings.verdict_id')
            .innerJoin(
              'stage_attempts',
              'stage_attempts.id',
              'verdicts.stage_attempt_id',
            )
            .select('findings.title as title')
            .where('stage_attempts.round_id', '=', rounds[0]!.id)
            .execute();
          expect(findings).toEqual([]);

          // ── 4. But it is on the record, not swallowed ───────────────
          // `report_only` means "changes no verdict", never "is invisible". The
          // transcript is where `adl logs` points, and `reportAppWarning` writes
          // the same line to the worker's stderr so it also reaches the daemon
          // log.
          const gateAttempt = await db
            .selectFrom('stage_attempts')
            .select('id')
            .where('round_id', '=', rounds[0]!.id)
            .where('stage_id', '=', 'behaviour')
            .executeTakeFirstOrThrow();
          const address = await findAttempt(db, gateAttempt.id);
          expect(address).toBeDefined();
          const transcript = await readFile(
            transcriptPathFor(logsRootFor(dbFilePath), address!),
            'utf8',
          );
          expect(transcript).toContain('[ADL][ROLE-07]');
          expect(transcript).toContain('commands.teardown did not succeed');
        },
      );
    },
  );
});
