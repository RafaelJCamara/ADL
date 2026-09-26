/**
 * The command gate — ADL's first real gate (LOOP-01, M05 step 5.14).
 *
 * It runs one `adl.yml` command through `workspace.exec` and turns what the
 * command reported into a {@link Verdict}. That is the whole of it, and the
 * smallness is the point: M05's own notes say *"the first gate is a command
 * gate, not the reviewer"* precisely because it is **deterministic and
 * forceable to fail on demand**, so the send-back plumbing this milestone
 * exists to prove is exercised with no agent nondeterminism anywhere in the
 * signal. A reviewer agent that sometimes passes and sometimes sends back cannot
 * tell you whether the loop works.
 *
 * ## The three answers in `exit_code` mode, and why the third is not a verdict
 *
 * | The child | Verdict | Why |
 * |---|---|---|
 * | exited 0 | `pass`, citing `{kind:'global', category:'build'}` | it judged, and it is satisfied |
 * | exited non-zero | `send_back`, one blocker finding | it judged, and the developer must fix it |
 * | never exited (killed by a signal) | **`StageError`**, `timeout` | it did not judge (D-12, CORE-06) |
 *
 * The third row is the one worth stating outright. A command ADL had to kill
 * produced no exit code, so there is no judgement to report — and reporting one
 * anyway would make an infrastructure failure cost the developer a round, which
 * is exactly what CORE-06 forbids. `ExecResult.exitCode` is `null` in precisely
 * that case (`ExecResult`'s own declaration: *"null when the child was killed
 * by a signal rather than exiting"*), which is why this module branches on
 * `null` rather than on any timeout flag — the port declares no such flag, and
 * inventing one would widen a published one-way type for a distinction the
 * exit code already carries.
 *
 * ## Every mode has a row, and a mode without one does not compile (M08 step 8.5)
 *
 * The gate reads its stdout as its pipeline entry declares — `exit_code`,
 * `verdict` (M07 step 7.3), or `tap` (M08 step 8.5; `@adl/core/config`'s
 * `command-gate.ts` carries why each exists). Until step 8.5 this module told
 * the modes apart with two `emits === 'verdict'` comparisons, and **that was a
 * hole measured, not guessed at**: with `'tap'` added to the mode list and
 * nothing else changed, the build stayed green and a real zero-test
 * `node --test --test-reporter=tap` declared `emits: tap` came back `pass`,
 * because every mode that was not `verdict` fell through to exit-code judging —
 * 7.3's sniff, arriving by omission.
 *
 * So the modes are dispatched through {@link OUTPUT_MODE_JUDGES}, a `Record`
 * over the mode union with an `Exclude` pairing: a mode with no row is a
 * missing-property error, a row for no mode is an `Exclude` error, and there is
 * no default for a new mode to fall into.
 *
 * ## `pass` cites a global category, never a criterion
 *
 * `PassVerdictSchema.checked` is non-empty by schema (ROLE-04: *"an approval
 * citing none is malformed rather than an approval"*), and `verdict.ts`'s own
 * docblock names this gate's answer: *"A command gate cites `{ kind: 'global'
 * }` — honest, and visibly different from claiming criterion coverage."* A
 * green `npm test` is evidence that the suite passed; it is **not** evidence
 * that acceptance criterion AC-3 was verified, and citing one would put
 * fabricated coverage into the pull-request table that exists to answer exactly
 * that question. A `tap` pass cites the same thing, from the same judge the
 * behaviour tester's suite uses.
 *
 * ## What this module deliberately does not do
 *
 * - **It does not run `build`, `start` or `teardown`.** ADL owning an app's
 *   whole lifecycle is ROLE-07, and it belongs to the gate that declares
 *   `needs_app` — `stage-runner.ts` runs it around this gate, never inside it.
 * - **It reads no spec.** It is handed one — `GateContext.spec`, M05 step 5.17
 *   — and ignores it, along with `GateContext.diff`, because what the command
 *   reported is the whole of what it judges on. That a gate may ignore its
 *   context is the point: what it *cannot* do is reach for context it was not
 *   given, and {@link GateContext} has no member naming the developer's
 *   session, transcript, or rendered prompt (ROLE-03). This function's
 *   parameter list is the whole of what it can see.
 *
 * ## Where this file lives, and why that is load-bearing
 *
 * `worker-entry/gates/` is governed by `eslint.config.js`'s
 * `adl/gate-fresh-context`: no importing the transcript store, the prompt
 * builder, or `ipc/protocol.js`'s `AssignMessage`, and no reading a
 * `logsRoot`/`sessionRef`/`systemPrompt` off anything. That rule closes the
 * residual the type structurally cannot — a gate reaching *around* its
 * parameters to the modules directly — which is the same two-layer shape
 * FORGE-10 needed in 5.12, for the same reason: an interface with no merge
 * method cannot stop an adapter merging through the client it already holds.
 * A new gate belongs in this directory so it inherits both layers on the day
 * it is created (D-27).
 */
