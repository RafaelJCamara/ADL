/**
 * Test outcomes read from a runner's own structured report, and a run that
 * executed no test is never a pass (ROLE-08, M08 step 8.5).
 *
 * Two pure functions, and the split between them is the design:
 *
 * - {@link readRunnerReport} turns a declared report format's text into a
 *   {@link RunnerReport} — or says, as a {@link RunnerReportDefect}, why it is
 *   not one. It judges nothing.
 * - {@link judgeRunnerReport} turns what was read, plus the runner's exit code,
 *   into {@link RunnerEvidence}: a `send_back`, an `inconclusive`, a `pass`, or
 *   "this cannot be judged" (`unparseable`, a `StageError`).
 *
 * Both callers of this module use both functions: a command gate that declares
 * `emits: tap`, and the behaviour tester, which runs its declared suite after the
 * agent finishes and lets that run — not the agent's own verdict — decide
 * (`manager/src/worker-entry/gates/tester-gate.ts`). So "outcomes from
 * structured runner output" is one piece of code with two callers, not two
 * policies that can drift.
 *
 * ## Why the exit code cannot decide, in either direction
 *
 * Measured against the installed runners (M08 step 8.5's probes, node v24.19.0
 * and vitest 4.1): `node --test` with nothing to run exits **0**, and `vitest
 * run` exits **1**. The first reads as a pass that verified nothing; the second
 * as a failure that costs the developer a round when nothing was judged. The
 * number of tests that executed exists only in the report, so the report is what
 * is judged.
 *
 * The exit code keeps exactly one power: it may **veto** a pass. vitest prints a
 * completely green report and exits 1 when a test leaks an unhandled rejection,
 * so a report alone would call that run clean. It never creates a pass, and it
 * never overrides a defect, a failure or zero-executed.
 *
 * ## The table, first match wins
 *
 * | # | What was read | Answer | Channel |
 * |---|---|---|---|
 * | 1 | no report document at all | `unparseable` | StageError |
 * | 2 | a malformed report, or more than one | `unparseable` | StageError |
 * | 3 | a report that does not account for its own tests (truncated), or one over {@link MAX_RUNNER_REPORT_CHARS} | `unparseable` | StageError |
 * | 4 | `Bail out!` after at least one failure | `send_back`, one blocker per failure | verdict |
 * | 5 | `Bail out!` with no failure | `unparseable` | StageError |
 * | 6 | at least one failure | `send_back`, one blocker per failure | verdict |
 * | 7 | **no test executed** — an empty run, or only skipped and todo tests | **`inconclusive`** | verdict |
 * | 8 | tests executed, none failed, exit code non-zero | `send_back`, one blocker naming the exit code | verdict |
 * | 9 | tests executed, none failed, exit 0 | `pass`, citing `{ kind: 'global', category: 'build' }` | verdict |
 *
 * **Rows 1–3 and 5 are `StageError`s, not verdicts (D-12).** A runner that
 * promised a report and printed none, or stopped part-way, did not judge — and
 * TAP's own convention that a missing test is a failed one would turn that into
 * a `send_back` nothing judged, costing the developer a round for an
 * infrastructure fault (CORE-06). `unparseable` is non-retryable, because the
 * same argv misbehaves the same way twice.
 *
 * **Row 7 is `inconclusive`, and that is harsher than it looks, deliberately.**
 * An `inconclusive` with no `send_back` beside it ends the round `unverified`
 * and escalates to a human with no retry — the harshness step 8.3 refused for an
 * app that never became ready, because a port race is transient. Nothing about
 * an empty suite is: a retry runs the same zero tests, and nothing the developer
 * does adds tests to a suite it cannot see. It is a verdict rather than a
 * `StageError` because the runner did run and did report; its report says
 * nothing was verified.
 *
 * **Row 8 is a `send_back`, on 8.3's "prefer the cheap mistake".** A failure
 * outside every test is most often the code under test leaking an error, and a
 * wrong send-back costs one round and names the exit code, while a wrong
 * `StageError` escalates to a human instead of to the agent that could fix it.
 *
 * ## What a runner-derived pass cites
 *
 * `{ kind: 'global', category: 'build' }` — what 5.14's `test` gate, the
 * `exit_code` mode and `app-failure.ts` already cite for the same claim. "Every
 * test that ran passed" is evidence about the suite, never about a named
 * acceptance criterion: which test covers which criterion is step 8.7's link,
 * and reading `AC-1` out of a test's name here would be a sniff. A new `test`
 * category would be a change to the published verdict schema (D-26) for
 * consumers (M09's coverage table) that do not exist yet.
 *
 * ## What no report can tell ADL, stated rather than hidden
 *
 * node's runner reports a test file that declares no tests — and a file whose
 * test calls `process.exit(0)` part-way, hiding every result before it — as
 * **one passing test named after the file**, with YAML identical to a real
 * test's. No reader of TAP (or of node's JUnit) can tell that from a real pass
 * without guessing from names. This module does not guess. What catches it is
 * step 8.8's must-fail-at-base guardrail: a file that passes vacuously passes at
 * the pre-feature commit too. `DEBT.md`'s D-8-05-2 carries it until then.
 *
 * **vitest has the same hole under one setting.** Run with `passWithNoTests`, it
 * prints an empty `describe` and a test-less file as plain passing points with no
 * diagnostic — found by step 8.5's review against vitest 4.1 — so they count as
 * executed and the run can `pass` with no test body having run. Without the
 * setting the same files are `not ok` ("No test suite found"), which is a
 * `send_back` rather than `inconclusive` — never a pass, but the wrong class. The
 * same guardrail, the same debt row.
 */
