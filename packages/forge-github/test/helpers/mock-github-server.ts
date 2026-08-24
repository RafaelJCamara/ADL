/**
 * A minimal stand-in for `api.github.com`, built on `node:http` — no new
 * test dependency (`nock`/`msw`) added for it, matching this repository's
 * low-dependency-surface convention.
 *
 * This is not a GitHub API simulator: it implements exactly the handful of
 * routes `githubForgeAdapter` calls, with just enough correctness to prove
 * the REAL `octokit` + `@octokit/auth-app` wiring works — a genuine App-auth
 * JWT is signed and really exchanged for an installation token over real
 * HTTP, a genuine GraphQL mutation is really POSTed and parsed — without
 * ever reaching `api.github.com`. The one live-credentialed run against the
 * real API is deferred to `docs/plan/DEBT.md` item 1.7.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockPullRequest {
  node_id: string;
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MockComment {
  id: number;
  body: string;
}

/** GitHub's own permission levels — never `'unknown'`, which is ADL's own sentinel, not GitHub's. */
export type MockCollaboratorPermission = 'admin' | 'write' | 'read' | 'none';

/** The server's in-memory state, exposed so a test can assert against it directly. */
export interface MockGithubState {
  readonly pulls: MockPullRequest[];
  readonly commentsByIssue: Map<number, MockComment[]>;
  readonly files: Map<string, string>;
  readonly diffs: Map<string, string>;
  /**
   * `${sha}:${path}` -> the login of whoever authored the most recent commit
   * touching `path`, or `null` for a commit GitHub could not match to any
   * account. No entry at all means no commit exists for that path — the
   * adapter treats both `null` and "no entry" as `'unknown'`.
   */
  readonly commitAuthorsByPath: Map<string, string | null>;
  /** username -> the permission level `getCollaboratorPermissionLevel` reports. No entry defaults to `'none'`. */
  readonly collaboratorPermissions: Map<string, MockCollaboratorPermission>;
  /** Every `Authorization` header this server has seen, for the JWT-exchange proof. */
  readonly authorizationHeadersSeen: string[];
  nextPullNumber: number;
  nextCommentId: number;
}

