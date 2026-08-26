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
import {
  findAttempt,
  logsRootFor,
  promptArtifactPathFor,
  startDaemon,
  type PromptArtifactContent,
} from '../../src/index.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The round loop turning on a **real** command gate (LOOP-01, AC2, M05 step
 * 5.14).
 *
 * `round-loop.test.ts` proved the loop with a *scripted* gate: a worker double
 * that read `assign.stageIndex` and reported a verdict from a list. That was
 * the right double for 5.13 — there was no gate implementation to run — and it
 * leaves one thing unproven, which is the thing this file is for: **nothing in
 * that test ever ran a command, so nothing ever needed the developer's commit
 * to still exist.** Its scripted worker built no workspace at all, which is
 * precisely why `docs/plan/DEBT.md` D-5-13-1 was found by reading the code
 * rather than by a red test.
 *
 * So every layer here is production: a real `startDaemon`, the real dispatcher
 * and round loop, real forked workers — one per stage, four in total — and the
 * **real `createProductionStageRunner`**, which creates the worktree and runs
 * the developer at index 0 and `runCommandGate` at index 1. The only double is
 * the `claude` binary itself, replaced by `fake-claude-success.mjs`
 * (`tracer-worker-entry.ts`'s existing seam), because the real one is billed.
 *
 * ## The gate fails, then passes, without the configuration changing
 *
 * `adl.yml` is snapshotted into the feature row at lease time and deliberately
 * **not re-merged** on a continuation dispatch (versioning rule 3, 5.13), so
 * `commands.test` is byte-identical in round 2 and round 1. The command
 * therefore has to be the thing that changes its mind, which is exactly what
 * M05's own notes ask of the first gate — *"deterministic and forceable to
 * fail on demand"*. {@link FAIL_THEN_PASS} is a two-line node script that
 * fails the first time it runs and passes afterwards, keyed on a counter file
 * the test owns. No agent nondeterminism anywhere in the signal.
 */

const API_TOKEN = `test-token-${ulid()}`;

/** The real production stage runner, with the billed CLI replaced. */
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);

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

/**
 * A `commands.test` that exits non-zero the first time and zero afterwards.
 *
 * The counter lives in a file the test owns rather than in the workspace,
 * because the workspace is the thing under test: a marker written into the
 * worktree would be indistinguishable from the developer's own work, and a
 * marker that survived only in memory would reset with every forked worker.
 *
 * It also **asserts the developer's commit is present** on the passing run, so
 * a single command carries both halves of what this scenario claims: the gate
 * changed its mind, and it was looking at the developer's tree while it did.
 */