import type { RunnerReportFormat } from '../config/command-gate.js';
import type { CriterionRef } from '../verdict/criterion-ref.js';
import {
  fingerprintFinding,
  sortFindings,
  type Finding,
} from '../verdict/finding.js';
import type {
  InconclusiveVerdict,
  PassVerdict,
  SendBackVerdict,
} from '../verdict/verdict.js';
import { readTapReport } from './tap.js';

/**
 * What a runner said about one test. Frozen list plus derived union
 * (convention 7).
 *
 * `todo` is its own status rather than a flavour of `skipped` because TAP gives
 * it a different meaning — a `not ok # TODO` is an expected failure, not a
 * failure — and neither counts as a test that executed.
 */
export const REPORTED_TEST_STATUSES = Object.freeze([
  'passed',
  'failed',
  'skipped',
  'todo',
] as const);

export type ReportedTestStatus = (typeof REPORTED_TEST_STATUSES)[number];

/**
 * One test point, as the runner reported it.
 *
 * `children` is present **iff the point is a group** — it owned a subtest block,
 * or the runner declared it a suite — and may be empty. That distinction is the
 * whole of what separates "a test that executed" from "a heading": node reports
 * a `describe` of skipped tests as `ok`, and counting it would turn an all-skipped
 * run into a pass.
 */
export interface ReportedTest {
  /** The description, escapes resolved, with directives and runner annotations (vitest's `# time=…`) removed. */
  readonly name: string;
  readonly status: ReportedTestStatus;
  /** 1-based line in the report. For messages only — never identity, because it moves when an unrelated test is added. */
  readonly line: number;
  /** The YAML diagnostic block, dedented and verbatim. Never parsed as data beyond the one key `tap.ts` names. */
  readonly diagnostic?: string;
  readonly children?: readonly ReportedTest[];
}

/** A complete, readable report. */
export interface RunnerReport {
  readonly format: RunnerReportFormat;
  /** Top-level points in report order, never de-duplicated. */
  readonly tests: readonly ReportedTest[];
  /** Present when the runner declared an early stop. Every point before it is kept. */
  readonly bailOut?: { readonly reason: string; readonly line: number };
  /** The reason given on a `1..0 # SKIP …` plan, when there was one. */
  readonly skipAll?: string;
}

/**
 * Why a runner's output is not a readable report. Frozen list plus derived
 * union (convention 7). Every member judges to `unparseable` — see the module
 * docblock's table for why none of them is a verdict.
 */
export const RUNNER_REPORT_DEFECTS = Object.freeze([
  'no_document',
  'multiple_documents',
  'malformed',
  'truncated',
  'too_large',
] as const);

export type RunnerReportDefect = (typeof RUNNER_REPORT_DEFECTS)[number];

/** Classify, don't throw (convention 5). */
export type RunnerReportRead =
  | { readonly ok: true; readonly report: RunnerReport }
  | {
      readonly ok: false;
      readonly defect: RunnerReportDefect;
      readonly detail: string;
      readonly line?: number;
    };

/**
 * The most report text ADL will read.
 *
 * A bound rather than a buffer that grows with whatever a suite prints: the
 * caller stops accumulating at this size plus one, and a report that reached it
 * is `too_large` rather than silently cut — a cut report would read as
 * truncated at best, and at worst lose a failure that came after the cut.
 */
