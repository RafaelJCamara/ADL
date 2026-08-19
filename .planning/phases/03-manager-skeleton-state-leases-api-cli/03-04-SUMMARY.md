---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 04
subsystem: infra
tags: [hono, child-process-fork, ipc, zod, bearer-auth, commander, tracer]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 02)
    provides: "featuresRepository.acquireLease/renewLease and nowIso — the lease queue this plan's dispatcher drives"
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 03)
    provides: "forkWorker from @adl/workspace — the manager→worker fork() seam this plan's supervisor uses"
provides:
  - "packages/manager/src/ipc/protocol.ts — the Zod-validated worker<->manager IPC contract (WorkerToManagerMessage, ManagerToWorkerMessage, IPC_MESSAGE_KINDS, parseWorkerMessage/parseManagerMessage)"
  - "packages/manager/src/worker-entry/index.ts — runWorker(deps), the forked process's own main, with an injected StageRunner (D-30) and no @adl/db in its dependency graph"
  - "packages/manager/src/worker-supervisor/supervisor.ts — createSupervisor, the manager's half of the fork() relationship: piped stdio, a pino child logger, and heartbeat-driven renewLease calls"
  - "packages/manager/src/scheduler/dispatcher.ts — dispatchOnce, the lease-acquire-and-transition sequence every dispatch attempt runs"
  - "packages/manager/src/api/app.ts + routes/{health,features}.ts — the Hono API with bearer auth (option-b: GET /health unauthenticated, everything else token-gated with crypto.timingSafeEqual)"
  - "packages/manager/src/daemon.ts — startDaemon/stopDaemon, the wiring a later plan (03-06/03-07) extends rather than restructures"
  - "packages/cli/src/http-client.ts + commands/status.ts + index.ts — daemonClient, statusCommand, and a commander program with a global --config flag"
  - "eslint.config.js's adl/worker-entry-no-db rule — @adl/db is now a lint-time ban under packages/manager/src/worker-entry/**, not just a structural pnpm guarantee"
