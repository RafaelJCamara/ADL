---
phase: 04-first-agent-backend-live-transcripts
reviewed: 2026-08-20T21:23:09Z
depth: standard
files_reviewed: 57
files_reviewed_list:
  - packages/agent-claude-code/package.json
  - packages/agent-claude-code/src/backend.ts
  - packages/agent-claude-code/src/events.ts
  - packages/agent-claude-code/src/index.ts
  - packages/agent-claude-code/src/preflight.ts
  - packages/agent-claude-code/src/usage.ts
  - packages/agent-claude-code/src/version.ts
  - packages/agent-claude-code/test/argv.test.ts
  - packages/agent-claude-code/test/backend.test.ts
  - packages/agent-claude-code/test/events.test.ts
  - packages/agent-claude-code/test/preflight.test.ts
  - packages/agent-claude-code/test/smoke.test.ts
  - packages/agent-claude-code/test/usage.test.ts
  - packages/agent-claude-code/tsconfig.json
  - packages/agent-claude-code/tsconfig.test.json
  - packages/agent-claude-code/vitest.config.ts
  - packages/cli/package.json
  - packages/cli/src/commands/dev-run.ts
  - packages/cli/src/commands/logs.ts
  - packages/cli/src/http-client.ts
  - packages/cli/src/index.ts
  - packages/cli/test/commands/logs.test.ts
  - packages/cli/test/control-verbs.test.ts
  - packages/cli/test/dev-run.test.ts
  - packages/cli/test/status.test.ts
  - packages/core/src/stage/agent.ts
  - packages/core/src/stage/index.ts
  - packages/core/src/stage/stage.ts
  - packages/core/test/stage/agent.test.ts
  - packages/core/test/stage/agent-runner.test-d.ts
  - packages/manager/package.json
  - packages/manager/src/api/app.ts
  - packages/manager/src/api/routes/dev-run.ts
  - packages/manager/src/api/routes/logs.ts
  - packages/manager/src/bookkeeping/attempt.ts
  - packages/manager/src/boot/backend-preflight.ts
  - packages/manager/src/daemon.ts
  - packages/manager/src/index.ts
  - packages/manager/src/ipc/protocol.ts
  - packages/manager/src/prompt/artifact.ts
  - packages/manager/src/prompt/build.ts
  - packages/manager/src/prompt/templates/developer.md
  - packages/manager/src/scheduler/dispatcher.ts
  - packages/manager/src/store/ndjson-log-store.ts
  - packages/manager/src/store/transcript-path.ts
  - packages/manager/src/worker-entry/index.ts
  - packages/manager/src/worker-entry/stage-runner.ts
  - packages/manager/src/worker-supervisor/supervisor.ts
  - packages/manager/test/api/logs-reconnect.test.ts
  - packages/manager/test/api/routes/dev-run.test.ts
  - packages/manager/test/bookkeeping/attempt.test.ts
  - packages/manager/test/boot/backend-preflight.test.ts
  - packages/manager/test/control/kill.test.ts
  - packages/manager/test/control/pause.test.ts
  - packages/manager/test/helpers/fake-claude-auth-fail.mjs
  - packages/manager/test/helpers/fake-claude-no-commit.mjs
  - packages/manager/test/helpers/fake-claude-nonzero.mjs
  - packages/manager/test/helpers/fake-claude-slow-success.mjs
  - packages/manager/test/helpers/fake-claude-success.mjs
  - packages/manager/test/helpers/fake-claude-unclassifiable-result.mjs
  - packages/manager/test/helpers/run-dev-run-once.mjs
  - packages/manager/test/helpers/tracer-worker-entry.ts
  - packages/manager/test/helpers/usage-worker-entry.ts
  - packages/manager/test/ipc/assign-workspace.test.ts
  - packages/manager/test/prompt/artifact.test.ts
  - packages/manager/test/prompt/build.test.ts
  - packages/manager/test/prompt/determinism.test.ts
  - packages/manager/test/prompt/run-build-once.mjs
  - packages/manager/test/recovery/crash-recovery.test.ts
  - packages/manager/test/scheduler/reaper.test.ts
  - packages/manager/test/store/ndjson-log-store.test.ts
  - packages/manager/test/store/transcript-path.test.ts
  - packages/manager/test/tracer/dev-run-end-to-end.test.ts
  - packages/manager/test/tracer/end-to-end.test.ts
  - packages/manager/test/usage/recording.test.ts
  - packages/manager/test/worker-entry/stage-runner.test.ts
  - packages/plugin-sdk/src/index.ts
  - packages/plugin-sdk/test/reexport-identity.test.ts
  - packages/workspace/src/exec/env.ts
  - packages/workspace/src/exec/scratch-home.ts
  - packages/workspace/src/index.ts
  - packages/workspace/src/worktree/backend.ts
  - packages/workspace/test/worktree/safe-directory.test.ts
  - pnpm-lock.yaml
  - test/lint/fixtures/spawn-agent-backend.ts
  - test/lint/no-restricted-imports.test.ts
