import { describe, expect, it } from 'vitest';
import {
  CHANGE_REQUEST_STATES,
  FORGE_ADAPTER_MEMBERS,
} from '../../src/forge/index.js';

/**
 * The never-merge guard, port half (FORGE-10, M05 step 5.12).
 *
 * `docs/plan/DECISIONS.md`: **"Human approves and merges the PR. ADL never
 * merges."** It is listed under "Explicitly out of scope for v1" as well, and
 * the milestone states the standard this file is built to: *prefer "the adapter
 * has no merge method" over "we don't call it"*. An unattended loop with write
 * access to the target branch is the single failure a team cannot recover from
 * by closing a pull request, so this property is not one a reviewer should have
 * to re-establish by reading `forge.ts` on every change.
 *
 * ── What is actually asserted, and why it is not vacuous ──────────────────
 *
 * `FORGE_ADAPTER_MEMBERS` is proven exhaustive *at compile time* by
 * `forge.ts`'s own `Exclude<keyof ForgeAdapter, …> extends never` assertion.
 * That is what makes the runtime check below meaningful rather than decorative:
 * without it, this file would be scanning a hand-maintained list that a new
 * interface member need never appear in, and the test would stay green while
 * the port grew the exact method it exists to forbid. The two assertions are
 * one guard in two halves and neither is worth much alone.
 *
 * ── Why the vocabulary is restated here as a literal ──────────────────────
 *
 * {@link MERGE_VOCABULARY} deliberately does NOT import
 * `eslint.config.js`'s `FORGE_MERGE_MEMBERS`, for the reason
 * `test/lint/no-restricted-imports.test.ts`'s own `anchoredPattern` docblock
 * gives about the extension set: an assertion has to be able to DISAGREE with
 * the configuration it is checking. Driving this list off the lint config would
 * mean that deleting a verb there also deleted the assertion that would have
 * caught the deletion. `@adl/core` also imports no sibling package by
 * construction (D-27), so there is no honest way to share one list across the
 * two layers even if sharing were desirable.
 */

/**
 * How a merge arrives, across every forge in scope for v1 and v2.
 *
 * GitHub REST spells it `pulls.merge`; GitHub GraphQL spells it
 * `mergePullRequest`, and `enablePullRequestAutoMerge` for the delayed form
 * that is *worse*, because it merges after this process has exited. GitLab's
 * client spells the same operation `accept` and
 * `mergeWhenPipelineSucceeds` — neither contains the word "merge" in a way a
 * casual reading of a diff would catch, which is the whole reason this is a
 * list rather than a substring search for `merge`.
 */
const MERGE_VOCABULARY = [
  'merge',
  'mergePullRequest',
  'enablePullRequestAutoMerge',
  'mergeWhenPipelineSucceeds',
  'accept',
] as const;

/** Case-insensitive: `Merge`, `merge`, and `MERGE_` are the same intent. */
function isMergeShaped(name: string): boolean {
  const lowered = name.toLowerCase();
  return MERGE_VOCABULARY.some((verb) => lowered.includes(verb.toLowerCase()));
}

describe('the vocabulary has teeth', () => {
  // Without these, `isMergeShaped` could return false unconditionally and
  // every assertion below would pass while proving nothing. Fabricated names,
  // permanently — rather than a scratch edit somebody has to remember to
  // revert. The same construction `test/toolchain.test.ts` uses for its range
  // evaluator, for the same reason.
  it.each([
    ['merge', true],
    ['mergeChangeRequest', true],
    ['mergePullRequest', true],
    ['enablePullRequestAutoMerge', true],
    ['mergeWhenPipelineSucceeds', true],
    ['accept', true],
    ['acceptChangeRequest', true],
    ['squashAndMerge', true],
    ['openChangeRequest', false],
    ['promoteToReady', false],
    ['listOpenChangeRequests', false],
    ['readDiff', false],
  ])('%s is merge-shaped: %s', (name, expected) => {
    expect(isMergeShaped(name)).toBe(expected);
  });
});

describe('ForgeAdapter has no merge method (FORGE-10)', () => {
  it('declares not one merge-shaped member', () => {
    const offenders = FORGE_ADAPTER_MEMBERS.filter(isMergeShaped);

    expect(
      offenders,
      offenders.length > 0
        ? `ForgeAdapter declares ${offenders.join(', ')}. ADL never merges ` +
            '(docs/plan/DECISIONS.md) — a human approves and merges the pull ' +
            'request, and an unattended loop that can write to the target ' +
            'branch is not acceptable in v1. If a forge genuinely needs a ' +
            'capability whose name collides with this vocabulary, it belongs ' +
            "on that forge's own adapter type as a separately-gated method " +
            '(the `GithubForgeAdapter`/`getPushToken` precedent), never on ' +
            'the neutral port every adapter must implement.'
        : undefined,
    ).toEqual([]);
  });

  it('reads a non-empty list — a guard over an empty array proves nothing', () => {
    // The vacuity control. `FORGE_ADAPTER_MEMBERS` emptied by a bad merge
    // resolution would make the assertion above pass trivially, and the
    // compile-time exhaustiveness proof in `forge.ts` cannot catch that
    // direction on its own: `Exclude<keyof ForgeAdapter, never>` is only
    // non-empty, not *complete*, and the `satisfies` clause allows a SHORT
    // list. The count is checked here instead, from the outside.
    expect(FORGE_ADAPTER_MEMBERS.length).toBeGreaterThanOrEqual(8);
  });

  it('still declares the operations M05 actually needs, so the list is the real port', () => {
    // Names the members the manager's own publish path calls today. If this
    // ever fails, `FORGE_ADAPTER_MEMBERS` has stopped describing the interface
    // the rest of the codebase uses, and the merge assertion above is reading
    // something other than the port.
    expect([...FORGE_ADAPTER_MEMBERS]).toEqual(
      expect.arrayContaining([
        'openChangeRequest',
        'promoteToReady',
        'upsertComment',
        'listOpenChangeRequests',
      ]),
    );
  });
});

describe('reading a merged state is not causing one', () => {
  it("keeps 'merged' in CHANGE_REQUEST_STATES", () => {
    // Stated as an assertion rather than left implicit, because it is the one
    // place in this package where the merge vocabulary legitimately appears
    // and a future contributor tightening the guard above into a blanket
    // "no merge vocabulary under forge/" would delete it.
    //
    // `ChangeRequestState` is what the forge REPORTS back. A human merging the
    // pull request is the intended, and the only, way that value ever arrives
    // — ADL has to be able to observe it (`listOpenChangeRequests` filters on
    // state; DETECT-01's undeveloped predicate reads the result). Observing a
    // state is the opposite of causing one, and a guard that could not tell
    // those apart would force the loop to go blind to the outcome it is
    // waiting for.
    expect(CHANGE_REQUEST_STATES).toContain('merged');
  });
});
