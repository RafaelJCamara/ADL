import { describe, expect, it } from 'vitest';
import {
  GATE_CONTEXT_MEMBERS,
  GATE_DIFF_MEMBERS,
} from '../../src/stage/index.js';

/**
 * Fresh-context gate isolation, port half (ROLE-03, M05 step 5.17).
 *
 * ROLE-03: *"Reviewer works from fresh context — it never inherits the
 * developer's session, transcript, or reasoning."* The milestone states the
 * standard this file is built to: make those *structurally* unreachable — **a
 * type the gate cannot name, not a rule it is asked to follow**. So the
 * assertion below is over the member list of `GateContext`, not over any gate's
 * behaviour: a gate cannot decline to read a field that does not exist.
 *
 * ── What is actually asserted, and why it is not vacuous ──────────────────
 *
 * `GATE_CONTEXT_MEMBERS` and `GATE_DIFF_MEMBERS` are proven exhaustive *at
 * compile time* by `gate-context.ts`'s own `Exclude<keyof …, …> extends never`
 * assertions. That is what makes the runtime checks here meaningful rather than
 * decorative: without them this file would be scanning hand-maintained lists
 * that a new member need never appear in, and it would stay green while the
 * context grew the exact field it exists to forbid. The two halves are one
 * guard and neither is worth much alone — the same construction, for the same
 * reason, as `packages/core/test/forge/never-merge.test.ts` (FORGE-10, 5.12).
 *
 * ── Why the vocabulary is restated here as a literal ──────────────────────
 *
 * {@link FRESH_CONTEXT_VOCABULARY} deliberately does not import
 * `eslint.config.js`'s equivalent list, for the reason `never-merge.test.ts`
 * already gives: an assertion has to be able to DISAGREE with the configuration
 * it is checking, and driving this list off the lint config would mean deleting
 * a term there also deleted the assertion that would have caught the deletion.
 * `@adl/core` imports no sibling by construction (D-27), so there is no honest
 * way to share one list across the two layers even if sharing were desirable.
 */

/**
 * How the developer's session, transcript, or reasoning would arrive if it ever
 * did — every spelling this codebase actually uses for one of the three.
 *
 * - `session` / `sessionRef` — `@adl/core/stage`'s own name for the opaque,
 *   backend-owned resumable-session token (`agent.ts`'s vocabulary rule). A
 *   gate handed one could resume the developer's conversation outright.
 * - `transcript` / `logsRoot` / `ndjson` — the on-disk record of everything the
 *   developer's agent said and did. `logsRoot` is the dangerous one: it is not
 *   a transcript, it is the *root every transcript is addressed under*, so one
 *   field plus the round and stage ids a gate legitimately knows reconstructs
 *   the path.
 * - `prompt` / `instructions` / `systemPrompt` — what the developer was asked,
 *   which is its reasoning's input rather than its output, and equally out of
 *   bounds.
 * - `brief` / `history` / `priorRound` — prior-round context. Not the
 *   developer's session, but not spec, diff, or repository either, and M05's
 *   acceptance criterion says gate context is assembled from those three
 *   **only**.
 */
const FRESH_CONTEXT_VOCABULARY = [
  'session',
  'transcript',
  'logsroot',
  'ndjson',
  'prompt',
  'instructions',
  'reasoning',
  'thinking',
  'brief',
  'history',
  'priorround',
  'attemptid',
] as const;

/** Case- and separator-insensitive: `logsRoot`, `logs_root` and `LOGSROOT` are one intent. */
function isForbiddenContext(name: string): boolean {
  const normalised = name.toLowerCase().replace(/[^a-z]/g, '');
  return FRESH_CONTEXT_VOCABULARY.some((term) => normalised.includes(term));
}

describe('the vocabulary has teeth', () => {
  // Without these, `isForbiddenContext` could return false unconditionally and
  // every assertion below would pass while proving nothing. Fabricated names,
  // permanently — rather than a scratch edit somebody has to remember to
  // revert. The same construction `never-merge.test.ts` uses, for the same
  // reason.
  it.each([
    ['sessionRef', true],
    ['session', true],
    ['developerSession', true],
    ['transcript', true],
    ['transcriptPath', true],
    ['logsRoot', true],
    ['logs_root', true],
    ['systemPrompt', true],
    ['instructions', true],
    ['promptArtifact', true],
    ['sendBackBrief', true],
    ['history', true],
    ['stageAttemptId', true],
    // …and the members a gate legitimately has. A matcher that flagged these
    // would be one nobody could keep.
    ['stageId', false],
    ['workspace', false],
    ['spec', false],
    ['diff', false],
    ['onEvent', false],
    ['signal', false],
    ['changedPaths', false],
    ['base', false],
    ['head', false],
  ])('%s is forbidden gate context: %s', (name, expected) => {
    expect(isForbiddenContext(name)).toBe(expected);
  });
});

describe('GateContext cannot name the developer’s session or transcript (ROLE-03)', () => {
  it('declares not one forbidden member', () => {
    const offenders = [...GATE_CONTEXT_MEMBERS, ...GATE_DIFF_MEMBERS].filter(
      isForbiddenContext,
    );

    expect(
      offenders,
      offenders.length > 0
        ? `GateContext declares ${offenders.join(', ')}. ROLE-03: a gate works ` +
            "from fresh context and never inherits the developer's session, " +
            'transcript, or reasoning, and M05 AC3 says gate context is ' +
            'assembled from spec, diff and repository ONLY. If a gate ' +
            'genuinely needs something new, ask which of those three it comes ' +
            'from — and if the answer is "none of them", it does not belong ' +
            'on this type. The developer’s own inputs travel on AssignMessage, ' +
            'which `worker-entry/gate-context.ts` narrows away and ' +
            '`adl/gate-fresh-context` stops a gate importing directly.'
        : undefined,
    ).toEqual([]);
  });

  it('reads non-empty lists — a guard over an empty array proves nothing', () => {
    // The vacuity control. Either list emptied by a bad merge resolution would
    // make the assertion above pass trivially, and the compile-time
    // exhaustiveness proofs cannot catch that direction on their own:
    // `Exclude<keyof T, never>` is only non-empty, not *complete*, and the
    // `satisfies` clause permits a SHORT list. The counts are checked here
    // instead, from the outside.
    expect(GATE_CONTEXT_MEMBERS.length).toBeGreaterThanOrEqual(6);
    expect(GATE_DIFF_MEMBERS.length).toBeGreaterThanOrEqual(3);
  });

  it('still declares the three sources M05 AC3 permits, so the list is the real context', () => {
    // Names what a gate must actually be able to reach. If this ever fails,
    // `GATE_CONTEXT_MEMBERS` has stopped describing the type the built-in gates
    // are handed, and the assertion above is reading something other than gate
    // context. `spec` and `diff` are two of AC3's three sources by name;
    // `workspace` is the third — the repository itself.
    expect([...GATE_CONTEXT_MEMBERS]).toEqual(
      expect.arrayContaining(['spec', 'diff', 'workspace']),
    );
  });
});
