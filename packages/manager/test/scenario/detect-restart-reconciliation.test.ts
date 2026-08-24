import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import { startDaemon } from '../../src/daemon.js';
import { runPollOnce } from '../../src/scheduler/poll-schedule.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';
import { withHeldWorker } from '../helpers/worker-harness.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * DETECT-05, M05 step 5.6 — exclusive claim + restart reconciliation.
 *
 * The two halves the milestone doc names are already built by earlier
 * steps: the lease CAS (`FeaturesRepository.acquireLease` +
 * `dispatchOnce`'s CAS write, M02/M03) makes a claim exclusive, and 5.2's
 * `undevelopedFeatures` — already the first thing 5.5's production poll
 * loop calls — refuses to re-admit a folder with a known `features` row OR
 * a currently-open change request. Nothing here re-proves either mechanism
 * in isolation; those each have their own suite. What had never been
 * exercised together before this file is the COMPOSITION: a feature
 * detected and dispatched for real, re-detected while still in flight, and
 * re-detected again after the daemon that dispatched it is gone and a fresh
 * one boots against the same database and repository.
 */

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

const ADL_YML_FIXTURE: AdlYml = AdlYmlSchema.parse({
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
  pipeline: ['develop'],
});

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
    add: (p: string) => Promise<unknown>;
    raw: (a: string[]) => Promise<string>;
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
): void {
  server.state.commitAuthorsByPath.set(
    `${defaultBranch}:features/${folder}`,
    login,
  );
  server.state.collaboratorPermissions.set(login, 'write');
}

function daemonConfigFixture(): ReturnType<typeof DaemonConfigSchema.parse> {
  return DaemonConfigSchema.parse({
    concurrency: { global: 1 },
    lease_ttl_ms: 100_000,
    heartbeat_interval_ms: 50,
    worker_stop_grace_ms: 200,
    poll: { interval_ms: 200 },
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 20 } = {},
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

describe('DETECT-05: exclusive claim survives re-detection and a daemon restart', () => {
  it('a feature already dispatched is left alone by re-detection, and by a fresh daemon after a restart', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      await commitFeatureFolder(mainRepo, git, 'dark-mode');
      const defaultBranch = (
        await git.raw(['branch', '--show-current'])
      ).trim();

      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        const repoId = await seedRepo(db, defaultBranch);

        const server = await startMockGithubServer();
        try {
          trustAuthor(server, defaultBranch, 'dark-mode', 'a-maintainer');
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });

          const worker = withHeldWorker();
          const daemonConfig = daemonConfigFixture();
          const { logger: logger1 } = createCapturingLogger();

          const handle1 = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: `scenario-token-${ulid()}`,
            leaseTtlMs: daemonConfig.lease_ttl_ms,
            heartbeatIntervalMs: daemonConfig.heartbeat_interval_ms,
            daemonConfig,
            resolveAdlYml: () => ADL_YML_FIXTURE,
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
            workerEntryPath: worker.entryPath,
            workerCwd: worker.cwd,
            workerExecArgv: [...worker.execArgv],
            forge: { adapter: forge, repo: FORGE_REPO },
            logger: logger1,
          });

          const repo = featuresRepository(db);
          let leasedRowId: string;

          try {
            // Detected, enqueued, AND leased — dispatchOnce's CAS write
            // moves queued -> leased synchronously, before the (held,
            // never-completing) worker is even forked.
            await waitUntil(async () => {
              const row = await repo.findByPath(repoId, 'features/dark-mode');
              return row?.state === 'leased';
            });

            const afterFirstLease = await repo.findByPath(
              repoId,
              'features/dark-mode',
            );
            leasedRowId = afterFirstLease!.id;

            // Re-detection while still in flight: let several more poll
            // ticks (200ms apiece) run against the SAME live daemon.
            await delay(650);

            const allRowsWhileLeased = await db
              .selectFrom('features')
              .selectAll()
              .where('repo_id', '=', repoId)
              .execute();
            expect(allRowsWhileLeased).toHaveLength(1);
            expect(allRowsWhileLeased[0]?.id).toBe(leasedRowId);
            expect(allRowsWhileLeased[0]?.state).toBe('leased');
          } finally {
            await handle1.stop();
          }

          // --- Restart: a fresh startDaemon() against the SAME on-disk
          // database and the SAME repository. Boot's unconditional lease
          // expiry (D-13) reclaims the dangling lease `stop()` may have
          // left mid-teardown, and the fresh poll schedule re-detects
          // features/dark-mode all over again.
          const { logger: logger2 } = createCapturingLogger();
          const handle2 = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: `scenario-token-${ulid()}`,
            leaseTtlMs: daemonConfig.lease_ttl_ms,
            heartbeatIntervalMs: daemonConfig.heartbeat_interval_ms,
            daemonConfig,
            resolveAdlYml: () => ADL_YML_FIXTURE,
            migrationsDir: MIGRATIONS_DIR,
            mainRepo,
            scratchRoot,
            workerEntryPath: worker.entryPath,
            workerCwd: worker.cwd,
            workerExecArgv: [...worker.execArgv],
            forge: { adapter: forge, repo: FORGE_REPO },
            logger: logger2,
          });

          try {
            // Boot recovers the dangling lease to `queued` immediately;
            // give the fresh poll schedule a few ticks too.
            await waitUntil(async () => {
              const row = await repo.findByPath(repoId, 'features/dark-mode');
              return row !== undefined && row.lease_token === null;
            });
            await delay(650);

            const allRowsAfterRestart = await db
              .selectFrom('features')
              .selectAll()
              .where('repo_id', '=', repoId)
              .execute();

            // Still exactly one row for this folder, still the SAME row
            // — a restart plus repeated re-detection never produced a
            // second `features` row for the folder that was already
            // being worked on.
            expect(allRowsAfterRestart).toHaveLength(1);
            expect(allRowsAfterRestart[0]?.id).toBe(leasedRowId);
            // Recovered and re-leaseable — never stuck.
            expect(['queued', 'leased']).toContain(
              allRowsAfterRestart[0]?.state,
            );
          } finally {
            await handle2.stop();
          }
        } finally {
          await server.close();
        }
      });
    });
  }, 30_000);
});

