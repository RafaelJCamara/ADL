---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 08
subsystem: cli
tags: [commander, croner, hono, status-view, gc, operator-cli]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: the dispatcher, worker supervisor, HTTP API skeleton, concurrency cap, pause/resume/kill control surface (03-01..03-07) this plan finishes the operator's side of
provides:
  - "resolveStageCell/pipelineFromEffectiveConfig (src/stage-name.ts) — a feature row's stage cell joined against its own snapshotted pipeline, rendering e.g. `gating 2/4 (test)`"
  - "GET /features' full FeatureView: id, repoId, path, state, stage, round, ageMs, worker, staleRejections — no cost/spend field"
  - "The full `adl` verb set over HTTP: status, pause, resume, kill, gc, daemon (start/stop) — commander subcommands in @adl/cli, none of them touching @adl/db or @adl/manager"
  - "D-29's blast-radius confirmation (confirm.ts): resolveScope's mutually-exclusive feature-id/--repo/--all, and confirmBlastRadius's --all-only prompt/refuse rule"
  - "src/scheduler/gc-schedule.ts — runGcOnce/startGcSchedule, binding @adl/workspace's sweepOrphans+sweepScratchHomes to the real featuresRepository and a croner timer; POST /control/gc"
affects: ["phase-6 (the budget gate's status-view column, if any, follows this plan's field-optionality pattern)", "phase-17 (the dashboard consumes the identical GET /features shape this plan finalized)"]

# Actuals (#2632)
actuals:
  tokens: 21769
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "StageCell.label is pre-assembled in stage-name.ts rather than re-derived per caller (the manager's own test and the CLI's table renderer both reach for the same string), and every field beyond `state`/`label` is optional together — a row with no resolvable pipeline renders the state alone rather than a partially-populated cell"
    - "@adl/cli's BuildProgramDeps gained a createClient injection seam (defaulting to the real daemonClient) so control-verb tests substitute a recording fake without mocking the ESM module graph — the same pattern loadConfig already established"
    - "Only --all gates behind confirmBlastRadius's prompt; a single feature or a named --repo are narrow enough not to need one, per the plan's own tested acceptance surface rather than a literal reading of every D-29 clause"
    - "runGcOnce wraps each sweep call in its own try/catch (sequential, not Promise.all) so a sweep that throws outright is logged and the other sweep still runs, distinct from each sweep's own internal per-entry onFailure reporting"
    - "croner has no native sub-second cadence, so startGcSchedule uses pattern '* * * * * *' (matches every second) paired with croner's own `interval` option in whole seconds, rounded up from intervalMs — correct for GC's minutes-scale cadence, never asked to resolve sub-second (that stays the reaper's setInterval loop)"

key-files:
  created:
    - packages/manager/src/stage-name.ts
    - packages/manager/src/scheduler/gc-schedule.ts
    - packages/manager/src/api/routes/gc.ts
    - packages/manager/test/api/features-view.test.ts
    - packages/manager/test/scheduler/gc-schedule.test.ts
    - packages/cli/src/render/status-table.ts
    - packages/cli/src/confirm.ts
    - packages/cli/src/commands/pause.ts
    - packages/cli/src/commands/resume.ts
    - packages/cli/src/commands/kill.ts
    - packages/cli/src/commands/gc.ts
    - packages/cli/src/commands/daemon.ts
    - packages/cli/test/status.test.ts
    - packages/cli/test/control-verbs.test.ts
  modified:
    - packages/manager/src/api/routes/features.ts
    - packages/manager/src/api/app.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts
    - packages/cli/src/commands/status.ts
    - packages/cli/src/http-client.ts
    - packages/cli/src/index.ts

