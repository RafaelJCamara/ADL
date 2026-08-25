/**
 * Two pure helpers around GitHub's own URL shapes (M05 step 5.10) — no
 * `octokit`, no I/O, both trivially unit-testable.
 *
 * `ForgeRepoRef` (`@adl/core/forge`) has no production derivation anywhere
 * yet: `ReposTable`/`WatchedRepoSchema` carry a plain `remote_url`, not
 * separate `owner`/`repo` columns (`docs/plan/milestones/m05-the-loop-closes.md`'s
 * own "seams" table never named one). `parseGithubRemoteUrl` is that
 * derivation for the one forge in scope — every test and every earlier
 * call site hand-constructed `{ owner, repo }` literally; this is the first
 * real one.
 */

import type { ForgeRepoRef } from '@adl/core/forge';

/**
 * `https://github.com/<owner>/<repo>(.git)?` or `git@github.com:<owner>/<repo>.git`
 * (and the `ssh://git@github.com/<owner>/<repo>.git` form some tooling
 * emits) → `{ owner, repo }`. Anything else — a non-GitHub host, a malformed
 * URL — is `undefined` rather than a guess: a wrong `ForgeRepoRef` would
 * silently address the wrong repository on every forge call.
 */
export function parseGithubRemoteUrl(
  remoteUrl: string,
): ForgeRepoRef | undefined {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(remoteUrl);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return undefined;
}

export interface GithubPushUrlParams {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  /** Overrides `github.com` — a test seam for a local/mock remote. */
  readonly host?: string;
}

/**
 * Format a short-lived installation token into the one authenticated-push
 * mechanism `ManagerGitClient.push` has left once `credential.helper` is
 * neutralised (`docs/plan/DEBT.md` D-5-R-1): a `remoteUrl` carrying its own
 * credential. `x-access-token` is GitHub's own documented username for an
 * installation token used this way — the password field carries the token.
 */
export function githubPushUrl(params: GithubPushUrlParams): string {
  const host = params.host ?? 'github.com';
  return `https://x-access-token:${params.token}@${host}/${params.owner}/${params.repo}.git`;
}
