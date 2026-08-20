---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 07
subsystem: infra
tags: [hono, zod-validator, kysely, sqlite, concurrency, dispatch, control-plane]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: the dispatcher, worker supervisor, IPC protocol, and HTTP API skeleton (03-01..03-06) this plan adds a cap and controls to
provides:
  - "dispatchOnce enforces a global concurrency cap with an optional per-repository override (D-15..17), inclusive ceiling, FIFO by ULID, drain on lower"
  - "src/control/state.ts — createControlState/isDispatchPaused (D-26), the in-memory dispatch brake, plus applyControlEvent — the shared pause/resume/kill transition-application helper"
  - "POST /features/:id/pause|resume|kill and POST /control/pause|resume|kill (scope feature|repo|all) — D-20's control surface"
  - "src/worker-supervisor/lifecycle.ts — stopWorker/stopAllWorkers, the single soft_stop-then-SIGKILL implementation D-28 (as amended) specifies, shared by gracefulShutdown and adl kill"
  - "the supervisor's onRoundBoundary hook, wired in daemon.ts to park an in-flight feature at its round boundary rather than mid-round"
affects: ["03-08 (adl pause/resume/kill CLI verbs and --all confirmation, D-29)", "phase-6 (the budget gate reuses this plan's 'check before dispatch, never after' cap shape)"]

# Actuals (#2632)
actuals:
  tokens: 22287
  tasks: 3
  commits: 3

tech-stack:
  added: ["@hono/zod-validator@0.9.0"]
  patterns:
    - "dispatchOnce selects via queued.find(...) rather than queued[0]: a candidate blocked by pause or the concurrency cap is skipped, the next-lowest-id candidate is tried, and the tick never reorders past a blocked candidate to favour one repository"
    - "applyControlEvent is the one shared transition-application helper (transition() + version-guarded write + audit event + lease release) reused by pause/resume routes, kill, and the round-boundary park hook — one write path, not three"
    - "kill reuses the pause event/edge (D-27): a killed feature and a maintainer-paused feature are indistinguishable in feature_events except by actor, which is deliberate — paused already has the resume edge back to queued"
    - "optional ApiDeps/FeaturesRouteDeps/ControlRoutesDeps fields (db, controlState, supervisor, workerStopGraceMs, logger), destructured into consts before a presence check, so earlier plans' createApi call sites keep compiling unchanged while daemon.ts always supplies the full set in production"

key-files:
  created:
    - packages/manager/src/control/state.ts
    - packages/manager/src/worker-supervisor/lifecycle.ts
    - packages/manager/src/api/routes/control.ts
    - packages/manager/test/scheduler/dispatcher.test.ts
    - packages/manager/test/control/pause.test.ts
    - packages/manager/test/control/kill.test.ts
    - packages/manager/test/helpers/ignores-stop-worker-entry.ts
  modified:
    - packages/manager/src/scheduler/dispatcher.ts
    - packages/manager/src/worker-supervisor/supervisor.ts
    - packages/manager/src/api/app.ts
    - packages/manager/src/api/routes/features.ts
    - packages/manager/src/boot/shutdown.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts
    - packages/manager/test/helpers/worker-harness.ts
    - packages/manager/package.json

key-decisions:
  - "transition.ts's pause edge is a stateless self-loop from any non-terminal state, including paused itself — applyControlEvent short-circuits when event.t === 'pause' and feature.state === 'paused' rather than relying on InvalidTransition, which the real transition.ts does not produce for this case"
  - "daemon.ts was touched even though it is not in this plan's file list, to keep pnpm -r typecheck / pnpm --filter @adl/manager test green after the intentional ApiDeps/DispatcherDeps/SupervisorDeps signature changes, and to wire pause/kill functionally end to end rather than leaving them provable only at the unit level"
  - "POST /features/:id/kill lives in routes/features.ts (not control.ts) even though pause/resume's feature-scoped routes live in control.ts — matching the plan's own file-list split literally; both share routes/control.ts's exported killFeature helper"
  - "control-level scope='feature' is rejected with 400 on /control/pause|resume|kill, directing the caller to the single-feature route instead — ControlScopeSchema's three-way union is reused for schema simplicity, but only repo|all are meaningful at control scope"