key-decisions:
  - "adl daemon start does not import @adl/manager and does not boot the real daemon in-process. Two independent reasons converged: importing @adl/manager would reverse D-21's documented 'CLI structurally cannot reach past HTTP into manager internals' with no automated test defending the reversal either way, and it would not even be functionally complete yet — StartDaemonOptions.resolveAdlYml has no production implementation because feature detection is Phase 5's job, not this plan's. adl daemon start prints an honest gap and exits 1 rather than fabricating success."
  - "adl daemon stop is real end-to-end: POST /control/shutdown was added to api/app.ts (ApiDeps.onShutdownRequested) and wired in daemon.ts to the same stop() DaemonHandle.stop() already calls, via a mutable holder object (not a reassigned let, to keep prefer-const clean) set once stop exists. The route responds before the shutdown sequence starts (setTimeout(0), not a same-tick microtask) so the client sees a real 200 before the server begins closing. This was not in Task 2's or Task 3's literal file list but app.ts/daemon.ts were already in Task 3's scope, and 'adl daemon stop asks a running daemon to shut down gracefully' is explicit behavior text this plan specifies (Rule 2 — missing critical functionality)."
  - "Only --all triggers confirmBlastRadius's prompt/refuse gate on pause/resume/kill — not --repo. D-29's prose reads 'explicit flags for wider blast radii' (plural), but every concrete acceptance criterion in this plan only exercises --all's confirmation; --repo scope has no confirmation test anywhere in the plan. Gating only --all matches the tested contract exactly and avoids inventing an untested requirement."
  - "ageMs is computed from updated_at, not created_at (daemon.ts's prior tracer-era implementation used created_at) — the plan's own action text specifies 'milliseconds since updated_at', and updated_at is what actually moves as a feature's state changes, which is the field an operator scanning 'how long has this been stuck' actually wants."

patterns-established:
  - "A feature row's derived view fields (StageCell, and any future one) are resolved with every optional field present-or-absent together, never partially populated, so a consumer checking one optional field can trust the others' presence follows the same rule"
  - "CLI action handlers built through buildProgram never call daemonClient directly — they go through a buildClient(config) indirection reading deps.createClient — the same injection shape as deps.loadConfig, so a future seam (e.g. request tracing) has one obvious place to add itself"

requirements-completed: [OBS-01, OBS-03, OBS-04, EXEC-01]

coverage:
  - id: D1
    description: "resolveStageCell renders one-based position, pipeline length, and the resolved stage name from a feature's snapshotted effective_config_json, e.g. 'gating 2/4 (test)'; a row with no resolvable pipeline renders the state alone, never throwing or printing the literal 'undefined'"
    requirement: "OBS-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/api/features-view.test.ts#resolveStageCell"
        status: pass
    human_judgment: false
  - id: D2
    description: "GET /features returns id, repoId, path, state, stage, round, ageMs, worker, staleRejections for every row, ordered by id, with no cost/spend field; two identical features produce two objects; the empty case returns []; two consecutive calls with no state change are byte-identical"
    requirement: "OBS-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/api/features-view.test.ts#GET /features"
        status: pass
    human_judgment: false
  - id: D3
    description: "adl status renders the table (or --json verbatim) from GET /features; the empty case prints one explanatory line, never a bare header; against a stopped daemon it exits 1 with D-25's exact message"
    requirement: "OBS-01"
    verification:
      - kind: unit
        ref: "packages/cli/test/status.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "adl pause/resume/kill accept a positional feature id, --repo <id>, or --all (mutually exclusive); only --all gates behind interactive confirmation, refusing outright non-interactively without --yes; declining posts nothing, an affirmative or --yes posts and reports the affected feature ids"
    requirement: "OBS-03"
    verification:
      - kind: unit
        ref: "packages/cli/test/control-verbs.test.ts#adl kill --all"
        status: pass
    human_judgment: false
  - id: D5
    description: "adl --help lists status, pause, resume, kill, gc, and daemon; every verb against a stopped daemon exits 1 with D-25's message"
    requirement: "OBS-04"
    verification:
      - kind: unit
        ref: "packages/cli/test/control-verbs.test.ts#adl --help, #every verb against a stopped daemon"
        status: pass
    human_judgment: false
  - id: D6
    description: "runGcOnce calls sweepOrphans and sweepScratchHomes (both from @adl/workspace, neither redefined) exactly once each; a sweep that throws outright is logged and the other still runs; the bound FeatureStateLookup resolves a real persisted state and the absent value for an unknown id; startGcSchedule's croner timer never runs two passes concurrently; the configured GC interval is >=100x heartbeat_interval_ms's default"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/gc-schedule.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "POST /control/gc runs one pass on demand behind the bearer token and returns the summary; adl gc posts it and prints the reclaimed counts"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/gc-schedule.test.ts#POST /control/gc, packages/cli/test/control-verbs.test.ts#adl gc"
        status: pass
    human_judgment: false