function failThenPass(counterPath: string): readonly string[] {
  return [
    process.execPath,
    '-e',
    [
      "const fs = require('node:fs');",
      `const counter = ${JSON.stringify(counterPath)};`,
      "const runs = Number(fs.readFileSync(counter, 'utf8')) + 1;",
      'fs.writeFileSync(counter, String(runs));',
      // Round 1: object, loudly enough that the finding's detail is worth
      // reading on the change request.
      "if (runs === 1) { process.stderr.write('FAIL: 1 test failed\\n'); process.exit(1); }",
      // Round 2: pass — but only if the developer's committed file is really
      // in the tree this command is running in.
      "if (!fs.existsSync('agent-output.txt')) { process.stderr.write('the gate cannot see the developer\\\\u2019s commit\\n'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'),
  ];
}

describe('scenario: a real command gate turns the loop', () => {
  it(
    'fails round 1, sends the developer back, and passes round 2 against the developer’s commit (AC2)',
    { timeout: 120_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `gate-loop-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nRun the gate\n\n## Acceptance Criteria\n\n- The gate runs.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          const counterPath = join(scratchRoot, '..', 'gate-runs');
          await writeFile(counterPath, '0', 'utf8');

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: failThenPass(counterPath), timeout: '60s' },
              teardown: { argv: ['true'] },
            },
            pipeline: ['develop', 'test'],
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
              const row = await featuresRepository(db).findById(featureId);
              return row?.state === 'publishing';
            });

            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();

            // Two rounds, and the first one is a send-back — AC2's standing
            // rule, restated: *the loop is not considered proven by a feature
            // that passes first try.*
            expect(rounds.map((round) => round.outcome)).toEqual([
              'send_back',
              'green',
            ]);

            // The send-back carried the command's own output, through a real
            // `Verdict` the gate produced rather than a scripted one.
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
            expect(findings[0]?.title).toContain('exit 1');
            expect(findings[0]?.detail).toContain('FAIL: 1 test failed');

            // The gate ran twice — once per round. Without this, a loop that
            // silently skipped the gate would satisfy everything above by
            // never running one.
            expect(Number(await readFile(counterPath, 'utf8'))).toBe(2);

            // Round 2's gate exited 0, which by construction (see
            // `failThenPass`) it could only do while looking at a tree
            // containing the developer's committed `agent-output.txt`. That
            // is `docs/plan/DEBT.md` D-5-13-1 proven closed through the whole
            // stack rather than at the stage runner alone: a gate that
            // branched from `baseRef` would have exited 2 and this would read
            // `send_back`.
            expect(rounds[1]?.outcome).toBe('green');

            // And each round recorded the commit it judged — `rounds.head_sha`
            // (D-5-11-1's residue), written by the round loop when the
            // developer stage reported `committed`, and what a prior round's
            // sticky-comment fold now reads instead of losing its sha.
            for (const round of rounds) {
              expect(round.head_sha).toMatch(/^[0-9a-f]{40}$/);
            }
            expect(rounds[0]?.head_sha).not.toBe(rounds[1]?.head_sha);

            // LOOP-02 (M05 step 5.15): round 2's developer is not handed the
            // identical prompt round 1 got — it carries round 1's own
            // finding as context. Read the SAME persisted artifact 04-09's
            // determinism proof already reads, for round 2's developer
            // attempt specifically (stage_index 0 of the second round).
            const round2Developer = await db
              .selectFrom('stage_attempts')
              .select(['id'])
              .where('round_id', '=', rounds[1]!.id)
              .where('stage_index', '=', 0)
              .executeTakeFirstOrThrow();
            const address = await findAttempt(db, round2Developer.id);
            expect(address).toBeDefined();
            const artifactPath = promptArtifactPathFor(
              logsRootFor(filePath),
              address!,
            );
            const artifact = JSON.parse(
              await readFile(artifactPath, 'utf8'),
            ) as PromptArtifactContent;

            // The exact finding round 1's gate raised — title, detail and
            // criterion — reaches round 2's developer instructions verbatim,
            // not a summary or a paraphrase.
            expect(artifact.instructions).toContain(findings[0]!.title);
            expect(artifact.instructions).toContain(findings[0]!.detail);
            expect(artifact.instructions).not.toContain(
              '(first round — no prior feedback)',
            );

            // And round 1's OWN developer prompt carried no such section —
            // there was nothing to send back yet, which is the negative
            // control proving the assertion above has teeth.
            const round1Developer = await db
              .selectFrom('stage_attempts')
              .select(['id'])
              .where('round_id', '=', rounds[0]!.id)
              .where('stage_index', '=', 0)
              .executeTakeFirstOrThrow();
            const round1Address = await findAttempt(db, round1Developer.id);
            const round1Artifact = JSON.parse(
              await readFile(
                promptArtifactPathFor(logsRootFor(filePath), round1Address!),
                'utf8',
              ),
            ) as PromptArtifactContent;
            expect(round1Artifact.instructions).toContain(
              '(first round — no prior feedback)',
            );

            // ── AC5 / BACK-09 (M05 step 5.18) ────────────────────────────
            //
            // *Every* agent invocation in the loop records its tokens and
            // cost against the feature — every role and every round, not
            // only the first `dev-run` M04 proved. This scenario is the only
            // place in the suite where a real daemon runs more than one
            // round through more than one role, so it is where "every" can
            // actually be checked rather than asserted of a single run.
            const usage = await usageRepository(db).listForFeature(featureId);

            // Two agent invocations happened — round 1's developer and round
            // 2's — and there are exactly two rows. Not three: the gate ran
            // twice (asserted above via the counter file) and invoked no
            // agent either time.
            expect(usage).toHaveLength(2);

            const attempts = await db
              .selectFrom('stage_attempts')
              .select(['id', 'round_id', 'stage_index'])
              .where(
                'round_id',
                'in',
                rounds.map((round) => round.id),
              )
              .execute();
            const developerAttempts = attempts.filter(
              (a) => a.stage_index === 0,
            );
            const gateAttempts = attempts.filter((a) => a.stage_index === 1);
            expect(developerAttempts).toHaveLength(2);
            expect(gateAttempts).toHaveLength(2);

            // One row per round, addressed to that round's own developer
            // attempt. A ledger that recorded twice against round 1, or that
            // attributed round 2's spend to round 1's attempt, would fail
            // here — and both are exactly what "the recording path exists"
            // alone does not rule out.
            expect(usage.map((row) => row.round_id)).toEqual(
              rounds.map((round) => round.id),
            );
            for (const round of rounds) {
              const rowsForRound = usage.filter(
                (row) => row.round_id === round.id,
              );
              expect(rowsForRound).toHaveLength(1);
              const developer = developerAttempts.find(
                (a) => a.round_id === round.id,
              );
              expect(rowsForRound[0]?.stage_attempt_id).toBe(developer?.id);
            }

            // Tokens AND cost, both rounds — `fake-claude-success.mjs`
            // reports a real `total_cost_usd`, so both rows are `reported`
            // rather than degraded. The negative half of D-31 is asserted in
            // `test/usage/recording.test.ts`: a run that reports nothing
            // records `'unknown'`, never a zero.
            for (const row of usage) {
              expect(row.cost_source).toBe('reported');
              expect(row.cost_usd).toBe(0.001);
              expect(row.input_tokens).toBe(10);
              expect(row.output_tokens).toBe(5);
            }

            // And not one row belongs to a gate. A command gate runs
            // `adl.yml`'s test command, not an agent — reporting zero tokens
            // for it would be a claim that an agent ran for free, which
            // `spendByCategory` would fold into the totals as confirmed
            // spend. Silence is the honest answer, and this is what makes it
            // a checked property rather than an accident of the code path.
            const gateAttemptIds = new Set(gateAttempts.map((a) => a.id));
            expect(
              usage.filter((row) =>
                gateAttemptIds.has(row.stage_attempt_id ?? ''),
              ),
            ).toHaveLength(0);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
