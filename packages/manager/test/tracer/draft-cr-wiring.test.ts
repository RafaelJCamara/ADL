import { mkdir, writeFile } from 'node:fs/promises';
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
import { branchNameFor } from '@adl/workspace';
import { githubForgeAdapter } from '@adl/forge-github';
import { startDaemon } from '../../src/index.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

/**
 * M05 step 5.10's own tracer — the AUTOMATIC version of what 5.0b's
 * `detect-to-draft-cr-end-to-end.test.ts` proved by hand. That tracer's own
 * docblock names this file's job explicitly: "the automatic wiring
 * (draft-at-round-1, promote-when-green) is 5.10 and 5.13's job."
 *
 * `POST /dev-run/:featureId` against a real `startDaemon()` configured with
 * a real `forge` (a real GitHub App auth flow, against a local mock GitHub
 * HTTP server) drives a real forked worker through a real commit — no
 * manual stitching of push/openChangeRequest, unlike the 5.0b tracer, which
 * called each step directly rather than through the scheduler nobody could
 * single-step through at the time.
 */

const API_TOKEN = `test-token-${ulid()}`;
const FORGE_REPO = { owner: 'adl-demo-org', repo: 'demo-repo' };
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

describe('tracer: a committed dev-run automatically pushes and opens a draft change request', () => {
  it('no manual stitching: dev-run -> dispatch -> real forked worker -> real commit -> real push -> real draft CR', async () => {
    const githubServer = await startMockGithubServer();
    try {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const featureId = `dark-mode-${ulid()}`;
          const featureDir = `features/${featureId}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nDark mode\n\n## Acceptance Criteria\n\n- A toggle appears in settings.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);

          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            repos: [
              {
                id: 'repo-1',
                remote_url: 'https://github.com/adl-demo-org/demo-repo.git',
                default_branch: defaultBranch,
                forge: 'github',
                features_dir: 'features',
              },
            ],
          });

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

          // The real forge adapter and push credential, threaded through
          // `StartDaemonOptions.forge` exactly as a real `adl daemon
          // start` (`cli-entry.ts`, 5.10's own `buildForgeOption`) would —
          // the mock GitHub server standing in for `api.github.com`, and a
          // local bare remote standing in for a real credentialed
          // `https://x-access-token:...@github.com/...` push target
          // (`ManagerGitClient.push` takes any git-pushable URL; the
          // credentialed-URL FORMATTING itself is unit-tested in
          // `packages/forge-github/test/repo-ref.test.ts` and does not
          // need a second, slower proof here).
          const forge = githubForgeAdapter({
            appId: 'adl-tracer-app',
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
            },
            dispatchIntervalMs: 20,
            forge: {
              adapter: forge,
              repo: FORGE_REPO,
              pushCredential: async () => bareRemote,
            },
          });

          try {
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
            };

            // No manual push, no manual openChangeRequest — a real draft
            // CR appears against the mock server on its own, from the real
            // commit this dev-run produces.
            await waitUntil(
              async () => {
                const open = await forge.listOpenChangeRequests(FORGE_REPO);
                return open.length > 0;
              },
              { timeoutMs: 15_000 },
            );

            const branch = branchNameFor(
              composeBranchFeatureId(featureId, devRunBody.featureId),
            );
            const open = await forge.listOpenChangeRequests(FORGE_REPO);
            expect(open).toHaveLength(1);
            expect(open[0]?.draft).toBe(true);
            expect(open[0]?.head).toBe(branch);
            expect(open[0]?.state).toBe('draft');

            // The branch really is on the (local, standing in for a real
            // credentialed) remote, at the commit the worker made.
            const pushedSha = (
              await git.raw([
                '-C',
                bareRemote,
                'rev-parse',
                `refs/heads/${branch}`,
              ])
            ).trim();
            expect(pushedSha).toMatch(/^[0-9a-f]{40}$/);
          } finally {
            await handle.stop();
          }
        });
      });
    } finally {
      await githubServer.close();
    }
  }, 30_000);
});
