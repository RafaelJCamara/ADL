import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { migrateToLatest } from '@adl/db';
import { processIsAlive } from '@adl/workspace';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import {
  findAttempt,
  logsRootFor,
  startDaemon,
  transcriptLength,
  transcriptPathFor,
  type AttemptAddress,
} from '../../src/index.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * `04-06`'s TRACER — the thinnest end-to-end path this whole phase exists to
 * prove: `adl dev-run <feature-id>` against a real `features/<id>/` folder
 * produces a real commit inside that feature's git worktree, made by an
 * agent CLI launched through `Workspace.exec()`, dispatched through the
 * real manager→worker path (a real lease, a real forked child), with its
 * transcript streamed live to `adl logs -f` while it is still running.
 *
 * The agent CLI is a scripted replay double
 * (`test/helpers/fake-claude-slow-success.mjs`) — see this plan's own KNOWN
 * GAP note: `04-01`'s Task 3 real-CLI capture was deferred, so no billed
 * invocation is exercised here or anywhere in this automated suite. The
 * double writes a real file, makes a real git commit using the identity the
 * production stage runner supplies, and emits a small, delayed stream-json
 * transcript so the live-growth assertion below has something real to
 * observe.
 */

const API_TOKEN = `test-token-${ulid()}`;
const FAKE_CLAUDE_SLOW_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-slow-success.mjs', import.meta.url),
);
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 15 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    await delay(intervalMs);
  }
}

