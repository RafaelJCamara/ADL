import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database, FeaturesTable } from '@adl/db';
import { sql, type Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import { branchNameFor } from '@adl/workspace';
import { publishDraftChangeRequest } from '../../src/publish/draft-cr.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import {
  startMockGithubServer,
  type MockGithubServer,
} from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

let server: MockGithubServer;
let forge: ReturnType<typeof githubForgeAdapter>;

beforeEach(async () => {
  server = await startMockGithubServer();
  forge = githubForgeAdapter({
    appId: 'adl-test-app',
    privateKey: throwawayPrivateKeyPem(),
    installationId: 1,
    baseUrl: server.url,
    disablePacingForTests: true,
  });
});

afterEach(async () => {
  await server.close();
});

async function seedRepo(
  db: Kysely<Database>,
  defaultBranch = 'main',
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

async function seedFeature(
  db: Kysely<Database>,
  repoId: string,
  path: string,
): Promise<FeaturesTable> {
  const now = nowIso();
  const id = ulid();
  await db
    .insertInto('features')
    .values({
      id,
      repo_id: repoId,
      path,
      state: 'developing',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: 'manager',
      lease_token: ulid(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await featuresRepository(db).findById(id))!;
}

describe('publishDraftChangeRequest', () => {
  it('opens a real draft change request against the branch a real dispatch would push', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db, 'main');
      const feature = await seedFeature(db, repoId, 'features/dark-mode');
      const { logger } = createCapturingLogger();

      await publishDraftChangeRequest(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        { feature, sha: 'a'.repeat(40) },
      );

      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open).toHaveLength(1);
      expect(open[0]?.draft).toBe(true);
      expect(open[0]?.head).toBe(
        branchNameFor(composeBranchFeatureId('dark-mode', feature.id)),
      );
      expect(server.state.pulls[0]?.base).toBe('main');
      expect(server.state.pulls[0]?.title).toContain('dark-mode');
    });
  });

  it('does not open a second draft when one is already open for the same branch (idempotent)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const feature = await seedFeature(db, repoId, 'features/dark-mode');
      const { logger } = createCapturingLogger();

      await publishDraftChangeRequest(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        { feature, sha: 'a'.repeat(40) },
      );
      await publishDraftChangeRequest(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        { feature, sha: 'b'.repeat(40) },
      );

      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open).toHaveLength(1);
    });
  });

  it('two different features each get their own draft change request', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const first = await seedFeature(db, repoId, 'features/dark-mode');
      const second = await seedFeature(db, repoId, 'features/export-widgets');
      const { logger } = createCapturingLogger();

      await publishDraftChangeRequest(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        { feature: first, sha: 'a'.repeat(40) },
      );
      await publishDraftChangeRequest(
        { db, logger, forge, forgeRepo: FORGE_REPO },
        { feature: second, sha: 'b'.repeat(40) },
      );

      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open).toHaveLength(2);
    });
  });

  it('logs and returns cleanly rather than throwing when the repos row is missing', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // `features.repo_id` is FK-enforced against `repos.id` in normal
      // operation (D-35's reconciliation always inserts the repo row
      // first) — matching `test/ipc/assign-workspace.test.ts`'s own
      // "no repos row" case, this state is reached here only by disabling
      // the constraint for this one seed, to prove the defensive check for
      // a repo row removed out from under a feature between reconciliation
      // runs.
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      const feature = await seedFeature(
        db,
        'no-such-repo',
        'features/dark-mode',
      );
      await sql`PRAGMA foreign_keys = ON`.execute(db);
      const { logger, logs } = createCapturingLogger();

      await expect(
        publishDraftChangeRequest(
          { db, logger, forge, forgeRepo: FORGE_REPO },
          { feature, sha: 'a'.repeat(40) },
        ),
      ).resolves.toBeUndefined();

      expect(logs.some((l) => l.msg?.includes('no repos row'))).toBe(true);
      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open).toHaveLength(0);
    });
  });

  it('logs and returns cleanly rather than throwing when the forge call fails', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const feature = await seedFeature(db, repoId, 'features/dark-mode');
      const { logger, logs } = createCapturingLogger();

      // A forge adapter pointed at an address nothing is listening on — a
      // real connection failure, not a mocked/simulated one. Started and
      // immediately closed rather than reusing/closing the shared `server`,
      // so this test's own cleanup can't race the shared `afterEach`'s.
      const deadServer = await startMockGithubServer();
      await deadServer.close();
      const deadForge = githubForgeAdapter({
        appId: 'adl-test-app',
        privateKey: throwawayPrivateKeyPem(),
        installationId: 1,
        baseUrl: deadServer.url,
        disablePacingForTests: true,
      });

      await expect(
        publishDraftChangeRequest(
          { db, logger, forge: deadForge, forgeRepo: FORGE_REPO },
          { feature, sha: 'a'.repeat(40) },
        ),
      ).resolves.toBeUndefined();

      expect(
        logs.some((l) =>
          l.msg?.includes('could not open a draft change request'),
        ),
      ).toBe(true);
    });
  });
});