export const MAX_RUNNER_REPORT_CHARS = 8 * 1024 * 1024;

/**
 * How many failing tests become findings.
 *
 * A finding lands on a database row and in a **public** pull-request comment,
 * so a suite with five hundred failures cannot put five hundred there. The cap
 * is applied after {@link sortFindings}, which orders by fingerprint, so it is
 * deterministic even though both runners report parallel files in completion
 * order. The total goes in the verdict's `summary`, which is not fingerprinted
 * — a synthetic "and N more" finding would carry a title that moves with N.
 */
export const MAX_RUNNER_FINDINGS = 20;

/** How much of a failing test's diagnostic travels on its finding — a public comment, again. */
export const MAX_RUNNER_FINDING_DETAIL_CHARS = 2_000;

/** One segment of a test's identity path, and the whole path, as they go into a finding title. */
const MAX_TITLE_SEGMENT_CHARS = 120;
const MAX_TITLE_PATH_CHARS = 300;

const READERS = Object.freeze({
  tap: readTapReport,
} satisfies Record<RunnerReportFormat, (text: string) => RunnerReportRead>);

/**
 * A reader for every declared format and no reader for anything else, at build
 * time. `satisfies` rather than an annotation, and that is load-bearing: an
 * annotated table's `keyof` is the annotation's, which made this pairing assert
 * nothing — step 8.5's watched-failing pass found that, in this pattern's
 * precedent (`app-failure.ts`, fixed in the same step).
 */
type _EveryFormatHasAReader =
  Exclude<keyof typeof READERS, RunnerReportFormat> extends never
    ? true
    : never;
const _everyFormatHasAReader: _EveryFormatHasAReader = true;
void _everyFormatHasAReader;

/**
 * Read `text` as a report in the declared `format`.
 *
 * `text` is the runner's stdout with its lines joined by `\n` —
 * `Workspace.exec` delivers one line per chunk with the newline stripped, and a
 * caller that concatenated them would hand this a single line.
 */
export function readRunnerReport(
  format: RunnerReportFormat,
  text: string,
): RunnerReportRead {
  if (text.length > MAX_RUNNER_REPORT_CHARS) {
    return {
      ok: false,
      defect: 'too_large',
      detail:
        `the report is longer than ${String(MAX_RUNNER_REPORT_CHARS)} characters, ` +
        'so ADL did not read it rather than judge part of it',
    };
  }
  return READERS[format](text);
}

/** One test, flattened, as later steps consume it (8.7's stability runs, 8.8's base-versus-head comparison). */
export interface ReportedTestResult {
  /** Outermost group first. Identity, and NOT guaranteed unique — runners allow two tests with one name. */
  readonly path: readonly [string, ...string[]];
  readonly status: ReportedTestStatus;
  /** True for a point that owned a subtest block or was declared a suite. A group never counts as executed. */
  readonly group: boolean;
  readonly line: number;
  readonly diagnostic?: string;
  /**
   * A failed point with no failed descendant — a test that failed, or a group
   * that failed outside any test (an `after` hook). node's `before` hook is the
   * other shape: it fails every test it cancelled, so those tests are the root
   * causes and the hook's own error travels on their findings as the failed
   * group's diagnostic ({@link judgeRunnerReport} appends it).
   */
  readonly rootCauseFailure: boolean;
}

/** Every point in the report, depth first, in report order. */
export function flattenReport(
  report: RunnerReport,
): readonly ReportedTestResult[] {
  const out: ReportedTestResult[] = [];
  const visit = (test: ReportedTest, parents: readonly string[]): boolean => {
    const path: [string, ...string[]] =
      parents.length === 0
        ? [test.name]
        : [parents[0]!, ...parents.slice(1), test.name];
    const index = out.length;
    // Placeholder first so the flattened order is parents before children;
    // the root-cause flag needs the children's answer, so it is filled after.
    out.push({
      path,
      status: test.status,
      group: test.children !== undefined,
      line: test.line,
      rootCauseFailure: false,
      ...(test.diagnostic !== undefined ? { diagnostic: test.diagnostic } : {}),
    });
    let descendantFailed = false;
    for (const child of test.children ?? []) {
      if (visit(child, path)) descendantFailed = true;
    }
    const failed = test.status === 'failed';
    if (failed && !descendantFailed) {
      out[index] = { ...out[index]!, rootCauseFailure: true };
    }
    return failed || descendantFailed;
  };
  for (const test of report.tests) visit(test, []);
  return out;
}

