import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest } from '@adl/db';
import { ulid } from 'ulid';
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
 * LOOP-09 end to end (M07 step 7.8): the goalposts cannot move mid-feature.
 *
 * A reviewer given a fresh look each round has no memory of having been
 * satisfied. Left unbounded it produces a new opinion every round, and each one
 * spends one of `limits.max_rounds` — the feature never converges and the human
 * eventually gets an escalation about a feature that was finished two rounds
 * ago.
 *
 * Every layer here is production, on `command-gate-loop.test.ts`'s precedent: a
 * real `startDaemon`, the real dispatcher, real forked workers, the real
 * `createProductionStageRunner` and the real reviewer gate, with only the
 * `claude` binary replaced. The double
 * (`fake-claude-reviewer-script.mjs`) raises a genuinely different finding on
 * its second review, which is exactly the move under test — a second *identical*
 * send-back is the ordinary unfixed case and the policy correctly leaves it
 * alone.
 *
 * **What is asserted:**
 *
 * 1. Round 1 is a `send_back`. The reviewer's first look is the contract, and
 *    nothing in it is ever a follow-up — without this the reviewer would be
 *    decorative rather than protected.
 * 2. Round 2 is **green**, even though the reviewer sent back again. Its
 *    round-2 finding was raised for the first time after its own first look, so
 *    it is a follow-up and has no claim on a round.
 * 3. The round-2 verdict is stored as `warn`, not `send_back` — what ADL acted
 *    on is what the pull request will be rendered from.
 * 4. Both findings survive. The policy changes *what a finding costs*, never
 *    whether it is recorded.
 * 5. The audit trail says `gate_follow_ups` and never `gate_passed` for that
 *    round: the reviewer was not satisfied, it was overruled on timing.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_REVIEWER_SCRIPT = fileURLToPath(
  new URL('../helpers/fake-claude-reviewer-script.mjs', import.meta.url),
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

describe('scenario: a reviewer finding first raised after round 1 is a follow-up, not a send-back (LOOP-09)', () => {
  it(
    'sends back on the first review and goes green on a brand-new second-round finding',
    { timeout: 180_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `follow-ups-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Exportable report\n\nA feature.\n\n## Acceptance Criteria\n\n- The export button appears.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          // Outside the worktree, so a workspace teardown between rounds cannot
          // reset it — the same reason `command-gate-loop.test.ts` keeps its own
          // counter there.
          const reviewCounter = join(scratchRoot, '..', 'review-counter');

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            // The reviewer alone, so the round outcome is its verdict and
            // nothing else's — a second gate would make "round 2 is green" a
            // statement about two gates.
            pipeline: ['develop', 'review'],
          });

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
                FAKE_CLAUDE_REVIEWER_SCRIPT,
                '--adl-review-counter',
                reviewCounter,
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

            // Every gate passed, so the feature promotes. Under the pre-7.8
            // behaviour it would still be looping: round 2's send-back would
            // start round 3, round 3's a fourth, and so on to `max_rounds`.
            await waitUntil(async () => {
              const row = await featuresRepository(db).findById(featureId);
              return row?.state === 'publishing';
            });

            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();

            // ── 1 & 2. The first look is the contract; the second is not ─
            expect(rounds.map((round) => round.outcome)).toEqual([
              'send_back',
              'green',
            ]);

            // ── 3. What ADL acted on is what was persisted ───────────────
            // The reviewer said `send_back` both times. Storing round 2's as a
            // `send_back` would leave `verdicts.outcome` disagreeing with the
            // round it produced, and the pull request is rendered from these
            // rows.
            const verdicts = await db
              .selectFrom('verdicts')
              .innerJoin(
                'stage_attempts',
                'stage_attempts.id',
                'verdicts.stage_attempt_id',
              )
              .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
              .select(['verdicts.id', 'verdicts.outcome', 'rounds.number'])
              .where('rounds.feature_id', '=', featureId)
              .where('stage_attempts.stage_id', '=', 'review')
              .orderBy('rounds.number')
              .execute();
            expect(verdicts.map((row) => [row.number, row.outcome])).toEqual([
              [1, 'send_back'],
              [2, 'warn'],
            ]);

            // ── 4. Both findings survive ─────────────────────────────────
            // LOOP-09 changes what a finding COSTS, never whether it is
            // recorded. The round-2 finding is what the pull request shows the
            // human as a follow-up.
            const findings = await db
              .selectFrom('findings')
              .select(['fingerprint', 'title'])
              .where(
                'verdict_id',
                'in',
                verdicts.map((row) => row.id),
              )
              .orderBy('fingerprint')
              .execute();
            expect(findings.map((row) => row.fingerprint)).toEqual([
              'a'.repeat(64),
              'b'.repeat(64),
            ]);

            // ── 5. The audit trail is honest about which of the three ────
            // this was. `gate_passed` reads as "this gate was satisfied" and it
            // was not; `gate_deferred` reads as "still blocking, later" and it
            // is not. 7.2 paid for `gate_deferred` for exactly this reason and
            // this is the third name.
            const events = await db
              .selectFrom('feature_events')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('seq')
              .execute();
            const kinds = events.map(
              (row) => (JSON.parse(row.event_json) as { t: string }).t,
            );
            expect(kinds).toContain('gate_follow_ups');
            expect(kinds).toContain('all_gates_passed');
            expect(kinds).not.toContain('gate_passed');
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
