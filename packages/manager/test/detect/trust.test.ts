import { describe, expect, it } from 'vitest';
import { githubForgeAdapter } from '@adl/forge-github';
import { evaluateFeatureTrust } from '../../src/detect/trust.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

describe('evaluateFeatureTrust', () => {
  it('trusts a folder whose most recent author has write access, rejects one whose author does not', async () => {
    const server = await startMockGithubServer();
    try {
      const forge = githubForgeAdapter({
        appId: 'adl-test-app',
        privateKey: throwawayPrivateKeyPem(),
        installationId: 1,
        baseUrl: server.url,
        disablePacingForTests: true,
      });

      server.state.commitAuthorsByPath.set(
        'main:features/dark-mode',
        'a-maintainer',
      );
      server.state.collaboratorPermissions.set('a-maintainer', 'write');

      server.state.commitAuthorsByPath.set(
        'main:features/export-widgets',
        'an-outsider',
      );
      server.state.collaboratorPermissions.set('an-outsider', 'read');

      const results = await evaluateFeatureTrust({
        folders: ['dark-mode', 'export-widgets'],
        featuresDir: 'features',
        defaultBranch: 'main',
        forge,
        forgeRepo: FORGE_REPO,
      });

      expect(results).toEqual([
        { folder: 'dark-mode', decision: { kind: 'trusted' } },
        {
          folder: 'export-widgets',
          decision: { kind: 'untrusted', reason: 'insufficient-permission' },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('rejects a folder with no resolvable author as unresolvable-author, not insufficient-permission', async () => {
    const server = await startMockGithubServer();
    try {
      const forge = githubForgeAdapter({
        appId: 'adl-test-app',
        privateKey: throwawayPrivateKeyPem(),
        installationId: 1,
        baseUrl: server.url,
        disablePacingForTests: true,
      });
      // No commitAuthorsByPath entry at all — the mock server's "no commit
      // found" case, same as a real folder git never recorded a match for.

      const results = await evaluateFeatureTrust({
        folders: ['no-history'],
        featuresDir: 'features',
        defaultBranch: 'main',
        forge,
        forgeRepo: FORGE_REPO,
      });

      expect(results).toEqual([
        {
          folder: 'no-history',
          decision: { kind: 'untrusted', reason: 'unresolvable-author' },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('returns empty for an empty folder list', async () => {
    const server = await startMockGithubServer();
    try {
      const forge = githubForgeAdapter({
        appId: 'adl-test-app',
        privateKey: throwawayPrivateKeyPem(),
        installationId: 1,
        baseUrl: server.url,
        disablePacingForTests: true,
      });

      const results = await evaluateFeatureTrust({
        folders: [],
        featuresDir: 'features',
        defaultBranch: 'main',
        forge,
        forgeRepo: FORGE_REPO,
      });

      expect(results).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