patterns-established:
  - "A limit (concurrency cap, and Phase 6's coming budget) is checked immediately before the state-changing action, never after — dispatchOnce's cap check is the shape Phase 6's budget gate extends rather than restructures"
  - "Lowering a limit (the concurrency cap here; Phase 6's budget will be the same shape) drains: it governs future dispatch only, never revokes something already granted"

requirements-completed: [EXEC-05, OBS-03, OBS-04]

coverage:
  - id: D1
    description: "dispatchOnce enforces a global concurrency cap with an optional per-repository override — inclusive ceiling, in-flight counted from listLeased() (not an in-memory counter), FIFO by lowest queued ULID, and lowering the cap mid-flight drains rather than revoking"
    requirement: "EXEC-05"
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/dispatcher.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /control/pause|resume and POST /features/:id/pause|resume at global, repo, and single-feature scope; an in-flight feature finishes its current round (via the supervisor's onRoundBoundary hook) before parking, never mid-round"
    requirement: "OBS-03"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/pause.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "stopWorker: soft_stop over IPC, graceful exit within the grace window or SIGKILL after it, resolving rather than hanging — exercised against real forked processes on the host platform with no skip"
    requirement: "OBS-04"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/kill.test.ts#stopWorker"
        status: pass
    human_judgment: false
  - id: D4
    description: "POST /features/:id/kill and POST /control/kill (scope feature|repo|all) stop the worker first, then land the feature in paused — never escalated, never left in queued; an all/repo-scoped kill stops every in-flight feature and parks every queued one"
    requirement: "OBS-04"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/kill.test.ts#POST /features/:id/kill, #POST /control/kill"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-08-20
status: complete
---

# Phase 03 Plan 07: Concurrency Cap, Pause/Resume, Kill Summary

**A global-plus-per-repo concurrency cap with drain-on-lower semantics, pause/resume at three scopes with round-boundary parking, and kill via a shared soft_stop-then-SIGKILL helper that lands a stopped feature in `paused`, never `escalated`.**

## Performance

- **Duration:** ~13 min (first commit 06:23:44+02:00, last commit 06:36:20+02:00)
- **Started:** 2026-08-20T06:23:44+02:00
- **Completed:** 2026-08-20T06:36:20+02:00
- **Tasks:** 3
- **Files modified:** 16 (7 created, 9 modified)

## Accomplishments

- `dispatchOnce` enforces a global concurrency cap with an optional per-repository override (D-15..17): an inclusive ceiling (`in-flight >= cap` blocks), in-flight counted from `listLeased()` so a restarted daemon counts correctly, FIFO selection by the lowest queued ULID, and lowering the cap mid-flight drains rather than revoking any held lease
- `src/control/state.ts`: `createControlState`/`isDispatchPaused` (D-26) — the dispatch brake, held in memory only — plus `applyControlEvent`, the one shared transition-application helper (transition + version-guarded write + audit event + lease release) every pause/resume/kill call site reuses
- `POST /features/:id/pause|resume` and `POST /control/pause|resume` (scope `feature`|`repo`|`all`) in `api/routes/control.ts`, `zValidator` applied per route
- The supervisor gains an `onRoundBoundary` hook, fired on an accepted `stage_result`; `daemon.ts` wires it to `parkOnRoundBoundary`, which transitions an in-flight feature to `paused` right at that boundary if dispatch is paused for its repository — never mid-round
- `worker-supervisor/lifecycle.ts`: `stopWorker`/`stopAllWorkers` — the single soft_stop-then-SIGKILL implementation (D-28 as amended: no `SIGTERM`, ever). `boot/shutdown.ts` was refactored to call it instead of keeping a parallel copy, so `gracefulShutdown` and `adl kill` cannot drift apart
- `POST /features/:id/kill` (`routes/features.ts`) and `POST /control/kill` (`routes/control.ts`, scope `repo`|`all`) both call the shared `killFeature`: stop the worker first, then transition to `paused` (D-27) — never `escalated`, never left in `queued`. An `all`/`repo`-scoped kill stops every in-flight feature and parks every queued one
- `test/control/kill.test.ts` exercises `stopWorker`'s graceful and forced paths against real forked processes, with a new "ignores soft_stop" worker double (`test/helpers/ignores-stop-worker-entry.ts`) proving the forced path SIGKILLs after the grace period and resolves rather than hanging — no platform skip

## Task Commits

Each task was committed atomically:

1. **Task 1: The concurrency cap — inclusive ceiling, FIFO by ULID, drain on lower** - `31b6bfe` (feat)
2. **Task 2: Pause and resume — a brake on new work, not a kill** - `c810702` (feat)
3. **Task 3: Kill — soft stop over IPC, then SIGKILL, and the feature lands in paused** - `8963a13` (feat)

**Plan metadata:** (this commit, following SUMMARY.md)

## Files Created/Modified

- `packages/manager/src/scheduler/dispatcher.ts` - concurrency cap (global + per-repo), `isDispatchPaused` consulted per candidate
- `packages/manager/src/control/state.ts` - `createControlState`, `isDispatchPaused`, `applyControlEvent`, `parkOnRoundBoundary`
- `packages/manager/src/worker-supervisor/supervisor.ts` - `onRoundBoundary` hook fired on an accepted `stage_result`
- `packages/manager/src/worker-supervisor/lifecycle.ts` - `stopWorker`, `stopAllWorkers`, `StopOutcome`
- `packages/manager/src/api/routes/control.ts` - `ControlScopeSchema`, `PauseRequestSchema`, `KillRequestSchema`, `ControlResultSchema`, `killFeature`, `registerControlRoutes`
- `packages/manager/src/api/routes/features.ts` - `POST /features/:id/kill`
- `packages/manager/src/api/app.ts` - `ApiDeps` extended with `db`/`controlState`/`supervisor`/`workerStopGraceMs`/`logger`, all optional
- `packages/manager/src/boot/shutdown.ts` - refactored to call `stopAllWorkers` rather than a local copy
- `packages/manager/src/daemon.ts` - wires `controlState`, `onRoundBoundary`, and the full `createApi`/`dispatchOnce` dependency set
- `packages/manager/src/index.ts` - barrel exports for `control/state.ts`, `routes/control.ts`, `worker-supervisor/lifecycle.ts`
- `packages/manager/test/scheduler/dispatcher.test.ts` - the concurrency cap's behavior surface
- `packages/manager/test/control/pause.test.ts` - pause/resume at three scopes, the round-boundary park
- `packages/manager/test/control/kill.test.ts` - `stopWorker`'s graceful/forced/already-gone outcomes, kill's HTTP surface, `shutdown.ts`'s reuse of `lifecycle.ts`
- `packages/manager/test/helpers/ignores-stop-worker-entry.ts`, `test/helpers/worker-harness.ts` - the new "ignores soft_stop" scripted worker double
- `packages/manager/package.json` - `@hono/zod-validator@0.9.0` added (compatible with `hono@4.13.2`, `zod@4.4.3` per npm registry `peerDependencies`)

## Decisions Made

- `transition.ts`'s `pause` edge is drawn from *every* non-terminal state, including `paused` itself, as a stateless self-loop — not an `InvalidTransition`. `applyControlEvent` special-cases `event.t === 'pause' && feature.state === 'paused'` to a no-op short-circuit, because the plan's acceptance criterion ("pausing an already-paused feature responds successfully and reports zero changed") does not hold if the generic helper is allowed to write a redundant `paused -> paused` audit event.
- `POST /features/:id/kill` lives in `routes/features.ts`, not `routes/control.ts`, matching the plan's own task-level file-list split literally (Task 2 grouped feature-scoped pause/resume into `control.ts`; Task 3 lists both `control.ts` and `features.ts`). Both share `routes/control.ts`'s exported `killFeature` so the stop-then-transition sequence is one implementation.
- Control-level `scope: 'feature'` on `/control/pause|resume|kill` is rejected with 400, directing the caller to the single-feature route — `ControlScopeSchema`'s three-way union is reused across both request schemas for simplicity, but only `repo`/`all` are meaningful once already at control scope.
- `ApiDeps`/`FeaturesRouteDeps`/`ControlRoutesDeps` gained new fields as *optional*, not required, specifically so the tracer suite's and fencing suite's existing `createApi(...)` call sites (outside this plan's file list) keep compiling unchanged. `daemon.ts` always supplies the full set in production.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `daemon.ts` updated to wire the new dependencies, though not in this plan's file list**
- **Found during:** Task 2 (pause/resume)
- **Issue:** `createApi`'s, `dispatchOnce`'s, and `createSupervisor`'s dependency shapes all changed in intentional, plan-described ways (a `controlState` brake, an `onRoundBoundary` hook). `daemon.ts` is the one production call site for all three and was not in the plan's `files_modified` list, but leaving it unchanged would have broken `pnpm -r typecheck` and `pnpm --filter @adl/manager test` (the tracer suite calls `startDaemon`), and would have left pause/kill provable only at the unit level rather than functioning end to end — directly relevant to the plan's own must-have truth about pause parking in-flight work.
- **Fix:** `daemon.ts` now constructs one `ControlState` per daemon process, wires the supervisor's `onRoundBoundary` hook to `parkOnRoundBoundary`, passes `controlState` through to `dispatchOnce`, and passes `db`/`controlState`/`supervisor`/`workerStopGraceMs`/`logger` through to `createApi`.
- **Files modified:** `packages/manager/src/daemon.ts`
- **Verification:** `pnpm -r typecheck` and `pnpm --filter @adl/manager test` (115 tests) both pass; `test/control/pause.test.ts`'s round-boundary test exercises this wiring indirectly by constructing the same hook shape directly against a real forked worker.
- **Committed in:** `c810702` (Task 2)

**2. [Rule 3 - Blocking] `@hono/zod-validator` added as a new dependency**
- **Found during:** Task 2 (pause/resume routes)
- **Issue:** The plan's own `03-RESEARCH.md` cites `zValidator` from `@hono/zod-validator` as the per-route validation pattern, but the package was not yet a dependency of `@adl/manager`.
- **Fix:** Added `@hono/zod-validator@0.9.0`, verified against the npm registry as compatible with `hono@4.13.2` (peer `>=4.11.2`) and `zod@4.4.3` (peer `^3.25.0 || ^4.0.0`) before installing — this is the official Hono middleware monorepo package the phase's own research already names, not a substitution.
- **Files modified:** `packages/manager/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm install`, `pnpm -r typecheck` clean.
- **Committed in:** `c810702` (Task 2)

---

**Total deviations:** 2 auto-fixed (2 blocking — an intentional API-signature ripple and a plan-cited-but-not-yet-installed dependency)
**Impact on plan:** Both were necessary to keep the build/test suite green and to deliver the plan's stated functionality end to end. No scope creep — no capability was added beyond what Tasks 1-3 specify.

## Issues Encountered

- `transition.ts`'s `pause` event turned out to be a self-loop from every non-terminal state rather than a rejection from `paused` — see "Decisions Made" above. Caught by the plan's own acceptance test for re-pausing an already-paused feature; fixed inline before the Task 2 commit (not a separate deviation entry, since it was fixed within the same task's normal TDD-style iteration, not discovered after the commit).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `03-08` can build `adl pause`/`adl resume`/`adl kill` CLI verbs directly against this plan's HTTP surface, including the interactive `--all` confirmation D-29 requires (deliberately not enforced server-side, since a scripted client and a future dashboard are both legitimate callers).
- Phase 6's budget gate can extend `dispatchOnce`'s cap-check shape (checked immediately before the lease is acquired, never after) rather than restructuring the dispatch path.
- **Flagged assumptions carried forward, unresolved by this plan (see plan frontmatter):** OBS-03's global pause is held in memory only — a daemon restart resumes dispatch; a persisted pause would need a `meta` row and a boot-time read. OBS-04's `all`-scope kill reading ("stops what is running, parks what is waiting") is an assumption, not a stated requirement — the alternative (stop only what is in flight, leave the queue intact) is equally consistent with the requirement text.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-20*

## Self-Check: PASSED

All key files (`control/state.ts`, `worker-supervisor/lifecycle.ts`,
`api/routes/control.ts`, `test/scheduler/dispatcher.test.ts`,
`test/control/pause.test.ts`, `test/control/kill.test.ts`,
`test/helpers/ignores-stop-worker-entry.ts`) verified present on disk. All
three task commits (`31b6bfe`, `c810702`, `8963a13`) verified present in
`git log`.