affects: [03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 22800
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Manager<->worker IPC as two Zod discriminated unions + a frozen IPC_MESSAGE_KINDS list paired with a compile-time Exclude<> exhaustiveness assertion, mirroring FEATURE_EVENT_KINDS exactly"
    - "parseWorkerMessage/parseManagerMessage return {ok:false, reason} rather than throw — an unparseable IPC message is treated as an infrastructure failure (CORE-06's discipline), never trusted data"
    - "The forked worker's own StageRunner is injected (D-30): the real worker-entry module IS the test double's entry point, with only the thing that would call an agent swapped out — no --fake flag, no env-selected runner"
    - "A scripted worker-entry test double lives in test/helpers/ as a real TypeScript module, forked with execArgv: ['--import', 'tsx'] — no build step needed in the test loop, verified empirically to run correctly via Node's ancestor node_modules resolution"
    - "dispatchOnce writes the state transition (compareAndSwapState + appendEvent) and the effective_config_json snapshot in one db.transaction(), separate from acquireLease's own already-atomic guarded UPDATE"
    - "Bearer middleware compares with crypto.timingSafeEqual against a same-length decoy buffer when lengths differ, so a length mismatch is not itself a timing signal"
    - "A new architectureConfigs entry that reconfigures no-restricted-imports for a glob already matched by adl/no-direct-spawn must re-merge FORBIDDEN_SPAWN into its own paths list, or it silently lifts the spawn ban for that glob (flat config replaces per rule id, 02-RESEARCH.md Pitfall 1)"

key-files:
  created:
    - packages/manager/src/ipc/protocol.ts
    - packages/manager/src/worker-entry/index.ts
    - packages/manager/src/worker-supervisor/supervisor.ts
    - packages/manager/src/scheduler/dispatcher.ts
    - packages/manager/src/api/app.ts
    - packages/manager/src/api/routes/health.ts
    - packages/manager/src/api/routes/features.ts
    - packages/manager/src/daemon.ts
    - packages/manager/test/helpers/ephemeral-port.ts
    - packages/manager/test/helpers/worker-harness.ts
    - packages/manager/test/helpers/scripted-worker-entry.ts
    - packages/manager/test/tracer/end-to-end.test.ts
    - packages/cli/src/http-client.ts
    - packages/cli/src/commands/status.ts
    - test/lint/fixtures/worker-entry-imports-db.ts
  modified:
    - packages/manager/src/index.ts
    - packages/manager/package.json
    - packages/cli/src/index.ts
    - packages/cli/package.json
    - eslint.config.js
    - test/lint/no-restricted-imports.test.ts
    - pnpm-lock.yaml
    - packages/db/src/repository/features.ts (formatting only)
    - packages/db/test/lease.test.ts (formatting only)
    - packages/db/test/pragmas.test.ts (formatting only)
    - packages/db/test/repos-meta.test.ts (formatting only)
    - packages/workspace/test/contract/workspace-contract.test.ts (formatting only)

key-decisions:
  - "Task 1 checkpoint (bearer-token generation/storage/health-exemption) was pre-resolved by the human maintainer before this dispatch: option-b — a daemon-generated token in .adl/daemon.json, with GET /health unauthenticated and returning only { status, schemaVersion }. This plan implements the token-comparison half (timingSafeEqual, the exactly-one-exemption test); the config-file generation and .adl/daemon.json I/O is 03-06's job (loadDaemonConfig), consistent with 03-06-PLAN.md's own file list already naming packages/manager/src/config/daemon-config.ts."
  - "All manager-side test assertions (IPC parsing, dispatchOnce, createApi, the down-daemon CLI case, and the tracer) live in one file, packages/manager/test/tracer/end-to-end.test.ts, matching the plan's files_modified list literally rather than splitting into several test files the plan did not name."
  - "The CLI's status command is exercised in-process from the manager's own test file via a relative import into packages/cli/src (../../../cli/src/http-client.js, .../commands/status.js) rather than adding @adl/cli as a package.json devDependency of @adl/manager — mirrors the plan's own precedent of reusing packages/db/test/helpers/temp-db.ts by relative import across a package boundary, and avoids adding a dependency edge in either direction."
  - "The scripted worker-entry test double is forked with execArgv: ['--import', 'tsx'] rather than requiring a pre-test tsc build — empirically verified (node --import tsx <file>.ts, then a real forkWorker() call) to run correctly, and Node's ancestor-directory node_modules resolution finds the repo-root tsx devDependency from any package's test directory with no per-package tsx dependency needed."
  - "kysely (0.29.5, already pinned via @adl/db) was added as a direct @adl/manager dependency, and picocolors (1.1.1, already in the lockfile via prettier) as a direct @adl/cli dependency — both at their already-vetted pinned versions, needed because pnpm's strict node_modules requires a direct listing to import either type/module."
  - "adl/worker-entry-no-db's no-restricted-imports rule set merges FORBIDDEN_SPAWN into its own paths list alongside the new @adl/db ban, rather than naming @adl/db alone — omitting the merge would have silently cleared the spawn ban for packages/manager/src/worker-entry/** the moment this entry landed, since adl/no-direct-spawn also matches that glob and flat config replaces (not merges) per rule id for an overlapping glob."

requirements-completed: [EXEC-01, EXEC-02, OBS-01]

coverage:
  - id: D1
    description: "A single queued feature is picked up by the daemon, leased, handed to a real forked worker process, and adl status --json against the running daemon reports that feature with its id, state, round, and stage index — with no AI anywhere in the loop"
    requirement: EXEC-02
    verification:
      - kind: integration
        ref: "packages/manager/test/tracer/end-to-end.test.ts#tracer: a queued feature is leased by a real forked worker and appears in adl status > travels dispatch -> lease -> real forked process -> IPC heartbeat -> manager write -> HTTP -> CLI, and stopping the daemon leaves no child process running"
        status: pass
    human_judgment: false
  - id: D2
    description: "The worker never opens the database: heartbeat_at moves because the manager wrote it in response to an IPC message, and @adl/db is unresolvable from the worker entry module"
    requirement: EXEC-02
    verification:
      - kind: integration
        ref: "packages/manager/test/tracer/end-to-end.test.ts (same tracer case — asserts heartbeat_at advances at least twice via the manager's own db write, driven entirely by IPC heartbeat messages)"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#the worker-entry @adl/db ban is scoped to worker-entry, not the whole package (03-04) — plus the FIXTURES-loop row for test/lint/fixtures/worker-entry-imports-db.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "A request to the API without the configured bearer token is rejected, and the server binds a loopback address rather than all interfaces"
    requirement: OBS-01
    verification:
      - kind: unit
        ref: "packages/manager/test/tracer/end-to-end.test.ts#createApi > GET /features without the bearer token responds 401; with it responds 200 and a JSON array"
        status: pass
      - kind: unit
        ref: "packages/manager/test/tracer/end-to-end.test.ts#createApi > binds a loopback address, not 0.0.0.0"
        status: pass
    human_judgment: false
  - id: D4
    description: "The IPC message union is Zod-validated on receipt; a message that does not parse is rejected and logged rather than acted on"
    requirement: EXEC-01
    verification:
      - kind: unit
        ref: "packages/manager/test/tracer/end-to-end.test.ts#parseWorkerMessage (4 tests: valid kinds, unknown t, missing leaseToken, non-object payload)"
        status: pass
    human_judgment: false
  - id: D5
    description: "adl status --json against a live daemon reports the feature; against no daemon it exits non-zero with D-25's exact message"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "packages/manager/test/tracer/end-to-end.test.ts#adl status --json against a stopped daemon (2 tests) and the tracer case's CLI-in-process assertion"
        status: pass
    human_judgment: false

duration: 95min
completed: 2026-08-19
status: complete
---

# Phase 3 Plan 04: Manager Skeleton Tracer — Dispatch, Lease, Fork, IPC, API, CLI Summary

**The thinnest real end-to-end slice through every layer Phase 3 touches: a queued feature is dispatched by `dispatchOnce`, leased through `@adl/db`'s optimistic-concurrency guard, handed to a genuinely separate `fork()`'d worker process that heartbeats over a Zod-validated IPC channel, and shown by `adl status --json` through a bearer-authenticated Hono API — proven by one real, non-mocked, cross-process integration test.**

## Performance

- **Duration:** ~95 min
- **Started:** 2026-08-19T16:30:00Z (approx — worktree provisioned and context-read began here)
- **Completed:** 2026-08-19T18:05:00Z (approx)
- **Tasks:** 3 (Task 1 pre-resolved checkpoint; Tasks 2-3 executed this dispatch)
- **Files modified:** 27 (20 created, 7 modified — 5 of the 7 modifications are formatting-only on pre-existing files)

## Accomplishments

- `packages/manager/src/ipc/protocol.ts`: the full worker<->manager IPC contract as two Zod discriminated unions (`ready`/`heartbeat`/`stage_result`/`fatal` and `assign`/`soft_stop`/`lease_lost`), `IPC_MESSAGE_KINDS` with a compile-time exhaustiveness assertion, and `parseWorkerMessage`/`parseManagerMessage` that return a discriminated result rather than throwing.
- `packages/manager/src/worker-entry/index.ts`: the forked process's own main. `runWorker(deps)` takes an injected `StageRunner` (D-30) — accepts exactly one `assign` per process lifetime, starts a heartbeat interval, self-terminates on `soft_stop`, `lease_lost`, or a dead IPC channel, and the bottom-of-file `main()` (guarded by an entry-point check) builds the production stage runner, which honestly reports "no agent backend configured in this phase". Does not import `@adl/db` — enforced by Task 3's lint rule, not merely intended.
- `packages/manager/src/worker-supervisor/supervisor.ts`: `createSupervisor` forks via `@adl/workspace`'s `forkWorker` (never `node:child_process` directly), pipes stdio into a pino child logger, drops unparseable IPC messages at `warn` with no repository call, and calls `renewLease` on every heartbeat — the D-06 fence is enforced by `renewLease`'s own `WHERE lease_token = ?` predicate, so the supervisor delegates the staleness decision to SQL rather than re-deriving it.
- `packages/manager/src/scheduler/dispatcher.ts`: `dispatchOnce` selects the oldest queued feature (FIFO by ULID), acquires its lease, snapshots `effective_config_json` via `mergeConfig(DEFAULT_CONFIG, daemonConfig, resolveAdlYml(feature))`, and writes the guarded state update plus the `FeatureEventEffect` from `transition()` in one DB transaction before handing the feature to the supervisor.
- `packages/manager/src/api/app.ts` + `routes/health.ts` + `routes/features.ts`: a Hono app with bearer middleware implementing Task 1's pre-resolved option-b — `GET /health` is the one unauthenticated route (`UNAUTHENTICATED_PATHS`, asserted to have exactly one entry), returning only `{ status, schemaVersion }`; every other route requires `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` against a same-length decoy on a length mismatch.
- `packages/manager/src/daemon.ts`: `startDaemon`/`stopDaemon` wire the database, supervisor, dispatcher, and API together, accept port `0` for ephemeral test binding, and `stop()` SIGKILLs every active worker (waiting for its `exit` event) before closing the HTTP server and destroying the DB handle — the tracer test asserts no child process survives.
- `packages/cli/src/http-client.ts` + `commands/status.ts` + `index.ts`: `daemonClient` (D-25's exact down-daemon message, `DaemonUnreachableError`), `statusCommand` (`--json` or a `picocolors` table), and a commander program with a global `--config <path>` flag, built via a testable `buildProgram(deps)` seam.
- `eslint.config.js`'s new `adl/worker-entry-no-db` rule: `@adl/db` and `@adl/db/*` are now a lint-time ban under `packages/manager/src/worker-entry/**`, with a deliberate-violation fixture and a scoping test proving `packages/manager/src/api/app.ts` — which legitimately reaches the database — still lints clean.
- One real, cross-process integration test (`packages/manager/test/tracer/end-to-end.test.ts`) proves the whole path: a real `fork()`'d worker (via `tsx`, no build step), a real IPC handshake, `heartbeat_at` observed to advance at least twice through two independent DB connections, the HTTP API, and `adl status --json` in-process — then asserts `processIsAlive(pid)` is `false` after `stop()`.

## Task Commits

Each task was committed atomically:

1. **Task 1: How the control plane's bearer token is generated, stored, and checked** — pre-resolved by the human maintainer before this dispatch (option-b: daemon-generated token in `.adl/daemon.json`, `GET /health` unauthenticated). No file changes attributable to Task 1 alone; the token-comparison and health-exemption implementation is folded into Task 2's commits below.
2. **Task 2: End-to-end — a queued feature is leased by a real forked worker and appears in `adl status`** — `c0fe262` (test, RED: the failing tracer + support test files) and `2a695a9` (feat, GREEN: the full manager/CLI implementation)
3. **Task 3: The worker entry cannot reach the database — enforced, not intended** — `9b91451` (feat)

Plus one deviation commit: `cc43c9e` (style) — pre-existing prettier violations from 03-02/03-03 that blocked this plan's own `pnpm format` acceptance criterion (see Deviations below).

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

## TDD Gate Compliance

Task 2 carried `tdd="true"`. Gate sequence present in git log:
1. RED — `c0fe262` `test(03-04): add failing tracer test for manager skeleton` (test files only; the modules under test did not exist yet)
2. GREEN — `2a695a9` `feat(03-04): manager skeleton — IPC, worker entry, dispatcher, API, CLI status` (all 21 tests pass)

No REFACTOR commit — the implementation passed on the first full run with no post-green cleanup needed.

## Files Created/Modified

- `packages/manager/src/ipc/protocol.ts` — the IPC contract, `IPC_MESSAGE_KINDS`, `parseWorkerMessage`/`parseManagerMessage`
- `packages/manager/src/worker-entry/index.ts` — `runWorker`, `WorkerDeps`, `StageRunner`, `StageRunnerResult`, the module's own `main`
- `packages/manager/src/worker-supervisor/supervisor.ts` — `createSupervisor`, `WorkerSupervisor`, `SupervisorDeps`, `ActiveWorker`, `WorkerReady`
- `packages/manager/src/scheduler/dispatcher.ts` — `dispatchOnce`, `DispatcherDeps`, `DispatchDecision`, `SpawnCall`
- `packages/manager/src/api/app.ts` — `createApi`, `ApiDeps`, `UNAUTHENTICATED_PATHS`
- `packages/manager/src/api/routes/health.ts` — `registerHealthRoute`
- `packages/manager/src/api/routes/features.ts` — `registerFeaturesRoute`, `FeatureView`
- `packages/manager/src/daemon.ts` — `startDaemon`, `stopDaemon`, `DaemonHandle`, `StartDaemonOptions`
- `packages/manager/src/index.ts` — barrel: re-exports the daemon lifecycle, `createApi`, the supervisor, the dispatcher, and the IPC contract; deliberately does not export worker-entry internals
- `packages/manager/test/helpers/ephemeral-port.ts` — `withEphemeralPort`
- `packages/manager/test/helpers/worker-harness.ts` — `withScriptedWorker`, `scriptedWorkerEntry`
- `packages/manager/test/helpers/scripted-worker-entry.ts` — the forked double, importing the real `runWorker`
- `packages/manager/test/tracer/end-to-end.test.ts` — all Plan 04 behaviour assertions (protocol, dispatcher, API, CLI-down-daemon, and the tracer case)
- `packages/cli/src/http-client.ts` — `daemonClient`, `DaemonClient`, `DaemonUnreachableError`, `daemonDownMessage`
- `packages/cli/src/commands/status.ts` — `statusCommand`, `FeatureRow`, `WriteSink`
- `packages/cli/src/index.ts` — `buildProgram`, `loadCliConfig`, `CliConfig`
- `eslint.config.js` — `adl/worker-entry-no-db` rule set + `WORKER_ENTRY_DB_BAN_MESSAGE`
- `test/lint/fixtures/worker-entry-imports-db.ts` — the deliberate-violation fixture
- `test/lint/no-restricted-imports.test.ts` — the new fixture row + scoping assertions
- `packages/manager/package.json` — added `kysely` dependency
- `packages/cli/package.json` — added `picocolors` dependency
- `pnpm-lock.yaml` — records both new direct dependencies
- `packages/db/src/repository/features.ts`, `packages/db/test/lease.test.ts`, `packages/db/test/pragmas.test.ts`, `packages/db/test/repos-meta.test.ts`, `packages/workspace/test/contract/workspace-contract.test.ts` — formatting only (see Deviations)

## Decisions Made

See `key-decisions` in the frontmatter — five decisions, covering the Task 1 checkpoint resolution, the single-test-file structure, the cross-package relative-import test strategy for the CLI, the `tsx`-forked test double, and the two dependency additions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `kysely` as a direct `@adl/manager` dependency**
- **Found during:** Task 2 (writing `dispatcher.ts`/`daemon.ts`, which type against `Kysely<Database>`)
- **Issue:** `pnpm --filter @adl/manager typecheck` failed with `Cannot find module 'kysely'` — pnpm's strict `node_modules` requires a direct dependency listing, and `@adl/manager`'s `package.json` did not list it even though `@adl/db` (a dependency) already uses it internally.
- **Fix:** Added `"kysely": "0.29.5"` to `packages/manager/package.json` — the exact version already pinned via `@adl/db`, not a new external package.
- **Files modified:** `packages/manager/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm --filter @adl/manager typecheck` exits 0.
- **Committed in:** `2a695a9` (Task 2 GREEN commit)

**2. [Rule 3 - Blocking] Added `picocolors` as a direct `@adl/cli` dependency**
- **Found during:** Task 2 (writing `commands/status.ts`, which the plan's own action explicitly directs to "keep the table at the `picocolors` level of formatting")
- **Issue:** `picocolors` was not listed in `@adl/cli`'s `package.json`, so importing it would fail to resolve under pnpm's strict `node_modules`.
- **Fix:** Added `"picocolors": "1.1.1"` — the exact version already present in the lockfile as a transitive dependency of `prettier`, not a new external package.
- **Files modified:** `packages/cli/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm --filter @adl/cli typecheck` exits 0.
- **Committed in:** `2a695a9` (Task 2 GREEN commit)

**3. [Rule 3 - Blocking] Formatted 5 pre-existing files to satisfy this plan's own `pnpm format` acceptance criterion**
- **Found during:** the plan's own verification step (`pnpm format` after Tasks 2-3 landed)
- **Issue:** `packages/db/src/repository/features.ts`, `packages/db/test/lease.test.ts`, `packages/db/test/pragmas.test.ts`, `packages/db/test/repos-meta.test.ts`, and `packages/workspace/test/contract/workspace-contract.test.ts` — all landed by `03-02`/`03-03`, none touched by this plan's own behaviour changes — were already failing `prettier --check` before this dispatch started. This plan's own acceptance criteria require `pnpm format` to exit `0` repository-wide.
- **Fix:** Ran `prettier --write` on exactly those 5 files. `git diff` confirms whitespace/line-wrap only, no logic change (verified by inspection of each diff).
- **Files modified:** the 5 files listed above.
- **Verification:** `pnpm format` exits 0 repository-wide; `@adl/db` (71 tests) and `@adl/workspace` (214 passed, 4 skipped) both still green after the formatting change.
- **Committed in:** `cc43c9e` (separate `style` commit, kept out of the `feat` commits so the diff is easy to audit as formatting-only)

---

**Total deviations:** 3 auto-fixed (2 missing dependencies, 1 blocking format issue on pre-existing files)
**Impact on plan:** All three were necessary to make this plan's own stated acceptance criteria true. No scope creep — both new dependencies are already-vetted, already-pinned packages elsewhere in the monorepo, and the formatting fix touches no logic.

## Issues Encountered

- No `node_modules` existed in this worktree at dispatch start (a fresh linked worktree, distinct from the main repo's tree) — `corepack pnpm install` was required before any `tsc`/`vitest`/`eslint` command would resolve `@adl/*` packages or third-party dependencies correctly. Running it created a local, worktree-scoped `node_modules` linked from the shared pnpm content-addressable store (fast, no re-download), rather than accidentally resolving ancestor-directory `node_modules` belonging to the main repo (which Node's resolution algorithm would otherwise have silently done, since this worktree lives at `.claude/worktrees/<id>/` inside the main repo's own directory tree).
- Forking a real `.ts` worker-entry module in tests (rather than a pre-built `.js`) was a genuinely open question at plan-read time — resolved by empirically verifying `node --import tsx <file>.ts` runs correctly (including a live IPC channel via a real `forkWorker()` call) before committing to the design, rather than assuming it would work.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `03-05` (reaper, fencing, crash recovery) can extend `dispatcher.ts`, `supervisor.ts`, and `worker-entry/index.ts` directly — all three are real, tested modules, not scaffolding.
- `03-06` (daemon config, schema-version gate, repo reconciliation) has a `startDaemon` to extend: `daemonConfig`/`resolveAdlYml` are already parameters, so wiring `loadDaemonConfig` in is a call-site change, not a restructure. The `.adl/daemon.json` token-file generation Task 1's checkpoint decided is still open — `03-06`'s own file list already anticipates it.
- `03-07` (HTTP surface completion, pause/kill) extends `api/app.ts`/`routes/` with `POST /features/:id/pause|kill` and `/control/*` behind the same bearer middleware.
- `03-08` (`adl` CLI verb completion) extends `packages/cli/src/index.ts`'s `buildProgram` with `pause`/`resume`/`kill`/`gc`/`daemon` subcommands beside the existing `status`.
- No blockers for the rest of Phase 3's plans.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-19*

## Self-Check: PASSED

All 15 created/modified source and test files verified present via `git ls-files`. All four task commit hashes (`c0fe262`, `2a695a9`, `9b91451`, `cc43c9e`) verified present in git history via `git cat-file -t`.
