/**
 * `githubForgeAdapter` — the GitHub `ForgeAdapter` (FORGE-02, M05 step 5.9).
 *
 * A GitHub App, never a PAT (`.claude/CLAUDE.md` § Git, forge, and
 * workspace): scoped, revocable, per-installation, higher rate limits. Auth
 * is `@octokit/auth-app`'s `createAppAuth` strategy — this module signs no
 * JWT itself and stores no token; it hands `octokit` the App credentials
 * once, and every request after that carries whatever `octokit`'s own
 * auth hook attaches.
 *
 * `baseUrl` is accepted so a test can point every request — REST *and*
 * GraphQL *and* the App's own installation-token exchange — at a local
 * server instead of `api.github.com`. That works because `@octokit/core`
 * passes its own already-`baseUrl`-configured `request` function into
 * `authStrategy` at construction (verified against the installed
 * `@octokit/core@7.0.7` source: `authStrategy({ request: this.request, ... })`),
 * so the installation-token POST inherits the override with no separate
 * wiring here.
 *
 * **`getPushToken` is the one deliberate exception to "stores no token."**
 * `ManagerGitClient.push` (`packages/workspace/src/git/manager-git.ts`, M05
 * step 5.10) takes no credential parameter — `credential.helper` is
 * neutralised, so the only mechanism left for an authenticated push is a
 * remote URL carrying `x-access-token:<token>`, which needs the bare string,
 * not an auth hook `octokit`'s internals can consume on this adapter's
 * behalf. `getPushToken` reuses the exact `octokit` instance already
 * configured above (`octokit.auth(...)`, the documented public accessor for
 * an `authStrategy`'s own resolved auth function) rather than constructing a
 * second `createAppAuth` — so it inherits the same `baseUrl` test override
 * with no separate wiring, exactly like every other method here.
 */
import { createAppAuth } from '@octokit/auth-app';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import {
  COLLABORATOR_PERMISSIONS,
  type ChangeRequest,
  type CollaboratorPermission,
  type ForgeAdapter,
  type ForgeRepoRef,
  type OpenChangeRequestInput,
  type PromoteToReadyInput,
  type ReadDiffInput,
  type ReadFileInput,
  type UpsertCommentInput,
} from '@adl/core/forge';

export interface GithubForgeAdapterOptions {
  readonly appId: number | string;
  readonly privateKey: string;
  readonly installationId: number | string;
  /** Test seam: overrides `api.github.com`. Never set in production. */
  readonly baseUrl?: string;
  /**
   * Test seam: disables `octokit`'s bundled throttling and retry plugins.
   * Never set in production — both are exactly what FORGE-06's own docblock
   * names ("the exact shape a forge's own secondary rate limiter
   * penalises"): the throttling plugin proactively paces write requests
   * (`pulls.create`, `issues.createComment`, ...) roughly one per second,
   * which is real GitHub-recommended behaviour, not a defect. Verified
   * empirically against the installed `@octokit/plugin-throttling@11.0.5`
   * (`wrap-request.js`'s `state.write.key(...).schedule(...)` gate on every
   * non-GET, non-auth request) — a repeated write in this package's own
   * tests would otherwise cost roughly a second each and risk the suite's
   * default timeout for no reason a mock server benefits from.
   */
  readonly disablePacingForTests?: boolean;
}

/**
 * The subset of GitHub's pull-request response shape this adapter reads —
 * declared narrowly rather than importing octokit's generated response type
 * wholesale, so a field this adapter does not use is not a field this file
 * has to keep matching across an octokit upgrade.
 */
interface GithubPullRequest {
  readonly node_id: string;
  readonly number: number;
  readonly html_url: string;
  readonly state: string;
  readonly draft?: boolean | null;
  readonly merged_at?: string | null;
  readonly head: { readonly ref: string };
}