/**
 * Whether this test **executed**: a leaf that passed or failed.
 *
 * A group never counts — it is a heading, and node reports a `describe` whose
 * every test was skipped as `ok`. A skipped or todo test never counts either.
 * This is the predicate ROLE-08's rule is about, so it is exported rather than
 * restated by the next step that needs it (rule 8).
 */
export function isExecuted(test: ReportedTestResult): boolean {
  return !test.group && (test.status === 'passed' || test.status === 'failed');
}

/** What {@link judgeRunnerReport} is given. */
export interface RunnerReportInput {
  readonly stageId: string;
  /** How the run is named in summaries — the argv, joined. Never fingerprinted. */
  readonly runLabel: string;
  /** The runner's exit code. A child ADL had to kill has none, and never reaches here — that is the caller's `timeout`. */
  readonly exitCode: number;
  readonly read: RunnerReportRead;
  /**
   * A bounded, elision-stated tail of everything the run printed, both streams
   * interleaved. The detail of the exit-code veto's finding, and the evidence in
   * an `unparseable` detail — the only place either answer can point a human at
   * what actually happened.
   */
  readonly outputTail: string;
}

/**
 * The only answers a runner report can produce. Frozen list plus derived union
 * (convention 7).
 */
export const RUNNER_EVIDENCE_KINDS = Object.freeze([
  'unjudgeable',
  'failed',
  'nothing_executed',
  'passed',
] as const);

export type RunnerEvidenceKind = (typeof RUNNER_EVIDENCE_KINDS)[number];

/**
 * What a runner's report is evidence of.
 *
 * **It cannot carry `fail`, `warn` or `skip`, and no `StageError` kind but
 * `unparseable`** — the answer type is the guarantee, on `AppFailureAnswer`'s
 * precedent (convention 9), rather than a test over a mapping a later edit could
 * get wrong. And `passed` carries the executed tests as a **non-empty tuple**:
 * a pass built from zero executed tests does not typecheck.
 */
export type RunnerEvidence =
  | {
      readonly kind: 'unjudgeable';
      readonly errorKind: 'unparseable';
      readonly detail: string;
    }
  | {
      readonly kind: 'failed';
      readonly verdict: SendBackVerdict;
      readonly report: RunnerReport;
    }
  | {
      readonly kind: 'nothing_executed';
      readonly verdict: InconclusiveVerdict;
      readonly report: RunnerReport;
    }
  | {
      readonly kind: 'passed';
      readonly verdict: PassVerdict;
      readonly report: RunnerReport;
      readonly executed: readonly [ReportedTestResult, ...ReportedTestResult[]];
    };

type _EveryEvidenceKindListed =
  Exclude<RunnerEvidence['kind'], RunnerEvidenceKind> extends never
    ? Exclude<RunnerEvidenceKind, RunnerEvidence['kind']> extends never
      ? true
      : never
    : never;
const _everyEvidenceKindListed: _EveryEvidenceKindListed = true;
void _everyEvidenceKindListed;

/** What every runner-derived verdict cites — see the module docblock. A fresh object each time, so no verdict shares one with another. */
function suiteCitation(): CriterionRef {
  return { kind: 'global', category: 'build' };
}

/** Judge what was read. Total: every input produces exactly one answer from the table. */
export function judgeRunnerReport(input: RunnerReportInput): RunnerEvidence {
  const { read, stageId, runLabel, exitCode } = input;

  if (!read.ok) {
    return unjudgeable(input, describeDefect(read));
  }

  const { report } = read;
  const results = flattenReport(report);
  const failures = results.filter((result) => result.rootCauseFailure);

  if (failures.length > 0) {
    return {
      kind: 'failed',
      verdict: sendBackFor(
        stageId,
        runLabel,
        exitCode,
        failures,
        report,
        new Map(
          results
            .filter((result) => result.group)
            .map((result) => [result.path.join('\u0000'), result]),
        ),
      ),
      report,
    };
  }

  if (report.bailOut !== undefined) {
    return unjudgeable(
      input,
      `the runner bailed out at line ${String(report.bailOut.line)}` +
        `${report.bailOut.reason === '' ? '' : ` (${report.bailOut.reason})`} ` +
        'before any test failed, so it stopped without judging',
    );
  }

  const executed = results.filter(isExecuted);
  const [first, ...rest] = executed;
  if (first === undefined) {
    return {
      kind: 'nothing_executed',
      verdict: nothingExecuted(runLabel, exitCode, results, report),
      report,
    };
  }

  if (exitCode !== 0) {
    const title = `the ${stageId} runner exited ${String(exitCode)} although every test it reported passed`;
    return {
      kind: 'failed',
      verdict: {
        outcome: 'send_back',
        summary:
          `\`${runLabel}\` reported ${countExecuted(executed.length)}, all passed, ` +
          `but exited ${String(exitCode)} — a failure outside every test`,
        findings: [
          {
            fingerprint: fingerprintFinding({ stageId, title }),
            severity: 'blocker',
            title,
            detail: input.outputTail,
            criterionRef: suiteCitation(),
          },
        ],
      },
      report,
    };
  }

  return {
    kind: 'passed',
    verdict: {
      outcome: 'pass',
      summary:
        `\`${runLabel}\` exited 0 and reported ${countExecuted(executed.length)}, ` +
        `all passed${tallyOf(results)}`,
      checked: [suiteCitation()],
    },
    report,
    executed: [first, ...rest],
  };
}