import type {
  CommandGateOutputMode,
  CommandSpec,
  RunnerReportFormat,
} from '@adl/core/config';
import {
  judgeRunnerReport,
  MAX_RUNNER_REPORT_CHARS,
  readRunnerReport,
  stageErrorPolicy,
  type GateContext,
  type RunnerEvidence,
} from '@adl/core/stage';
import {
  fingerprintFinding,
  VerdictSchema,
  type Verdict,
} from '@adl/core/verdict';
import type { StageRunnerVerdict } from '../../ipc/stage-verdict.js';
import { runCaptured } from './captured-exec.js';

/**
 * This gate's own configuration — the second and last parameter.
 *
 * Deliberately separate from {@link GateContext} rather than a member of it.
 * Context is what a gate is told *about the feature*; this is what a gate is
 * told *about itself*, and it comes from `adl.yml` — the maintainer's file,
 * which ROLE-11 hard-fails a round for editing (M05 step 5.16). Folding a
 * command into the shared context type would make every future gate's private
 * configuration part of the surface ROLE-03's guard has to reason about, for
 * no gain: neither field below can name a session or a transcript, which is
 * what keeps the two-parameter shape honest.
 */
export interface CommandGateConfig {
  /** The `adl.yml` command to run. */
  readonly command: CommandSpec;
  /** The child's `PATH`. Required by `ExecSpec`, and required here for the same reason. */
  readonly path: string;
  /**
   * What this gate's stdout means (HARN-02, M07 step 7.3; ROLE-08, M08 step
   * 8.5). Defaults to `exit_code`, which is 5.14's behaviour exactly — see
   * `@adl/core/config`'s `command-gate.ts` for why the mode is declared rather
   * than sniffed.
   */
  readonly emits?: CommandGateOutputMode;
}

/**
 * How much of a verdict-emitting gate's stdout is quoted back when it will not
 * parse.
 *
 * Short on purpose. This lands in a `StageError.detail`, which the escalation
 * comment renders into a **public** pull request (M06 step 6.8), and the point
 * is to show the operator enough to recognise their own output — not to
 * reproduce it. The whole of it is in the attempt's transcript, which is where
 * `adl logs` points.
 */
const MALFORMED_VERDICT_EXCERPT_CHARS = 500;

/** A command that ran to completion, as a judge sees it. */
interface ExitedRun {
  readonly stageId: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  /** stdout's lines joined by `\n` — empty for a mode that does not read it. */
  readonly stdout: string;
  /** A bounded, elision-stated tail of both streams, for findings and errors. */
  readonly tail: string;
}

/** How one output mode is read. */
interface OutputModeJudge {
  /** Whether stdout is captured at all — `exit_code` never pays for a buffer. */
  readonly readsStdout: boolean;
  readonly judge: (run: ExitedRun) => StageRunnerVerdict;
}

/**
 * Every output mode, and how it is judged — see the module docblock for why a
 * table and not a comparison.
 */
const OUTPUT_MODE_JUDGES = Object.freeze({
  exit_code: { readsStdout: false, judge: verdictFromExitCode },
  verdict: {
    readsStdout: true,
    judge: (run: ExitedRun) =>
      verdictFromStdout(run.stageId, run.stdout, run.exitCode),
  },
  tap: {
    readsStdout: true,
    judge: (run: ExitedRun) => verdictFromRunnerReport('tap', run),
  },
} satisfies Record<CommandGateOutputMode, OutputModeJudge>);

