import { describe, expectTypeOf, it } from 'vitest';

import type { StageError, StageOutcome } from '../../src/stage/index.js';
import type { Verdict } from '../../src/verdict/index.js';

/**
 * The compile-time half of D-12 / CORE-06.
 *
 * A runtime test cannot express this. `stage-error.test.ts` proves the two
 * *schemas* reject each other's payloads — but a refactor that unified the two
 * TypeScript types (say, by folding `StageError` in as a seventh outcome, or by
 * widening `StageError` until a `SkipVerdict` satisfies it) would leave every
 * one of those runtime assertions passing while quietly making a broken gate
 * assignable to a judging one everywhere in the codebase.
 *
 * These assertions fail the **typecheck** instead. The `@ts-expect-error`
 * comments are the sharp end: if the assignment ever becomes legal, the
 * suppression becomes unused and TypeScript reports *that* as an error. The
 * proof therefore breaks in exactly the situation it exists to catch.
 */

const stageError: StageError = {
  kind: 'timeout',
  retryable: true,
  detail: 'the reviewer agent exceeded its wall clock',
};

const verdict: Verdict = {
  outcome: 'pass',
  summary: 'every acceptance criterion is covered',
  checked: [{ kind: 'criterion', id: 'AC-1' }],
};

describe('StageError and Verdict are different kinds of thing (D-12)', () => {
  it('will not let a broken gate be recorded as a gate that judged', () => {
    // @ts-expect-error — a StageError is not a Verdict, and must never become one.
    const asVerdict: Verdict = stageError;
    void asVerdict;

    expectTypeOf<StageError>().not.toExtend<Verdict>();
  });

  it('will not let a gate that judged be recorded as a broken gate', () => {
    // @ts-expect-error — a Verdict is not a StageError, in the other direction too.
    const asStageError: StageError = verdict;
    void asStageError;

    expectTypeOf<Verdict>().not.toExtend<StageError>();
  });

  it('carries both, and only both, in StageOutcome', () => {
    expectTypeOf<Verdict>().toExtend<StageOutcome>();
    expectTypeOf<StageError>().toExtend<StageOutcome>();
    expectTypeOf<StageOutcome>().toEqualTypeOf<Verdict | StageError>();
  });

  it('keeps the discriminating field on exactly one side', () => {
    // `outcome` is what every Verdict member has and no StageError has, which is
    // what makes `isStageError` a total narrowing rather than a guess.
    expectTypeOf<Verdict>().toHaveProperty('outcome');
    expectTypeOf<StageError>().not.toHaveProperty('outcome');
    expectTypeOf<StageError>().toHaveProperty('kind');
  });
});