duration: 32min
completed: 2026-08-20
status: complete
---

# Phase 03 Plan 08: Status View, Control Verbs, and GC Schedule Summary

**The full `adl` verb set over HTTP — `status | pause | resume | kill | gc | daemon` — plus the joined stage-cell status view (`gating 2/4 (test)`) and the GC schedule that discharges Phase 2's deferred worktree/scratch-home backstop.**

## Performance

- **Duration:** ~32 min (base commit 06:40:39+02:00, last task commit 07:12:40+02:00)
- **Started:** 2026-08-20T06:40:39+02:00
- **Completed:** 2026-08-20T07:12:40+02:00
- **Tasks:** 3
- **Files modified:** 21 (14 created, 7 modified)

## Accomplishments

- `packages/manager/src/stage-name.ts`: `resolveStageCell`/`pipelineFromEffectiveConfig` join `current_stage_index` against the pipeline snapshotted in `effective_config_json`, producing `StageCell` — a state string, an optional one-based position/pipeline-length/name triple, and a pre-assembled `label` (e.g. `gating 2/4 (test)`). A row with no resolvable pipeline renders the state alone, never throwing, never printing `undefined`. `TransitionCtx` still carries only a length and an index; this module reads the row for display only.
- `GET /features` now returns the full column set — `id`, `repoId`, `path`, `state`, `stage`, `round`, `ageMs` (from `updated_at`, one clock read per request), `worker`, `staleRejections` — ordered by id, with no cost/spend field. Two identical features produce two objects; two consecutive reads with no state change are byte-identical.
- `@adl/cli`'s `render/status-table.ts` (`renderStatusTable`/`formatAge`/`truncateId`) and `commands/status.ts`: the empty case prints one explanatory line, never a bare header; `--json` emits the array verbatim.
- `confirm.ts`: `isInteractive`/`confirmBlastRadius` (D-29) — `--yes` bypasses the prompt; a non-interactive context without it refuses outright rather than silently proceeding. `resolveScope` is the one shared scope-resolution helper `pause.ts`/`resume.ts`/`kill.ts` all use: a positional feature id, `--repo <id>`, or `--all`, mutually exclusive, raising `ScopeUsageError` (posting nothing) otherwise. Only `--all` gates behind the confirmation prompt.
- `http-client.ts` extended with `postFeatureControl`/`postControl`/`postGc`/`postShutdown` — every verb still speaks HTTP only.
- `index.ts` wires all six verbs into one commander program: a global `--config`/`--json`, a shared `runVerb()` reporting D-25's daemon-down message and scope usage errors identically, and a `createClient` injection seam.
- `scheduler/gc-schedule.ts`: `runGcOnce` calls `sweepOrphans` and `sweepScratchHomes` (both from `@adl/workspace`, neither redefined), binding `lookupFeatureState` through the real `featuresRepository` and `isProcessAlive` to `@adl/workspace`'s own `processIsAlive`. `startGcSchedule` runs it on a `croner` timer with `protect: true`. `POST /control/gc` (new route) and `POST /control/shutdown` (new, on `daemon stop`'s behalf) both land behind the existing bearer middleware.
- `adl gc` posts `POST /control/gc` and prints the reclaimed counts and failures.

## Task Commits

Each task was committed atomically:

1. **Task 1: The status view — stage resolution, the full column set, and the empty state** - `8a05e08` (feat)
2. **Task 2: The control verbs — scoping, the blast-radius confirmation, and `adl daemon`** - `5ff5d94` (feat)
3. **Task 3: The GC schedule and `adl gc` — discharging Phase 2's deferred D-15** - `e1e5c83` (feat)

