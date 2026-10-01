import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubForgeAdapter } from '../src/backend.js';
import {
  startMockGithubServer,
  type MockGithubServer,
} from './helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from './helpers/throwaway-key.js';

/**
 * D-7-05-1: `upsertComment` reads every comment, looks for its marker, then
 * creates or edits -- check-then-act. Two calls for one key that overlap both
 * read "none" and both create.
 *
 * The mock server holds each comment-list response back AFTER snapshotting, so
 * a caller's answer describes the world as it was when it asked. That makes the
 * overlap a certainty rather than scheduler luck, which is what lets this guard
 * be observed failing (convention 13) -- the same two calls against an adapter
 * with no serialisation produce two comments, every time.
 */

const REPO = { owner: 'adl-test-org', repo: 'demo-repo' };
/** Far longer than the gap between two calls issued in the same tick. */
const LIST_LATENCY_MS = 300;

let server: MockGithubServer;
let adapter: ReturnType<typeof githubForgeAdapter>;

beforeEach(async () => {
  server = await startMockGithubServer({
    listCommentsLatencyMs: LIST_LATENCY_MS,
  });
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

async function openChangeRequest(head: string): Promise<number> {
  const cr = await adapter.openChangeRequest({
    repo: REPO,
    head,
    base: 'main',
    title: head,
    body: 'body',
    draft: true,
  });
  return cr.number;
}

describe('githubForgeAdapter.upsertComment under concurrency (D-7-05-1)', () => {
  it('two overlapping upserts for one key leave exactly one comment, holding the later body', async () => {
    const number = await openChangeRequest('adl/dark-mode');

    await Promise.all([
      adapter.upsertComment({
        repo: REPO,
        number,
        key: 'developer',
        body: 'first summary',
      }),
      adapter.upsertComment({
        repo: REPO,
        number,
        key: 'developer',
        body: 'second summary',
      }),
    ]);

    const comments = server.state.commentsByIssue.get(number) ?? [];
    expect(comments).toHaveLength(1);
    // Calls for a key run in call order, so the later call is the one that
    // edits the comment the earlier one created.
    expect(comments[0]?.body).toContain('second summary');
    expect(comments[0]?.body).not.toContain('first summary');
  });

  it('many overlapping upserts for one key still leave exactly one comment', async () => {
    const number = await openChangeRequest('adl/dark-mode');

    await Promise.all(
      [1, 2, 3, 4, 5].map((round) =>
        adapter.upsertComment({
          repo: REPO,
          number,
          key: 'developer',
          body: `round ${String(round)}`,
        }),
      ),
    );

    const comments = server.state.commentsByIssue.get(number) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('round 5');
  });

  it('overlapping upserts for different keys on one change request each get their own comment, without waiting on each other', async () => {
    const number = await openChangeRequest('adl/dark-mode');

    const start = Date.now();
    await Promise.all([
      adapter.upsertComment({
        repo: REPO,
        number,
        key: 'developer',
        body: 'developer summary',
      }),
      adapter.upsertComment({
        repo: REPO,
        number,
        key: 'escalation',
        body: 'escalation summary',
      }),
    ]);
    const elapsedMs = Date.now() - start;

    const comments = server.state.commentsByIssue.get(number) ?? [];
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.body.split('\n')[0]).sort()).toEqual([
      '<!-- adl:role=developer -->',
      '<!-- adl:role=escalation -->',
    ]);
    // Two list round trips of LIST_LATENCY_MS each, run back to back, would
    // take at least twice the latency. Overlapping, they take about one.
    expect(elapsedMs).toBeLessThan(2 * LIST_LATENCY_MS);
  });

  it('overlapping upserts for the same key on different change requests do not serialise against each other', async () => {
    const first = await openChangeRequest('adl/dark-mode');
    const second = await openChangeRequest('adl/export-widgets');

    const start = Date.now();
    await Promise.all([
      adapter.upsertComment({
        repo: REPO,
        number: first,
        key: 'developer',
        body: 'one',
      }),
      adapter.upsertComment({
        repo: REPO,
        number: second,
        key: 'developer',
        body: 'two',
      }),
    ]);
    const elapsedMs = Date.now() - start;

    expect(server.state.commentsByIssue.get(first)).toHaveLength(1);
    expect(server.state.commentsByIssue.get(second)).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2 * LIST_LATENCY_MS);
  });
});
