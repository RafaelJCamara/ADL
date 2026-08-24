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
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import type {
  ChangeRequest,
  ForgeAdapter,
  ForgeRepoRef,
  OpenChangeRequestInput,
  PromoteToReadyInput,
  ReadDiffInput,
  ReadFileInput,
  UpsertCommentInput,
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
 * The hidden marker `upsertComment` uses to find its own prior comment
 * (FORGE-06). Embedded as an HTML comment so it renders invisibly on the
 * change request while staying trivially greppable in the raw body.
 */
function stickyMarker(key: string): string {
  return `<!-- adl:role=${key} -->`;
}

export function githubForgeAdapter(
  options: GithubForgeAdapterOptions,
): ForgeAdapter {
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
  };
}
