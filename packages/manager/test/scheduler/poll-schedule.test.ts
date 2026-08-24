import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import {
  runPollOnce,
  startPollSchedule,
} from '../../src/scheduler/poll-schedule.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * `05-05` (DETECT-03) — the polling detection loop: scan -> undeveloped
 * filter -> trust filter -> enqueue, composed for real for the first time.
 * 5.1's scanner, 5.2's `undevelopedFeatures`, and 5.3's `evaluateFeatureTrust`
 * each already have their own isolated suite; this one proves the
 * COMPOSITION — a feature folder actually committed to a real git repository
 * becomes a real `queued` `features` row, an untrusted one does not, and an
 * already-known one is left alone.
 */

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

async function seedRepo(
  db: Kysely<Database>,
  defaultBranch: string,
): Promise<string> {
  const id = ulid();
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/adl-test-org/demo-repo.git',
      default_branch: defaultBranch,
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function commitFeatureFolder(
  mainRepo: string,
  git: {
    add: (path: string) => Promise<unknown>;
    raw: (args: string[]) => Promise<string>;
  },
  folder: string,
): Promise<void> {
  const dir = join(mainRepo, 'features', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'spec.md'),
    `# ${folder}\n\n## Acceptance Criteria\n\n- It works.\n`,
    'utf8',
  );
  await git.add(`features/${folder}/spec.md`);
  await git.raw(['commit', '-m', `add ${folder}`]);
}

function trustAuthor(
  server: Awaited<ReturnType<typeof startMockGithubServer>>,
  defaultBranch: string,
  folder: string,
  login: string,
  permission: 'write' | 'read',
): void {
  server.state.commitAuthorsByPath.set(
    `${defaultBranch}:features/${folder}`,
    login,
  );
  server.state.collaboratorPermissions.set(login, permission);
}

describe('runPollOnce', () => {
  it('enqueues a trusted, undeveloped feature folder as a queued features row', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        await commitFeatureFolder(mainRepo, git, 'dark-mode');
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();
        await seedRepo(db, defaultBranch);

        const server = await startMockGithubServer();
        try {
          trustAuthor(
            server,
            defaultBranch,
            'dark-mode',
            'a-maintainer',
            'write',
          );
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });
          const { logger } = createCapturingLogger();

          const summary = await runPollOnce({
            mainRepo,
            scratchRoot,
            db,
            logger,
            forge,
            forgeRepo: FORGE_REPO,
          });

          expect(summary.enqueued).toEqual(['dark-mode']);
          expect(summary.rejected).toEqual([]);
          expect(summary.failures).toEqual([]);

          const row = await featuresRepository(db).findByPath(
            (
              await db
                .selectFrom('repos')
                .select('id')
                .executeTakeFirstOrThrow()
            ).id,
            'features/dark-mode',
          );
          expect(row?.state).toBe('queued');
          expect(row?.round).toBe(0);
          expect(row?.current_stage_index).toBe(0);
          expect(row?.spec_hash).toHaveLength(64);
          expect(row?.effective_config_json).toBeNull();
        } finally {
          await server.close();
        }
      });
    });
  });

  it('rejects an untrusted feature folder without enqueueing it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        await commitFeatureFolder(mainRepo, git, 'export-widgets');
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();
        const repoId = await seedRepo(db, defaultBranch);

        const server = await startMockGithubServer();
        try {
          trustAuthor(
            server,
            defaultBranch,
            'export-widgets',
            'an-outsider',
            'read',
          );
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });
          const { logger, logs } = createCapturingLogger();

          const summary = await runPollOnce({
            mainRepo,
            scratchRoot,
            db,
            logger,
            forge,
            forgeRepo: FORGE_REPO,
          });

          expect(summary.enqueued).toEqual([]);
          expect(summary.rejected).toEqual([
            { folder: 'export-widgets', reason: 'insufficient-permission' },
          ]);
          expect(
            await featuresRepository(db).findByPath(
              repoId,
              'features/export-widgets',
            ),
          ).toBeUndefined();
          expect(
            logs.some((line) =>
              String(line.msg ?? '').includes('rejected an untrusted'),
            ),
          ).toBe(true);
        } finally {
          await server.close();
        }
      });
    });
  });

  it('leaves an already-known feature folder alone', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        await commitFeatureFolder(mainRepo, git, 'dark-mode');
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();
        const repoId = await seedRepo(db, defaultBranch);

        const now = nowIso();
        const existingId = ulid();
        await db
          .insertInto('features')
          .values({
            id: existingId,
            repo_id: repoId,
            path: 'features/dark-mode',
            state: 'gating',
            state_version: 1,
            round: 1,
            current_stage_index: 0,
            spec_hash: 'a'.repeat(64),
            effective_config_json: null,
            workspace_handle: null,
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
            heartbeat_at: null,
            crash_count: 0,
            created_at: now,
            updated_at: now,
          })
          .execute();

        const server = await startMockGithubServer();
        try {
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });
          const { logger } = createCapturingLogger();

          const summary = await runPollOnce({
            mainRepo,
            scratchRoot,
            db,
            logger,
            forge,
            forgeRepo: FORGE_REPO,
          });

          expect(summary.enqueued).toEqual([]);
          expect(summary.rejected).toEqual([]);
          // The pre-existing row is untouched — still `gating`, not reset to `queued`.
          const row = await featuresRepository(db).findById(existingId);
          expect(row?.state).toBe('gating');
        } finally {
          await server.close();
        }
      });
    });
  });

  it('returns an empty summary and does not throw when no repository is configured', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot }) => {
        const { logger } = createCapturingLogger();
        const forge = githubForgeAdapter({
          appId: 'adl-test-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: 'http://127.0.0.1:1',
          disablePacingForTests: true,
        });

        const summary = await runPollOnce({
          mainRepo,
          scratchRoot,
          db,
          logger,
          forge,
          forgeRepo: FORGE_REPO,
        });

        expect(summary).toEqual({ enqueued: [], rejected: [], failures: [] });
      });
    });
  });
});

describe('startPollSchedule', () => {
  it('ticks on its own cadence and stop() halts further ticks', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        await commitFeatureFolder(mainRepo, git, 'dark-mode');
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();
        const repoId = await seedRepo(db, defaultBranch);

        const server = await startMockGithubServer();
        try {
          trustAuthor(
            server,
            defaultBranch,
            'dark-mode',
            'a-maintainer',
            'write',
          );
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });
          const { logger } = createCapturingLogger();

          const handle = startPollSchedule({
            mainRepo,
            scratchRoot,
            db,
            logger,
            forge,
            forgeRepo: FORGE_REPO,
            intervalMs: 200,
          });

          try {
            // A tick fires on croner's own cadence — wait for the real effect
            // (the row appearing) rather than a fixed sleep tied to the
            // interval, so this assertion is not a race against the timer.
            const deadline = Date.now() + 5000;
            let row;
            do {
              row = await featuresRepository(db).findByPath(
                repoId,
                'features/dark-mode',
              );
              if (row !== undefined) break;
              await delay(25);
            } while (Date.now() < deadline);
            expect(row?.state).toBe('queued');
          } finally {
            handle.stop();
          }

          // Delete the row, then wait well past another interval — if the
          // timer really stopped, no new pass re-enqueues it.
          await db
            .deleteFrom('features')
            .where('repo_id', '=', repoId)
            .execute();
          await delay(500);
          expect(
            await featuresRepository(db).findByPath(
              repoId,
              'features/dark-mode',
            ),
          ).toBeUndefined();
        } finally {
          await server.close();
        }
      });
    });
  }, 15_000);
});