/**
 * A row for no mode fails the build, and so does a missing one — through
 * `satisfies`, never a type annotation. Written first with the annotation, this
 * pairing asserted nothing: a stale `junit` row compiled, because an annotated
 * table's `keyof` is the annotation's keys. The watched-failing pass caught it
 * (and the same defect in `app-failure.ts`, the precedent it was copied from).
 */
type _EveryJudgeIsAMode =
  Exclude<keyof typeof OUTPUT_MODE_JUDGES, CommandGateOutputMode> extends never
    ? true
    : never;
const _everyJudgeIsAMode: _EveryJudgeIsAMode = true;
void _everyJudgeIsAMode;

/**
 * Run the command and report what it decided.
 *
 * Never throws for a failing command — that is the whole distinction
 * `ExecResult.exitCode` exists to carry, and the workspace contract suite
 * pins it (*"reports a failing child as an exit code rather than a rejection"*).
 * A command the workspace refused or could not spawn is a `provider_error`: the
 * child never ran, so nothing was judged (D-12).
 */
export async function runCommandGate(
  gate: GateContext,
  config: CommandGateConfig,
): Promise<StageRunnerVerdict> {
  const { stageId } = gate;
  const emits: CommandGateOutputMode = config.emits ?? 'exit_code';
  const mode = OUTPUT_MODE_JUDGES[emits];

  const run = await runCaptured(gate, {
    command: config.command,
    path: config.path,
    readStdout: mode.readsStdout,
    transcriptPrefix: '',
  });

  if (run.kind === 'spawn_failed') {
    return stageError(
      'provider_error',
      `the ${stageId} command could not be run: ${run.detail}`,
    );
  }

  // The terminal record, so a transcript reader can tell "the command finished"
  // from "the file stopped growing" (T-4-33's distinction, one layer down).
  // `cancelled` for a child ADL killed and `completed` for one that exited on
  // its own — `AGENT_RESULT_OUTCOMES` has exactly three members and
  // `turn_limit_reached` is meaningless here, so these are the two honest ones.
  gate.onEvent({
    kind: 'result',
    outcome: run.kind === 'killed' ? 'cancelled' : 'completed',
    durationMs: run.durationMs,
  });

  if (run.kind === 'killed') {
    // Killed rather than exited — the timeout, or a cancellation. There is no
    // exit code, so there is no judgement, so this is not a verdict.
    return stageError(
      'timeout',
      `the ${stageId} command was killed after ${String(run.durationMs)}ms without exiting` +
        `${run.signal === undefined ? '' : ` (signal ${run.signal})`}: ${run.tail}`,
    );
  }

  if (mode.readsStdout && run.stdoutOverflowed) {
    // Refused rather than read in part: a report cut at the bound reads as
    // truncated at best, and at worst loses a failure that came after the cut.
    return stageError(
      'unparseable',
      `the ${stageId} gate declares \`emits: ${emits}\` and printed more than ` +
        `${String(MAX_RUNNER_REPORT_CHARS)} characters to stdout, so ADL did not read it — ` +
        'the whole of it is in this attempt’s transcript',
    );
  }

  return mode.judge({
    stageId,
    argv: config.command.argv,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    stdout: run.stdout,
    tail: run.tail,
  });
}

/** `exit_code` mode — 5.14's behaviour, exactly. */
function verdictFromExitCode(run: ExitedRun): StageRunnerVerdict {
  const { stageId, argv, exitCode, durationMs, tail } = run;
  if (exitCode === 0) {
    return {
      kind: 'verdict',
      verdict: {
        outcome: 'pass',
        summary: `\`${argv.join(' ')}\` exited 0 in ${String(durationMs)}ms`,
        // See the module docblock: a green command is evidence about the
        // build, never about a named acceptance criterion.
        checked: [{ kind: 'global', category: 'build' }],
      },
    };
  }

  // The title is what the fingerprint is computed over, so it carries the
  // stage and the exit code and **nothing that varies between runs** — not the
  // duration, not the output. That is what makes the same failure recurring
  // across rounds recognisable as the same finding, which is what
  // `limits.repeat_finding_threshold`'s stall detection (M06) reads.
  const title = `the ${stageId} command failed (exit ${String(exitCode)})`;
  const verdict: Verdict = {
    outcome: 'send_back',
    summary: `\`${argv.join(' ')}\` exited ${String(exitCode)}`,
    findings: [
      {
        fingerprint: fingerprintFinding({ stageId, title }),
        severity: 'blocker',
        title,
        detail: tail,
        criterionRef: { kind: 'global', category: 'build' },
      },
    ],
  };
  return { kind: 'verdict', verdict };
}