findings:
  critical: 2
  warning: 3
  info: 3
  total: 8
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-20T21:23:09Z
**Depth:** standard
**Files Reviewed:** 57 (of the files listed for review; several — `package.json`, `tsconfig*.json`, `vitest.config.ts`, `pnpm-lock.yaml` — carried no findings and are not discussed further below)
**Status:** issues_found

## Summary

This phase wires up the first real `AgentRunner` (`@adl/agent-claude-code`), the live NDJSON transcript store, the manager↔worker IPC surface that drives it, and the `adl dev-run` / `adl logs -f` CLI path. The individual modules are carefully written, defensively validated (Zod `.strictObject` everywhere, "classify, don't throw" is followed consistently), and the path-traversal discipline established in earlier phases (`resolveWithinRoot`) is applied correctly at the two route/store boundaries that build a filesystem path from an untrusted id (`GET /stages/:id/logs`, `POST /dev-run/:featureId`, `transcript-path.ts`, `prompt/artifact.ts`).

Two defects found during this review are serious enough to block: the "live transcript" feature this phase's own success criteria describe never actually terminates in production (`closeAttempt` is defined but never called from any production code path, so `adl logs -f`/the SSE route can never observe the `ended` event that is supposed to close the connection), and the transcript writer is fed concurrently from unserialized, unawaited `fs` appends, which is explicitly documented by Node itself as unsafe and can corrupt or reorder the very file the byte-offset addressing scheme in this phase depends on.

Three further issues are worth fixing but do not block: an unguarded `join()` in the production stage runner (defense-in-depth gap, not currently reachable with untrusted input, but inconsistent with the containment discipline used everywhere else in this phase); a hardcoded 10-minute wall-clock timeout with no path to the effective config, which risks classifying legitimate long-running agent work as a timeout; and dead/misleading placeholder data on the `stage_result` IPC message.

## Critical Issues

### CR-01: `closeAttempt` is never called from production code — `adl logs -f` (and the SSE follow route) can never observe `ended`

**File:** `packages/manager/src/worker-entry/stage-runner.ts:429-435` (teardown path — no `closeAttempt` call), `packages/manager/src/worker-supervisor/supervisor.ts:376-394` (`stage_result` handling — no `closeAttempt` call), `packages/manager/src/api/routes/logs.ts:189-203` (`isAttemptEnded` gate), `packages/manager/src/bookkeeping/attempt.ts:172-183` (`closeAttempt` definition)

