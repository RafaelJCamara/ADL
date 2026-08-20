---
phase: 04-first-agent-backend-live-transcripts
plan: 06
subsystem: agent-backend-tracer
tags: [tracer, claude-code-adapter, dev-run, sse-logs, worker-entry, cli]

dependency-graph:
  requires:
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-01: @adl/agent-claude-code package scaffold, PINNED_CLAUDE_CODE_VERSION, spawn-ban proof (Task 3 — real CLI fixture capture — deferred, see Known Gaps)"
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-02: writeScratchGitConfig / safe.directory fix for D-2-08-1"
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-03: AgentRunner/AgentEvent/AgentTask/TranscriptRecord port shape"
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-04: AssignMessage's workspace fields, bookkeeping/attempt.ts (openAttempt/closeAttempt/findAttempt)"
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-05: transcriptPathFor, openTranscriptWriter/readTranscriptFrom/transcriptLength"
  provides:
    - "claudeCodeBackend / translateLine — the real AgentRunner implementation for the pinned Claude Code CLI"
    - "buildDeveloperPrompt — the PromptBuilder, deterministic prompt rendering"
    - "createProductionStageRunner — the real production StageRunner, replacing the named gap in worker-entry/index.ts"
    - "POST /dev-run/:featureId and GET /stages/:id/logs — the manager's HTTP surface for this phase"
    - "adl dev-run and adl logs -f — the CLI verbs"
    - "AssignMessage.logsRoot, DispatchDecision.stageAttemptId, SupervisorDeps.workerEnv/StartDaemonOptions.workerEnv/mainRepo — small, necessary wiring additions"
  affects: [04-07-preflight-and-reconnect, 04-08-logs-follow-loop, 04-09-prompt-persistence-and-byte-identity, phase-05-loop-runner]

tech-stack:
  added: []
  patterns:
    - "Classify, don't throw: claudeCodeBackend.run() never throws for a non-zero exit, a missing binary, or an auth failure — it emits an error-kind AgentEvent and returns a plausible AgentRunResult; the STAGE RUNNER (not the adapter) is what turns an observed error event into the round's infrastructure-failure report"
    - "LogChunk is one already-complete, delimiter-stripped line per invocation for the real Workspace.exec() (execa's line iterable) — backend.ts's line handler treats a chunk with no embedded '\\n' as complete immediately, and only buffers across calls when a chunk genuinely embeds one (a defensive case for a non-execa producer)"
    - "featureId ambiguity, resolved: AssignMessage.featureId / WorkspaceSpec.featureId is the features ROW's own ULID primary key (worktree/branch naming key) — NOT the features/<id>/ folder name. The folder name only reaches the worker via AssignMessage.workspaceHandle (== feature.path)"
    - "logsRoot threaded through AssignMessage (mirroring 04-04's mainRepo/scratchRoot precedent) rather than derived from scratchRoot inside the worker — the worker cannot import @adl/db and so cannot see dbFilePath, and a scratchRoot not colocated with the database file (the tracer's own test fixture, and a legitimate production topology) breaks a derived guess"
    - "dispatchOnce called synchronously from POST /dev-run/:featureId (not left to the next background tick) so the HTTP response can carry the stageAttemptId the caller needs for adl logs -f; both the tick and the route call the exact same runDispatchOnce closure, never two assemblies of DispatcherDeps"