export interface MockGithubServer {
  readonly url: string;
  readonly state: MockGithubState;
  close(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : (JSON.parse(raw) as unknown);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function toPullResponse(pr: MockPullRequest): Record<string, unknown> {
  return {
    node_id: pr.node_id,
    number: pr.number,
    html_url: pr.html_url,
    state: pr.state,
    draft: pr.draft,
    merged_at: pr.merged_at,
    head: { ref: pr.head },
  };
}

/** Start the mock server. Always on an OS-assigned free port. */
export async function startMockGithubServer(): Promise<MockGithubServer> {
  const state: MockGithubState = {
    pulls: [],
    commentsByIssue: new Map(),
    files: new Map(),
    diffs: new Map(),
    commitAuthorsByPath: new Map(),
    collaboratorPermissions: new Map(),
    authorizationHeadersSeen: [],
    nextPullNumber: 1,
    nextCommentId: 1,
  };

  const server = createServer((req, res) => {
    void handle(req, res, state).catch((error: unknown) => {
      sendJson(res, 500, {
        message: error instanceof Error ? error.message : 'mock server error',
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockGithubState,
): Promise<void> {
  const authorization = req.headers.authorization;
  if (authorization !== undefined)
    state.authorizationHeadersSeen.push(authorization);

  const [pathname = '', search = ''] = (req.url ?? '').split('?');
  const query = new URLSearchParams(search);
  const method = req.method ?? 'GET';

  // POST /app/installations/:id/access_tokens — the App-auth JWT exchange.
  if (
    method === 'POST' &&
    /^\/app\/installations\/[^/]+\/access_tokens$/.test(pathname)
  ) {
    if (
      authorization === undefined ||
      !/^bearer [^.]+\.[^.]+\.[^.]+$/i.test(authorization)
    ) {
      sendJson(res, 401, { message: 'a JWT-shaped bearer token is required' });
      return;
    }
    sendJson(res, 201, {
      token: 'mock-installation-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: {},
      repository_selection: 'all',
    });
    return;
  }

  // POST /repos/:owner/:repo/pulls
  let match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(pathname);
  if (method === 'POST' && match) {
    const body = (await readJsonBody(req)) as {
      title?: string;
      body?: string;
      head?: string;
      base?: string;
      draft?: boolean;
    };
    const number = state.nextPullNumber++;
    const pr: MockPullRequest = {
      node_id: `PR_mock_${String(number)}`,
      number,
      html_url: `https://github.com/${match[1]}/${match[2]}/pull/${String(number)}`,
      state: 'open',
      draft: body.draft ?? false,
      merged_at: null,
      head: body.head ?? '',
      base: body.base ?? '',
      title: body.title ?? '',
      body: body.body ?? '',
    };
    state.pulls.push(pr);
    sendJson(res, 201, toPullResponse(pr));
    return;
  }

  // GET /repos/:owner/:repo/pulls?state=open
  if (method === 'GET' && match) {
    const wanted = query.get('state') ?? 'open';
    const filtered = state.pulls.filter((pr) => pr.state === wanted);
    sendJson(res, 200, filtered.map(toPullResponse));
    return;
  }

  // GET /repos/:owner/:repo/pulls/:number
  match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(pathname);
  if (method === 'GET' && match) {
    const number = Number(match[3]);
    const pr = state.pulls.find((p) => p.number === number);
    if (pr === undefined) {
      sendJson(res, 404, { message: 'not found' });
      return;
    }
    sendJson(res, 200, toPullResponse(pr));
    return;
  }

  // POST /graphql
  if (method === 'POST' && pathname === '/graphql') {
    const body = (await readJsonBody(req)) as {
      query?: string;
      variables?: { id?: string };
    };
    if (body.query?.includes('markPullRequestReadyForReview') === true) {
      const id = body.variables?.id;
      const pr = state.pulls.find((p) => p.node_id === id);
      if (pr === undefined) {
        sendJson(res, 200, {
          errors: [{ message: `no pull request with node id ${String(id)}` }],
        });
        return;
      }
      pr.draft = false;
      sendJson(res, 200, {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: {
              id: pr.node_id,
              number: pr.number,
              url: pr.html_url,
              isDraft: false,
              state: 'OPEN',
            },
          },
        },
      });
      return;
    }
    sendJson(res, 200, {
      errors: [{ message: 'unhandled query in mock server' }],
    });
    return;
  }

  // GET/POST /repos/:owner/:repo/issues/:number/comments
  match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(pathname);
  if (match) {
    const issueNumber = Number(match[3]);
    const comments = state.commentsByIssue.get(issueNumber) ?? [];
    state.commentsByIssue.set(issueNumber, comments);

    if (method === 'GET') {
      sendJson(res, 200, comments);
      return;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as { body?: string };
      const comment: MockComment = {
        id: state.nextCommentId++,
        body: body.body ?? '',
      };
      comments.push(comment);
      sendJson(res, 201, comment);
      return;
    }
  }

  // PATCH /repos/:owner/:repo/issues/comments/:commentId
  match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(pathname);
  if (method === 'PATCH' && match) {
    const commentId = Number(match[3]);
    const body = (await readJsonBody(req)) as { body?: string };
    for (const comments of state.commentsByIssue.values()) {
      const existing = comments.find((c) => c.id === commentId);
      if (existing !== undefined) {
        existing.body = body.body ?? existing.body;
        sendJson(res, 200, existing);
        return;
      }
    }
    sendJson(res, 404, { message: 'comment not found' });
    return;
  }

  // GET /repos/:owner/:repo/contents/:path (path may itself contain slashes)
  match = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname);
  if (method === 'GET' && match) {
    const path = decodeURIComponent(match[3] ?? '');
    const ref = query.get('ref') ?? '';
    const content = state.files.get(`${ref}:${path}`);
    if (content === undefined) {
      sendJson(res, 404, { message: 'not found' });
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      path,
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    return;
  }

  // GET /repos/:owner/:repo/compare/:basehead
  match = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)$/.exec(pathname);
  if (method === 'GET' && match) {
    const basehead = decodeURIComponent(match[3] ?? '');
    const diff = state.diffs.get(basehead);
    if (diff === undefined) {
      sendJson(res, 404, { message: 'not found' });
      return;
    }
    // `charset=utf-8` is what makes @octokit/request's fetch wrapper decode
    // this as text rather than an ArrayBuffer — verified against the
    // installed @octokit/request@10.0.15 source (`fetch-wrapper.js`).
    res.writeHead(200, {
      'content-type': 'application/vnd.github.diff; charset=utf-8',
    });
    res.end(diff);
    return;
  }

  // GET /repos/:owner/:repo/commits?path=...&sha=...
  match = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(pathname);
  if (method === 'GET' && match) {
    const path = query.get('path') ?? '';
    const sha = query.get('sha') ?? '';
    const key = `${sha}:${path}`;
    if (!state.commitAuthorsByPath.has(key)) {
      sendJson(res, 200, []);
      return;
    }
    const login = state.commitAuthorsByPath.get(key) ?? null;
    sendJson(res, 200, [
      {
        sha: `mock-commit-${path}`,
        author: login === null ? null : { login },
      },
    ]);
    return;
  }

  // GET /repos/:owner/:repo/collaborators/:username/permission
  match =
    /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(
      pathname,
    );
  if (method === 'GET' && match) {
    const username = decodeURIComponent(match[3] ?? '');
    const permission = state.collaboratorPermissions.get(username) ?? 'none';
    sendJson(res, 200, { permission, role_name: permission });
    return;
  }

  sendJson(res, 404, {
    message: `mock server has no route for ${method} ${pathname}`,
  });
}
