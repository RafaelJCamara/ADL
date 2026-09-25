/**
 * HARN-04 as code (M08 step 8.4): *"reviewer and tester are implemented on the
 * same interface third parties use."*
 *
 * 7.9 proved the reviewer's half by removal — delete it from `adl.yml` and it
 * leaves the pipeline, with no code change. That proof does not transfer to the
 * tester's other half, which is about what the two gates are *handed*: a branch
 * giving the built-in tester a richer context than a third party's gate would be
 * invisible to a removal test, because the gate that was removed is the one that
 * would have noticed.
 *
 * So this reads `stage-runner.ts` as text. That is the same shape as
 * `packages/workspace/test/contract/workspace-contract.test.ts`'s importer pins
 * and exists for the same reason: the property lives in one expression, the
 * expression is easy to edit in a way that looks harmless, and no type can see
 * the difference.
 *
 * ## The exact regression this catches
 *
 * `runGate` builds one `gateForRun` — `built.gate` plus the app's port when one
 * was started — and hands it to both the agent implementation and the command
 * gate. The harmless-looking edit is to pass `gateForRun` to `implementation(…)`
 * and leave `runCommandGate(built.gate, …)` as it was. Everything compiles, every
 * existing test stays green, and the built-in tester now reads a member a third
 * party's command gate declaring the identical `needs_app` cannot. That is HARN-04
 * false with nothing red.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, BUILT_IN_STAGE_IDS } from '@adl/core/config';
// The two policy tables live in `@adl/core/loop` beside the loop decisions that
// read them, not beside the stage-id list they are keyed by.
import { costClassOf, judgementKindOf } from '@adl/core/loop';
import { withoutComments } from '../../../workspace/test/helpers/source-scan.js';

const STAGE_RUNNER = fileURLToPath(
  new URL('../../src/worker-entry/stage-runner.ts', import.meta.url),
);

async function stageRunnerCode(): Promise<string> {
  // Comments stripped, because this file's own subject matter is named at length
  // in that module's prose — and because `source-scan.ts`'s stripper is the one
  // that does not go blind on a docblock opener inside a line comment (D-8-01-1).
  return withoutComments(await readFile(STAGE_RUNNER, 'utf8'));
}

describe('both gate kinds are handed the same context object', () => {
  it('passes gateForRun to the agent implementation AND to the command gate', async () => {
    const code = await stageRunnerCode();

    expect(code, 'the agent gate must receive the composed context').toContain(
      'implementation(gateForRun)',
    );
    expect(
      code,
      'and so must the command gate — otherwise a built-in agent gate reads a ' +
        "member a third party's command gate cannot (HARN-04)",
    ).toContain('runCommandGate(gateForRun,');
  });

  it('hands the narrowed context to neither, so there is one object and not two', async () => {
    // The anti-vacuity half. Without this, adding a second call that passes
    // `built.gate` alongside the two above would satisfy them both.
    const code = await stageRunnerCode();

    expect(code).not.toContain('implementation(built.gate)');
    expect(code).not.toContain('runCommandGate(built.gate,');
  });

  it('reads the app port from the pipeline entry’s declaration, never from a stage id', async () => {
    // The other way a privileged branch gets written: `needsApp` inferred from the
    // stage being the built-in tester. `resolvedStageFor(assign)?.needsApp` is the
    // only permitted source, and a comparison against a stage-id literal beside it
    // is what this forbids.
    const code = await stageRunnerCode();

    expect(code).toContain('resolvedStageFor(assign)?.needsApp');
    for (const forbidden of [
      "assign.stageId === 'behaviour'",
      "stageId === 'behaviour'",
      "role.role === 'tester'",
    ]) {
      expect(
        code,
        `${forbidden} would make the lifecycle a property of the tester's NAME`,
      ).not.toContain(forbidden);
    }
  });
});

describe('an entry that declares its own program wins over a built-in name', () => {
  it("checks source: 'command' BEFORE the agent-role lookup", async () => {
    // A real regression, caught by four existing scenario tests the moment
    // `behaviour → tester` entered `AGENT_GATE_ROLES`. All four name their gate
    // `harness: 'behaviour'` with their own `with.command` — an arbitrary
    // third-party name, which is exactly what HARN-02 promises is allowed — and all
    // four were suddenly dispatched into the built-in tester agent instead of
    // running their own program.
    //
    // Asserted on the source rather than only through those scenarios because the
    // scenarios catch it by accident: they would stop catching it the day somebody
    // renamed their fixture gate, and the property would silently be gone.
    const code = await stageRunnerCode();
    const commandCheck = code.indexOf(
      "resolvedStageFor(assign)?.source === 'command'",
    );
    const agentLookup = code.indexOf('AGENT_GATE_ROLES.get(assign.stageId)');

    expect(commandCheck).toBeGreaterThan(-1);
    expect(agentLookup).toBeGreaterThan(-1);
    expect(
      commandCheck,
      "resolveStageRole must decide `source: 'command'` before looking up an agent " +
        "role, or a third party cannot name their gate after one of ADL's built-ins " +
        'without ADL quietly running something else',
    ).toBeLessThan(agentLookup);
  });
});

describe('the tester is a built-in like any other, with its policies declared', () => {
  it('is a built-in stage id, so its policies are machine-checked', async () => {
    // Finding 8: `BUILT_IN_COST_CLASSES` and `BUILT_IN_JUDGEMENT_KINDS` are keyed
    // by `BuiltInStageId`, so being on this list is what makes a missing policy a
    // BUILD failure rather than a silent default.
    expect([...BUILT_IN_STAGE_IDS]).toContain('behaviour');
  });

  it('declares expensive and deterministic, and each for a stated reason', async () => {
    const stage = { id: 'behaviour', source: 'built-in' } as const;

    // `expensive` → `on_send_back` defaults to `stop`, so an earlier gate's
    // send-back does not pay to build and boot an app in order to judge code
    // already known to need changes.
    expect(costClassOf(stage)).toBe('expensive');

    // `deterministic` → LOOP-09 cannot demote a genuine round-2 regression to a
    // follow-up. Step 8.6's committed tests are what make this honest: a re-run
    // test has a stable fingerprint, so the tester stops being a fresh opinion
    // every round.
    expect(judgementKindOf(stage)).toBe('deterministic');
  });

  it('is not the same classification as the reviewer, which is the point', async () => {
    // Anti-vacuity: if `judgementKindOf` were returning the default for everything,
    // the case above would pass and mean nothing. The reviewer is `opinion` and the
    // tester is `deterministic`, and the difference is exactly what finding 8 is
    // about.
    expect(judgementKindOf({ id: 'review', source: 'built-in' })).toBe(
      'opinion',
    );
    expect(judgementKindOf({ id: 'behaviour', source: 'built-in' })).toBe(
      'deterministic',
    );
  });

  it('does not inherit a built-in classification through a repo-path harness of the same name', async () => {
    // `costClassOf` and `judgementKindOf` both key on `source` as well as `id`,
    // because a pipeline entry's id is chosen by whoever wrote `adl.yml`. A
    // repo-path harness NAMED `behaviour` must not inherit ADL's tester policy.
    expect(judgementKindOf({ id: 'behaviour', source: 'repo-path' })).toBe(
      'deterministic',
    );
    expect(costClassOf({ id: 'behaviour', source: 'repo-path' })).toBe(
      'expensive',
    );
    // Both happen to equal the built-in's values, which is why the `test` case is
    // the one that actually discriminates: `cheap` as a built-in, `expensive` as
    // anything else.
    expect(costClassOf({ id: 'test', source: 'built-in' })).toBe('cheap');
    expect(costClassOf({ id: 'test', source: 'repo-path' })).toBe('expensive');
  });

  it('has a producer for every agent role, the tester included', async () => {
    // `tester: null` was the honest state until this step. The list is read from
    // `@adl/core` so a fourth role added later is visible here too.
    expect([...AGENT_ROLES]).toEqual(['developer', 'reviewer', 'tester']);
    const code = await stageRunnerCode();
    expect(code).toContain("tester: 'behaviour'");
    expect(code).toContain('tester: runTesterGate');
    expect(code).not.toContain('tester: null');
  });
});
