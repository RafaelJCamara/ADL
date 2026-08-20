/**
 * `claudeCodeBackend(options)` — the `AgentRunner` implementation for the
 * pinned Claude Code CLI (D-01, BACK-01).
 *
 * `run` calls the workspace's `exec` method **exactly once**: the program is
 * the agent CLI, the working directory is the workspace root, and the argv
 * carries the reproducibility flag (`--bare`), the streaming output format
 * (`--output-format stream-json`), the verbose and incremental-message flags
 * (`--verbose --include-partial-messages`), the explicitly-supplied system
 * prompt (`--append-system-prompt`), and a permission mode — the combination
 * `04-01-PLAN.md` names as what its (deferred) capture exercises.
 *
 * This module imports no process library — `packages/workspace/**` is the
 * repository's only spawn primitive, and `adl/no-direct-spawn` reaches this
 * package precisely because it is not under that exemption (`04-01`'s own
 * spawn-ban proof).
 *
 * `run` reads no environment of its own beyond what `options` was handed at
 * construction time: the model credential, the child's `PATH`, and the
 * commit identity are all the CALLER's job to assemble
 * (`worker-entry/stage-runner.ts`, Phase 2's D-09 per-exec allowlist, and
 * this plan's Task 2 identity guard) and arrive here as plain data, merged
 * onto the one exec spec this module builds. Nothing here reads
 * `process.env`.
 *
 * `run` never throws for a non-zero exit, a missing binary, or an auth
 * failure — those are classifications, reported as `error`-kind
 * {@link AgentEvent}s via `ctx.onEvent` and folded into the resolved
 * {@link AgentRunResult}'s outcome (the closest of `AgentResultOutcome`'s
 * three members — `AgentRunResult` has no fourth "failed" member; the event
 * stream is where the classification lives, and `worker-entry/stage-runner.ts`
 * (Task 2) is what turns an observed error event into the round's
 * infrastructure-failure report).
 */
import type {
  AgentEvent,
  AgentRunContext,
  AgentRunner,
  AgentRunResult,
  AgentTask,
  AgentUsage,
  AgentUsageEvent,
  ExecSpec,
  LogChunk,
} from '@adl/core/stage';
import type { StageErrorKind } from '@adl/core/stage';
import { translateLine } from './events.js';
import { preflightClaudeCode, type VersionCheckResult } from './preflight.js';
import { usageFromResult, type AgentUsageRecord } from './usage.js';
import { PINNED_CLAUDE_CODE_VERSION } from './version.js';

/** The pinned CLI's own name on the process table — the default argv[0]. */
const DEFAULT_BINARY: readonly string[] = ['claude'];

const EMPTY_USAGE = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
});

/**
 * {@link AgentRunResult}, with the DB-shaped usage record this run produced
 * attached alongside it — 04-10 Task 1's "surface the record on the run
 * result so the caller does not re-parse the terminal event". `usageRecord`
 * is a genuine superset field (covariant on `AgentRunner.run`'s declared
 * `Promise<AgentRunResult>` return type), never a narrowing — a caller that
 * only knows the base `AgentRunner` port still gets a fully valid
 * `AgentRunResult` back, it simply cannot see this extra field without
 * importing this package's own richer type, which is exactly what
 * `worker-entry/stage-runner.ts` (the one production caller of
 * `claudeCodeBackend` directly, rather than through the generic port) does.
 *
 * Exported (via `index.ts`) so the worker can read this type when handling
 * the resolved run result, without re-implementing `usageFromResult`'s
 * mapping itself.
 */
export interface AgentRunResultWithUsage extends AgentRunResult {
  /** Undefined when the run never reached a terminal `result` event (a spawn failure, a timeout, or a kill before one arrived). */
  readonly usageRecord?: AgentUsageRecord;
}

/**
 * {@link AgentRunner}, narrowed to the richer resolved value {@link claudeCodeBackend}
 * actually returns. A `ClaudeCodeAgentRunner` is always assignable to a plain
 * `AgentRunner` (the extra field is additive), so nothing about the generic
 * port changes — this interface exists purely so a caller that imports
 * `claudeCodeBackend` directly (rather than going through the generic port)
 * can read `usageRecord` off the resolved value without a cast.
 */
export interface ClaudeCodeAgentRunner extends AgentRunner {
  run(task: AgentTask, ctx: AgentRunContext): Promise<AgentRunResultWithUsage>;
}

