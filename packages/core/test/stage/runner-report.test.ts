/**
 * Judging a runner's report (ROLE-08, M08 step 8.5).
 *
 * Three properties carry the weight, and each is checked over the whole captured
 * corpus rather than a hand-picked case:
 *
 * 1. **Zero executed is `inconclusive`, whatever the exit code** — node's empty
 *    run exits 0 and vitest's exits 1, and both must land on the same answer.
 * 2. **A pass needs executed tests AND exit 0.** Stated as an invariant over
 *    every fixture at both exit codes, so a regression in any row surfaces here.
 * 3. **A truncated report is never a pass.** Every proper prefix of every
 *    report that passes, cut anywhere a real line would be lost, judges to
 *    something else — which is what a runner killed mid-print looks like.
 *
 * The anti-vacuity pair is node's zero run and node's two-test run: both exit 0,
 * so the exit code cannot be what tells them apart.
 */
import { describe, expect, it } from 'vitest';

import {
  judgeRunnerReport,
  MAX_RUNNER_FINDINGS,
  MAX_RUNNER_REPORT_CHARS,
  readRunnerReport,
  REPORTED_TEST_STATUSES,
  RUNNER_EVIDENCE_KINDS,
  RUNNER_REPORT_DEFECTS,
  type RunnerEvidence,
} from '../../src/stage/index.js';
import { VerdictSchema } from '../../src/verdict/index.js';
import {
  capturedReport,
  CAPTURED_RUN_NAMES,
  CAPTURED_RUNS,
  type CapturedRunName,
} from './runner-report-corpus.js';

const STAGE = 'behaviour';

function judge(text: string, exitCode: number): RunnerEvidence {
  return judgeRunnerReport({
    stageId: STAGE,
    runLabel: 'node --test --test-reporter=tap',
    exitCode,
    read: readRunnerReport('tap', text),
    outputTail: '(the tail of the run)',
  });
}

function judgeCaptured(name: CapturedRunName, exitCode?: number) {
  return judge(capturedReport(name), exitCode ?? CAPTURED_RUNS[name].exitCode);
}

function titles(evidence: RunnerEvidence): string[] {
  return evidence.kind === 'failed'
    ? evidence.verdict.findings.map((finding) => finding.title)
    : [];
}

describe('ROLE-08: a run in which no test executed is inconclusive, never a pass', () => {
  it('node with nothing to run exits 0 — and is inconclusive', () => {
    const evidence = judgeCaptured('node-zero');
    expect(CAPTURED_RUNS['node-zero'].exitCode).toBe(0);
    expect(evidence.kind).toBe('nothing_executed');
    if (evidence.kind !== 'nothing_executed') return;
    expect(evidence.verdict.outcome).toBe('inconclusive');
    expect(evidence.verdict.reason).toContain('no test executed');
    expect(evidence.verdict.reason).toContain('ROLE-08');
  });

  it('vitest with nothing to run exits 1 — and is inconclusive, not a round-costing failure', () => {
    expect(CAPTURED_RUNS['vitest-zero'].exitCode).toBe(1);
    expect(judgeCaptured('vitest-zero').kind).toBe('nothing_executed');
  });

  it('a run of only skipped and todo tests executed nothing', () => {
    for (const name of [
      'node-skip-todo-only',
      'node-describe-all-skipped',
      'vitest-skipped-only',
    ] as const) {
      expect(judgeCaptured(name).kind, name).toBe('nothing_executed');
    }
    const evidence = judgeCaptured('node-skip-todo-only');
    if (evidence.kind !== 'nothing_executed') return;
    expect(evidence.verdict.reason).toContain('2 skipped, 1 todo');
  });

  it('a `1..0 # SKIP` run carries its reason into the verdict', () => {
    const evidence = judge('TAP version 13\n1..0 # SKIP no browser\n', 0);
    expect(evidence.kind).toBe('nothing_executed');
    if (evidence.kind !== 'nothing_executed') return;
    expect(evidence.verdict.reason).toContain('no browser');
  });

  it('an empty describe is a heading, not an executed test', () => {
    const evidence = judge(
      "TAP version 13\nok 1 - AC-1\n  ---\n  duration_ms: 1\n  type: 'suite'\n  ...\n1..1\n",
      0,
    );
    expect(evidence.kind).toBe('nothing_executed');
  });

  it('the anti-vacuity pair: two exit-0 node runs, told apart only by the report', () => {
    const zero = judgeCaptured('node-zero');
    const ran = judgeCaptured('node-pass');
    expect(CAPTURED_RUNS['node-zero'].exitCode).toBe(
      CAPTURED_RUNS['node-pass'].exitCode,
    );
    expect(zero.kind).toBe('nothing_executed');
    expect(ran.kind).toBe('passed');
    if (ran.kind !== 'passed') return;
    expect(ran.executed.map((test) => test.path.join(' > '))).toEqual([
      'AC-1: GET /health answers 200',
      'AC-2: the body is JSON',
    ]);
    expect(ran.verdict.summary).toContain('exited 0');
    expect(ran.verdict.summary).toContain('2 executed tests');
  });
});