**Issue:** `closeAttempt` writes the `ended_at` column that `isAttemptEnded` (used by `GET /stages/:id/logs?follow=1`'s follow loop) reads to decide when to emit the `ended` wire event and close the SSE response (`api/routes/logs.ts:189-203`, `bookkeeping/attempt.ts:227-250`). A repo-wide search shows `closeAttempt` is exported (`src/index.ts:254`) and imported **only** by test files (`test/api/logs-reconnect.test.ts` calls it manually to simulate the missing production write). Neither `createProductionStageRunner` (`worker-entry/stage-runner.ts`) nor the supervisor's `stage_result`/`fatal` handling (`worker-supervisor/supervisor.ts:376-394`) ever calls it.

The consequence is concrete and reproducible against the real system: a real `adl dev-run` followed by a real `adl logs -f <stageAttemptId>` (the exact flow `packages/cli/src/commands/dev-run.ts` prints as the next step, and the flow `packages/cli/src/commands/logs.ts`'s `consumeOneConnection` explicitly returns only on `'ended'` or a dropped connection) will **never terminate on its own** — the SSE connection sits polling `idle` forever even though the stage attempt genuinely finished, the worker exited, and the feature moved to its terminal state. This directly undermines this phase's own headline deliverable ("the transcript … streamed live to `adl logs -f` while it is still running", `packages/manager/src/worker-entry/stage-runner.ts:1-38`) — a user has to know to Ctrl-C the command every single time. It also means `stage_attempts.status` stays `'running'` forever for every attempt this phase's production path produces, which any future reader of that table (status views, GC, round bookkeeping) will misinterpret as still in flight.

**Fix:** Call `closeAttempt` from the one place that already knows the terminal outcome — `createProductionStageRunner`'s `finally` block (or immediately before it, using `'error'`/`'verdict'` based on which return path was taken) — before the writer is closed and the workspace destroyed:
```ts
// worker-entry/stage-runner.ts, before the writer.close()/workspace.destroy() in `finally`
await closeAttempt(
  { db: /* not available here — see note below */ },
  { stageAttemptId: assign.stageAttemptId, status: outcomeStatus },
);
```
Note `worker-entry/**` is banned from importing `@adl/db`/using a `Kysely` handle directly (`adl/worker-entry-no-db`), so the actual fix has to report the terminal status over the existing IPC channel (a new `WorkerToManagerMessage` variant, or piggy-backing on `stage_result`/`fatal`) and have the **manager** call `closeAttempt` once it accepts that message — mirroring how `usage` is already handled (`worker-supervisor/supervisor.ts:348-373`, `daemon.ts`'s `recordUsage`). Whichever shape is chosen, some caller in the manager process must call `closeAttempt` for every attempt this phase's production path produces.

### CR-02: Unserialized concurrent transcript writes can corrupt or reorder the NDJSON transcript file

**File:** `packages/manager/src/worker-entry/stage-runner.ts:372-382`, `packages/manager/src/store/ndjson-log-store.ts:108-145`

**Issue:** `createProductionStageRunner`'s `onEvent` handler pushes every translated `AgentEvent` onto `appendPromises` without awaiting each call individually:
```ts
onEvent: (event: AgentEvent) => {
  if (event.kind === 'error' && firstError === undefined) firstError = event;
  appendPromises.push(appendRecord(event));   // NOT awaited here
},
```
and only awaits the whole batch once the run finishes (`await Promise.all(appendPromises)`). `appendRecord` calls `writer.append()`, which does `await handle.appendFile(line, 'utf8')` on a single, shared `FileHandle` (`store/ndjson-log-store.ts:122-137`). Because `translateLine` frequently produces several events for one line (`events.ts`'s `mapAssistant`/`mapUserToolResult` both return arrays), and a real CLI's stdout is very plausibly delivered as several already-complete lines inside one `LogChunk`, `createLineHandler.handle()` (`backend.ts:189-246`) calls `onEvent` — and therefore starts a new, unawaited `handle.appendFile()` — multiple times in a tight synchronous loop, all against the same `FileHandle`.

Node's own documentation states this is unsafe: concurrent, unawaited writes to the same `FileHandle` are not guaranteed to complete in issuance order (they are dispatched to the libuv threadpool independently), so two records can land on disk out of the `seq` order they were assigned, or — worse — interleave mid-write and produce a line that is not valid JSON. `TranscriptRecordSchema`'s own docblock states the two invariants the rest of the system depends on ("one record is one line", ordering via `seq`) and `readTranscriptFrom` throws (uncaught, propagating into the SSE handler) if a line fails `JSON.parse`/schema validation. This is exactly the failure mode `stage-runner.test.ts`'s own assertion ("every record's `seq` is monotonically increasing", line 167-169) is silently relying on Node's threadpool *usually* preserving order to pass — it is not a guarantee, and the existing store-level test suite (`ndjson-log-store.test.ts`) only ever exercises sequentially-awaited appends, never this concurrent pattern.

**Fix:** Serialize writes inside `openTranscriptWriter` itself (the correct fix, since every caller benefits and the ordering guarantee becomes structural rather than caller-discipline), e.g.:
```ts
let writeQueue: Promise<unknown> = Promise.resolve();
return {
  append(record) {
    writeQueue = writeQueue.then(async () => {
      const parsed = TranscriptRecordSchema.parse(record);
      await handle.appendFile(`${JSON.stringify(parsed)}\n`, 'utf8');
      currentOffset = (await handle.stat()).size;
      return currentOffset;
    });
    return writeQueue as Promise<number>;
  },
  ...
};
```
Alternatively (or additionally, as defense in depth), `stage-runner.ts` could `await appendRecord(event)` before returning from `onEvent`'s synchronous caller — but `onEvent` is a synchronous callback contract (`AgentRunContext.onEvent: (event: AgentEvent) => void`), so that would require making `handleEvent`/`createLineHandler` async-aware, which is a larger change than fixing the primitive itself.

## Warnings

### WR-01: Hardcoded 10-minute wall-clock timeout is not wired to the effective config, and will falsely classify long-running legitimate agent work as a timeout

**File:** `packages/manager/src/worker-entry/stage-runner.ts:86, 358`

**Issue:** `DEFAULT_MAX_WALL_CLOCK_MS = 10 * 60 * 1000` is applied to every developer-agent invocation regardless of what `effectiveConfig.limits` actually says, because (per the module's own comment) `EffectiveConfig.limits` has no per-invocation wall-clock field yet. A real Claude Code developer run implementing a non-trivial feature (multiple files, tests, iteration) can easily exceed 10 minutes. When it does, `backend.ts`'s `execResult.exitCode === null` branch fires, emits a `timeout` error event, and `worker-entry/stage-runner.ts` reports it as a `stage_error` (never a pass) — a legitimate, in-progress, otherwise-successful run is killed and reported as an infrastructure failure. This is documented as a "conservative placeholder", but it is a real risk to this phase's own success criterion of proving a real committed change from a real agent invocation.

**Fix:** At minimum, raise the default meaningfully (e.g. 30-60 minutes) until Phase 6's budget enforcement lands, or thread a configurable ceiling through `StartDaemonOptions`/`ProductionStageRunnerDeps` now rather than leaving it a compile-time constant with no override in production.

### WR-02: `loadSpecFromWorktree` builds a filesystem path from `workspaceHandle` with no containment check, unlike every other path-building site this phase touches

**File:** `packages/manager/src/worker-entry/stage-runner.ts:124-137`

**Issue:**
```ts
async function loadSpecFromWorktree(workspaceRoot: string, workspaceHandle: string): Promise<NormalizedSpec> {
  const featureDir = join(workspaceRoot, workspaceHandle);   // plain join(), no containment check
  ...
}
```
`workspaceHandle` originates from `AssignMessage.workspaceHandle`, which the dispatcher sets to `feature.workspace_handle ?? feature.path` (`scheduler/dispatcher.ts:253-254`). Today the only writer of `features.path` is `POST /dev-run/:featureId` (`api/routes/dev-run.ts:153`), which validates the `featureId` component through `resolveWithinRoot` **before** insert — so this specific call chain is safe in practice. However, every other place in this phase that builds a path from an id that ultimately traces back to caller/database input goes through `resolveWithinRoot`/`assertWithinRoot` explicitly at the point of use (`transcript-path.ts:150-171`, `prompt/artifact.ts` via `transcriptPathFor`, `prompt/build.ts:218` via `resolveWithinRoot`, `api/routes/dev-run.ts:87`) — this is the one path-building site in the phase's own file list that instead relies entirely on an upstream validation the function itself cannot see or verify. A future feature-detection path that populates `workspace_handle`/`path` some other way (the natural next phase for this codebase, per `ARCHITECTURE.md`) would silently reopen a traversal here with no local defense.

**Fix:** Apply the same lexical containment guard used elsewhere, e.g. `const featureDir = resolveWithinRoot(workspaceRoot, workspaceHandle);`, matching the pattern `prompt/build.ts` and `transcript-path.ts` already establish.

### WR-03: `argv` passes the rendered system prompt and instructions as bare positional/flag-value arguments with no `--` separator

**File:** `packages/agent-claude-code/src/backend.ts:367-379`

**Issue:**
```ts
const argv: string[] = [
  ...binary, '--bare', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--append-system-prompt', task.systemPrompt,
  '--permission-mode', 'acceptEdits', task.instructions,
];
```
`task.instructions` (the fully-rendered developer prompt, built from feature spec content — see `prompt/build.ts`) is passed as the CLI's trailing positional argument with no `--` separator ahead of it. Today this is not exploitable: `DEVELOPER_SYSTEM_PROMPT` is a fixed constant and the rendered `instructions` string always starts with the template's own `## Feature: {{title}}` header (`prompt/templates/developer.md`), so it can never begin with `-`. But this is an accidental safety, not an enforced one — a future template edit, a different pipeline stage's prompt (reviewer/tester, later phases), or a spec whose title is interpolated earlier in the string could produce content starting with `-`/`--`, which the `claude` CLI's own argument parser would then be free to interpret as a flag rather than the intended prompt text.

**Fix:** Add an explicit `--` before `task.instructions` (and consider doing the same immediately before `task.systemPrompt`'s value is not itself a risk since it is a fixed constant, but the principle applies uniformly): `..., '--permission-mode', 'acceptEdits', '--', task.instructions,` — verify first that the pinned CLI honours `--` as an end-of-options marker before its trailing positional argument.

## Info

### IN-01: `stage_result`'s `roundId`/`stageIndex` are hardcoded placeholders that collide in name (but not type) with the real, ulid-typed round id

**File:** `packages/manager/src/worker-entry/index.ts:104-113`

**Issue:** `runAssignedStage` always reports `roundId: 0, stageIndex: 0` on the `stage_result` message, regardless of the real `assign.roundId` (a ulid string) or `assign.stageIndex` the worker was actually given. This is explicitly documented as a placeholder pending "the full pipeline walk" (a later plan), and nothing in this phase currently reads these two fields back out — but the field is named identically to `AssignMessageSchema.roundId` (a `string`) while itself being typed as `number` in `StageResultMessageSchema` (`ipc/protocol.ts:54-62` vs `125-161`), which is confusing for a future reader/maintainer wiring the real value in.

**Fix:** No functional change needed now, but consider renaming this field (e.g. `roundOrdinal`) to avoid the same-name-different-type collision with `AssignMessage.roundId`, or add a comment at the schema declaration cross-referencing the placeholder note in `worker-entry/index.ts`.

### IN-02: `worker-entry/stage-runner.ts` never uses `AgentTask.contextFiles`

**File:** `packages/manager/src/worker-entry/stage-runner.ts:351-359`

**Issue:** `task.contextFiles` is always set to `[]`, even though `buildDeveloperPrompt` already embeds every declared context file's content directly into the rendered `instructions` string. This is consistent with the module's own design (context is textual, not a separate loader hint), but `AgentTask.contextFiles`'s own docblock ("Workspace-relative paths to load explicitly") reads as though a real backend might use it independently, which this backend does not. Purely a documentation/clarity note — not a functional defect.

### IN-03: `classifySpawnError`'s ENOENT message-text fallback is a soft-matching heuristic with no test proving it is actually reached on any platform

**File:** `packages/agent-claude-code/src/backend.ts:248-268`

**Issue:** `classifySpawnError` first checks `error.code === 'ENOENT'`, then falls back to a regex over `error.message` (`/ENOENT|not found|no such file/i`). `stage-runner.test.ts`'s own missing-binary test is explicitly gated `posixOnly` and documents that on Windows this whole distinction is unreachable (the workspace layer reports a plain non-zero exit instead of a spawn-time rejection at all — see `run.ts`'s documented limitation). The regex fallback therefore has no test coverage proving it is ever exercised on any platform this repository currently tests; it is unreachable-but-harmless dead logic today. Worth a `// istanbul ignore` / follow-up note rather than a functional fix.

---

## Post-Review Fixes

Both Critical findings were fixed by the orchestrator immediately after this review, before phase verification:

- **CR-01** — fixed by wiring `closeAttempt` into `createSupervisor`'s `stage_result` (`status: 'verdict'`) and `fatal` (`status: 'error'`) handling, with `daemon.ts` supplying the real write through `bookkeeping/attempt.ts`'s `closeAttempt`. New tests: `packages/manager/test/usage/recording.test.ts` ("closeAttempt wiring (CR-01)" — 3 tests, including a negative-control test proving the attempt never ends without the wiring).
- **CR-02** — fixed by serializing `openTranscriptWriter`'s appends through an internal write queue in `packages/manager/src/store/ndjson-log-store.ts`, so ordering is structural rather than caller discipline; a rejected append no longer poisons the queue for subsequent calls. New tests: `packages/manager/test/store/ndjson-log-store.test.ts` (concurrent-order proof + poison-queue negative control).

Warnings (WR-01, WR-02, WR-03) and Info items were left as recorded findings — none are currently exploitable or block this phase's success criteria; they are follow-up work.

_Reviewed: 2026-08-20T21:23:09Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