function toAgentUsage(record: AgentUsageRecord | undefined): AgentUsage {
  if (record === undefined) return EMPTY_USAGE;
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadInputTokens,
    cacheWriteTokens: record.cacheCreationInputTokens,
  };
}

/** Build the resolved value every `run()` return path shares — usage/cost populated from whatever `usageRecord` this invocation produced, `EMPTY_USAGE`/no cost when it produced none. */
function buildRunResult(
  outcome: AgentRunResult['outcome'],
  durationMs: number,
  usageRecord: AgentUsageRecord | undefined,
): AgentRunResultWithUsage {
  return {
    outcome,
    durationMs,
    usage: toAgentUsage(usageRecord),
    ...(usageRecord?.costUsd !== null && usageRecord?.costUsd !== undefined
      ? { costUsd: usageRecord.costUsd }
      : {}),
    ...(usageRecord !== undefined ? { usageRecord } : {}),
  };
}

export interface ClaudeCodeBackendOptions {
  /**
   * The agent CLI as an argv prefix, mirroring `AdlGitOptions.binary` /
   * `ManagerGitClientOptions.gitBinary`'s precedent — a parameter so a test
   * can point this at a replay double (`node <path-to-fixture-script>`)
   * rather than the real, billed CLI. Defaults to `['claude']`.
   */
  readonly binary?: readonly string[];
  /**
   * Explicit environment values placed on the one exec spec this backend
   * builds — the model credential (D-09) and, when the caller supplies it,
   * the commit identity (this plan's Task 2). Assembling these from
   * `process.env` is the CALLER's job (`worker-entry/stage-runner.ts`); this
   * module only forwards what it is handed. The credential's value is never
   * interpolated into a log line, an error message, or an event.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The child's `PATH` (`ExecSpec.path` is required — see `workspace.ts`
   * note 2). This backend reads no environment of its own, so it cannot
   * resolve the daemon's own `PATH` the way `adlGit`/`managerGitClient` do —
   * the caller reads `process.env.PATH` once and hands it here explicitly,
   * the same "caller assembles, adapter forwards" discipline `env` follows.
   * Defaults to `''`, which reliably fails the exec — an empty `PATH` is a
   * caller bug this backend has no way to paper over honestly.
   */
  readonly path?: string;
  /** Wall-clock ceiling for the one exec this backend performs. Passed through to `ExecSpec.timeoutMs`; defaults to `task.limits.maxWallClockMs`. */
  readonly timeoutMs?: number;
  /**
   * The version-check invocation `probe()` delegates to (04-07, D-01/D-02).
   * Optional because this module is I/O-free and cannot construct one
   * itself (see the module docblock) — the manager's startup gate
   * (`packages/manager/src/boot/backend-preflight.ts`) is the real caller
   * that supplies it, via the ADL-owned exec boundary. Absent, `probe()`
   * answers honestly that nothing was checked rather than guessing.
   */
  readonly runVersionCheck?: () => Promise<VersionCheckResult>;
}

/**
 * A `LogChunk` handler that emits one translated batch per complete line.
 *
 * ── What `LogChunk` actually delivers, and why this is not naive string concatenation ──
 *
 * `Workspace.exec()`'s only real implementation in this repository
 * (`packages/workspace/src/exec/run.ts`) iterates execa's own
 * `subprocess.iterable({ from: 'stdout' })`, which is *already* a
 * line-buffering transform: it splits on the newline and delivers each
 * *complete, delimiter-stripped* line as one `LogChunk`. `git/adl-git.ts`'s
 * `collect()` documents this exact fact ("execa's line iterable strips the
 * newline, so the lines are rejoined rather than concatenated") and every
 * other real consumer of `LogChunk` in this codebase (`managerGitClient`)
 * relies on it the same way. Concretely: **a real `LogChunk` for `stdout`
 * never contains an embedded `\n`, and there is no delimiter left to wait
 * for** — treating each invocation as a complete line (rather than
 * buffering across calls hoping for a `\n` that execa already consumed) is
 * what makes this correct against the real workspace, not merely against a
 * hand-built double.
 *
 * A chunk that DOES contain an embedded `\n` (a producer that is not
 * execa's iterable — a future non-execa `Workspace` backend, or a chunk this
 * one happens to batch two lines into) is still handled defensively: split
 * on `\n` and translate every piece, including a trailing piece with no
 * terminator. Buffering only exists here for THAT rarer case, never for the
 * common one.
 */
