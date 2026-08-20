---
phase: 04-first-agent-backend-live-transcripts
plan: 04
subsystem: infra
tags: [kysely, better-sqlite3, zod, ipc, sqlite, scheduler]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: dispatchOnce, the manager<->worker IPC protocol, startDaemon's fixed boot order
provides:
  - "AssignMessage carrying the full WorkspaceSpec (mainRepo, scratchRoot, baseRef, workspaceBackendId) plus round/attempt addressing (roundId, stageAttemptId, stageId, stageIndex) — every field required"
  - "packages/manager/src/bookkeeping/attempt.ts: openAttempt, closeAttempt, findAttempt — the one place a round and stage attempt are opened/closed, and the DB-backed resolution a stage attempt id must go through"
  - "dispatchOnce calling openAttempt before every spawnWorker, so every agent invocation has a real rounds+stage_attempts row before it starts"
  - "startDaemon creating a scratch root (StartDaemonOptions.scratchRoot, defaulted beside the db file) at boot"
affects: [04-05, 04-06, 04-08, 04-10]

# Actuals (#2632)
actuals:
  tokens: 14250
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "openAttempt/closeAttempt/findAttempt: a bookkeeping module of functions taking deps as parameters (no service classes), following dispatcher.ts and the @adl/db repository factories"
    - "AssignMessage's workspace/attempt fields are all required — an insufficient IPC message fails validation at the boundary rather than letting a worker guess"

key-files:
  created:
    - packages/manager/src/bookkeeping/attempt.ts
    - packages/manager/test/bookkeeping/attempt.test.ts
    - packages/manager/test/ipc/assign-workspace.test.ts
  modified:
    - packages/manager/src/ipc/protocol.ts
    - packages/manager/src/scheduler/dispatcher.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts

key-decisions:
  - "Executed Task 2 (bookkeeping/attempt.ts) before Task 1 (protocol.ts + dispatcher.ts wiring), reversing the plan's task numbering — see Deviations."
  - "openAttempt is called from inside dispatchOnce itself, after the lease CAS succeeds and before spawnWorker, using the stage resolved from the pipeline snapshotted at that same dispatch (feature.current_stage_index + outcome.counters.currentStageIndex). A recovery dispatch for a feature with an already-open round naturally becomes a second attempt at the same round+stage index (D-13), not a fresh round."
  - "baseRef is refused rather than defaulted when a feature's repos row is missing (reposRepository.findById returns undefined) — dispatchOnce returns { dispatched: false } before ever acquiring a lease."
  - "workspaceBackendId defaults to 'worktree' when DispatcherDeps.workspaceBackendId is absent, keeping every earlier plan's DispatcherDeps construction as close to unchanged as the new required fields allow."

patterns-established:
  - "AttemptDeps { db, now? } / functions-not-classes bookkeeping module — the shape 04-08 (transcript route) and 04-10 (usage writer) should follow when they need the same two rows."

requirements-completed: [OBS-02, BACK-01]

coverage:
  - id: D1
    description: "AssignMessage carries mainRepo/scratchRoot/baseRef/workspaceBackendId; a message missing any of the four workspace fields, or naming an unregistered backend id, fails IPC validation with a named reason"
    requirement: "BACK-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/ipc/assign-workspace.test.ts#parseManagerMessage — assign carries the workspace spec"
        status: pass
    human_judgment: false
  - id: D2
    description: "dispatchOnce populates the assign message's workspace fields from the daemon's own configuration (mainRepo/scratchRoot from DispatcherDeps, baseRef from the repos row's default_branch), and refuses to dispatch rather than guess when the repos row is missing"
    requirement: "BACK-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/ipc/assign-workspace.test.ts#dispatchOnce — the assign message is self-sufficient"
        status: pass
    human_judgment: false
  - id: D3
    description: "openAttempt opens a round (reusing one already in flight, or numbering a new one past the highest existing) and a stage_attempts row in one transaction, incrementing the attempt ordinal for a repeat at the same round+stage index rather than overwriting (D-13); closeAttempt is idempotent; findAttempt resolves a stage attempt id to its feature/round/stage/attempt or undefined, never a throw"
    requirement: "OBS-02"
    verification:
      - kind: unit
        ref: "packages/manager/test/bookkeeping/attempt.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every agent invocation gets a real rounds+stage_attempts row before dispatchOnce spawns its worker, and the assign message it receives carries that round/attempt's ids"
    requirement: "OBS-02"
    verification:
      - kind: unit
        ref: "packages/manager/test/ipc/assign-workspace.test.ts#dispatchOnce — the assign message is self-sufficient > carries the configured main repository and the repo row default_branch as baseRef"
        status: pass
    human_judgment: false
  - id: D5
    description: "startDaemon creates the scratch root workspaces are built under, at startup, both the default (beside the db file) and an explicitly configured path"
    requirement: "BACK-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/ipc/assign-workspace.test.ts#startDaemon — the scratch root"
        status: pass
    human_judgment: false

