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
import { branchNameFor } from '@adl/workspace';
import { githubForgeAdapter } from '@adl/forge-github';
import {
  findAttempt,
  logsRootFor,
  promptArtifactPathFor,
  startDaemon,
  type PromptArtifactContent,
} from '../../src/index.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

/**
 * M05 step 5.19 — the milestone's own tracer, and AC2's proof (LOOP-01,
 * LOOP-02, DETECT-03, FORGE-05).
 *
 * Every prior step in this milestone proved one seam in isolation:
 * `poll-schedule-wiring.test.ts` proves detection alone (dispatch disabled),
 * `draft-cr-wiring.test.ts` proves auto-push-and-draft alone (triggered by a
 * manual `dev-run`, no polling), `command-gate-loop.test.ts` proves the real
 * gate turning the loop alone (no forge at all, so nothing is ever
 * promoted). None of them runs the whole thing — a feature folder committed
 * with no further action, through detection, a real send-back, and a real
 * promotion — in a single daemon lifetime. This is that test.
 *
 * There is **no manual `POST /dev-run` call anywhere in this file.** The only
 * external action is the one commit that seeds the feature folder; every
 * transition after that — enqueue, dispatch, commit, push, draft CR, gate
 * failure, send-back, round 2, gate pass, promotion — happens on the
 * daemon's own background timers (`poll.interval_ms`, `dispatchIntervalMs`),
 * exactly as it would for a real team.
 *
 * **AC2's own rule, restated by construction, not by assertion:** the
 * `commands.test` command ({@link failThenPass}, copied from
 * `command-gate-loop.test.ts`'s own precedent — this file's send-back half
 * is that scenario's, composed with detection and a forge rather than
 * re-derived) fails deterministically the first time it runs and passes
 * every time after. Round 1 cannot pass by luck; the loop is only proven by
 * the round that comes back green *after* a real send-back.
 */

const FORGE_REPO = { owner: 'adl-demo-org', repo: 'full-loop-repo' };
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
 * A `commands.test` that exits non-zero the first time and zero afterwards,
 * keyed on a counter file the test owns rather than the workspace (the
 * workspace is what's under test). Also asserts the developer's commit is
 * really in the tree the second time — D-5-13-1's closed property, exercised
 * again here rather than trusted from `command-gate-loop.test.ts` alone.
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
      "if (runs === 1) { process.stderr.write('FAIL: 1 test failed\\n'); process.exit(1); }",
      "if (!fs.existsSync('agent-output.txt')) { process.stderr.write('the gate cannot see the developer\\\\u2019s commit\\n'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'),
  ];
}

