/**
 * Reading a TAP report (ROLE-08, M08 step 8.5).
 *
 * What carries the weight here is that the reader is checked against **real
 * runners' real output** — the captured corpus — before any synthetic case: both
 * nesting dialects, both YAML indents, node's repeated point numbers and escaped
 * `#`, vitest's `# time=` annotations and its forged-document shape. The
 * synthetic cases after that cover what the specification allows and neither
 * runner printed, and each is labelled so.
 */
import { describe, expect, it } from 'vitest';

import {
  flattenReport,
  readTapReport,
  type ReportedTest,
  type RunnerReport,
  type RunnerReportRead,
} from '../../src/stage/index.js';
import { capturedReport, CAPTURED_RUN_NAMES } from './runner-report-corpus.js';

function report(read: RunnerReportRead): RunnerReport {
  if (!read.ok) {
    throw new Error(
      `expected a readable report, got ${read.defect}: ${read.detail}`,
    );
  }
  return read.report;
}

/** `name [status]`, children indented — a shape a failure message can show whole. */
function outline(tests: readonly ReportedTest[], depth = 0): string[] {
  return tests.flatMap((test) => [
    `${'  '.repeat(depth)}${test.name} [${test.status}${test.children === undefined ? '' : ', group'}]`,
    ...outline(test.children ?? [], depth + 1),
  ]);
}

function outlineOf(name: Parameters<typeof capturedReport>[0]): string[] {
  return outline(report(readTapReport(capturedReport(name))).tests);
}

describe('the captured corpus — real node and vitest output', () => {
  it('reads every captured report except the one that holds two documents', () => {
    // Anti-vacuity for the file: the corpus is not empty, and every member but
    // one is readable — a reader that refused everything would fail here rather
    // than pass every "is not a pass" case below for the wrong reason.
    expect(CAPTURED_RUN_NAMES.length).toBe(27);
    const unreadable = CAPTURED_RUN_NAMES.filter(
      (name) => !readTapReport(capturedReport(name)).ok,
    );
    expect(unreadable).toEqual(['vitest-forged']);
  });

  it('node, nothing to run: a complete, empty report', () => {
    expect(report(readTapReport(capturedReport('node-zero'))).tests).toEqual(
      [],
    );
  });

  it('node, flat tests with a trailing plan and YAML at +2', () => {
    const read = report(readTapReport(capturedReport('node-fail')));
    expect(outline(read.tests)).toEqual([
      'AC-1: GET /health answers 200 [failed]',
      'AC-2: the body is JSON [passed]',
    ]);
    expect(read.tests[0]!.diagnostic).toContain('404 !== 200');
    expect(read.tests[0]!.diagnostic).toContain(
      "failureType: 'testCodeFailure'",
    );
    // Dedented: the block's own indent is gone, its internal structure is not.
    expect(read.tests[0]!.diagnostic!.startsWith('duration_ms')).toBe(true);
  });

  it('node, children BEFORE their parent point are adopted by it', () => {
    expect(outlineOf('node-nested-fail')).toEqual([
      'AC-3 export [failed, group]',
      '  shows the button [passed]',
      '  downloads a csv [failed]',
    ]);
  });

  it('node, a describe inside a describe — children that start two levels down', () => {
    // The first structural line inside `outer` is at depth 2, because `inner`
    // has printed nothing but a comment yet. A reader that refused a jump of
    // more than one level would call node's own nesting malformed.
    expect(outlineOf('node-nested-double')).toEqual([
      'outer [passed, group]',
      '  inner [passed, group]',
      '    deep leaf passes [passed]',
      '  shallow leaf passes [passed]',
    ]);
  });

  it("node, an empty describe is a group — read from its YAML `type: 'suite'`", () => {
    // It prints no subtest block at all, so structurally it is a passing leaf.
    // Without the one key tap.ts reads, a tester that wrote only an empty
    // describe would have "executed a test".
    expect(outlineOf('node-empty-describe')).toEqual([
      'empty group [passed, group]',
      'a real test [passed]',
    ]);
  });

  it('node, skip and todo directives', () => {
    expect(outlineOf('node-skip-todo-only')).toEqual([
      'skipped one [skipped]',
      'todo one [todo]',
      'dynamic skip [skipped]',
    ]);
  });

  it('node, an escaped # is part of the name, never a directive', () => {
    expect(outlineOf('node-hash-names')).toEqual([
      'grp [failed, group]',
      '  inner fails # TODO y [failed]',
      '  counts 3 # of items [passed]',
      '  back\\slash [passed]',
    ]);
  });

  it('node, repeated point numbers are accepted — they are never validated', () => {
    // `process.exitCode = 1` in a passing test makes node append a file-level
    // `not ok 1` after `ok 1` and `ok 2`, under `1..3`.
    expect(outlineOf('node-exitcode')).toEqual([
      'passes but sets exitCode [passed]',
      'second passes [passed]',
      'a.test.mjs [failed]',
    ]);
  });

  it("node, a test's own console output is a comment, not a test", () => {
    expect(outlineOf('node-console')).toEqual(['real one [passed]']);
  });

  it('node, a hook failure is a failed group whose tests passed or were cancelled', () => {
    expect(outlineOf('node-after-hook')).toEqual([
      'suite with failing after hook [failed, group]',
      '  passes [passed]',
    ]);
    expect(outlineOf('node-before-hook')).toEqual([
      'suite with failing before hook [failed, group]',
      '  never gets to run [failed]',
    ]);
  });

  it('vitest, buffered `{ … }` blocks with leading plans and `# time=` removed', () => {
    expect(outlineOf('vitest-pass-nested')).toEqual([
      'a.test.mjs [passed, group]',
      '  AC-3 group [passed, group]',
      '    nested pass [passed]',
      '    skipped [skipped]',
      '    later [todo]',
      '  AC-1: top [passed]',
    ]);
  });

  it('vitest, YAML at +4 attaches to its point', () => {
    const read = report(readTapReport(capturedReport('vitest-fail')));
    const failing = flattenReport(read).find(
      (test) => test.path.at(-1) === 'AC-1: GET /health answers 200',
    );
    expect(failing?.status).toBe('failed');
    expect(failing?.diagnostic).toContain(
      'expected 404 to be 200 // Object.is equality',
    );
  });

  it('vitest, a skipped file: the directive sits before the `{`', () => {
    expect(outlineOf('vitest-skipped-only')).toEqual([
      'a.test.mjs [skipped, group]',
      '  only skipped [skipped]',
    ]);
  });

  it('vitest, a hook failure fails the group and leaves its test passed or skipped', () => {
    expect(outlineOf('vitest-after-all')).toEqual([
      'a.test.mjs [failed, group]',
      '  grp [failed, group]',
      '    inner passes [passed]',
    ]);
    expect(outlineOf('vitest-before-all')).toEqual([
      'a.test.mjs [failed, group]',
      '  grp [failed, group]',
      '    inner never runs [skipped]',
    ]);
  });

  it('vitest `tap-flat` erases the group that failed — a known limit, stated', () => {
    // Why the `emits` description says `--reporter=tap` and not `tap-flat`:
    // the same afterAll failure reads as one passing test here.
    expect(outlineOf('vitest-after-all-flat')).toEqual([
      'a.test.mjs > grp > inner passes [passed]',
    ]);
  });

  it('vitest, a test that forges a report produces two documents, and is refused', () => {
    const read = readTapReport(capturedReport('vitest-forged'));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.defect).toBe('multiple_documents');
  });

  it('reads CRLF line endings exactly as LF — a Windows checkout converts them', () => {
    for (const name of CAPTURED_RUN_NAMES) {
      const lf = capturedReport(name).replace(/\r\n/g, '\n');
      const crlf = lf.replace(/\n/g, '\r\n');
      expect(readTapReport(crlf), name).toEqual(readTapReport(lf));
    }
  });
});

