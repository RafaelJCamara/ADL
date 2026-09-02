/**
 * The command gate — ADL's first real gate (LOOP-01, M05 step 5.14).
 *
 * It runs one `adl.yml` command through `workspace.exec` and turns the exit
 * code into a {@link Verdict}. That is the whole of it, and the smallness is
 * the point: M05's own notes say *"the first gate is a command gate, not the
 * reviewer"* precisely because it is **deterministic and forceable to fail on
 * demand**, so the send-back plumbing this milestone exists to prove is
 * exercised with no agent nondeterminism anywhere in the signal. A reviewer
 * agent that sometimes passes and sometimes sends back cannot tell you whether
 * the loop works.
 *
 * ## The three answers, and why the third is not a verdict
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
 * ## `pass` cites a global category, never a criterion
 *
 * `PassVerdictSchema.checked` is non-empty by schema (ROLE-04: *"an approval
 * citing none is malformed rather than an approval"*), and `verdict.ts`'s own
 * docblock names this gate's answer: *"A command gate cites `{ kind: 'global'
 * }` — honest, and visibly different from claiming criterion coverage."* A
 * green `npm test` is evidence that the suite passed; it is **not** evidence
 * that acceptance criterion AC-3 was verified, and citing one would put
 * fabricated coverage into the pull-request table that exists to answer exactly
 * that question.
 *
 * ## What this module deliberately does not do
 *
 * - **It does not run `build`, `start` or `teardown`.** ADL owning an app's
 *   whole lifecycle is ROLE-07, and the behaviour tester (M08) is what owns it.
 *   A gate that quietly ran three more commands would be reporting on something
 *   other than what its stage id names.
 * - **It reads no spec.** It is handed one — `GateContext.spec`, M05 step 5.17
 *   — and ignores it, along with `GateContext.diff`, because an exit code is
 *   the whole of what it judges on. That a gate may ignore its context is the
 *   point: what it *cannot* do is reach for context it was not given, and
 *   {@link GateContext} has no member naming the developer's session,
 *   transcript, or rendered prompt (ROLE-03). This function's parameter list is
 *   the whole of what it can see.
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
import {
  parseDuration,
  type CommandGateOutputMode,
  type CommandSpec,
} from '@adl/core/config';
import type {
  AgentEvent,
  ExecResult,
  GateContext,
  LogChunk,
} from '@adl/core/stage';
import { stageErrorPolicy } from '@adl/core/stage';
import { join } from 'node:path';
import {
  fingerprintFinding,
  VerdictSchema,
  type Verdict,
} from '@adl/core/verdict';
import type { StageRunnerVerdict } from '../../ipc/stage-verdict.js';

/**
 * How much of the command's output travels on the finding.
 *
 * A `Finding` is persisted to a database row and rendered into a **public**
 * pull-request comment (threat T-1-21, T-1-02), so unbounded child output
 * cannot go on one. The complete output is not lost: every chunk is streamed
 * to this attempt's NDJSON transcript as it arrives, which is where `adl logs`
 * points and what the artifact-store `rawRef` contract exists for.
 *
 * A rolling **tail** rather than `capRawOutput`'s head-and-tail elision, and
 * that is a memory decision rather than a stylistic one: `capRawOutput` takes
 * the whole string, which means holding the whole string, which is the thing
 * being avoided for a test suite that prints megabytes. A failing suite's
 * actionable lines are at the end.
 */
const OUTPUT_TAIL_CHARS = 4_000;

/**
 * The ceiling applied when the command declares no `timeout` of its own.
 *
 * The same constant and the same reasoning as `stage-runner.ts`'s
 * `DEFAULT_MAX_WALL_CLOCK_MS`: `EffectiveConfig.limits` has no per-invocation
 * wall-clock field, so this is a conservative placeholder rather than an
 * unbounded run. `CommandSpecSchema.timeout` is how an operator overrides it
 * today, and Phase 6's budget enforcement is where a configured default
 * belongs.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** A bounded tail of everything the child printed, in arrival order. */
interface OutputTail {
  /** The last {@link OUTPUT_TAIL_CHARS} characters, or all of them if fewer. */
  readonly text: string;
  /** How many characters were dropped off the front. */
  readonly elided: number;
}