function unjudgeable(input: RunnerReportInput, what: string): RunnerEvidence {
  return {
    kind: 'unjudgeable',
    errorKind: 'unparseable',
    detail:
      `\`${input.runLabel}\` (exit ${String(input.exitCode)}) did not produce a report ADL can judge: ` +
      `${what} — ${input.outputTail}`,
  };
}

function describeDefect(
  read: Extract<RunnerReportRead, { ok: false }>,
): string {
  const at = read.line === undefined ? '' : ` (line ${String(read.line)})`;
  switch (read.defect) {
    case 'no_document':
      return (
        `${read.detail}${at}. A runner prints a report only when told to: node needs ` +
        '`--test-reporter=tap` and vitest `--reporter=tap`'
      );
    case 'multiple_documents':
    case 'malformed':
    case 'truncated':
    case 'too_large':
      return `${read.detail}${at}`;
    default: {
      const unhandled: never = read.defect;
      return String(unhandled);
    }
  }
}

function countExecuted(n: number): string {
  return n === 1 ? '1 executed test' : `${String(n)} executed tests`;
}

/** ` (2 skipped, 1 todo)`, or nothing when there were neither. */
function tallyOf(results: readonly ReportedTestResult[]): string {
  const leaves = results.filter((result) => !result.group);
  const skipped = leaves.filter((r) => r.status === 'skipped').length;
  const todo = leaves.filter((r) => r.status === 'todo').length;
  if (skipped === 0 && todo === 0) return '';
  return ` (${String(skipped)} skipped, ${String(todo)} todo)`;
}

function nothingExecuted(
  runLabel: string,
  exitCode: number,
  results: readonly ReportedTestResult[],
  report: RunnerReport,
): InconclusiveVerdict {
  const leaves = results.filter((result) => !result.group);
  const skipped = leaves.filter((r) => r.status === 'skipped').length;
  const todo = leaves.filter((r) => r.status === 'todo').length;
  const skipAll =
    report.skipAll === undefined || report.skipAll === ''
      ? ''
      : `; the runner skipped the whole run: ${report.skipAll}`;
  return {
    outcome: 'inconclusive',
    summary: `\`${runLabel}\` executed no test`,
    reason:
      `\`${runLabel}\` exited ${String(exitCode)} and reported a complete run in which no test ` +
      `executed (0 passed, 0 failed, ${String(skipped)} skipped, ${String(todo)} todo)${skipAll} — ` +
      'zero executed tests is not a pass (ROLE-08)',
  };
}