key-files:
  created:
    - packages/agent-claude-code/src/backend.ts
    - packages/agent-claude-code/src/events.ts
    - packages/agent-claude-code/test/backend.test.ts
    - packages/agent-claude-code/test/events.test.ts
    - packages/manager/src/prompt/build.ts
    - packages/manager/src/prompt/templates/developer.md
    - packages/manager/src/worker-entry/stage-runner.ts
    - packages/manager/src/api/routes/dev-run.ts
    - packages/manager/src/api/routes/logs.ts
    - packages/manager/test/tracer/dev-run-end-to-end.test.ts
    - packages/manager/test/worker-entry/stage-runner.test.ts
    - packages/manager/test/prompt/build.test.ts
    - packages/manager/test/prompt/run-build-once.mjs
    - packages/manager/test/api/routes/dev-run.test.ts
    - packages/manager/test/api/routes/logs.test.ts
    - packages/manager/test/helpers/fake-claude-success.mjs
    - packages/manager/test/helpers/fake-claude-slow-success.mjs
    - packages/manager/test/helpers/fake-claude-no-commit.mjs
    - packages/manager/test/helpers/fake-claude-auth-fail.mjs
    - packages/manager/test/helpers/fake-claude-nonzero.mjs
    - packages/manager/test/helpers/fake-claude-unclassifiable-result.mjs
    - packages/manager/test/helpers/tracer-worker-entry.ts
    - packages/cli/src/commands/dev-run.ts
    - packages/cli/src/commands/logs.ts
    - packages/cli/test/dev-run.test.ts
    - packages/cli/test/logs.test.ts
  modified:
    - packages/agent-claude-code/src/index.ts
    - packages/manager/src/worker-entry/index.ts
    - packages/manager/src/api/app.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts
    - packages/manager/src/ipc/protocol.ts
    - packages/manager/src/scheduler/dispatcher.ts
    - packages/manager/src/worker-supervisor/supervisor.ts
    - packages/manager/package.json
    - packages/manager/test/ipc/assign-workspace.test.ts
    - packages/manager/test/control/kill.test.ts
    - packages/manager/test/control/pause.test.ts
    - packages/manager/test/recovery/crash-recovery.test.ts
    - packages/manager/test/scheduler/reaper.test.ts
    - packages/cli/src/http-client.ts
    - packages/cli/src/index.ts
    - packages/cli/test/control-verbs.test.ts
    - packages/cli/test/status.test.ts
    - pnpm-lock.yaml

decisions:
  - "Proceeded without 04-01's Task 3 real-CLI fixtures (deferred, no ANTHROPIC_API_KEY in that session) — translateLine is written against documented real event shapes (04-RESEARCH.md, ARCHITECTURE.md §4), matching 04-03's own precedent for the same gap. Recorded as a KNOWN GAP in events.ts's own docblock, not silently assumed correct."
  - "featureId vs workspaceHandle: AssignMessage.featureId is the features table's own ULID primary key (used for worktree/branch naming, per the existing 04-02/04-04 design); the features/<id>/ folder name only reaches the worker via AssignMessage.workspaceHandle (== feature.path). loadSpecFromWorktree uses workspaceHandle — using featureId there (my first attempt) is a real bug the tracer test caught: ENOENT on a worktree whose folder name never matched the row's ULID."
  - "logsRoot threaded through AssignMessage (new required field) rather than derived inside the worker from scratchRoot's colocation with the database file — the tracer's own test fixture (scratchRoot from a temp-repo helper, unrelated to the temp-db's directory) demonstrated the derived-guess approach silently reads/writes two different files. daemon.ts computes it once (logsRootFor(dbFilePath)) and both DispatchOnce's assign message and the GET /stages/:id/logs route use the same value."
  - "SupervisorDeps.workerEnv / StartDaemonOptions.workerEnv (new): the ONLY channel anything reaches a forked worker's process.env through (forkWorker's own allowlist is PATH-only). daemon.ts uses it to forward ANTHROPIC_API_KEY once, read from its own environment; the tracer test uses it to inject a scripted 'claude' CLI double's path into test-only worker-entry (tracer-worker-entry.ts), never into the real, shipped worker-entry/index.ts (which keeps zero test-injection surface, per that file's own stated design principle)."
  - "StartDaemonOptions.mainRepo (new, decoupled from workerCwd): workerCwd is the forked child's own process cwd (where --import tsx resolves the loader from); mainRepo is the repository ADL is running against. Coupling the two (the pre-existing options.workerCwd ?? process.cwd() expression, used in three places) made 'the daemon's mainRepo is a temp repo, but the worker's own cwd must stay inside the real package for tsx to resolve' inexpressible — exactly what the tracer test needed."
  - "dev-run.ts calls dispatchOnce synchronously inside the HTTP handler (not merely marks the row queued and waits for the next background tick) — the response has to carry the stageAttemptId dispatchOnce mints via openAttempt, and there is no other way to get it back to the caller in this phase. A documented, accepted simplification: on a daemon with other queued work, this call could (rarely) dispatch a different feature first, reported as 409 rather than returning the wrong attempt id."
  - "backend.ts's LogChunk handling treats a chunk with no embedded '\\n' as ALREADY a complete line and flushes it immediately, rather than buffering indefinitely waiting for a delimiter — matches execa's real line-iterable behaviour (verified: adl-git.ts's own collect() comment confirms this), and is what actually made the transcript grow correctly against the real worktree backend. My first implementation buffered on '\\n' presence alone, which never fires for execa's delimiter-stripped chunks and silently merged an entire run's output into one unparseable line — caught by the tracer, not by the unit tests (whose fakeWorkspace doubles happened to always embed the delimiter)."
  - "Auth-failure classification (errorKind: 'auth') is a best-effort keyword match (/auth|unauthorized|401|api[_-]?key/i) against stderr text and unrecognised result subtypes — there is no captured real fixture naming the pinned CLI's actual wording for a rejected credential (same 04-01 Task 3 gap), so this is a documented stand-in, not a confirmed mapping."