/**
 * A runner-report mode (ROLE-08, M08 step 8.5): read the declared format and
 * judge it with `@adl/core/stage`'s `judgeRunnerReport` — the one judgement a
 * behaviour tester's suite gets too, so the two cannot drift.
 */
function verdictFromRunnerReport(
  format: RunnerReportFormat,
  run: ExitedRun,
): StageRunnerVerdict {
  return runnerEvidenceVerdict(
    judgeRunnerReport({
      stageId: run.stageId,
      runLabel: run.argv.join(' '),
      exitCode: run.exitCode,
      read: readRunnerReport(format, run.stdout),
      outputTail: run.tail,
    }),
  );
}

/**
 * Evidence as a command gate reports it: a report that cannot be judged is
 * `unparseable` (D-12), and every other answer is the verdict the evidence
 * already carries.
 */
function runnerEvidenceVerdict(evidence: RunnerEvidence): StageRunnerVerdict {
  if (evidence.kind === 'unjudgeable') {
    return stageError(evidence.errorKind, evidence.detail);
  }
  return { kind: 'verdict', verdict: evidence.verdict };
}

/**
 * Parse a verdict-emitting gate's stdout, or say honestly that it could not be
 * parsed (HARN-02, M07 step 7.3).
 *
 * **Every failure here is `unparseable`, never a verdict** — CORE-06 in its
 * most literal form. A gate that promised a verdict and produced something
 * else did not judge, and inventing a `send_back` from its exit code would
 * charge the developer a round for the gate author's bug. `stageErrorPolicy`
 * makes `unparseable` non-retryable, so the round loop escalates to a human
 * rather than re-running a program that will misbehave identically.
 *
 * Validated against the same `VerdictSchema` the published JSON Schema is
 * emitted from (`packages/core/schema/verdict.schema.json`, diffed in CI), so
 * a gate author checking their output against the published contract and ADL
 * checking it here are checking the same thing — not two implementations of
 * one idea (D-25's reasoning, one layer down).
 *
 * The exit code is deliberately not consulted, in EITHER direction. A linter
 * that exits 1 to mean "I found things" and prints an accurate `send_back` is
 * reporting correctly, and a gate that exits 0 while printing a `fail` is too.
 * Mixing the two signals would make the contract "emit a verdict AND get the
 * exit code right", which is two contracts. (`tap` differs, and its judge says
 * why: a runner's stdout reports tests, and a failure outside every test shows
 * up only in the exit status.)
 */
function verdictFromStdout(
  stageId: string,
  stdout: string,
  exitCode: number,
): StageRunnerVerdict {
  const text = stdout.trim();
  if (text === '') {
    return stageError(
      'unparseable',
      `the ${stageId} gate declares \`emits: verdict\` but printed nothing to stdout ` +
        `(it exited ${String(exitCode)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${stageId} gate declares \`emits: verdict\` but its stdout is not JSON: ` +
        `${error instanceof Error ? error.message : String(error)} — ${excerpt(text)}`,
    );
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return stageError(
      'unparseable',
      `the ${stageId} gate declares \`emits: verdict\` but its stdout is not a valid ` +
        `verdict: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')} — ${excerpt(text)}`,
    );
  }

  return { kind: 'verdict', verdict: result.data };
}

/** A bounded, elision-stated excerpt for a `StageError.detail`. */
function excerpt(text: string): string {
  if (text.length <= MALFORMED_VERDICT_EXCERPT_CHARS) return text;
  return `${text.slice(0, MALFORMED_VERDICT_EXCERPT_CHARS)}…(${String(text.length - MALFORMED_VERDICT_EXCERPT_CHARS)} more characters; the whole of it is in this attempt's transcript)`;
}

/** A `StageError` envelope with `retryable` derived from the kind, never restated (rule 8). */
function stageError(
  kind: 'provider_error' | 'timeout' | 'unparseable',
  detail: string,
): StageRunnerVerdict {
  return {
    kind: 'stage_error',
    error: { kind, retryable: stageErrorPolicy(kind).retryable, detail },
  };
}