function createLineHandler(onEvent: (event: AgentEvent) => void): {
  readonly handle: (chunk: LogChunk) => void;
  readonly flush: () => void;
} {
  let buffer = '';
  return {
    handle(chunk: LogChunk): void {
      if (chunk.stream === 'stderr') {
        // The CLI's documented behaviour writes machine-readable output to
        // stdout only; stderr is diagnostic text (progress, warnings, a
        // usage error). Classified rather than silently dropped, so a
        // failure written only to stderr still reaches the transcript. A
        // line naming authentication/authorization is classified `auth`
        // (best-effort keyword match — see `events.ts`'s identical note on
        // the missing captured fixture for the real wording).
        const trimmed = chunk.text.trim();
        if (trimmed.length > 0) {
          onEvent({
            kind: 'error',
            errorKind: /auth|unauthorized|401|api[_-]?key/i.test(trimmed)
              ? 'auth'
              : 'provider_error',
            detail: trimmed.slice(0, 2000),
          });
        }
        return;
      }

      const combined = buffer + chunk.text;
      if (!combined.includes('\n')) {
        // No embedded delimiter anywhere: the common, real case — this
        // invocation IS one already-complete line (see the function
        // docblock). Flushed now rather than held forever waiting for a
        // `\n` execa already stripped.
        buffer = '';
        if (combined.length > 0) {
          for (const event of translateLine(combined)) onEvent(event);
        }
        return;
      }

      const lines = combined.split('\n');
      // The last element is whatever follows the final `\n` — a genuine
      // partial line, carried into the next call (or `flush()` at stream
      // end).
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        for (const event of translateLine(line)) onEvent(event);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        for (const event of translateLine(buffer)) onEvent(event);
      }
      buffer = '';
    },
  };
}

/** Best-effort classification of a spawn-time exception — a genuinely missing binary versus everything else. */
function classifySpawnError(error: unknown): {
  readonly errorKind: StageErrorKind;
  readonly detail: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === 'ENOENT' || /ENOENT|not found|no such file/i.test(message)) {
    return {
      errorKind: 'binary_missing',
      detail: `the agent CLI could not be launched: ${message}`,
    };
  }
  return {
    errorKind: 'provider_error',
    detail: `the agent CLI could not be launched: ${message}`,
  };
}