metrics:
  duration: "single extended session — a 19-file, cross-package tracer plan (agent-claude-code + manager + cli)"
  completed: "2026-08-20"

status: complete

actuals:
  tokens: 46800
  tasks: 2
  commits: 2
---

# Phase 04 Plan 06: The Tracer — `adl dev-run` Makes a Real Commit Through a Real Agent, Streamed Live Summary

**A feature folder goes in, a real agent process runs through `Workspace.exec()`, a real commit comes out, and its transcript streams live to `adl logs -f` while it is still running — the thinnest end-to-end slice through every layer this phase touches, proven by a real forked worker and a real git worktree, not a mock.**

## What Was Built

### `@adl/agent-claude-code` — the real `AgentRunner`

- **`src/events.ts`** — `translateLine(line)`, mapping one line of the pinned Claude Code CLI's `stream-json` output to zero, one, or several members of `AgentEvent`. Classifies rather than throws for a non-JSON line or an unrecognised shape (`errorKind: 'unparseable'`), and every constructed event is re-validated against `AgentEventSchema` before being returned. Written against the *documented* real event shapes (`04-RESEARCH.md`, `ARCHITECTURE.md` §4) rather than a captured fixture — see **Known Gaps** below.
- **`src/backend.ts`** — `claudeCodeBackend(options)`. `run()` calls `Workspace.exec()` exactly once, with the argv carrying `--bare`, `--output-format stream-json`, `--verbose --include-partial-messages`, `--append-system-prompt`, and a permission mode. Reads no environment of its own — the model credential, the child's `PATH`, and the commit identity all arrive via `options`, assembled by the caller (`stage-runner.ts`). Never throws for a non-zero exit, a missing binary (best-effort ENOENT classification), or an auth failure (keyword-matched) — each becomes an `error`-kind `AgentEvent` and a plausible `AgentRunResult`.
- The `LogChunk` line handler treats a chunk with no embedded `\n` as **already a complete line** (matching execa's real, delimiter-stripping iterable — see `adl-git.ts`'s own `collect()` comment) rather than buffering indefinitely; it only buffers across calls when a chunk genuinely contains an embedded `\n`. This distinction is what makes the transcript grow correctly against the real worktree backend — see **Deviations**.

### `@adl/manager` — `PromptBuilder`, the production stage runner, and the HTTP surface

- **`src/prompt/build.ts` + `templates/developer.md`** — `buildDeveloperPrompt(input)`, a pure function of `{spec, effectiveConfig, capabilities}`: byte-identical output across two calls in the same process and across two separate processes (proven via a real second `node --import tsx` invocation in `test/prompt/run-build-once.mjs`). The raw spec text is included verbatim alongside the ID'd acceptance-criteria checklist. Template substitution uses `split/join`, not `String.replace()` — see **Deviations** for why.
- **`src/worker-entry/stage-runner.ts`** — `createProductionStageRunner`, the real `StageRunner` `worker-entry/index.ts`'s `main()` now calls, replacing the named "no agent backend configured in this phase" gap. Resolves a workspace from the registry, loads the spec directly from the worktree (via `assign.workspaceHandle`, **not** `assign.featureId` — see Deviations), renders the prompt, opens a transcript writer, runs the backend appending one record per event as it arrives, classifies any observed `error`-kind event into the round's infrastructure-failure report (prohibition P1), supplies the commit identity (`ADL (claude-code) <adl+claude-code@noreply.local>`) via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment values on the one exec spec (prohibition P2), and closes the writer + destroys the workspace on every exit path, including failure.
- **`src/api/routes/dev-run.ts`** — `POST /dev-run/:featureId`: loads and validates the spec off disk (404 for a missing folder, 400 naming the load error), upserts the feature row, and calls `dispatchOnce` synchronously so the response can carry the minted `stageAttemptId`.
- **`src/api/routes/logs.ts`** — `GET /stages/:id/logs?offset=N`: resolves the untrusted `:id` through `findAttempt` **before** any filesystem path is built (T-4-15/T-4-07), then streams whatever complete records exist from `offset` over SSE. Serves history only — no live-follow loop (`04-08`'s addition, named explicitly in this plan's own action text).
- **Wiring additions** (small, necessary, all documented in `decisions` above): `AssignMessage.logsRoot`, `DispatchDecision.stageAttemptId`, `SupervisorDeps.workerEnv` / `StartDaemonOptions.workerEnv`, `StartDaemonOptions.mainRepo` (decoupled from `workerCwd`).