describe('tracer: the whole loop, with no manual dev-run — detection, a real send-back, and a real promotion', () => {
  it(
    'a committed feature folder becomes a draft CR at round 1, sends the developer back once, and promotes to ready (AC1, AC2)',
    { timeout: 120_000 },
    async () => {
      const githubServer = await startMockGithubServer();
      try {
        await withTempDb(async ({ db, filePath }) => {
          await migrateToLatest(db, MIGRATIONS_DIR);

          await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
            const folder = `full-loop-${ulid()}`;
            const featureDir = `features/${folder}`;
            await mkdir(join(mainRepo, featureDir), { recursive: true });
            await writeFile(
              join(mainRepo, featureDir, 'spec.md'),
              '# Title\n\nThe whole loop\n\n## Acceptance Criteria\n\n- The loop closes end to end.\n',
              'utf8',
            );
            await git.add(`${featureDir}/spec.md`);
            await git.raw(['commit', '-m', 'add feature']);
            const defaultBranch = (
              await git.raw(['branch', '--show-current'])
            ).trim();

            // SPEC-06's trust filter has to admit this folder for detection
            // to enqueue it at all — a real check against the mock forge,
            // never the raw git author identity, seeded before the daemon
            // (and its first poll tick) starts.
            githubServer.state.commitAuthorsByPath.set(
              `${defaultBranch}:${featureDir}`,
              'a-maintainer',
            );
            githubServer.state.collaboratorPermissions.set(
              'a-maintainer',
              'write',
            );

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
              poll: { interval_ms: 150 },
              repos: [
                {
                  id: 'repo-1',
                  remote_url:
                    'https://github.com/adl-demo-org/full-loop-repo.git',
                  default_branch: defaultBranch,
                  forge: 'github',
                  features_dir: 'features',
                },
              ],
            });

            const forge = githubForgeAdapter({
              appId: 'adl-full-loop-app',
              privateKey: throwawayPrivateKeyPem(),
              installationId: 1,
              baseUrl: githubServer.url,
              disablePacingForTests: true,
            });
            const bareRemote = join(scratchRoot, '..', 'origin.git');
            await mkdir(bareRemote, { recursive: true });
            await git.raw(['-C', bareRemote, 'init', '--bare']);

            const handle = await startDaemon({
              dbFilePath: filePath,
              port: 0,
              apiToken: `test-token-${ulid()}`,
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
              // Both timers live — unlike `poll-schedule-wiring.test.ts`,
              // which deliberately disables dispatch to isolate polling,
              // this tracer needs the enqueued row to actually run.
              dispatchIntervalMs: 20,
              forge: {
                adapter: forge,
                repo: FORGE_REPO,
                pushCredential: async () => bareRemote,
              },
            });

            try {
              // ── AC1, detection half ──────────────────────────────────
              //
              // No `POST /dev-run` anywhere in this file. The `features`
              // row has to appear through the daemon's own poll schedule,
              // which is DETECT-03's whole job.
              await waitUntil(
                async () =>
                  (await featuresRepository(db).findByPath(
                    'repo-1',
                    featureDir,
                  )) !== undefined,
                { timeoutMs: 20_000 },
              );
              const row = await featuresRepository(db).findByPath(
                'repo-1',
                featureDir,
              );
              const featureId = row!.id;

              // ── AC1, draft-CR half ───────────────────────────────────
              //
              // A real draft change request appears from the round-1
              // commit, with no manual push or `openChangeRequest` call —
              // 5.10's automatic wiring, reached this time through
              // detection rather than a manual dev-run.
              await waitUntil(
                async () => {
                  const open = await forge.listOpenChangeRequests(FORGE_REPO);
                  return open.length > 0;
                },
                { timeoutMs: 20_000 },
              );

              const branch = branchNameFor(
                composeBranchFeatureId(folder, featureId),
              );
              const opened = await forge.listOpenChangeRequests(FORGE_REPO);
              expect(opened).toHaveLength(1);
              expect(opened[0]?.draft).toBe(true);
              expect(opened[0]?.state).toBe('draft');
              expect(opened[0]?.head).toBe(branch);
              const number = opened[0]!.number;

              // ── AC2 ───────────────────────────────────────────────────
              //
              // The one wait that covers the rest of the story: round 1's
              // gate fails, the developer is sent back, round 2's gate
              // passes, and — because a forge is configured this time,
              // unlike `command-gate-loop.test.ts` — the green round
              // promotes the draft. `pr_open` is reachable only through
              // `cr_opened`, which `round-runner.ts`'s `promoteOnGreen`
              // raises only after a real `forge.promoteToReady` call
              // succeeded (`publishing → pr_open`,
              // `@adl/core/state/feature-state.ts`), so this single wait is
              // both AC2's send-back proof and FORGE-05's promotion proof.
              await waitUntil(
                async () => {
                  const current =
                    await featuresRepository(db).findById(featureId);
                  return current?.state === 'pr_open';
                },
                { timeoutMs: 90_000 },
              );

              const rounds = await db
                .selectFrom('rounds')
                .selectAll()
                .where('feature_id', '=', featureId)
                .orderBy('number')
                .execute();

              // AC2's standing rule: the loop is not proven by a feature
              // that passes first try.
              expect(rounds.map((r) => r.outcome)).toEqual([
                'send_back',
                'green',
              ]);

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
              expect(findings[0]?.detail).toContain('FAIL: 1 test failed');

              // The gate ran exactly twice — a loop that silently skipped
              // it would satisfy the round outcomes above without ever
              // running a command.
              expect(Number(await readFile(counterPath, 'utf8'))).toBe(2);

              // Two distinct real commits, one per round.
              for (const r of rounds) {
                expect(r.head_sha).toMatch(/^[0-9a-f]{40}$/);
              }
              expect(rounds[0]?.head_sha).not.toBe(rounds[1]?.head_sha);

              // LOOP-02: round 2's developer carried round 1's finding as
              // context, not an identical prompt.
              const round2Developer = await db
                .selectFrom('stage_attempts')
                .select(['id'])
                .where('round_id', '=', rounds[1]!.id)
                .where('stage_index', '=', 0)
                .executeTakeFirstOrThrow();
              const address = await findAttempt(db, round2Developer.id);
              const artifact = JSON.parse(
                await readFile(
                  promptArtifactPathFor(logsRootFor(filePath), address!),
                  'utf8',
                ),
              ) as PromptArtifactContent;
              expect(artifact.instructions).toContain(findings[0]!.title);
              expect(artifact.instructions).toContain(findings[0]!.detail);

              // ── FORGE-05 / AC2, the promotion itself ────────────────
              //
              // The same change request 5.10 opened as a draft is now
              // ready for review — never merged (ADL never merges,
              // FORGE-10), still open, just no longer a draft.
              const promoted = await forge.listOpenChangeRequests(FORGE_REPO);
              expect(promoted).toHaveLength(1);
              expect(promoted[0]?.number).toBe(number);
              expect(promoted[0]?.draft).toBe(false);
              expect(promoted[0]?.state).toBe('open');

              // ── AC4 ───────────────────────────────────────────────────
              //
              // One sticky comment, not one per round — round 1 folded
              // away, round 2 the current headline.
              await waitUntil(
                () =>
                  (githubServer.state.commentsByIssue.get(number) ?? [])
                    .length > 0,
                { timeoutMs: 10_000 },
              );
              const comments =
                githubServer.state.commentsByIssue.get(number) ?? [];
              expect(comments).toHaveLength(1);
              expect(comments[0]?.body).toContain(
                '<!-- adl:role=developer -->',
              );
              expect(comments[0]?.body).toContain('Round 2');
              expect(comments[0]?.body).toContain('<details>');

              // ── AC5 ───────────────────────────────────────────────────
              //
              // Both developer invocations recorded on the spend ledger —
              // and, since detection admitted this folder at all, SPEC-06's
              // trust filter is exercised for real rather than bypassed by
              // a direct dev-run call.
              const usage = await usageRepository(db).listForFeature(featureId);
              expect(usage).toHaveLength(2);
              for (const u of usage) {
                expect(u.cost_source).toBe('reported');
              }
            } finally {
              await handle.stop();
            }
          });
        });
      } finally {
        await githubServer.close();
      }
    },
  );
});