describe('DETECT-05: a lost features row is reconciled against a REAL production branch', () => {
  it('runPollOnce does not re-enqueue a folder whose change request is still open, matched through the composed <folder>--<ulid> branch a real dispatch creates', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      await commitFeatureFolder(mainRepo, git, 'dark-mode');
      const defaultBranch = (
        await git.raw(['branch', '--show-current'])
      ).trim();

      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        const repoId = await seedRepo(db, defaultBranch);

        const server = await startMockGithubServer();
        try {
          trustAuthor(server, defaultBranch, 'dark-mode', 'a-maintainer');
          const forge = githubForgeAdapter({
            appId: 'adl-test-app',
            privateKey: throwawayPrivateKeyPem(),
            installationId: 1,
            baseUrl: server.url,
            disablePacingForTests: true,
          });

          // Simulates: a PRIOR daemon life already dispatched
          // features/dark-mode, a real worker created a worktree and
          // opened a change request off a branch named the way
          // `stage-runner.ts` really names one — folder basename and row
          // ULID composed together — and then, before that daemon's next
          // boot, its `features` row was lost. No row for `dark-mode`
          // exists in THIS fresh database at all.
          await forge.openChangeRequest({
            repo: FORGE_REPO,
            head: `adl/${composeBranchFeatureId('dark-mode', ulid())}`,
            base: defaultBranch,
            title: 'Dark mode',
            body: 'body',
            draft: true,
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

          // Not re-enqueued: the open change request already accounts
          // for it, decoded correctly from the real branch shape.
          expect(summary.enqueued).toEqual([]);
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
  }, 20_000);
});
