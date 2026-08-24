import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database } from '@adl/db';
import type { Kysely } from 'kysely';
import { githubForgeAdapter } from '@adl/forge-github';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import { undevelopedFeatures } from '../../src/detect/undeveloped.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

async function seedRepo(db: Kysely<Database>): Promise<string> {
  const id = ulid();
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/adl-test-org/demo-repo.git',
      default_branch: 'main',
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
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('features')
    .values({
      id: ulid(),
      repo_id: repoId,
      path,
      state: 'queued',
      state_version: 1,
      round: 0,
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
}

describe('undevelopedFeatures', () => {
  it('excludes a folder with a known features row and a folder with an open change request, keeps the rest', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, repoId, 'features/dark-mode');

      const server = await startMockGithubServer();
      try {
        const forge = githubForgeAdapter({
          appId: 'adl-test-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: server.url,
          disablePacingForTests: true,
        });
        // Simulates a features row lost since the change request was opened
        // — the DB-loss reconciliation case, still not re-admitted. The
        // branch is the REAL shape a dispatch actually creates (DETECT-05,
        // 5.6): the folder's basename and the row's own (now-lost) ULID,
        // composed together — never just the bare folder name, which is
        // what production would have if a `features` row survived to tell
        // it apart, exactly the case this test is not.
        await forge.openChangeRequest({
          repo: FORGE_REPO,
          head: `adl/${composeBranchFeatureId('export-widgets', ulid())}`,
          base: 'main',
          title: 'Export widgets',
          body: 'body',
          draft: true,
        });

        const result = await undevelopedFeatures({
          scannedFolders: ['dark-mode', 'export-widgets', 'new-feature'],
          featuresDir: 'features',
          repoId,
          featuresRepo: featuresRepository(db),
          forge,
          forgeRepo: FORGE_REPO,
        });

        expect(result).toEqual(['new-feature']);
      } finally {
        await server.close();
      }
    });
  });

  it('excludes a folder behind a bare, non-composed open change request branch too — never dropped for failing to decode', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);

      const server = await startMockGithubServer();
      try {
        const forge = githubForgeAdapter({
          appId: 'adl-test-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: server.url,
          disablePacingForTests: true,
        });
        // A bare `adl/<folder>` branch, no composed `--<ulid>` suffix — the
        // shape `test/tracer/detect-to-draft-cr-end-to-end.test.ts` still
        // constructs (it builds its own workspace directly, bypassing
        // `stage-runner.ts`'s compose call), and the shape every branch had
        // before DETECT-05's encoding existed. `folderNameOf` must fall
        // back to treating the whole remainder as the folder name here,
        // never drop the entry outright.
        await forge.openChangeRequest({
          repo: FORGE_REPO,
          head: 'adl/export-widgets',
          base: 'main',
          title: 'Export widgets',
          body: 'body',
          draft: true,
        });

        const result = await undevelopedFeatures({
          scannedFolders: ['export-widgets', 'new-feature'],
          featuresDir: 'features',
          repoId,
          featuresRepo: featuresRepository(db),
          forge,
          forgeRepo: FORGE_REPO,
        });

        expect(result).toEqual(['new-feature']);
      } finally {
        await server.close();
      }
    });
  });

  it('returns every scanned folder undeveloped when nothing is known and nothing is open', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);

      const server = await startMockGithubServer();
      try {
        const forge = githubForgeAdapter({
          appId: 'adl-test-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: server.url,
          disablePacingForTests: true,
        });

        const result = await undevelopedFeatures({
          scannedFolders: ['dark-mode', 'export-widgets'],
          featuresDir: 'features',
          repoId,
          featuresRepo: featuresRepository(db),
          forge,
          forgeRepo: FORGE_REPO,
        });

        expect(result).toEqual(['dark-mode', 'export-widgets']);
      } finally {
        await server.close();
      }
    });
  });

  it("ignores an open change request whose branch is not one of ADL's own", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);

      const server = await startMockGithubServer();
      try {
        const forge = githubForgeAdapter({
          appId: 'adl-test-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: server.url,
          disablePacingForTests: true,
        });
        // A human's own PR, unrelated to ADL — its branch carries no
        // `adl/` prefix, so `featureIdFromBranch` must not match it to
        // any scanned folder.
        await forge.openChangeRequest({
          repo: FORGE_REPO,
          head: 'dark-mode',
          base: 'main',
          title: "A human's PR",
          body: 'body',
          draft: false,
        });

        const result = await undevelopedFeatures({
          scannedFolders: ['dark-mode'],
          featuresDir: 'features',
          repoId,
          featuresRepo: featuresRepository(db),
          forge,
          forgeRepo: FORGE_REPO,
        });

        expect(result).toEqual(['dark-mode']);
      } finally {
        await server.close();
      }
    });
  });
});