describe('the whole table, over the captured corpus', () => {
  const EXPECTED: Readonly<
    Record<CapturedRunName, readonly [RunnerEvidence['kind'], ...string[]]>
  > = {
    'node-zero': ['nothing_executed'],
    'node-pass': ['passed'],
    'node-fail': ['failed', 'test failed: AC-1: GET /health answers 200'],
    'node-nested-fail': [
      'failed',
      'test failed: AC-3 export > downloads a csv',
    ],
    'node-nested-double': ['passed'],
    'node-describe-all-skipped': ['nothing_executed'],
    'node-skip-todo-only': ['nothing_executed'],
    'node-after-hook': [
      'failed',
      'test group failed outside any test: suite with failing after hook',
    ],
    'node-before-hook': [
      'failed',
      'test failed: suite with failing before hook > never gets to run',
    ],
    'node-load-throw': ['failed', 'test failed: a.test.mjs'],
    'node-exitcode': ['failed', 'test failed: a.test.mjs'],
    // Residual R1, stated rather than hidden: node reports a test-less file,
    // and a file whose test called process.exit(0), as ONE PASSING TEST named
    // after the file. No report reader can tell it from a real pass; step 8.8's
    // must-fail-at-base guardrail is what catches it (DEBT.md D-8-05-2).
    'node-empty-file': ['passed'],
    'node-exit0-midrun': ['passed'],
    'node-hash-names': ['failed', 'test failed: grp > inner fails # TODO y'],
    'node-console': ['passed'],
    'node-empty-describe': ['passed'],
    'vitest-pass-nested': ['passed'],
    'vitest-fail': [
      'failed',
      'test failed: a.test.mjs > AC-1: GET /health answers 200',
    ],
    'vitest-zero': ['nothing_executed'],
    'vitest-after-all': [
      'failed',
      'test group failed outside any test: a.test.mjs > grp',
    ],
    // Residual R6: `tap-flat` erases the failed group, so the afterAll failure
    // survives only as the exit-code veto, and the beforeAll one as an empty
    // run. Never a pass — but the wrong class, which is why the `emits`
    // description names `--reporter=tap`.
    'vitest-after-all-flat': [
      'failed',
      `the ${STAGE} runner exited 1 although every test it reported passed`,
    ],
    'vitest-before-all': [
      'failed',
      'test group failed outside any test: a.test.mjs > grp',
    ],
    'vitest-before-all-flat': ['nothing_executed'],
    'vitest-unhandled': [
      'failed',
      `the ${STAGE} runner exited 1 although every test it reported passed`,
    ],
    'vitest-skipped-only': ['nothing_executed'],
    'vitest-forged': ['unjudgeable'],
    'vitest-empty-file': ['failed', 'test failed: a.test.mjs'],
  };

  it.each(CAPTURED_RUN_NAMES)('%s', (name) => {
    const [kind, ...expectedTitles] = EXPECTED[name];
    const evidence = judgeCaptured(name);
    expect(evidence.kind).toBe(kind);
    expect(titles(evidence)).toEqual(expectedTitles);
  });

  it('every verdict the table produces is one the published schema accepts', () => {
    for (const name of CAPTURED_RUN_NAMES) {
      for (const exitCode of [0, 1]) {
        const evidence = judgeCaptured(name, exitCode);
        if (evidence.kind === 'unjudgeable') continue;
        expect(
          VerdictSchema.safeParse(evidence.verdict).success,
          `${name} at exit ${String(exitCode)}`,
        ).toBe(true);
      }
    }
  });

  it('a pass cites the suite, never a criterion — which test covers which criterion is step 8.7', () => {
    const evidence = judgeCaptured('vitest-pass-nested');
    expect(evidence.kind).toBe('passed');
    if (evidence.kind !== 'passed') return;
    expect(evidence.verdict.checked).toEqual([
      { kind: 'global', category: 'build' },
    ]);
    // The test is NAMED `AC-1: top`; reading a criterion out of that would be
    // a sniff.
    expect(JSON.stringify(evidence.verdict.checked)).not.toContain('AC-1');
    expect(evidence.verdict.summary).toContain('(1 skipped, 1 todo)');
  });
});

