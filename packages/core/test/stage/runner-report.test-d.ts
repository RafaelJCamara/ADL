import { describe, expectTypeOf, it } from 'vitest';

import type {
  ReportedTestResult,
  RunnerEvidence,
  RunnerReport,
} from '../../src/stage/index.js';
import type { Outcome, PassVerdict } from '../../src/verdict/index.js';

/**
 * The compile-time half of ROLE-08 (M08 step 8.5).
 *
 * `runner-report.test.ts` shows the judge never returns a pass from zero
 * executed tests. These show a pass from zero executed tests cannot even be
 * **written** — and that the answer type has no room for an outcome the table
 * does not produce. Both live here because core's runtime tests are not
 * typechecked (only `*.test-d.ts` is, through `tsconfig.test.json`), so a claim
 * about a type made anywhere else would be compiled by nothing.
 *
 * The `@ts-expect-error` lines are the sharp end: if the assignment ever becomes
 * legal, the suppression becomes unused and TypeScript reports THAT.
 */

declare const report: RunnerReport;
declare const pass: PassVerdict;
declare const one: ReportedTestResult;

describe('RunnerEvidence', () => {
  it('cannot express a pass built from zero executed tests', () => {
    const fromNothing: RunnerEvidence = {
      kind: 'passed',
      verdict: pass,
      report,
      // @ts-expect-error — a pass needs at least one executed test, by type.
      executed: [],
    };
    void fromNothing;

    const fromOne: RunnerEvidence = {
      kind: 'passed',
      verdict: pass,
      report,
      executed: [one],
    };
    void fromOne;
  });

  it('carries only the three outcomes the table produces', () => {
    type Carried = Extract<
      RunnerEvidence,
      { verdict: unknown }
    >['verdict']['outcome'];
    expectTypeOf<Carried>().toEqualTypeOf<
      'pass' | 'send_back' | 'inconclusive'
    >();
    expectTypeOf<Exclude<Outcome, Carried>>().toEqualTypeOf<
      'fail' | 'warn' | 'skip'
    >();
  });

  it('names exactly one StageError kind — a report that cannot be judged is unparseable', () => {
    type ErrorKind = Extract<
      RunnerEvidence,
      { kind: 'unjudgeable' }
    >['errorKind'];
    expectTypeOf<ErrorKind>().toEqualTypeOf<'unparseable'>();
  });
});