/**
 * Accumulate `chunk` into a tail that never exceeds {@link OUTPUT_TAIL_CHARS}.
 *
 * Both streams into one buffer, interleaved as they arrived, because that is
 * how a human reads a failing test run — a build tool's error line on stderr
 * makes sense beside the stdout line before it, and separating them would
 * reorder the story. The `stream` tag is preserved on the transcript, which is
 * where a consumer that wants to distinguish them looks.
 */
function appendTail(tail: OutputTail, chunk: LogChunk): OutputTail {
  const combined = tail.text + chunk.text;
  if (combined.length <= OUTPUT_TAIL_CHARS) {
    return { text: combined, elided: tail.elided };
  }
  const dropped = combined.length - OUTPUT_TAIL_CHARS;
  return {
    text: combined.slice(dropped),
    elided: tail.elided + dropped,
  };
}

/** The tail as it belongs on a finding — with the elision stated, never silent. */
function renderTail(tail: OutputTail): string {
  const body = tail.text.trim();
  if (tail.elided === 0) {
    return body === '' ? '(the command produced no output)' : body;
  }
  return `…(${String(tail.elided)} earlier characters elided — the full output is in this attempt's transcript)…\n${body}`;
}

/**
 * The timeout to enforce, in milliseconds.
 *
 * `command.timeout` reached this process as a field on a JSON blob that
 * `stage-runner.ts` casts rather than validates, so a value `DurationSchema`
 * would have rejected can arrive here even though `adl.yml` parsing could never
 * have produced one. `parseDuration` throws on those; falling back to the
 * default is the right answer rather than failing the stage, because a
 * malformed ceiling is a configuration problem and running under a conservative
 * one is strictly better than not running.
 */