describe('the document boundary', () => {
  it('ignores everything before the version line, such as npm’s script header', () => {
    // Synthetic: `npm test` prints these two lines before the runner starts.
    const read = readTapReport(
      '\n> pkg@1.0.0 test\n> node --test\n\nTAP version 13\nok 1 - works\n1..1\n',
    );
    expect(outline(report(read).tests)).toEqual(['works [passed]']);
  });

  it('refuses output with no TAP document — a forgotten reporter flag, or a crash before printing', () => {
    for (const text of [
      '',
      '✔ AC-1 (1.2ms)\nℹ tests 1\nℹ pass 1\n',
      'ok 1 - a point with no document around it\n1..1\n',
    ]) {
      const read = readTapReport(text);
      expect(read.ok, JSON.stringify(text)).toBe(false);
      if (!read.ok) expect(read.defect).toBe('no_document');
    }
  });

  it('refuses a TAP version it does not read', () => {
    // Synthetic: TAP 12 has no version line at all and is `no_document` above;
    // an explicit unknown version is refused rather than guessed at.
    const read = readTapReport('TAP version 15\nok 1 - x\n1..1\n');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.defect).toBe('malformed');
  });

  it('refuses a second document', () => {
    const read = readTapReport(
      'TAP version 13\nok 1 - a\n1..1\nTAP version 13\nnot ok 1 - b\n1..1\n',
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.defect).toBe('multiple_documents');
  });
});