### `@adl/cli` — `adl dev-run` and `adl logs -f`

- **`commands/dev-run.ts`** — posts to `/dev-run/:featureId`, prints the dispatched feature id, the stage attempt id, and the exact `adl logs -f` command to run next.
- **`commands/logs.ts`** — consumes `DaemonClient.streamStageLogs` (built on `eventsource-parser`, added in `04-01`). Without `--follow`, one poll runs and the command exits (matching the route's own history-only contract). With `--follow`, polls on a short interval using the `nextOffset` each poll reports — the CLI implements the "follow" experience client-side, since the server route does not yet.

## The Tracer (Task 1)

`test/tracer/dev-run-end-to-end.test.ts` proves the full path against a temp database and a temp repository containing one real `features/<id>/` folder:

1. `POST /dev-run/<feature-id>` — 200, a real `dispatchOnce` call, a real lease, a real forked worker (`workerEntryPath` pointed at `test/helpers/tracer-worker-entry.ts`, a test-only entry that constructs `createProductionStageRunner` with a scripted "claude" CLI double — the SHIPPED `worker-entry/index.ts` carries no test-injection surface, per its own stated design).
2. A real child process exists (`processIsAlive(pid)` true, pid from the worker's own `ready` message).
3. The transcript file's byte length **grows** between two reads taken while the stage is still running.
4. `GET /stages/:id/logs`, read while the worker is still alive, returns at least one `record` event.
5. A real commit lands in the feature's worktree (read via `git -C <worktreePath> rev-parse HEAD` **before** `destroy()` removes the worktree and its `adl/<id>` branch — see Deviations), with an author naming `ADL (claude-code)`, never the test's own git identity.
6. Stopping the daemon leaves no child process running.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `String.prototype.replace()` is unsafe for untrusted replacement content in `buildDeveloperPrompt`**
- **Found during:** Task 1, writing `prompt/build.ts`.
- **Issue:** `template.replace(literal, value)` interprets `$&`/`$$`/`$'`-style sequences in the *replacement* string even when the search value is a plain string, not a regex. Every value substituted (spec title, raw spec text, criteria checklist) is repo-supplied, untrusted content that could legitimately contain a literal `$`.
- **Fix:** `substitute()` uses `template.split(literal).join(value)` — a literal, one-shot substitution with no special-sequence interpretation.
- **Files:** `packages/manager/src/prompt/build.ts`. **Verification:** `test/prompt/build.test.ts`'s dedicated `$&`/`$$` test.

**2. [Rule 1 — Bug] `assign.featureId` is the DB row's ULID, not the `features/<id>/` folder name**
- **Found during:** Task 1, the tracer test — an `ENOENT` reading `features/<ULID>` inside the worktree.
- **Issue:** `AssignMessage.featureId` / `WorkspaceSpec.featureId` is the `features` table's own primary key (used for worktree/branch naming, an existing `04-02`/`04-04` design decision, not something this plan chose). `loadSpecFromWorktree` used it to build `features/<featureId>/`, which only happens to work when a test fixture's folder name coincides with its row id — never true for a real feature folder with a human-readable name.
- **Fix:** `loadSpecFromWorktree` takes `assign.workspaceHandle` (== `feature.path`, e.g. `"features/export-widgets"`) directly, deriving the loader's own `featureId` argument (the folder's basename, used for `NormalizedSpec.id`/branch-suffix semantics) via `basename(workspaceHandle)`.
- **Files:** `packages/manager/src/worker-entry/stage-runner.ts`. **Verification:** the tracer test, end to end.

**3. [Rule 1 — Bug] `LogChunk` line-buffering never flushed against the real `Workspace.exec()`**
- **Found during:** Task 1, the tracer test — the transcript file existed but stayed at 0 bytes forever.
- **Issue:** My first `createLineHandler` buffered text across calls, flushing only on an embedded `\n`. execa's real line iterable (`run.ts`) strips the delimiter before delivering each already-complete line, so no `LogChunk` for `stdout` ever contains a literal `\n` — the buffer accumulated the whole run's output into one string that was never flushed until `flush()` at the very end, where it was fed to `translateLine` as ONE unparseable blob.
- **Fix:** A chunk with no embedded `\n` is now treated as already complete and flushed immediately; buffering across calls only happens for a chunk that genuinely embeds a delimiter (a defensive case for a non-execa producer). Documented at length in `createLineHandler`'s own docblock, including *why* this is correct for the real transport and not merely convenient.
- **Files:** `packages/agent-claude-code/src/backend.ts`, plus the backend-level chunking test in `test/backend.test.ts` was rewritten to test the two REAL delivery shapes (batched-into-one-chunk vs. one-line-per-chunk, no delimiter) rather than a fictional per-character split that cannot occur against any real `Workspace.exec()` in this codebase.
- **Verification:** the tracer test's transcript-growth assertion, and `backend.test.ts`'s rewritten chunking tests.

**4. [Rule 3 — Blocking] `logsRoot` derivation from `scratchRoot` colocation was demonstrably wrong**
- **Found during:** Task 1, the tracer test — the transcript file the worker wrote and the path the test read from were two different files.
- **Issue:** My first `logsRootFromScratchRoot(scratchRoot)` reproduced `logsRootFor(dbFilePath)`'s colocation (`join(dirname(x), 'logs')`) from `scratchRoot` instead of `dbFilePath` (the worker cannot import `@adl/db`). This holds only when `scratchRoot` is colocated with the database file — true by *default*, false in the tracer's own fixture (a temp-repo helper's `scratchRoot`, unrelated to the temp-db's directory) and in any real deployment that configures the two independently.
- **Fix:** Threaded a real `logsRoot` field through `AssignMessage` (mirroring `04-04`'s `mainRepo`/`scratchRoot` precedent), computed once in `daemon.ts` (`logsRootFor(dbFilePath)`) and reused by both `dispatchOnce`'s assign message and `GET /stages/:id/logs`. `DispatcherDeps.logsRoot` is optional (defaults to the old colocation formula) so the ~5 pre-existing test files that construct `AssignMessage`/`DispatcherDeps` literals needed only a mechanical field addition, not a redesign.
- **Files:** `packages/manager/src/ipc/protocol.ts`, `src/scheduler/dispatcher.ts`, `src/daemon.ts`, `src/worker-entry/stage-runner.ts`, and `test/control/kill.test.ts`, `test/control/pause.test.ts`, `test/recovery/crash-recovery.test.ts`, `test/scheduler/reaper.test.ts`, `test/ipc/assign-workspace.test.ts` (mechanical `logsRoot` field additions to existing `AssignMessage` literals).
- **Verification:** the tracer test's transcript-growth and `adl logs -f` assertions; `pnpm --filter @adl/manager test` (209/209).

**5. [Rule 3 — Blocking] The model credential had no channel into a forked worker's environment**
- **Found during:** Task 1, wiring the tracer — `forkWorker`'s own allowlist (`WORKER_ENV_ALLOWLIST`) carries only `PATH` (+`SystemRoot` on Windows); nothing forwards `ANTHROPIC_API_KEY` from the daemon's own environment into the worker process that needs to hand it to the backend.
- **Fix:** `SupervisorDeps.workerEnv` / `StartDaemonOptions.workerEnv` — explicit environment values merged over the allowlist for every forked worker. `daemon.ts` reads `process.env.ANTHROPIC_API_KEY` once and forwards it; the tracer test uses the same channel to inject its scripted CLI double's path into `tracer-worker-entry.ts` (a test-only entry point, never the shipped `worker-entry/index.ts`).
- **Files:** `packages/manager/src/worker-supervisor/supervisor.ts`, `src/daemon.ts`.
- **Note:** this also closes the credential-forwarding gap that would otherwise have made a *real*, credentialed `adl dev-run` invocation fail with a missing-key error regardless of anything else in this plan — see Known Gaps for the human-check status.

**6. [Rule 2 — auto-add missing critical functionality] Auth-failure classification (`errorKind: 'auth'`)**
- **Found during:** Task 2, writing the auth-failure test.
- **Issue:** The translator/backend only classified `binary_missing` (spawn ENOENT) vs. a generic `provider_error` for everything else, including a rejected credential — collapsing `auth` (not retryable, D-15) into `provider_error` (retryable) would make the loop back off and retry an auth failure that will never succeed differently.
- **Fix:** Best-effort keyword match (`/auth|unauthorized|401|api[_-]?key/i`) against stderr text and unrecognised `result` subtypes, documented as a stand-in pending `04-01`'s real fixture (the pinned CLI's actual wording for a rejected credential is unknown without it).
- **Files:** `packages/agent-claude-code/src/events.ts`, `src/backend.ts`.

No deviation required a checkpoint (Rule 4) — every one was a bug in this plan's own new code, a missing wiring channel this plan's own design required, or a critical-correctness addition, all resolved within the deviation rules' existing scope.

## Known Gaps

- **`04-01`'s Task 3 real-CLI fixture capture is still outstanding.** `translateLine` and the whole tracer are built and tested against *documented* real event shapes and a scripted replay double, never a real, billed invocation of the pinned Claude Code CLI. This is the same gap `04-03`'s executor recorded for the same reason. Reconciling `events.ts` against the real captured fixtures once `04-01` Task 3 lands is a natural, non-urgent follow-up.
- **The human-check in Task 1's `<verify>` was NOT performed.** Per this plan's own instruction ("do not attempt to fetch real credentials yourself") and the objective's explicit KNOWN GAP note, no real `ANTHROPIC_API_KEY` or real pinned CLI was used in this session. Everything above is proven against a scripted double. The plan's own `<verification>` section explicitly anticipates this: *"The human check in Task 1 has been performed against the real pinned CLI, or the summary states plainly that it has not."* — stated plainly here.
- **Repair/retry attempt ordinals are not threaded through `AssignMessage`.** `stage-runner.ts` hardcodes `attempt: 1` for the transcript address — correct for every dispatch this plan's own code produces (always a fresh first attempt), but a real retry/repair round (D-13) would need the real ordinal from `openAttempt`, which is not yet on the wire.
- **`POST /dev-run/:featureId` assumes a single configured repository** (`reposRepo.list()[0]`), matching the daemon's own current single-`mainRepo` design (`dispatchOnce`'s `mainRepo: string`, singular) rather than a limitation this plan introduced.