function toChangeRequest(pr: GithubPullRequest): ChangeRequest {
  const state: ChangeRequest['state'] =
    pr.merged_at != null
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : (pr.draft ?? false)
          ? 'draft'
          : 'open';

  return {
    id: pr.node_id,
    number: pr.number,
    url: pr.html_url,
    state,
    draft: pr.draft ?? false,
    head: pr.head.ref,
  };
}

/**
 * The subset of GitHub's commit response this adapter reads. `author` is
 * GitHub's *resolved* GitHub account for the commit — distinct from
 * `commit.author`, the raw, unverifiable git identity — and is `null` (or an
 * object with no `login`) when GitHub cannot match the commit's email to any
 * account.
 */
interface GithubAuthoredCommit {
  readonly author: { readonly login?: string } | null;
}

/** GitHub's own permission levels — never `'unknown'`, which is ADL's sentinel, not GitHub's. */
const GITHUB_PERMISSION_LEVELS = COLLABORATOR_PERMISSIONS.filter(
  (level) => level !== 'unknown',
);

function isGithubPermissionLevel(
  value: string,
): value is Exclude<CollaboratorPermission, 'unknown'> {
  return (GITHUB_PERMISSION_LEVELS as readonly string[]).includes(value);
}

/**
 * The hidden marker `upsertComment` uses to find its own prior comment
 * (FORGE-06). Embedded as an HTML comment so it renders invisibly on the
 * change request while staying trivially greppable in the raw body.
 */
function stickyMarker(key: string): string {
  return `<!-- adl:role=${key} -->`;
}