describe('the invariants', () => {
  it('passed ⇒ exit 0 and at least one executed test — every fixture, both exit codes', () => {
    let passes = 0;
    for (const name of CAPTURED_RUN_NAMES) {
      for (const exitCode of [0, 1]) {
        const evidence = judgeCaptured(name, exitCode);
        if (evidence.kind !== 'passed') continue;
        passes += 1;
        expect(exitCode, `${name} passed at exit ${String(exitCode)}`).toBe(0);
        expect(evidence.executed.length).toBeGreaterThan(0);
      }
    }
    // Anti-vacuity: an invariant over zero passes proves nothing.
    expect(passes).toBeGreaterThanOrEqual(6);
  });

  it('the exit code can veto a pass and never create one', () => {
    for (const name of CAPTURED_RUN_NAMES) {
      const at0 = judgeCaptured(name, 0).kind;
      const at1 = judgeCaptured(name, 1).kind;
      if (at0 !== 'passed') {
        expect(at1, `${name}: a non-zero exit turned ${at0} into ${at1}`).toBe(
          at0,
        );
      } else {
        expect(at1).toBe('failed');
      }
    }
  });

  it('no proper prefix of a passing report passes — a report cut short is never green', () => {
    let prefixes = 0;
    for (const name of CAPTURED_RUN_NAMES) {
      if (judgeCaptured(name, 0).kind !== 'passed') continue;
      const lines = capturedReport(name).replace(/\r\n/g, '\n').split('\n');
      for (let keep = 0; keep < lines.length; keep += 1) {
        const dropped = lines.slice(keep);
        // Losing only blank lines and comments loses nothing a report is judged
        // on; every other cut loses a point, a plan, a `}` or a YAML terminator.
        const lostSomething = dropped.some(
          (line) => line.trim() !== '' && !line.trimStart().startsWith('#'),
        );
        if (!lostSomething) continue;
        prefixes += 1;
        const evidence = judge(lines.slice(0, keep).join('\n'), 0);
        expect(
          evidence.kind,
          `${name} cut to its first ${String(keep)} lines still passed`,
        ).not.toBe('passed');
      }
    }
    expect(prefixes).toBeGreaterThan(50);
  });
});