**Plan metadata:** (this commit, following SUMMARY.md)

## Files Created/Modified

- `packages/manager/src/stage-name.ts` - `resolveStageCell`, `pipelineFromEffectiveConfig`, `StageCell`, `StageCellInput`
- `packages/manager/src/api/routes/features.ts` - `FeatureView` extended to the full column set (`stage` replaces the tracer-era `stageIndex`/`pipelineLength`)
- `packages/manager/src/api/app.ts` - `ApiDeps` gains `mainRepo` (mounts `POST /control/gc`) and `onShutdownRequested` (mounts `POST /control/shutdown`)
- `packages/manager/src/daemon.ts` - `listFeatureViews` uses `resolveStageCell`; wires `startGcSchedule`/`gcSchedule.stop()`; wires the shutdown-request holder to the existing `stop()`
- `packages/manager/src/index.ts` - barrel exports for `stage-name.ts`, `scheduler/gc-schedule.ts`, `api/routes/gc.ts`
- `packages/manager/src/scheduler/gc-schedule.ts` - `runGcOnce`, `startGcSchedule`, `createFeatureStateLookup`, `GcRunSummary`, `GcRunDeps`, `GcScheduleDeps`
- `packages/manager/src/api/routes/gc.ts` - `registerGcRoute`, `GcRouteDeps`
- `packages/manager/test/api/features-view.test.ts` - `resolveStageCell` unit tests and `GET /features`'s full behavior surface
- `packages/manager/test/scheduler/gc-schedule.test.ts` - the GC binding, failure propagation, overlap protection, and `POST /control/gc`
- `packages/cli/src/render/status-table.ts` - `renderStatusTable`, `formatAge`, `truncateId`, `FeatureRow`, `StageCellView`
- `packages/cli/src/commands/status.ts` - rewritten to use `renderStatusTable`
- `packages/cli/src/confirm.ts` - `isInteractive`, `confirmBlastRadius`, `resolveScope`, `ScopeUsageError`
- `packages/cli/src/commands/pause.ts`, `resume.ts`, `kill.ts` - the three control verbs
- `packages/cli/src/commands/gc.ts` - `adl gc`
- `packages/cli/src/commands/daemon.ts` - `adl daemon start`/`stop`
- `packages/cli/src/http-client.ts` - `postFeatureControl`, `postControl`, `postGc`, `postShutdown`, `ControlResult`, `GcRunSummary`, `DaemonRequestError`
- `packages/cli/src/index.ts` - all six verbs wired, `createClient` injection seam
- `packages/cli/test/status.test.ts` - the status view's full behavior surface
- `packages/cli/test/control-verbs.test.ts` - scoping, confirmation, `--help`, and the daemon-down path across all six verbs

## Decisions Made

- `adl daemon start` does not import `@adl/manager` and does not boot the real daemon in-process — see `key-decisions` in the frontmatter for the full reasoning (D-21's package boundary, plus `resolveAdlYml`'s absence pending Phase 5). It prints an honest gap and exits 1.
- `adl daemon stop` is real end-to-end: `POST /control/shutdown` was added in this plan's Task 3 commit (app.ts/daemon.ts were already in that task's scope) as a Rule 2 addition, since "asks a running daemon to shut down gracefully" is explicit plan text.
- Only `--all` gates behind `confirmBlastRadius` on pause/resume/kill — matches every concrete acceptance criterion in the plan; `--repo` has no confirmation test anywhere in it.
- `ageMs` is computed from `updated_at`, not the tracer-era `created_at`, per the plan's own action text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `POST /control/shutdown` added so `adl daemon stop` is functionally real**
- **Found during:** Task 2 (`adl daemon` command)
- **Issue:** The plan's behavior text says "`adl daemon stop` asks a running daemon to shut down gracefully," but no HTTP route existed for a shutdown request, and Task 2's own file list did not include any manager-side files.
- **Fix:** Added `ApiDeps.onShutdownRequested` and `POST /control/shutdown` in `api/app.ts`, wired in `daemon.ts` to the same `stop()` `DaemonHandle.stop()` already calls (via a mutable holder object set once `stop` exists, rather than a reassigned `let`, to keep `prefer-const` clean). The response is written before the shutdown sequence starts. Landed in the Task 3 commit since `app.ts`/`daemon.ts` were already in that task's file list.
- **Files modified:** `packages/manager/src/api/app.ts`, `packages/manager/src/daemon.ts`, `packages/cli/src/http-client.ts` (`postShutdown`), `packages/cli/src/commands/daemon.ts`
- **Verification:** `pnpm --filter @adl/manager test` and `pnpm --filter @adl/cli test` both pass; the down-daemon path is covered by `control-verbs.test.ts`'s `adl daemon stop` case.
- **Committed in:** `e1e5c83` (Task 3)

