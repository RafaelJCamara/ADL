/**
 * Run one declared command through a gate's own workspace, and keep what it
 * printed (M08 step 8.5).
 *
 * Two callers, one mechanism: the plain-command gate running its program, and
 * the behaviour tester running the suite its pipeline entry declares. Both need
 * the same four things — the cwd joined under the workspace root, the command's
 * own ceiling, every chunk on the transcript as it arrives, and the output
 * captured in a shape its reader can use — and a second copy of any of them is
 * the drift convention 8 exists to prevent.
 *
 * ## Lines are rejoined, and that is load-bearing
 *
 * `Workspace.exec` delivers output **one line per chunk, with the newline
 * stripped** (`workspace/src/exec/run.ts` iterates execa's line iterable; the
 * contract suite pins it). Concatenating chunks, which is what the command gate
 * did before this step, turns a multi-line report into one line: harmless for a
 * JSON verdict, which does not care about line breaks between tokens, and fatal
 * for a TAP report, which is nothing *but* lines. So both the captured stdout
 * and the human-facing tail rejoin with `\n` — the tail too, because a failing
 * run's output reads as lines to the person on the pull request as well.
 *
 * ## Bounded, and the bound is stated
 *
 * stdout is captured only when the caller will read it, and capture STOPS once
 * it would pass `MAX_RUNNER_REPORT_CHARS`: no more is held in memory for a suite
 * that prints megabytes, and `stdoutOverflowed` is the only signal that the bound
 * was crossed — a caller must check it, because the text it hands a reader is
 * already within the bound. (`readRunnerReport`'s own `too_large` row protects a
 * caller that did not bound its text itself.) The tail is `OUTPUT_TAIL_CHARS` of both streams interleaved, as a
 * human reads a failing run; the whole output is always on the transcript.
 */
import type { CommandSpec } from '@adl/core/config';
import {
  MAX_RUNNER_REPORT_CHARS,
  type AgentEvent,
  type ExecResult,
  type GateContext,
  type LogChunk,
} from '@adl/core/stage';
import { join } from 'node:path';
import { timeoutMsFor } from '../command-timeout.js';

/**
 * How much of the combined output travels on a finding or in a `StageError`.
 *
 * A finding is persisted to a database row and rendered into a **public**
 * pull-request comment (threats T-1-21, T-1-02), so unbounded child output
 * cannot go on one. A rolling tail rather than head-and-tail elision, because
 * holding the whole output to elide its middle is the thing being avoided, and
 * a failing run's actionable lines are at the end.
 */
export const OUTPUT_TAIL_CHARS = 4_000;

/** What one run of a declared command came to. */
export type CapturedRun =
  /** The workspace refused the exec, or the binary could not be spawned: nothing ran. */
  | { readonly kind: 'spawn_failed'; readonly detail: string }
  /** ADL killed it — the ceiling, or a cancellation. No exit code, so no judgement. */
  | {
      readonly kind: 'killed';
      readonly durationMs: number;
      readonly signal?: string;
      readonly tail: string;
    }
  | {
      readonly kind: 'exited';
      readonly exitCode: number;
      readonly durationMs: number;
      readonly tail: string;
      /** stdout's lines joined by `\n`, or `''` when the caller did not ask for it. */
      readonly stdout: string;
      /** True when stdout outgrew `MAX_RUNNER_REPORT_CHARS` and capture stopped. */
      readonly stdoutOverflowed: boolean;
    };

export interface CaptureOptions {
  readonly command: CommandSpec;
  /** The child's `PATH`; `ExecSpec.path` is required, and the caller is what reads it. */
  readonly path: string;
  /** Capture stdout for a reader. `exit_code` mode does not, so a suite printing megabytes pays for no buffer. */
  readonly readStdout: boolean;
  /**
   * Prefixed to the stream name in each transcript record's `messageId` —
   * `''` for a command gate (the grouping `command-gate.ts` has always used),
   * `'suite:'` for a suite the tester's gate runs after its agent, so a reader
   * of the transcript can tell the agent's own tool output from ADL's run.
   */
  readonly transcriptPrefix: string;
}

/** A bounded tail of everything the child printed, in arrival order. */
interface OutputTail {
  readonly text: string;
  readonly elided: number;
}

function appendTail(tail: OutputTail, line: string): OutputTail {
  const combined = `${tail.text}${line}\n`;
  if (combined.length <= OUTPUT_TAIL_CHARS) {
    return { text: combined, elided: tail.elided };
  }
  const dropped = combined.length - OUTPUT_TAIL_CHARS;
  return { text: combined.slice(dropped), elided: tail.elided + dropped };
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
 * Run `options.command` in `gate.workspace` and report what happened. Never
 * throws: a refused or unspawnable command is `spawn_failed`, beside the code
 * that knows what that means.
 */
export async function runCaptured(
  gate: GateContext,
  options: CaptureOptions,
): Promise<CapturedRun> {
  const { workspace } = gate;
  const { command } = options;

  // `command.cwd` is repo-relative by schema, and containment is `exec`'s own
  // first, unconditional check on every backend (D-02, WR-01) — so this joins
  // and does not re-guard. See `command-gate.ts`'s history for why a second
  // guard here would be the wrong one.
  const cwd = join(workspace.root, command.cwd ?? '.');

  let tail: OutputTail = { text: '', elided: 0 };
  const stdoutLines: string[] = [];
  let stdoutLength = 0;
  let stdoutOverflowed = false;

  const onChunk = (chunk: LogChunk): void => {
    tail = appendTail(tail, chunk.text);
    if (options.readStdout && chunk.stream === 'stdout' && !stdoutOverflowed) {
      // +1 for the newline the join will put back.
      stdoutLength += chunk.text.length + 1;
      if (stdoutLength > MAX_RUNNER_REPORT_CHARS + 1) {
        stdoutOverflowed = true;
      } else {
        stdoutLines.push(chunk.text);
      }
    }
    const event: AgentEvent = {
      kind: 'text',
      messageId: `${options.transcriptPrefix}${chunk.stream}`,
      delta: chunk.text,
    };
    gate.onEvent(event);
  };

  let result: ExecResult;
  try {
    result = await workspace.exec(
      {
        argv: command.argv,
        cwd,
        path: options.path,
        ...(command.env !== undefined ? { env: command.env } : {}),
        timeoutMs: timeoutMsFor(command),
        ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        // v1's only values. See `NetworkPolicy`'s docblock for why the field
        // exists before any backend can enforce it.
        networkPolicy: 'full',
        resources: {},
      },
      onChunk,
    );
  } catch (error) {
    return {
      kind: 'spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.exitCode === null) {
    return {
      kind: 'killed',
      durationMs: result.durationMs,
      ...(result.signal !== undefined ? { signal: result.signal } : {}),
      tail: renderTail(tail),
    };
  }

  return {
    kind: 'exited',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    tail: renderTail(tail),
    stdout: stdoutLines.join('\n'),
    stdoutOverflowed,
  };
}
