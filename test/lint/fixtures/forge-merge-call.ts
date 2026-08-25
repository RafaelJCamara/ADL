/**
 * Deliberate violation of `adl/no-forge-merge` (FORGE-10, M05 step 5.12).
 *
 * This file exists to be reported. It is globally ignored by `eslint.config.js`
 * so `pnpm lint` is not permanently red, and linted with `ignore: false` by
 * `test/lint/no-restricted-imports.test.ts` through that same config — so the
 * rule objects exercised here are literally the ones `packages/forge-github`
 * is linted with.
 *
 * One case per banned entry, and the test asserts that EVERY entry in
 * `FORGE_MERGE_MEMBERS` and `FORGE_MERGE_ROUTES` is named by at least one
 * message on this file. A verb added to either tuple without a case here
 * therefore goes red, which is what stops the tuples growing entries nobody
 * has ever watched fire.
 *
 * Typed against hand-written minimal interfaces rather than `octokit`'s own:
 * the fixture must be clean under the base rule set alone (the negative
 * control), and `@typescript-eslint/no-explicit-any` is part of it.
 */

interface PullsApi {
  merge(input: { readonly pull_number: number }): Promise<void>;
}

interface MergeRequestsApi {
  accept(project: number, iid: number): Promise<void>;
  mergeWhenPipelineSucceeds(project: number, iid: number): Promise<void>;
}

/**
 * A typed GraphQL SDK, where the mutation names are METHODS rather than text
 * inside a query string. Both shapes are real and neither ban sees the other:
 * the resolved-config assertions in `test/lint/no-restricted-imports.test.ts`
 * proved the selectors exist, and the "reports every banned verb" assertion
 * caught this file the first time it was written without these two — the
 * mutation names had a string case each and no member case at all.
 */
interface GraphqlSdk {
  mergePullRequest(input: { readonly pullRequestId: string }): Promise<void>;
  enablePullRequestAutoMerge(input: {
    readonly pullRequestId: string;
  }): Promise<void>;
}

interface ForgeClient {
  readonly pulls: PullsApi;
  readonly MergeRequests: MergeRequestsApi;
  readonly sdk: GraphqlSdk;
  request(route: string, params: Record<string, unknown>): Promise<void>;
  graphql(query: string): Promise<void>;
}

export async function landItWithoutAHuman(client: ForgeClient): Promise<void> {
  // 1. The member call — GitHub REST's spelling.
  await client.pulls.merge({ pull_number: 1 });

  // 2. The aliased reference. A call-expression selector would miss this
  //    entirely, which is why the ban is on the member expression.
  const alias = client.pulls.merge;
  await alias({ pull_number: 2 });

  // 3. The raw REST route, reached as a string rather than as a method.
  await client.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
    pull_number: 3,
  });

  // 4. The GraphQL mutation, template-literal form.
  await client.graphql(`mutation($id: ID!) {
    mergePullRequest(input: { pullRequestId: $id }) { pullRequest { id } }
  }`);

  // 5. And its plain-string form — the same mutation, invisible to a
  //    TemplateElement-only ban.
  await client.graphql(
    'mutation { mergePullRequest(input: {}) { clientMutationId } }',
  );

  // 6. The deferred merge: it lands after this process has exited, so nothing
  //    in ADL's logs, transcripts or accounting records the moment it did.
  await client.graphql(`mutation {
    enablePullRequestAutoMerge(input: {}) { clientMutationId }
  }`);

  // 7. GitLab's two spellings, neither of which reads as a merge in a diff.
  await client.MergeRequests.accept(1, 2);
  await client.MergeRequests.mergeWhenPipelineSucceeds(1, 2);

  // 8. The same two GitHub mutations again, reached as SDK methods rather
  //    than as query text — the form a string-only ban is blind to.
  await client.sdk.mergePullRequest({ pullRequestId: 'x' });
  await client.sdk.enablePullRequestAutoMerge({ pullRequestId: 'x' });
}