## Self-Check: PASSED

- FOUND: `packages/agent-claude-code/src/backend.ts`
- FOUND: `packages/agent-claude-code/src/events.ts`
- FOUND: `packages/manager/src/prompt/build.ts`
- FOUND: `packages/manager/src/worker-entry/stage-runner.ts`
- FOUND: `packages/manager/src/api/routes/dev-run.ts`
- FOUND: `packages/manager/src/api/routes/logs.ts`
- FOUND: `packages/manager/test/tracer/dev-run-end-to-end.test.ts`
- FOUND: `packages/manager/test/worker-entry/stage-runner.test.ts`
- FOUND: `packages/cli/src/commands/dev-run.ts`
- FOUND: `packages/cli/src/commands/logs.ts`
- FOUND commit `3f33000` in `git log --oneline`
- FOUND commit `310416c` in `git log --oneline`

## Verification

- `pnpm --filter @adl/agent-claude-code test`: 25/25 passed.
- `pnpm --filter @adl/manager test`: 209/209 passed (26 test files), including the tracer.
- `pnpm --filter @adl/cli test`: 24/24 passed.
- `pnpm -r test` (whole workspace): 1035/1035 passed across `cli`, `core` (446), `agent-claude-code`, `plugin-sdk`, `db`, `workspace` (222 + 6 platform-gated skips), `manager`.
- `npx vitest run --project root` (the architecture/spawn-ban suite): 65/65 passed.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm format`: all exit 0.
- The Phase 3 tracer, fencing, recovery, and control suites are unchanged in behaviour and still green (only mechanical `logsRoot` field additions to existing test literals).

## Next Phase Readiness

- `claudeCodeBackend`, `translateLine`, `buildDeveloperPrompt`, and `createProductionStageRunner` are real, tested, and wired end to end — `04-07` (preflight + reconnect) and `04-09` (prompt persistence + byte-identity proof across real invocations) build directly on this plan's shapes with no redesign expected.
- `04-08` (the logs follow loop) has a real `GET /stages/:id/logs` route to extend — this plan's own action text already names the absent-vs-past-end wire distinction and the follow loop as its addition.
- Phase 5's loop runner is the first real consumer of `StageRunnerVerdict`'s `{kind: 'developer_outcome' | 'stage_error', ...}` envelope this plan introduced for the IPC `verdictJson` payload — no schema currently reads it back on the manager side (by design; that is Phase 5's job).

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