duration: ~2h40m (across a session interruption/resume)
completed: 2026-08-20
status: complete
---

# Phase 4 Plan 4: Assign Message Workspace Spec & Round/Attempt Bookkeeping Summary

**The `assign` IPC message now carries a worker's whole world (workspace spec + round/attempt ids), and `openAttempt`/`closeAttempt`/`findAttempt` in `packages/manager/src/bookkeeping/attempt.ts` are the one place a round and stage attempt are opened, closed, and resolved.**

## Performance

- **Duration:** ~2h40m (spans a session pause/resume)
- **Tasks:** 2
- **Files modified:** 16 (3 created, 13 modified)

## Accomplishments

- `AssignMessageSchema` gained eight fields — `mainRepo`, `scratchRoot`, `baseRef`, `workspaceBackendId` (constrained to `WORKSPACE_BACKEND_IDS`), `roundId`, `stageAttemptId`, `stageId`, `stageIndex` — every one required, so an insufficient `assign` fails Zod validation at the IPC boundary instead of letting a forked worker guess a workspace root.
- `dispatchOnce` now looks up the feature's `repos` row for `baseRef` (refusing to dispatch, not defaulting, when it's missing), resolves the dispatched stage from the pipeline it just snapshotted, and calls `openAttempt` before handing a worker to `spawnWorker` — every agent invocation gets a real `rounds`/`stage_attempts` row before it starts.
- New `packages/manager/src/bookkeeping/attempt.ts`: `openAttempt` (find-or-open a round + insert a stage attempt, one transaction, ordinal-incrementing on repeat), `closeAttempt` (idempotent terminal-status write), `findAttempt` (the DB-backed resolution the future transcript route must use rather than trusting a path parameter — T-4-15).
- `startDaemon` gained `StartDaemonOptions.scratchRoot` (defaulted beside the database file) and creates that directory at boot, after the schema gate and before the first dispatch tick.
- 12 existing manager test files updated for the new required `DispatcherDeps`/`AssignMessage` fields — a mechanical, unavoidable consequence of making the workspace/attempt fields required (see Deviations).

## Task Commits

Both tasks were committed atomically. Note the commit order is reversed from the plan's task numbering — see Deviations below.