/** Resolve `findAttempt` once the round/stage attempt row is visible. */
async function waitForAttempt(
  db: Parameters<typeof findAttempt>[0],
  stageAttemptId: string,
): Promise<AttemptAddress> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const address = await findAttempt(db, stageAttemptId);
    if (address !== undefined) return address;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAttempt: ${stageAttemptId} never resolved`);
    }
    await delay(15);
  }
}

describe('tracer: adl dev-run makes a real commit through a real agent, streamed live', () => {
  it(
    'travels dev-run -> dispatch -> real forked worker -> real Workspace.exec -> a real commit, ' +
      'with the transcript growing live and no orphaned child process left behind',
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const featureId = `export-widgets-${ulid()}`;
          const featureDir = `features/${featureId}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nExport widgets\n\n## Acceptance Criteria\n\n- The export button appears.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);

          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();
          const baseSha = (await git.raw(['rev-parse', defaultBranch])).trim();

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

          // The synthetic single-stage pipeline D-04 specifies: `develop`
          // alone, so dispatching this feature's first (only) stage IS the
          // developer stage this plan exercises — no special-casing lives
          // in `dev-run.ts` itself; it is a property of this fixture's
          // `pipeline`.
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

          const readyPids: number[] = [];

          const handle = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            migrationsDir: MIGRATIONS_DIR,
            leaseTtlMs: 10_000,
            heartbeatIntervalMs: 100,
            daemonConfig,
            resolveAdlYml: () => adlYml,
            mainRepo,
            scratchRoot,
            workerEntryPath: TRACER_WORKER_ENTRY,
            workerExecArgv: ['--import', 'tsx'],
            workerEnv: {
              ADL_TRACER_CLAUDE_BINARY_JSON: JSON.stringify([
                process.execPath,
                FAKE_CLAUDE_SLOW_SUCCESS,
              ]),
              ADL_TRACER_STAGE_DELAY_MS: '250',
            },
            dispatchIntervalMs: 20,
            onWorkerReady: (ready) => readyPids.push(ready.pid),
          });

          try {
            // `adl dev-run <feature-id>` — the real HTTP route, the real
            // bearer auth, exactly what the CLI itself would send.
            const devRunResponse = await fetch(
              `http://127.0.0.1:${handle.port}/dev-run/${featureId}`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${API_TOKEN}` },
              },
            );
            expect(devRunResponse.status).toBe(200);
            const devRunBody = (await devRunResponse.json()) as {
              featureId: string;
              stageAttemptId: string;
            };
            expect(devRunBody.stageAttemptId).toBeTruthy();

            // A real child process was forked — the pid comes from the
            // worker's own `ready` message, exactly as Phase 3's tracer
            // proves for the lease/fork path this plan reuses unchanged.
            await waitUntil(() => readyPids.length > 0);
            const pid = readyPids[0]!;
            expect(processIsAlive(pid)).toBe(true);

            // The transcript file exists and its byte length GROWS between
            // two reads taken while the stage is still running — the
            // buffering anti-pattern `04-RESEARCH.md` names would make this
            // assertion fail (the file would appear all at once, at the end,
            // or not until the process exits).
            const address = await waitForAttempt(db, devRunBody.stageAttemptId);
            const logsRoot = logsRootFor(filePath);
            const transcriptPath = transcriptPathFor(logsRoot, address);

            await waitUntil(
              async () =>
                (await transcriptLength(transcriptPath)) !== undefined,
              {
                timeoutMs: 5000,
              },
            );
            const firstLength = (await transcriptLength(transcriptPath)) ?? 0;
            await waitUntil(
              async () =>
                ((await transcriptLength(transcriptPath)) ?? 0) > firstLength,
              { timeoutMs: 5000 },
            );
            const secondLength = (await transcriptLength(transcriptPath)) ?? 0;
            expect(secondLength).toBeGreaterThan(firstLength);

            // `adl logs -f` attached mid-run receives events before the
            // stage result does — the real HTTP route, read while the
            // worker is still alive.
            const logsResponse = await fetch(
              `http://127.0.0.1:${handle.port}/stages/${devRunBody.stageAttemptId}/logs`,
              { headers: { Authorization: `Bearer ${API_TOKEN}` } },
            );
            expect(logsResponse.status).toBe(200);
            const logsText = await logsResponse.text();
            expect(logsText).toContain('event:');
            expect(processIsAlive(pid)).toBe(true); // still running when we read

            // A real commit exists in the feature's worktree that was not
            // there before — read WHILE the worktree still exists. The
            // production stage runner destroys the workspace (worktree AND
            // its `adl/<folder>--<id>` branch, by design — a leaked worktree
            // is a defect, not a feature) the moment the stage completes, so
            // this has to be observed before that teardown, not after. The
            // worktree lives at `scratchRoot/<folderName>--<devRunBody.featureId>`
            // (DETECT-05, 5.6, `../../src/branch-identity.js`) —
            // `devRunBody.featureId` is the `features` ROW's own ULID
            // (`WorkspaceSpec.featureId`'s identity), composed with this
            // file's own `featureId` local (the human-readable
            // `features/<id>/` folder name, used for the URL path and the
            // folder on disk) rather than either one alone.
            const worktreePath = join(
              scratchRoot,
              composeBranchFeatureId(featureId, devRunBody.featureId),
            );
            let commitSha = '';
            let authorLine = '';
            await waitUntil(
              async () => {
                try {
                  const sha = (
                    await git.raw(['-C', worktreePath, 'rev-parse', 'HEAD'])
                  ).trim();
                  if (sha === '' || sha === baseSha) return false;
                  commitSha = sha;
                  authorLine = (
                    await git.raw([
                      '-C',
                      worktreePath,
                      'log',
                      '-1',
                      '--format=%an <%ae>',
                      sha,
                    ])
                  ).trim();
                  return true;
                } catch {
                  // The worktree may not exist yet, or HEAD may not have
                  // moved yet — both ordinary states while the run is still
                  // in flight.
                  return false;
                }
              },
              { timeoutMs: 10_000 },
            );
            expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
            expect(commitSha).not.toBe(baseSha);
            // The commit's author names ADL and the backend — never the
            // maintainer's/CI's own git identity (`withTempRepo`'s
            // "tracer@adl.invalid" / "ADL Tracer").
            expect(authorLine).toBe(
              'ADL (claude-code) <adl+claude-code@noreply.local>',
            );

            // The run ends — the forked worker exits once its stage result
            // is accepted and reported. Its own teardown removes the
            // worktree and the `adl/<id>` branch; the commit object itself
            // remains in the shared object database (unreachable, not
            // garbage-collected within this test's lifetime).
            await waitUntil(() => !processIsAlive(pid), { timeoutMs: 10_000 });

            // The worker exiting is not the same signal as the MANAGER
            // finishing its own async work on this stage's result (M05 step
            // 5.13's round loop, running in this process, not the worker's) —
            // `onStageCompleted`/`closeAttempt` fire after the worker has
            // already reported and can still be in flight once it exits.
            // Tearing the daemon down mid-flight raced a real `git diff`
            // subprocess (M05 step 5.16's protected-path check) against
            // `withTempDb`'s connection teardown often enough to be worth a
            // real wait rather than a coincidence of the old, faster timing:
            // the round this single-`develop`-stage pipeline produces always
            // closes as `escalate` (5.13's own documented "develop alone"
            // rule), so waiting for `rounds.ended_at` is the direct signal.
            await waitUntil(
              async () => {
                const round = await db
                  .selectFrom('rounds')
                  .select('ended_at')
                  .where('feature_id', '=', devRunBody.featureId)
                  .executeTakeFirst();
                return (
                  round?.ended_at !== null && round?.ended_at !== undefined
                );
              },
              { timeoutMs: 10_000 },
            );
          } finally {
            await handle.stop();
          }

          // Stopping the daemon leaves no child process running.
          for (const pid of readyPids) {
            expect(processIsAlive(pid)).toBe(false);
          }
        });
      });
    },
    30_000,
  );
});