function timeoutMsFor(command: CommandSpec): number {
  if (command.timeout === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    return parseDuration(command.timeout);
  } catch {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
}

/**
 * How a {@link LogChunk} becomes a transcript record.
 *
 * The transcript's vocabulary is `AgentEvent`, because it was built for the one
 * thing that produced transcripts until now (M04's Claude Code adapter). A
 * command gate has no agent, so the mapping has to be made deliberately rather
 * than assumed, and it is made **here** — beside the code that knows what the
 * events mean — rather than in the stage runner, which would have to
 * reconstruct the same knowledge.
 *
 * Three deliberate choices:
 *
 * - `text`, not `tool_result`. The command's output *is* the assistant-visible
 *   content of this stage; there is no tool and no call id to invent.
 * - `messageId` carries the **stream name**. `AgentTextEvent`'s own docblock
 *   says the field "carries no meaning beyond grouping", and grouping stdout
 *   apart from stderr is exactly what a reader of a failing test run wants.
 * - **No `started` event.** It requires `capabilities: AgentCapabilities`, and
 *   there is no agent here whose capabilities those would be. Fabricating a
 *   set would put a false claim about tool access and cost reporting into the
 *   permanent record of an attempt.
 */
function chunkEvent(chunk: LogChunk): AgentEvent {
  return { kind: 'text', messageId: chunk.stream, delta: chunk.text };
}

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
   * What this gate's stdout means (HARN-02, M07 step 7.3). Defaults to
   * `exit_code`, which is 5.14's behaviour exactly — see
   * `@adl/core/config`'s `command-gate.ts` for why the mode is declared
   * rather than sniffed.
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

/**
 * Run the command and report what it decided.
 *
 * Never throws for a failing command — that is the whole distinction
 * `ExecResult.exitCode` exists to carry, and the workspace contract suite
 * pins it (*"reports a failing child as an exit code rather than a rejection"*).
 * A `cwd` outside the workspace root, or a workspace that refuses the exec,
 * still rejects; the caller classifies that.
 */
export async function runCommandGate(
  gate: GateContext,
  config: CommandGateConfig,
): Promise<StageRunnerVerdict> {
  const { workspace, stageId } = gate;
  const { command } = config;

  // `command.cwd` is repo-relative by schema (`RepoRelativePathSchema`), and
  // the containment check is `exec`'s own: every backend calls
  // `assertCwdWithinRoot(root, spec.cwd)` **first and unconditionally**, before
  // anything reaches the process table (D-02, WR-01, and the contract suite's
  // "refuses an exec whose cwd is …" cases pin it on both backends).
  //
  // So this deliberately does not re-guard, and that is not WR-02's defect
  // repeating: WR-02 was a path handed to a *direct filesystem read* with no
  // guard anywhere in the chain. Here the only thing this path is ever passed
  // to is the call that guards it, so a second check would be a second
  // implementation to keep in agreement — and `assertWithinRoot`, the one this
  // package can reach, is the wrong guard anyway: it rejects the workspace root
  // itself, which is the normal and correct value here.
  const cwd = join(workspace.root, command.cwd ?? '.');

  let tail: OutputTail = { text: '', elided: 0 };
  // Accumulated SEPARATELY from the interleaved tail above, and only in
  // `verdict` mode (M07 step 7.3). The tail deliberately merges both streams
  // because that is how a human reads a failing run; a verdict is a document,
  // and interleaving a progress line from stderr into the middle of it would
  // corrupt the very thing being parsed. Not accumulated at all in
  // `exit_code` mode, so an ordinary test suite printing megabytes does not
  // pay for a buffer nothing reads.
  const emits: CommandGateOutputMode = config.emits ?? 'exit_code';
  let stdout = '';

  let result: ExecResult;
  try {
    result = await workspace.exec(
      {
        argv: command.argv,
        cwd,
        path: config.path,
        ...(command.env !== undefined ? { env: command.env } : {}),
        timeoutMs: timeoutMsFor(command),
        ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        // v1's only values, at the one call site that could have hardcoded
        // them invisibly. See `NetworkPolicy`'s docblock for why the field
        // exists before any backend can enforce it.
        networkPolicy: 'full',
        resources: {},
      },
      (chunk) => {
        tail = appendTail(tail, chunk);
        if (emits === 'verdict' && chunk.stream === 'stdout') {
          stdout += chunk.text;
        }
        gate.onEvent(chunkEvent(chunk));
      },
    );
  } catch (error) {
    // The child never ran: the binary could not be spawned, or the workspace
    // refused. Not a verdict — nothing was judged (D-12).
    return stageError(
      'provider_error',
      `the ${stageId} command could not be run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The terminal record, so a transcript reader can tell "the command finished"
  // from "the file stopped growing" (T-4-33's distinction, one layer down).
  // `cancelled` for a child ADL killed and `completed` for one that exited on
  // its own — `AGENT_RESULT_OUTCOMES` has exactly three members and
  // `turn_limit_reached` is meaningless here, so these are the two honest ones.
  gate.onEvent({
    kind: 'result',
    outcome: result.exitCode === null ? 'cancelled' : 'completed',
    durationMs: result.durationMs,
  });

  if (result.exitCode === null) {
    // Killed rather than exited — the timeout above, or a cancellation. There
    // is no exit code, so there is no judgement, so this is not a verdict.
    return stageError(
      'timeout',
      `the ${stageId} command was killed after ${String(result.durationMs)}ms without exiting` +
        `${result.signal === undefined ? '' : ` (signal ${result.signal})`}: ${renderTail(tail)}`,
    );
  }

  // HARN-02 (M07 step 7.3): a gate that promised a verdict is judged on the
  // verdict, whatever its exit code was.
  //
  // The exit code is deliberately not consulted here, in EITHER direction. A
  // linter that exits 1 to mean "I found things" and prints an accurate
  // `send_back` is reporting correctly, and a gate that exits 0 while printing
  // a `fail` is too. Mixing the two signals would make the contract "emit a
  // verdict AND get the exit code right", which is two contracts.
  if (emits === 'verdict') {
    return verdictFromStdout(stageId, stdout, result.exitCode);
  }

  if (result.exitCode === 0) {
    return {
      kind: 'verdict',
      verdict: {
        outcome: 'pass',
        summary: `\`${command.argv.join(' ')}\` exited 0 in ${String(result.durationMs)}ms`,
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
  const title = `the ${stageId} command failed (exit ${String(result.exitCode)})`;
  const verdict: Verdict = {
    outcome: 'send_back',
    summary: `\`${command.argv.join(' ')}\` exited ${String(result.exitCode)}`,
    findings: [
      {
        fingerprint: fingerprintFinding({ stageId, title }),
        severity: 'blocker',
        title,
        detail: renderTail(tail),
        criterionRef: { kind: 'global', category: 'build' },
      },
    ],
  };
  return { kind: 'verdict', verdict };
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