1. **Task 2: One place opens and closes a stage attempt** — `eb57458` (feat) — committed first
2. **Task 1: The assign message carries everything a worker needs** — `afc253d` (feat) — committed second, since it depends on Task 2's `openAttempt`

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/manager/src/bookkeeping/attempt.ts` — `openAttempt`/`closeAttempt`/`findAttempt`
- `packages/manager/test/bookkeeping/attempt.test.ts` — 9 tests for the above
- `packages/manager/src/index.ts` — barrel exports for the bookkeeping module
- `packages/manager/src/ipc/protocol.ts` — `AssignMessageSchema`'s 8 new required fields
- `packages/manager/src/scheduler/dispatcher.ts` — repo lookup for `baseRef`, pipeline/stage resolution, `openAttempt` call, `DispatcherDeps.mainRepo`/`scratchRoot`/`workspaceBackendId`
- `packages/manager/src/daemon.ts` — `StartDaemonOptions.scratchRoot`, directory creation at boot, threading `mainRepo`/`scratchRoot` into `dispatchOnce`
- `packages/manager/test/ipc/assign-workspace.test.ts` — 9 tests for the above
- 12 existing test files (`control/kill.test.ts`, `control/pause.test.ts`, `control/pause-persistence.test.ts`, `lease/fencing.test.ts`, `recovery/crash-recovery.test.ts`, `scenario/concurrency-crash-restart.test.ts`, `scheduler/dispatcher.test.ts`, `scheduler/reaper.test.ts`, `tracer/end-to-end.test.ts`) — added the new required `mainRepo`/`scratchRoot` `DispatcherDeps` fields and/or the 8 new `AssignMessage` literal fields wherever a test constructed one directly

## Decisions Made

- **openAttempt is called inside dispatchOnce itself**, not left for a later plan to wire — it's the only place in this plan's scope where "a worker is about to be spawned" is known, and the plan's own must_have ("every agent invocation has a rounds row and a stage_attempts row written before it starts") requires it to be real by the end of this plan, not a synthesized id.
- **baseRef comes from `reposRepository.findById(feature.repo_id).default_branch`**, looked up before the lease is acquired; a missing repos row (impossible in normal operation since the column is FK-enforced, but defensively handled for the case a row is removed between reconciliation runs) fails the dispatch cleanly with no lease held.
- **workspaceBackendId defaults to `'worktree'`** when absent from `DispatcherDeps`, so every earlier plan's `DispatcherDeps` construction needed only two new required fields (`mainRepo`, `scratchRoot`), not three.
- **scratchRoot defaults to a `scratch` directory beside the database file** and is created (`mkdir` recursive) right after the schema gate at daemon startup, matching `WorkspaceSpec.scratchRoot`'s "must already exist" contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reversed the execution order of Task 1 and Task 2**
- **Found during:** Starting Task 1
- **Issue:** The plan's Task 1 makes every field on `AssignMessage` required, including `roundId`/`stageAttemptId` — and states the worker needs all four round/attempt fields "without ever reaching the database." Task 1's own `<action>` text only describes populating `mainRepo`/`scratchRoot`/`baseRef`/`workspaceBackendId` in `dispatchOnce`; it says nothing about producing `roundId`/`stageAttemptId`, and Task 2 (which creates the function that produces them, `openAttempt`) doesn't list `dispatcher.ts` in its own task-level `<files>`. Taken literally in the stated order, Task 1's `dispatcher.ts` would not compile: `AssignMessage` would require fields the code had no source for.
- **Fix:** Implemented and committed Task 2 (`bookkeeping/attempt.ts`) first, then Task 1 (`protocol.ts` schema + `dispatcher.ts`, wiring `dispatchOnce` to call `openAttempt` for the round/attempt ids). This is also the only design that makes the plan's own must_have true ("every agent invocation has a rounds row and a stage_attempts row written before it starts") within this plan's scope, since no other call site in this plan's file list touches `dispatchOnce`.
- **Files modified:** No additional files beyond what each task already specified — only the order changed.
- **Verification:** Both tasks' full acceptance criteria pass; `pnpm --filter @adl/manager test`, `pnpm lint`, `pnpm -r typecheck`, `pnpm format` all exit 0.
- **Committed in:** `eb57458` (Task 2), `afc253d` (Task 1)

**2. [Rule 3 - Blocking] Updated 12 existing test files for the new required `DispatcherDeps`/`AssignMessage` fields**
- **Found during:** Task 1, after making `mainRepo`/`scratchRoot` required `DispatcherDeps` fields and adding 8 required `AssignMessage` fields (per the plan's own explicit instruction: "Every field is required")
- **Issue:** `tsc --noEmit -p tsconfig.test.json` failed with ~30 errors across `control/kill.test.ts`, `control/pause.test.ts`, `control/pause-persistence.test.ts`, `lease/fencing.test.ts`, `recovery/crash-recovery.test.ts`, `scenario/concurrency-crash-restart.test.ts`, `scheduler/dispatcher.test.ts`, `scheduler/reaper.test.ts`, and `tracer/end-to-end.test.ts` — every existing call site that built a `DispatcherDeps` object or a literal `AssignMessage` (mostly for `supervisor.spawn(...)`) was now missing required properties. None of these files are in the plan's `files_modified` list.
- **Fix:** Added `mainRepo: '/main/repo'`, `scratchRoot: '/main/repo/.adl/scratch'` to every `DispatcherDeps` construction, and the remaining six `AssignMessage` fields (`baseRef`, `workspaceBackendId`, `roundId`, `stageAttemptId`, `stageId`, `stageIndex`) to every literal `assign` object built for `supervisor.spawn(...)`.
- **Files modified:** the 12 test files listed above (also listed in Files Created/Modified)
- **Verification:** `pnpm --filter @adl/manager test` — all 19 test files, 155 tests pass; `pnpm -r typecheck`, `pnpm lint`, `pnpm format` all exit 0.
- **Committed in:** `afc253d` (Task 1)

**3. [Rule 1 - Bug] `assign-workspace.test.ts`'s scratch-root tests needed the database pre-migrated before `startDaemon`**
- **Found during:** Writing the `startDaemon — the scratch root` tests
- **Issue:** `runStartupGate`'s "absent schema_version" path (documented and tested in `test/boot/startup-gate.test.ts`) handles an already-migrated database whose `meta.schema_version` row was never written — it does not create the `meta` table itself. Passing a `dbFilePath` that had never been touched by `migrateToLatest` made `metaRepository.getSchemaVersion()` throw `SqliteError: no such table: meta`, which `startDaemon` did not catch, leaving its internal `db` handle open and un-destroyed — the subsequent `fs.rm` of the temp directory then failed with `EBUSY` on the `.db`/`.db-wal` files (this masked the real error initially; diagnosed via `process.stderr.write` instrumentation since Vitest was not surfacing `console.time` output for this test path).
- **Fix:** The test helper now opens a short-lived `createDb` connection, runs `migrateToLatest`, and destroys that connection *before* calling `startDaemon` — matching the convention every other `startDaemon` test in this suite already follows (`daemon-restart.test.ts`, `pause-persistence.test.ts`'s restart test). This is test-only; no production code changed for this issue, since `startDaemon`'s current bootstrap contract (schema gate seeds a `schema_version` row into an already-migrated `meta` table) predates this plan and matches the existing, tested contract in `test/boot/startup-gate.test.ts`.
- **Files modified:** `packages/manager/test/ipc/assign-workspace.test.ts`
- **Verification:** Both scratch-root tests pass reliably and fast (~1.3s total for the whole file, no EBUSY).
- **Committed in:** `afc253d` (Task 1)

---

**Total deviations:** 3 auto-fixed (2 Rule 3 blocking, 1 Rule 1 bug)
**Impact on plan:** All three were mechanical consequences of the plan's own explicit design choices (every `AssignMessage` field required; `openAttempt` needing to exist before `dispatchOnce` can call it) or a pre-existing test-infrastructure gap this plan's new tests happened to expose first. No scope creep — no behavior outside the plan's stated fields/functions was added.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `AssignMessage` is self-sufficient: `04-05` (the worker's own workspace-creation code) can build a `WorkspaceSpec` directly from the fields it receives, with no daemon-config or database access.
- `openAttempt`/`closeAttempt`/`findAttempt` are exported from `@adl/manager`'s barrel and ready for `04-06` (stage execution closing its own attempt), `04-08` (the transcript route, which must resolve its path through `findAttempt` per T-4-15 — this plan's test suite already proves an unknown id resolves to `undefined`, never a plausible path), and `04-10` (usage events joining on `round_id`/`stage_attempt_id`).
- No blockers. The dispatcher, fencing, and tracer suites carried over from Phase 3 remain green and behaviorally unchanged (only their `assign`/`DispatcherDeps` construction gained the new required fields).

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