describe('findings from failing tests', () => {
  it('a hook failure is a failure even though no test failed', () => {
    const evidence = judgeCaptured('node-after-hook', 0);
    expect(evidence.kind).toBe('failed');
    expect(titles(evidence)).toEqual([
      'test group failed outside any test: suite with failing after hook',
    ]);
  });

  it('a group that failed because a child failed adds no second finding', () => {
    expect(titles(judgeCaptured('node-nested-fail'))).toHaveLength(1);
  });

  it('carries the runner’s own diagnostic, bounded, on the finding', () => {
    const evidence = judgeCaptured('vitest-fail');
    expect(evidence.kind).toBe('failed');
    if (evidence.kind !== 'failed') return;
    const [finding] = evidence.verdict.findings;
    expect(finding?.severity).toBe('blocker');
    expect(finding?.criterionRef).toEqual({
      kind: 'global',
      category: 'build',
    });
    expect(finding?.detail).toContain('expected 404 to be 200');
  });

  it('fingerprints do not move with the workspace root, timings or point numbers', () => {
    // The blind workspace root embeds the attempt id, so a diagnostic's absolute
    // path differs every attempt; vitest's `# time=` and node's `duration_ms`
    // differ every run. None of it may reach the fingerprint, or stall
    // detection never recognises the same failing test twice.
    for (const name of [
      'node-fail',
      'vitest-fail',
      'node-nested-fail',
    ] as const) {
      const base = capturedReport(name);
      const a = judge(base.split('<root>').join('C:\\attempt-a'), 1);
      const b = judge(
        base
          .split('<root>')
          .join('/tmp/adl-visible/feat--behaviour-attempt-b')
          .replace(/time=[\d.]+ms/g, 'time=999.99ms')
          .replace(/duration_ms: [\d.]+/g, 'duration_ms: 12345.6')
          .replace(/^(\s*(?:not )?ok) \d+/gm, '$1 7'),
        1,
      );
      expect(a.kind).toBe('failed');
      expect(b.kind).toBe('failed');
      if (a.kind !== 'failed' || b.kind !== 'failed') return;
      expect(
        b.verdict.findings.map((f) => f.fingerprint),
        name,
      ).toEqual(a.verdict.findings.map((f) => f.fingerprint));
    }
  });

  function manyFailures(order: readonly number[]): string {
    return [
      'TAP version 13',
      ...order.map((n) => `not ok ${String(n)} - failing test ${String(n)}`),
      `1..${String(order.length)}`,
    ].join('\n');
  }

  it(`caps the findings at ${String(MAX_RUNNER_FINDINGS)}, deterministically, and says how many there were`, () => {
    const ascending = Array.from({ length: 25 }, (_, i) => i + 1);
    const a = judge(manyFailures(ascending), 1);
    const b = judge(manyFailures([...ascending].reverse()), 1);
    expect(a.kind).toBe('failed');
    expect(b.kind).toBe('failed');
    if (a.kind !== 'failed' || b.kind !== 'failed') return;
    expect(a.verdict.findings).toHaveLength(MAX_RUNNER_FINDINGS);
    expect(b.verdict.findings).toEqual(a.verdict.findings);
    expect(a.verdict.summary).toContain('25 failing tests');
    expect(a.verdict.summary).toContain(
      `(${String(MAX_RUNNER_FINDINGS)} listed)`,
    );
  });

  it('two failing tests with one name are one finding that says so', () => {
    const evidence = judge(
      'TAP version 13\nnot ok 1 - same name\nnot ok 2 - same name\n1..2\n',
      1,
    );
    expect(evidence.kind).toBe('failed');
    if (evidence.kind !== 'failed') return;
    expect(evidence.verdict.findings).toHaveLength(1);
    expect(evidence.verdict.findings[0]?.detail).toContain('2 times');
  });
});

describe('what cannot be judged is unparseable, never a verdict (D-12)', () => {
  it('no document at all names the reporter flags', () => {
    const evidence = judge('✔ AC-1 (1.2ms)\nℹ tests 1\n', 0);
    expect(evidence.kind).toBe('unjudgeable');
    if (evidence.kind !== 'unjudgeable') return;
    expect(evidence.errorKind).toBe('unparseable');
    expect(evidence.detail).toContain('--test-reporter=tap');
    expect(evidence.detail).toContain('--reporter=tap');
  });

  it('a truncated report is unparseable at either exit code', () => {
    for (const exitCode of [0, 1]) {
      expect(judge('TAP version 13\nok 1 - a\n', exitCode).kind).toBe(
        'unjudgeable',
      );
    }
  });

  it('a report over the size bound is refused rather than judged in part', () => {
    const huge = `TAP version 13\n${'#'.repeat(MAX_RUNNER_REPORT_CHARS)}\n1..0\n`;
    const read = readRunnerReport('tap', huge);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.defect).toBe('too_large');
  });

  it('Bail out! with a failure before it is a send_back; without one it did not judge', () => {
    expect(
      titles(judge('TAP version 13\n1..3\nnot ok 1 - a\nBail out!\n', 1)),
    ).toEqual(['test failed: a']);
    expect(
      judge('TAP version 13\n1..3\nok 1 - a\nBail out! out of disk\n', 1).kind,
    ).toBe('unjudgeable');
  });
});

