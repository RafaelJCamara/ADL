/**
 * `ForgeAdapter` — the forge port (FORGE-01, M05 step 5.8).
 *
 * **Forge-neutral vocabulary throughout.** `ChangeRequest`, never
 * `PullRequest` — GitLab calls the same concept a merge request, Gitea calls
 * it a pull request, and a core type named after either one commits the
 * abstraction to whichever forge got built first. Renaming this later costs
 * a sweep through every adapter (`docs/plan/DECISIONS.md`).
 *
 * **Designed to Gitea's floor, not GitHub's ceiling.** Gitea has the
 * narrowest API of the three forges in scope across M05/M09/M14: top-level
 * comments only, no line-level diff comments, no review-state updates, no
 * PR-code-comment webhook. Every operation below is something all three can
 * do; nothing here assumes a GitHub-only capability like inline review
 * threads. A future capability specific to one forge is an optional,
 * separately-gated method — never a widening of this interface that the
 * other adapters have to stub out.
 *
 * **Deliberately excludes branch creation.** `ManagerGitClient.push`
 * (`packages/workspace/src/git/manager-git.ts`) is what puts a branch on the
 * remote — an ordinary authenticated `git push`, not a forge REST call. Every
 * one of GitHub, GitLab, and Gitea create the branch as a side effect of
 * receiving that push; none of the three has (or needs) a "create branch"
 * REST operation in this flow. A `createBranch` method here would either
 * duplicate `push` under a different name or, worse, invite an
 * implementation that shells out — which `ForgeAdapter` implementations must
 * never do (WORK-02): a forge adapter talks HTTP, never a subprocess.
 *
 * Lives in `@adl/core` rather than in a forge-specific package for the same
 * reason `WorkspaceBackend` does: an out-of-tree forge adapter (a team's own
 * Gitea variant, say) implements this port directly, with no dependency on
 * any of ADL's built-in adapters. `@adl/core` stays pure — nothing here
 * imports `fetch`, reads an environment, or does any I/O; these are
 * declarations that erase at runtime.
 *
 * **Not published through `@adl/plugin-sdk`.** That surface is scoped to
 * what a third-party GATE author needs (`AgentRunner`'s backend-side types
 * are excluded for the identical reason, `stage/index.ts`) — a forge adapter
 * is a manager-internal concern a harness never touches.
 */

/** Where a change request stands. Four states are enough for every forge in scope. */
export const CHANGE_REQUEST_STATES = Object.freeze([
  'draft',
  'open',
  'merged',
  'closed',
] as const);

export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/**
 * A repository, as the forge itself addresses it.
 *
 * `owner`/`repo` is GitHub- and Gitea-shaped (both use it verbatim) and close
 * enough to GitLab's `namespace/project` that a GitLab adapter can join the
 * two fields with `/` — GitLab is M09's problem to solve for real, and
 * `.claude/CLAUDE.md` names GitLab specifically as "genuinely different,
 * forcing the abstraction honest"; widening this type if GitLab's numeric
 * project-id addressing turns out to need it is that milestone's decision to
 * make, not a reason to guess at a richer shape here first.
 */
export interface ForgeRepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** One change request, as the forge reports it back. */
export interface ChangeRequest {
  /** The forge's own identifier — GitHub's `node_id`, or an adapter-chosen equivalent. Opaque to a caller. */
  readonly id: string;
  /** The forge's human-facing number — what a person reads as "#42". */
  readonly number: number;
  /** The change request's web URL — what a sticky comment or a log line shows a human. */
  readonly url: string;
  readonly state: ChangeRequestState;
  readonly draft: boolean;
  /**
   * The branch this change request is built from — {@link OpenChangeRequestInput.head}
   * echoed back by the forge. DETECT-01's undeveloped predicate (5.2) and
   * DETECT-05's restart reconciliation (5.6) both match a change request
   * back to a feature folder by running `@adl/workspace`'s
   * `featureIdFromBranch` against this field — that match happens at the
   * call site, never here, so `@adl/core` stays dependency-free.
   */
  readonly head: string;
}

export interface OpenChangeRequestInput {
  readonly repo: ForgeRepoRef;
  /** The branch carrying the work — `ManagerGitClient.push`'s destination, already on the remote by the time this is called. */
  readonly head: string;
  /** The branch this change request targets — `WatchedRepo.default_branch`. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /**
   * Always `true` at round 1 (FORGE-05). A field rather than a hardcoded
   * `true` inside every adapter because a test double needs to assert the
   * caller asked for a draft, not merely that one happened to result.
   */
  readonly draft: boolean;
}

export interface PromoteToReadyInput {
  readonly repo: ForgeRepoRef;
  readonly number: number;
}

/**
 * Create-or-update one role's sticky comment (FORGE-06).
 *
 * `key` is a stable, adapter-opaque identifier for the comment's OWNER —
 * `'developer'`, `'reviewer'`, `'security'` — never a comment id, because the
 * caller does not know one on the first round. An implementation finds its
 * own prior comment (by embedding `key` in a hidden marker in the body, the
 * way `NEUTRALISED_CONFIG`'s README correspondence keeps a fact discoverable
 * rather than assumed) and edits it in place; finding none, it creates one.
 * Four gates over five rounds is twenty comments if this is gotten wrong —
 * the AI-slop pattern maintainers are revolting against, and the exact shape
 * a forge's own secondary rate limiter penalises.
 */
export interface UpsertCommentInput {
  readonly repo: ForgeRepoRef;
  readonly number: number;
  readonly key: string;
  readonly body: string;
}

export interface ReadFileInput {
  readonly repo: ForgeRepoRef;
  readonly ref: string;
  /** Repo-relative path. Containment is the adapter's job, matching every other repo-relative-path site in this codebase. */
  readonly path: string;
}

export interface ReadDiffInput {
  readonly repo: ForgeRepoRef;
  readonly base: string;
  readonly head: string;
}

/**
 * Everything ADL needs from a forge, and nothing a forge merely happens to
 * offer.
 *
 * **No merge method exists on this interface, anywhere, deliberately
 * (FORGE-10).** `docs/plan/DECISIONS.md`: "Human approves and merges the PR.
 * ADL never merges." The absence is the guard — "the adapter has no merge
 * method" is the structural version of "we don't call it" that step 5.12
 * asserts by reading this file's own shape.
 */
export interface ForgeAdapter {
  /** The registry id this adapter answers to — `'github'`, later `'gitlab'`, `'gitea'`. */
  readonly id: string;
  openChangeRequest(input: OpenChangeRequestInput): Promise<ChangeRequest>;
  /** Promote a draft to ready for review (FORGE-05) — never the reverse; nothing in this loop demotes a change request. */
  promoteToReady(input: PromoteToReadyInput): Promise<ChangeRequest>;
  upsertComment(input: UpsertCommentInput): Promise<void>;
  /**
   * Every open change request in `repo` — DETECT-01's undeveloped predicate
   * (5.2) reads it to avoid re-admitting a folder whose `features` row was
   * lost while its change request is still open, and DETECT-05's restart
   * reconciliation (5.6) reuses the same read.
   */
  listOpenChangeRequests(repo: ForgeRepoRef): Promise<readonly ChangeRequest[]>;
  /** A file's content at `ref` — gate context assembled from the repository, never from a developer's own session (ROLE-03). */
  readFile(input: ReadFileInput): Promise<string>;
  /** A unified diff between `base` and `head` — protected-path enforcement diffs what was actually written (ROLE-11). */
  readDiff(input: ReadDiffInput): Promise<string>;
}