/** A short-lived GitHub App installation token, as `@octokit/auth-app` reports it. */
export interface GithubPushToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * {@link ForgeAdapter} plus one GitHub-specific extension — never added to
 * the port itself (FORGE-10's minimal-interface spirit: a capability
 * specific to one forge is an optional, separately-gated method on that
 * forge's own adapter, not a widening every other adapter has to stub out).
 * A caller that only needs the neutral port keeps using `ForgeAdapter`; a
 * caller that needs a real push credential (M05 step 5.10) imports this
 * richer type instead.
 */
export interface GithubForgeAdapter extends ForgeAdapter {
  /** Mint a fresh installation access token for the configured App/installation — never cached here (see module docblock). */
  getPushToken(): Promise<GithubPushToken>;
}

export function githubForgeAdapter(
  options: GithubForgeAdapterOptions,
): GithubForgeAdapter {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: options.appId,
      privateKey: options.privateKey,
      installationId: options.installationId,
    },
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.disablePacingForTests === true
      ? { throttle: { enabled: false }, retry: { enabled: false } }
      : {}),
  });

  return {
    id: 'github',

    async openChangeRequest(
      input: OpenChangeRequestInput,
    ): Promise<ChangeRequest> {
      const { data } = await octokit.rest.pulls.create({
        owner: input.repo.owner,
        repo: input.repo.repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
      });
      return toChangeRequest(data);
    },

    async promoteToReady(input: PromoteToReadyInput): Promise<ChangeRequest> {
      // REST has no "set draft: false" operation — GitHub's REST `PATCH
      // .../pulls/{number}` does not accept a `draft` field. The GraphQL
      // mutation is the only way; it needs the PR's GraphQL node id, which
      // this adapter's own ChangeRequest.id already carries but
      // PromoteToReadyInput (deliberately, per the port's own docblock —
      // the caller may not have re-fetched a fresh ChangeRequest) does not,
      // so a lookup precedes the mutation.
      const { data: pr } = await octokit.rest.pulls.get({
        owner: input.repo.owner,
        repo: input.repo.repo,
        pull_number: input.number,
      });

      const result = await octokit.graphql<{
        markPullRequestReadyForReview: {
          pullRequest: {
            id: string;
            number: number;
            url: string;
            isDraft: boolean;
            state: string;
          };
        };
      }>(
        `mutation($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            pullRequest { id number url isDraft state }
          }
        }`,
        { id: pr.node_id },
      );

      const rp = result.markPullRequestReadyForReview.pullRequest;
      const state: ChangeRequest['state'] =
        rp.state === 'MERGED'
          ? 'merged'
          : rp.state === 'CLOSED'
            ? 'closed'
            : rp.isDraft
              ? 'draft'
              : 'open';

      return {
        id: rp.id,
        number: rp.number,
        url: rp.url,
        state,
        draft: rp.isDraft,
        // The GraphQL mutation's own selection set carries no branch field;
        // `pr.head.ref` from the REST lookup just above (fetched for its
        // `node_id`) already has it, so no second field is added to the
        // mutation's selection set for it.
        head: pr.head.ref,
      };
    },

    async upsertComment(input: UpsertCommentInput): Promise<void> {
      const marker = stickyMarker(input.key);
      const body = `${marker}\n${input.body}`;

      const { data: comments } = await octokit.rest.issues.listComments({
        owner: input.repo.owner,
        repo: input.repo.repo,
        issue_number: input.number,
      });
      const existing = comments.find(
        (comment) =>
          typeof comment.body === 'string' && comment.body.includes(marker),
      );

      if (existing !== undefined) {
        await octokit.rest.issues.updateComment({
          owner: input.repo.owner,
          repo: input.repo.repo,
          comment_id: existing.id,
          body,
        });
        return;
      }

      await octokit.rest.issues.createComment({
        owner: input.repo.owner,
        repo: input.repo.repo,
        issue_number: input.number,
        body,
      });
    },

    async listOpenChangeRequests(
      repo: ForgeRepoRef,
    ): Promise<readonly ChangeRequest[]> {
      const { data } = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
      });
      return data.map(toChangeRequest);
    },

    async readFile(input: ReadFileInput): Promise<string> {
      const { data } = await octokit.rest.repos.getContent({
        owner: input.repo.owner,
        repo: input.repo.repo,
        path: input.path,
        ref: input.ref,
      });

      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        typeof data.content !== 'string'
      ) {
        throw new Error(
          `${input.path} at ${input.ref} in ${input.repo.owner}/${input.repo.repo} is not a readable file`,
        );
      }

      return Buffer.from(data.content, 'base64').toString('utf8');
    },

    async readDiff(input: ReadDiffInput): Promise<string> {
      const response = await octokit.rest.repos.compareCommitsWithBasehead({
        owner: input.repo.owner,
        repo: input.repo.repo,
        basehead: `${input.base}...${input.head}`,
        mediaType: { format: 'diff' },
      });
      // A non-JSON `mediaType.format` makes octokit hand back the raw
      // response body as a string rather than the parsed comparison object
      // — that is the whole reason `mediaType.format: 'diff'` is passed.
      return response.data as unknown as string;
    },

    async authorPermission(
      input: ReadFileInput,
    ): Promise<CollaboratorPermission> {
      // The most recent commit touching this path at this ref — SPEC-06
      // asks about the folder's current content, not its full history.
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner: input.repo.owner,
        repo: input.repo.repo,
        sha: input.ref,
        path: input.path,
        per_page: 1,
      });

      const commit = commits[0] as GithubAuthoredCommit | undefined;
      const login = commit?.author?.login;
      // No commit at all, or one GitHub could not match to any account —
      // both are 'unknown', never 'none': 'none' asserts a real, checked
      // account was found and has zero access.
      if (login === undefined) return 'unknown';

      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: input.repo.owner,
        repo: input.repo.repo,
        username: login,
      });

      return isGithubPermissionLevel(data.permission)
        ? data.permission
        : 'unknown';
    },

    async getPushToken(): Promise<GithubPushToken> {
      // `octokit.auth` is typed `(...args: unknown[]) => Promise<unknown>`
      // upstream (`@octokit/core@7.0.7`'s own `dist-types`) — the cast below
      // is to `@octokit/auth-app`'s own documented result shape for an
      // `{ type: 'installation' }` request, not an assumption invented here.
      const auth = (await octokit.auth({
        type: 'installation',
        installationId: options.installationId,
      })) as InstallationAccessTokenAuthentication;
      return { token: auth.token, expiresAt: auth.expiresAt };
    },
  };
}