/** One path segment as it may appear in a title: whitespace collapsed, bounded, deterministically. */
function titleSegment(segment: string): string {
  const collapsed = segment.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_TITLE_SEGMENT_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_TITLE_SEGMENT_CHARS - 1)}…`;
}

function titlePath(path: readonly string[]): string {
  const joined = path.map(titleSegment).join(' > ');
  return joined.length <= MAX_TITLE_PATH_CHARS
    ? joined
    : `${joined.slice(0, MAX_TITLE_PATH_CHARS - 1)}…`;
}

function boundedDiagnostic(diagnostic: string | undefined): string {
  if (diagnostic === undefined || diagnostic.trim() === '') {
    return '(the runner reported no diagnostic for this test)';
  }
  if (diagnostic.length <= MAX_RUNNER_FINDING_DETAIL_CHARS) return diagnostic;
  return (
    `${diagnostic.slice(0, MAX_RUNNER_FINDING_DETAIL_CHARS)}…` +
    `(${String(diagnostic.length - MAX_RUNNER_FINDING_DETAIL_CHARS)} more characters; ` +
    "the whole report is in this attempt's transcript)"
  );
}

/**
 * The finding for one failure.
 *
 * The title is what the fingerprint is computed over, so it carries the test's
 * identity path and **nothing that varies between runs**: not the point number,
 * not vitest's `# time=…`, not node's `duration_ms`, and no location — TAP
 * carries no repository-relative path, and the absolute paths in a diagnostic
 * embed the attempt's own workspace root, which differs on every attempt. So the
 * same failing test produces the same fingerprint round after round for as long
 * as its name holds still, which is what `limits.repeat_finding_threshold`'s
 * stall detection reads (M06).
 */
function findingFor(
  stageId: string,
  failure: ReportedTestResult,
  failedAncestors: readonly ReportedTestResult[],
): Finding {
  const path = titlePath(failure.path);
  const title = failure.group
    ? `test group failed outside any test: ${path}`
    : `test failed: ${path}`;
  // The groups it sits in that failed too, innermost first — which is where a
  // hook's own error lives when the hook failed the tests under it (node's
  // `before`): without them the finding would blame a test that never ran and
  // say nothing of what broke. Detail only; the title, and so the fingerprint,
  // is unchanged.
  const context = failedAncestors
    .filter((ancestor) => (ancestor.diagnostic ?? '').trim() !== '')
    .map(
      (ancestor) =>
        `It sits in "${ancestor.path.join(' > ')}", which failed too:\n${ancestor.diagnostic ?? ''}`,
    );
  const diagnostic = [failure.diagnostic ?? '', ...context]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
  return {
    fingerprint: fingerprintFinding({ stageId, title }),
    severity: 'blocker',
    title,
    detail: `${failure.path.join(' > ')}\n\n${boundedDiagnostic(diagnostic === '' ? undefined : diagnostic)}`,
    criterionRef: suiteCitation(),
  };
}

/** The failed groups `failure` sits in, innermost first. */
function failedAncestorsOf(
  failure: ReportedTestResult,
  groups: ReadonlyMap<string, ReportedTestResult>,
): ReportedTestResult[] {
  const found: ReportedTestResult[] = [];
  for (let depth = failure.path.length - 1; depth >= 1; depth -= 1) {
    const group = groups.get(failure.path.slice(0, depth).join('\u0000'));
    if (group !== undefined && group.status === 'failed') found.push(group);
  }
  return found;
}

function sendBackFor(
  stageId: string,
  runLabel: string,
  exitCode: number,
  failures: readonly ReportedTestResult[],
  report: RunnerReport,
  groups: ReadonlyMap<string, ReportedTestResult>,
): SendBackVerdict {
  // De-duplicated by fingerprint: two tests with one name are one finding a
  // human reads, and two findings with one fingerprint would count twice toward
  // stall detection in a single round.
  const byFingerprint = new Map<string, { finding: Finding; count: number }>();
  for (const failure of failures) {
    const finding = findingFor(
      stageId,
      failure,
      failedAncestorsOf(failure, groups),
    );
    const seen = byFingerprint.get(finding.fingerprint);
    if (seen === undefined) {
      byFingerprint.set(finding.fingerprint, { finding, count: 1 });
    } else {
      seen.count += 1;
    }
  }
  const findings = sortFindings(
    [...byFingerprint.values()].map(({ finding, count }) =>
      count === 1
        ? finding
        : {
            ...finding,
            detail: `${finding.detail}\n\n(the runner reported this test ${String(count)} times)`,
          },
    ),
  );
  const listed = findings.slice(0, MAX_RUNNER_FINDINGS);
  const total = findings.length;
  const bail =
    report.bailOut === undefined
      ? ''
      : `; the runner then bailed out${report.bailOut.reason === '' ? '' : ` (${report.bailOut.reason})`}`;
  return {
    outcome: 'send_back',
    summary:
      `\`${runLabel}\` exited ${String(exitCode)} and reported ` +
      `${total === 1 ? '1 failing test' : `${String(total)} failing tests`}` +
      `${total > listed.length ? ` (${String(listed.length)} listed)` : ''}${bail}`,
    // Non-empty by construction: `failures` was non-empty and every failure
    // produced a finding. `judgeRunnerReport` only calls this with failures.
    findings: listed,
  };
}
