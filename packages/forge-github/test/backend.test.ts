import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubForgeAdapter } from '../src/backend.js';
import {
  startMockGithubServer,
  type MockGithubServer,
} from './helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from './helpers/throwaway-key.js';

const REPO = { owner: 'adl-test-org', repo: 'demo-repo' };

let server: MockGithubServer;
let adapter: ReturnType<typeof githubForgeAdapter>;

beforeEach(async () => {
  server = await startMockGithubServer();
  adapter = githubForgeAdapter({
    appId: 'test-app-id',
    privateKey: throwawayPrivateKeyPem(),
    installationId: 99,
    baseUrl: server.url,
    disablePacingForTests: true,
  });
});

afterEach(async () => {
  await server.close();
});

describe('githubForgeAdapter', () => {
  it('has the id "github"', () => {
    expect(adapter.id).toBe('github');
  });

  it('paces write requests by default — disablePacingForTests is what makes every other case in this file fast', async () => {
    const paced = githubForgeAdapter({
      appId: 'test-app-id',
      privateKey: throwawayPrivateKeyPem(),
      installationId: 99,
      baseUrl: server.url,
      // disablePacingForTests deliberately omitted.
    });

    const start = Date.now();
    await paced.openChangeRequest({
      repo: REPO,
      head: 'adl/paced-1',
      base: 'main',
      title: 'paced 1',
      body: 'body',
      draft: true,
    });
    await paced.openChangeRequest({
      repo: REPO,
      head: 'adl/paced-2',
      base: 'main',
      title: 'paced 2',
      body: 'body',
      draft: true,
    });
    const elapsedMs = Date.now() - start;

    // The pacing plugin schedules roughly one write per second; two
    // writes with no override takes noticeably longer than the ~20ms
    // every other (unpaced) test in this file measures for the same
    // pair of calls — a coarse threshold, not a tight timing assertion,
    // because the exact pacing interval is @octokit/plugin-throttling's
    // to change, not this adapter's contract.
    expect(elapsedMs).toBeGreaterThan(500);
  }, 10_000);

  it('opens a real draft change request through a real signed App-auth JWT exchange', async () => {
    const cr = await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/dark-mode',
      base: 'main',
      title: 'Dark mode',
      body: 'Implements dark mode.',
      draft: true,
    });

    expect(cr.draft).toBe(true);
    expect(cr.state).toBe('draft');
    expect(cr.number).toBeGreaterThan(0);
    expect(cr.url).toContain('/pull/');
    expect(cr.id).toBeTruthy();
    expect(cr.head).toBe('adl/dark-mode');

    // The installation-token exchange really happened over HTTP, with a
    // genuine JWT (three base64url segments) the mock server's own regex
    // guard would have rejected as 401 if it were anything else.
    expect(
      server.state.authorizationHeadersSeen.some((header) =>
        /^bearer [^.]+\.[^.]+\.[^.]+$/i.test(header),
      ),
    ).toBe(true);
  });

  it('promotes a draft to ready through the GraphQL mutation, never the reverse', async () => {
    const opened = await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/dark-mode',
      base: 'main',
      title: 'Dark mode',
      body: 'body',
      draft: true,
    });

    const promoted = await adapter.promoteToReady({
      repo: REPO,
      number: opened.number,
    });

    expect(promoted.draft).toBe(false);
    expect(promoted.state).toBe('open');
    expect(promoted.number).toBe(opened.number);
    expect(promoted.head).toBe('adl/dark-mode');
  });

  it('creates one comment, then edits it in place on a second call with the same key (FORGE-06)', async () => {
    const opened = await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/dark-mode',
      base: 'main',
      title: 'Dark mode',
      body: 'body',
      draft: true,
    });

    await adapter.upsertComment({
      repo: REPO,
      number: opened.number,
      key: 'developer',
      body: 'round 1 summary',
    });
    await adapter.upsertComment({
      repo: REPO,
      number: opened.number,
      key: 'developer',
      body: 'round 2 summary',
    });

    const comments = server.state.commentsByIssue.get(opened.number) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('round 2 summary');
    expect(comments[0]?.body).not.toContain('round 1 summary');
  });

  it('creates a separate comment per role key', async () => {
    const opened = await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/dark-mode',
      base: 'main',
      title: 'Dark mode',
      body: 'body',
      draft: true,
    });

    await adapter.upsertComment({
      repo: REPO,
      number: opened.number,
      key: 'developer',
      body: 'developer summary',
    });
    await adapter.upsertComment({
      repo: REPO,
      number: opened.number,
      key: 'reviewer',
      body: 'reviewer summary',
    });

    const comments = server.state.commentsByIssue.get(opened.number) ?? [];
    expect(comments).toHaveLength(2);
  });

  it('lists open change requests', async () => {
    await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/dark-mode',
      base: 'main',
      title: 'Dark mode',
      body: 'body',
      draft: true,
    });
    await adapter.openChangeRequest({
      repo: REPO,
      head: 'adl/export-widgets',
      base: 'main',
      title: 'Export widgets',
      body: 'body',
      draft: true,
    });

    const open = await adapter.listOpenChangeRequests(REPO);
    expect(open).toHaveLength(2);
    expect(open.map((cr) => cr.state)).toEqual(['draft', 'draft']);
    expect(open.map((cr) => cr.head)).toEqual([
      'adl/dark-mode',
      'adl/export-widgets',
    ]);
  });

  it('reads a file at a ref', async () => {
    server.state.files.set(
      'main:features/dark-mode/spec.md',
      '# Dark mode\n\nAcceptance criteria.\n',
    );

    const content = await adapter.readFile({
      repo: REPO,
      ref: 'main',
      path: 'features/dark-mode/spec.md',
    });

    expect(content).toBe('# Dark mode\n\nAcceptance criteria.\n');
  });

  it('reads a diff between base and head', async () => {
    const diffText =
      'diff --git a/spec.md b/spec.md\n' +
      'index 0000000..1111111 100644\n' +
      '--- a/spec.md\n' +
      '+++ b/spec.md\n' +
      '@@ -1 +1,2 @@\n' +
      ' # Dark mode\n' +
      '+more\n';
    server.state.diffs.set('main...adl/dark-mode', diffText);

    const diff = await adapter.readDiff({
      repo: REPO,
      base: 'main',
      head: 'adl/dark-mode',
    });

    expect(diff).toBe(diffText);
  });

  it("reports the write-permission author's real permission level", async () => {
    server.state.commitAuthorsByPath.set(
      'main:features/dark-mode/spec.md',
      'a-maintainer',
    );
    server.state.collaboratorPermissions.set('a-maintainer', 'write');

    const permission = await adapter.authorPermission({
      repo: REPO,
      ref: 'main',
      path: 'features/dark-mode/spec.md',
    });

    expect(permission).toBe('write');
  });

  it('reports a real account with no access as none, distinct from unknown', async () => {
    server.state.commitAuthorsByPath.set(
      'main:features/dark-mode/spec.md',
      'a-stranger',
    );
    server.state.collaboratorPermissions.set('a-stranger', 'none');

    const permission = await adapter.authorPermission({
      repo: REPO,
      ref: 'main',
      path: 'features/dark-mode/spec.md',
    });

    expect(permission).toBe('none');
  });

  it('reports unknown when no commit exists for the path', async () => {
    const permission = await adapter.authorPermission({
      repo: REPO,
      ref: 'main',
      path: 'features/never-committed/spec.md',
    });

    expect(permission).toBe('unknown');
  });

  it("reports unknown when GitHub can't associate the commit with any account", async () => {
    server.state.commitAuthorsByPath.set(
      'main:features/dark-mode/spec.md',
      null,
    );

    const permission = await adapter.authorPermission({
      repo: REPO,
      ref: 'main',
      path: 'features/dark-mode/spec.md',
    });

    expect(permission).toBe('unknown');
  });

  it('mints a real installation access token through the same App-auth JWT exchange (M05 step 5.10)', async () => {
    const pushToken = await adapter.getPushToken();

    expect(pushToken.token).toBe('mock-installation-token');
    expect(new Date(pushToken.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(
      server.state.authorizationHeadersSeen.some((header) =>
        /^bearer [^.]+\.[^.]+\.[^.]+$/i.test(header),
      ),
    ).toBe(true);
  });
});