describe('what counts as a structural line', () => {
  it('reads `ok` only as a whole word — `ok, starting server` is noise', () => {
    const read = readTapReport(
      'TAP version 13\nok, starting server on 4000\nokay then\nok 1 - real\n1..1\n',
    );
    expect(outline(report(read).tests)).toEqual(['real [passed]']);
  });

  it('never reads a summary comment — node’s `# fail 0` sits beside a failed hook', () => {
    const read = readTapReport(
      'TAP version 13\nnot ok 1 - x\n1..1\n# tests 1\n# pass 1\n# fail 0\n',
    );
    expect(outline(report(read).tests)).toEqual(['x [failed]']);
  });

  it('reads `not ok # SKIP` as a failure — fail-safe', () => {
    // Synthetic: neither runner prints it.
    const read = readTapReport(
      'TAP version 13\nnot ok 1 - x # SKIP why\n1..1\n',
    );
    expect(outline(report(read).tests)).toEqual(['x [failed]']);
  });

  it('reads a `1..0 # SKIP reason` plan as a complete empty run with its reason', () => {
    const read = report(
      readTapReport('TAP version 13\n1..0 # SKIP no browser here\n'),
    );
    expect(read.tests).toEqual([]);
    expect(read.skipAll).toBe('no browser here');
  });

  it('keeps a stack trace inside YAML as text, even where it looks like TAP', () => {
    const read = report(
      readTapReport(
        [
          'TAP version 13',
          'not ok 1 - x',
          '  ---',
          '  stack: |-',
          '    not ok 2 - this is text',
          '    Bail out! also text',
          '    1..9',
          '  ...',
          '1..1',
        ].join('\n'),
      ),
    );
    expect(outline(read.tests)).toEqual(['x [failed]']);
    expect(read.bailOut).toBeUndefined();
  });
});

describe('a report that does not account for its own tests', () => {
  // Synthetic, each one a way a real run stops part-way. A missing test is NOT
  // read as a failed one — see runner-report.ts for why that would be a
  // send_back nothing judged.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['no plan', 'TAP version 13\nok 1 - a\n', 'truncated'],
    [
      'fewer points than planned',
      'TAP version 13\n1..3\nok 1 - a\nok 2 - b\n',
      'truncated',
    ],
    [
      'more points than planned',
      'TAP version 13\n1..1\nok 1 - a\nok 2 - b\n',
      'malformed',
    ],
    ['a second plan', 'TAP version 13\n1..1\nok 1 - a\n1..1\n', 'malformed'],
    [
      'a point after the trailing plan',
      'TAP version 13\nok 1 - a\n1..1\nok 2 - b\n',
      'malformed',
    ],
    ['a plan that does not start at 1', 'TAP version 13\n2..5\n', 'malformed'],
    ['a stray `}`', 'TAP version 13\nok 1 - a\n}\n1..1\n', 'malformed'],
    [
      'a structural line indented by 2',
      'TAP version 13\n  ok 1 - a\n1..1\n',
      'malformed',
    ],
    [
      'an unclosed `{` block',
      'TAP version 13\n1..1\nok 1 - f {\n    1..1\n    ok 1 - a\n',
      'truncated',
    ],
    [
      'a dedent out of a `{` block without `}`',
      'TAP version 13\n1..2\nok 1 - f {\n    1..1\n    ok 1 - a\nok 2 - g\n',
      'malformed',
    ],
    [
      'node children no parent point ever claimed',
      'TAP version 13\n    ok 1 - a\n    1..1\n',
      'truncated',
    ],
    [
      'node children followed by a plan instead of their parent',
      'TAP version 13\n    ok 1 - a\n    1..1\n1..1\n',
      'malformed',
    ],
    [
      'a child block whose own plan is short',
      'TAP version 13\n    ok 1 - a\n    1..2\nok 1 - g\n1..1\n',
      'truncated',
    ],
    [
      'an unclosed YAML block',
      'TAP version 13\nnot ok 1 - a\n  ---\n  error: x\n',
      'truncated',
    ],
    [
      'a YAML block that follows no point',
      'TAP version 13\n1..0\n  ---\n  x: 1\n  ...\n',
      'malformed',
    ],
  ];
  it.each(cases)('%s', (_label, text, expected) => {
    const read = readTapReport(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.defect).toBe(expected);
  });
});

describe('Bail out!', () => {
  it('ends the document where it stands, keeping every point before it', () => {
    // Synthetic, per the specification: plan checks are waived after a bail.
    const read = report(
      readTapReport(
        'TAP version 13\n1..5\nok 1 - a\nnot ok 2 - b\nBail out! database gone\nok 3 - c\n',
      ),
    );
    expect(outline(read.tests)).toEqual(['a [passed]', 'b [failed]']);
    expect(read.bailOut).toEqual({ reason: 'database gone', line: 5 });
  });

  it('keeps points from a node block no parent had claimed yet', () => {
    const read = report(
      readTapReport('TAP version 13\n    not ok 1 - inner\nBail out!\n'),
    );
    expect(outline(read.tests)).toEqual(['inner [failed]']);
  });
});