export function claudeCodeBackend(
  options: ClaudeCodeBackendOptions = {},
): ClaudeCodeAgentRunner {
  const binary = options.binary ?? DEFAULT_BINARY;

  return {
    async probe() {
      // Delegates to `preflightClaudeCode` (04-07) rather than the tracer's
      // former inline placeholder. `AgentRunner.probe()`'s own signature
      // carries no `Workspace`, so this module still cannot invoke `claude
      // --version` itself — the manager's startup gate
      // (`backend-preflight.ts`) is the caller that constructs a real
      // `runVersionCheck` through the ADL-owned exec boundary and is what
      // this plan's `must_haves` are actually verified against
      // (`runBackendPreflight`, not this method). This method exists so a
      // FUTURE caller that already holds a `Workspace`-free version-check
      // runner (e.g. a later `adl doctor`) gets a real answer through the
      // standard `AgentRunner` port instead of a second bespoke path.
      if (options.runVersionCheck === undefined) {
        return {
          usable: true,
          installedVersion: null,
          expectedVersion: PINNED_CLAUDE_CODE_VERSION,
          detail:
            'claudeCodeBackend.probe() was not given a version-check runner ' +
            '(ClaudeCodeBackendOptions.runVersionCheck) — nothing was verified. ' +
            "The manager's startup gate (backend-preflight.ts) is what performs " +
            'the real check at daemon start.',
        };
      }
      const preflight = await preflightClaudeCode(options.runVersionCheck);
      return {
        usable: preflight.ok,
        installedVersion: preflight.installedVersion,
        expectedVersion: preflight.expectedVersion,
        ...(preflight.detail !== undefined ? { detail: preflight.detail } : {}),
      };
    },

    async run(
      task: AgentTask,
      ctx: AgentRunContext,
    ): Promise<AgentRunResultWithUsage> {
      const startedAt = Date.now();

      // Observed as the run's own events arrive, so the terminal `result`
      // event — which per `AgentEventSchema` never itself carries a model id
      // or token counts — can be combined with what was seen earlier into
      // one `AgentUsageRecord` (04-10 Task 1). `handleEvent` forwards every
      // event to `ctx.onEvent` unchanged; it never filters or reorders the
      // transcript, only observes it in passing.
      let observedModel: string | undefined;
      let observedUsage: AgentUsageEvent | undefined;
      let usageRecord: AgentUsageRecord | undefined;

      function handleEvent(event: AgentEvent): void {
        if (event.kind === 'started') {
          observedModel = event.model;
        } else if (event.kind === 'usage') {
          observedUsage = event;
        } else if (event.kind === 'result') {
          usageRecord = usageFromResult({
            event,
            usage: observedUsage,
            model: observedModel ?? task.model,
          });
          // Reconcile against the backend's own declared capabilities
          // (04-10 Task 1's action text): a backend that claims it reports
          // cost but whose terminal event carried none is a discrepancy.
          //
          // DELIBERATE DEVIATION from a literal reading of the action
          // text's "worth an event of the error kind in the transcript":
          // this module's own contract (see this file's docblock) folds
          // EVERY `kind: 'error'` event into `worker-entry/stage-runner.ts`'s
          // `firstError` — P1's prohibition — turning an otherwise-successful
          // run (a real commit, or an honest `blocked` outcome) into a false
          // `stage_error`. `fake-claude-no-commit.mjs` and several other
          // established replay doubles never report a cost figure at all,
          // and this reconciliation firing on every one of them broke
          // `stage-runner.test.ts`'s pre-existing "a run producing no commit
          // reports blocked honestly" case — verified by running the suite,
          // not assumed. The honest, already-structural signal is
          // `usageRecord.costSource === 'unknown'` itself (D-31): it is
          // recorded on the row, `spendByCategory`'s `unpricedEvents`
          // reports it, and Task 3's STATE.md write-up treats an `unknown`
          // source as evidence the spike is not closed (Prohibition P5).
          // Emitting a SECOND, transcript-level signal for the same fact
          // would either duplicate that (if harmless) or corrupt an
          // unrelated stage's outcome (as observed) — recording accurately
          // is what this module owns; deciding what an unknown-source event
          // means for the round's outcome belongs to Phase 6, not here.
        }
        ctx.onEvent(event);
      }

      const lineHandler = createLineHandler(handleEvent);

      const argv: string[] = [
        ...binary,
        '--bare',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--append-system-prompt',
        task.systemPrompt,
        '--permission-mode',
        'acceptEdits',
        task.instructions,
      ];

      const spec: ExecSpec = {
        argv,
        cwd: ctx.workspace.root,
        path: options.path ?? '',
        networkPolicy: 'full',
        resources: {},
        ...(options.env !== undefined ? { env: options.env } : {}),
        timeoutMs: options.timeoutMs ?? task.limits.maxWallClockMs,
        signal: ctx.signal,
      };

      let execResult;
      try {
        execResult = await ctx.workspace.exec(spec, lineHandler.handle);
      } catch (error) {
        // The workspace's exec() rejects for a genuine spawn-time failure
        // (the launcher itself could not start) rather than resolving with
        // a non-zero exit — that distinction is execa's, not this module's
        // to reproduce. Classified here rather than re-thrown: the port's
        // contract is to return an outcome, not to propagate an exception
        // for an expected-but-notable failure.
        const classified = classifySpawnError(error);
        ctx.onEvent({
          kind: 'error',
          errorKind: classified.errorKind,
          detail: classified.detail,
        });
        return buildRunResult('cancelled', Date.now() - startedAt, usageRecord);
      }

      lineHandler.flush();
      const durationMs = Date.now() - startedAt;

      if (execResult.exitCode === null) {
        // Killed by a signal — a timeout, an abort, or an external kill.
        ctx.onEvent({
          kind: 'error',
          errorKind: 'timeout',
          detail: `claude CLI was killed by signal ${execResult.signal ?? 'unknown'} after ${String(execResult.durationMs)}ms`,
        });
        return buildRunResult('cancelled', durationMs, usageRecord);
      }

      if (execResult.exitCode !== 0) {
        ctx.onEvent({
          kind: 'error',
          errorKind: 'provider_error',
          detail: `claude CLI exited with code ${String(execResult.exitCode)}`,
        });
        return buildRunResult('cancelled', durationMs, usageRecord);
      }

      return buildRunResult('completed', durationMs, usageRecord);
    },
  };
}