**2. [Rule 1 - Bug] `prefer-const` lint failure on the shutdown-request holder**
- **Found during:** Task 3, post-implementation `pnpm lint`
- **Issue:** `let requestShutdown: (() => void) | undefined;` declared with no initializer and assigned exactly once later triggered ESLint's `prefer-const` — a pattern that cannot literally become `const` without restructuring, since the single assignment happens after a closure that already reads it is constructed.
- **Fix:** Replaced the reassigned `let` with a `const shutdownRef: { current?: () => void }` holder object; only `.current` mutates, the binding itself never reassigns.
- **Files modified:** `packages/manager/src/daemon.ts`
- **Verification:** `pnpm lint` exits 0; `pnpm --filter @adl/manager test` still 129/129.
- **Committed in:** `e1e5c83` (Task 3, fixed before the commit was made)

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 lint bug)
**Impact on plan:** Both were necessary to deliver the plan's own stated behavior and to keep `pnpm lint` green. No scope creep beyond what Task 2's own behavior text specifies for `adl daemon stop`.

## Known Stubs

- **`adl daemon start` does not boot the manager.** It prints an honest message and exits 1 rather than starting anything. This is not a shortcut: `StartDaemonOptions.resolveAdlYml` has no production implementation anywhere in the codebase yet (feature detection is Phase 5's job), so a working in-process bootstrap is not achievable within this plan's scope regardless of the `@adl/cli`/`@adl/manager` package-boundary question. `packages/cli/src/commands/daemon.ts`'s docblock records both reasons. Resolving this is Phase 5+'s job, once `resolveAdlYml` exists and the CLI/manager boot story is deliberately decided (in-process import vs. a separate spawned binary).

## Issues Encountered

None beyond the two auto-fixed deviations above — both caught and resolved inline during normal task execution, before any commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Every ROADMAP criterion this plan targets is met: `adl status` shows state, stage, and round for every feature including none; pause/kill work at three blast radii with a confirmation proportionate to the widest; Phase 2's deferred D-15 sweep has both a timer and a verb.
- Phase 5 (feature detection) is what unblocks a real `adl daemon start` — once `resolveAdlYml` has a production implementation, the CLI/manager boot story (in-process import, reversing part of D-21, vs. a separately spawned binary) needs a deliberate decision, not an executor-level one.
- The `GET /features` shape (`FeatureView` with `stage: StageCell`) is now final for this phase and is what Phase 17's dashboard should consume directly rather than re-deriving.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-20*

## Self-Check: PASSED

All key files (`stage-name.ts`, `scheduler/gc-schedule.ts`, `api/routes/gc.ts`,
`render/status-table.ts`, `confirm.ts`, `commands/pause.ts`, `commands/resume.ts`,
`commands/kill.ts`, `commands/gc.ts`, `commands/daemon.ts`,
`test/api/features-view.test.ts`, `test/scheduler/gc-schedule.test.ts`,
`test/status.test.ts`, `test/control-verbs.test.ts`) verified present on disk.
All three task commits (`8a05e08`, `5ff5d94`, `e1e5c83`) verified present in
`git log`.
