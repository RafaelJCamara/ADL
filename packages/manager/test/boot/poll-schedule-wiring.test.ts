import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { migrateToLatest } from '@adl/db';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import { githubForgeAdapter } from '@adl/forge-github';
import { startDaemon } from '../../src/index.js';
import type { FeatureView } from '../../src/api/routes/features.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

const API_TOKEN = `poll-wiring-token-${ulid()}`;
const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
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

/**
 * `05-05` (DETECT-03) — proving the wiring, not re-proving the detection
 * logic (`test/scheduler/poll-schedule.test.ts` already owns that): a real
 * `startDaemon()` with `options.forge` supplied actually starts the poll
 * schedule, and a feature folder committed to a real repository shows up
 * through `GET /features` with no `adl dev-run` and no manual call into
 * `runPollOnce` — the loop's own background timer does it. `dispatchIntervalMs`
 * is set far longer than the test's own timeout so the dispatcher never
 * forks a worker for the row this test observes; that is 5.13's concern.
 */
describe('startDaemon — the poll schedule (05-05)', () => {
  it('enqueues a committed feature folder through GET /features when options.forge is supplied', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureDir = join(mainRepo, 'features', 'dark-mode');
        await mkdir(featureDir, { recursive: true });
        await writeFile(
          join(featureDir, 'spec.md'),
          '# Dark mode\n\n## Acceptance Criteria\n\n- A dark theme toggle appears.\n',
          'utf8',
        );
        await git.add('features/dark-mode/spec.md');
        await git.raw(['commit', '-m', 'add feature']);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const server = await startMockGithubServer();
        try {
          server.state.commitAuthorsByPath.set(
            `${defaultBranch}:features/dark-mode`,
            'a-maintainer',
          );
          server.state.collaboratorPermissions.set('a-maintainer', 'write');
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });

          const daemonConfig = DaemonConfigSchema.parse({
            api: { token: API_TOKEN },
            poll: { interval_ms: 100 },
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

          const handle = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: API_TOKEN,
            migrationsDir: MIGRATIONS_DIR,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig,
            resolveAdlYml: () => adlYml,
            mainRepo,
            scratchRoot,
            // Effectively disabled for this test's whole window — this test
            // observes the POLL schedule's effect, never dispatch's.
            dispatchIntervalMs: 60_000,
            forge: { adapter: forge, repo: FORGE_REPO },
          });

          try {
            await waitUntil(async () => {
              const response = await fetch(
                `http://127.0.0.1:${handle.port}/features`,
                { headers: { Authorization: `Bearer ${API_TOKEN}` } },
              );
              const features = (await response.json()) as FeatureView[];
              return features.some((f) => f.path === 'features/dark-mode');
            });

            const response = await fetch(
              `http://127.0.0.1:${handle.port}/features`,
              { headers: { Authorization: `Bearer ${API_TOKEN}` } },
            );
            const features = (await response.json()) as FeatureView[];
            const row = features.find((f) => f.path === 'features/dark-mode');
            expect(row?.state).toBe('queued');
          } finally {
            await handle.stop();
          }
        } finally {
          await server.close();
        }
      });
    });
  }, 20_000);

  it('never starts the poll schedule when options.forge is absent — no row appears', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureDir = join(mainRepo, 'features', 'dark-mode');
        await mkdir(featureDir, { recursive: true });
        await writeFile(
          join(featureDir, 'spec.md'),
          '# Dark mode\n\n## Acceptance Criteria\n\n- A dark theme toggle appears.\n',
          'utf8',
        );
        await git.add('features/dark-mode/spec.md');
        await git.raw(['commit', '-m', 'add feature']);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const daemonConfig = DaemonConfigSchema.parse({
          api: { token: API_TOKEN },
          poll: { interval_ms: 100 },
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

        const handle = await startDaemon({
          dbFilePath: filePath,
          port: 0,
          apiToken: API_TOKEN,
          migrationsDir: MIGRATIONS_DIR,
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          daemonConfig,
          resolveAdlYml: () => adlYml,
          mainRepo,
          scratchRoot,
          dispatchIntervalMs: 60_000,
          // No `forge` — the poll schedule must not start at all.
        });

        try {
          // Long enough for several would-be 100ms poll ticks.
          await delay(600);
          const response = await fetch(
            `http://127.0.0.1:${handle.port}/features`,
            { headers: { Authorization: `Bearer ${API_TOKEN}` } },
          );
          const features = (await response.json()) as FeatureView[];
          expect(features.some((f) => f.path === 'features/dark-mode')).toBe(
            false,
          );
        } finally {
          await handle.stop();
        }
      });
    });
  }, 20_000);
});