describe('the frozen vocabularies', () => {
  it('are frozen and say exactly what the answer types say', () => {
    expect(Object.isFrozen(REPORTED_TEST_STATUSES)).toBe(true);
    expect(Object.isFrozen(RUNNER_REPORT_DEFECTS)).toBe(true);
    expect(Object.isFrozen(RUNNER_EVIDENCE_KINDS)).toBe(true);
    expect(RUNNER_EVIDENCE_KINDS).toEqual([
      'unjudgeable',
      'failed',
      'nothing_executed',
      'passed',
    ]);
  });
});

/**
 * What step 8.5's review found, each pinned against the shape that exposed it.
 * The TAP below is real runner output as the review captured it (vitest 4.1.10;
 * node v24 for the named leaf), trimmed to the lines that matter.
 */
describe('shapes the review found', () => {
  it('a vitest failure with annotate() notes before its YAML is still a send_back, not unparseable', () => {
    const evidence = judge(
      [
        'TAP version 13',
        '1..1',
        'not ok 1 - a.test.mjs # time=21.40ms {',
        '    1..1',
        '    not ok 1 - AC-1 # time=19.12ms',
        '        # notice: probed /health',
        '        ---',
        '        error:',
        '            name: "AssertionError"',
        '            message: "expected 404 to be 200"',
        '        ...',
        '}',
      ].join('\n'),
      1,
    );
    expect(evidence.kind).toBe('failed');
    if (evidence.kind !== 'failed') return;
    expect(titles(evidence)).toEqual(['test failed: a.test.mjs > AC-1']);
    expect(evidence.verdict.findings[0]?.detail).toContain(
      'expected 404 to be 200',
    );
  });

  it('a node test NAMED with a trailing ` {` is a leaf that keeps its brace, not a block opener', () => {
    // node escapes `#` in a name but not `{`, and prints YAML after every point.
    const evidence = judge(
      [
        'TAP version 13',
        '# Subtest: returns {',
        'not ok 1 - returns {',
        '  ---',
        "  type: 'test'",
        "  error: 'expected an object'",
        '  ...',
        '# Subtest: fine',
        'ok 2 - fine',
        '  ---',
        "  type: 'test'",
        '  ...',
        '1..2',
      ].join('\n'),
      1,
    );
    expect(evidence.kind).toBe('failed');
    expect(titles(evidence)).toEqual(['test failed: returns {']);
  });

  it("node's before-hook failure: the cancelled test's finding carries the hook's own error", () => {
    // node fails every test a `before` hook cancelled, so they are the root
    // causes — and the hook's error lives only on the failed group's diagnostic.
    const evidence = judgeCaptured('node-before-hook');
    expect(evidence.kind).toBe('failed');
    if (evidence.kind !== 'failed') return;
    expect(evidence.verdict.findings[0]?.detail).toContain('setup hook broke');
    // Detail only: the title, and so the fingerprint, did not move.
    expect(titles(evidence)).toEqual([
      'test failed: suite with failing before hook > never gets to run',
    ]);
  });

  it('RESIDUAL, stated: vitest with passWithNoTests reports an empty describe and a test-less file as passing tests', () => {
    // No reader can tell these from real passing tests without guessing from
    // names. Step 8.8's must-fail-at-base guardrail is what catches them
    // (DEBT.md D-8-05-2). Pinned so that the day it changes, it is noticed.
    const evidence = judge(
      [
        'TAP version 13',
        '1..2',
        'ok 1 - a.test.mjs # time=4.82ms {',
        '    1..1',
        '    ok 1 - AC-1: the export works # time=0.50ms',
        '}',
        'ok 2 - b.test.mjs # time=2.30ms',
      ].join('\n'),
      0,
    );
    expect(evidence.kind).toBe('passed');
  });
});
