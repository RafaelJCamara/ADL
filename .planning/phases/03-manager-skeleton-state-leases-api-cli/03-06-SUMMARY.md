---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 06
subsystem: infra
tags: [zod, kysely, sqlite, pino, daemon-lifecycle, process-supervision]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: dispatcher, reaper, fencing, and crash-recovery policy (03-01..03-05) that the boot sequence and shutdown path build on
provides:
  - "DaemonConfigSchema extended in @adl/core with lease_ttl_ms, heartbeat_interval_ms, worker_stop_grace_ms, concurrency, api, gc, and repos"
  - "loadDaemonConfig/ensureDaemonConfig — the operator's daemon config file, zero-config first run, owner-only file permissions"
  - "runStartupGate — refuses a newer schema, copies-then-migrates an older/unseeded one, never deletes a copy"
  - "reconcileRepos — daemon config repos[] upserted into the repos table, never deletes a row absent from config"
  - "killBootOrphans — PID+process-start-time attributed boot-time orphan kill, Windows-degrades safely"
  - "gracefulShutdown/stopWorkerGracefully — soft_stop over IPC then SIGKILL after worker_stop_grace_ms, shared with a future adl kill"
  - "startDaemon wires the full D-37 boot order: schema gate -> reconcileRepos -> killBootOrphans -> expireAllLeasesAtBoot -> dispatch"
affects: [03-07 (adl kill reuses stopWorkerGracefully), phase-4 (transcripts extend EXEC-06's restart-survival proof)]

# Actuals (#2632)
actuals:
  tokens: 24885
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Daemon config is a separate JSON file from repo adl.yml, sharing DaemonConfigSchema (one schema, no clone) but authoritative over daemon-only fields with no mergeConfig fold"
    - "lease_owner stays a single TEXT column; new semantics are encoded as JSON inside it (encodeLeaseOwner/decodeLeaseOwner) rather than adding a schema column"
    - "Process attribution by PID + boot-relative start time (/proc/<pid>/stat field 22), never PID alone; unavailable-on-Windows degrades to 'not attributable', never to a weaker guarantee"
    - "Startup gate is one function per D-37's fixed order (schema gate, copy-then-migrate, repo reconciliation), called before any other daemon wiring"

key-files:
  created:
    - packages/manager/src/config/daemon-config.ts
    - packages/manager/src/boot/startup.ts
    - packages/manager/src/boot/orphans.ts
    - packages/manager/src/boot/shutdown.ts
    - packages/manager/test/config/daemon-config.test.ts
    - packages/manager/test/boot/startup-gate.test.ts
    - packages/manager/test/boot/orphans.test.ts
    - packages/manager/test/boot/daemon-restart.test.ts
    - packages/core/test/config/daemon-config-schema.test.ts
  modified:
    - packages/core/src/config/effective-config.ts
    - packages/core/src/config/index.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts
    - packages/manager/README.md
    - packages/manager/test/smoke.test.ts
    - packages/manager/test/tracer/end-to-end.test.ts

key-decisions:
  - "Task 1 checkpoint (maintainer decision): DAEMON_SCHEMA_VERSION is derived from the highest applied migration name in packages/db/migrations/, never a hand-maintained constant"
  - "Pre-migration copies are written beside the database as <db-file>.pre-<version>-<timestamp> and are never deleted — disk growth is an accepted, documented operator responsibility"
  - "Boot-time orphan kill only signals a PID when processIsAlive is true AND the recorded process start time matches exactly; any other case (dead, unavailable, mismatch) leaves the process alone and logs why"
  - "Shutdown uses IPC soft_stop then SIGKILL after worker_stop_grace_ms, never an OS SIGTERM, because a Windows forked child ignores SIGTERM and runs no handler"

patterns-established:
  - "Windows degrades visibly, never silently: every platform-gated skip prints an [ADL][SKIPPED][<requirement-id>] line to stderr, and README documents the reduced guarantee"
  - "The pre-migration copy and the schema-version comparison both happen before any other database write in the boot sequence, so a refusal is provably a no-write no-op"

requirements-completed: [EXEC-01, EXEC-06]

coverage:
  - id: D1
    description: "Daemon config file (.adl/daemon.json) extends DaemonConfigSchema in place with lease timing, concurrency, API, GC, and watched-repo fields, enforcing the lease_ttl_ms >= 3x heartbeat_interval_ms rule at parse time"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/core/test/config/daemon-config-schema.test.ts"
        status: pass
      - kind: unit
        ref: "packages/manager/test/config/daemon-config.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Startup gate refuses a newer/invalid schema (writing nothing, verified by file digest) and copies-then-migrates an older or unseeded database before running a single migration statement"
    requirement: "EXEC-06"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/startup-gate.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Watched repositories from the daemon config are reconciled into the repos table at boot; a repo absent from config is left in place, not deleted"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/startup-gate.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Boot orphan kill signals a still-running worker's PID only when its recorded process start time still matches; a mismatch or unavailable start time (Windows) leaves it alone and logs why"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/orphans.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "State, rounds, and usage_events survive a daemon restart with feature_events.seq gap-free and duplicate-free; every dangling lease is recovered to queued at boot (ROADMAP criterion 4)"
    requirement: "EXEC-06"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/daemon-restart.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "gracefulShutdown stops dispatch, gives every worker a real soft_stop grace window before SIGKILL, then closes the server and flushes the logger, on both CI platforms"
    requirement: "EXEC-01"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/orphans.test.ts, packages/manager/test/smoke.test.ts"
        status: pass
    human_judgment: false

duration: unknown (spanned a maintainer-decision checkpoint pause between Task 1 and Task 2)
completed: 2026-08-20
status: complete
---

# Phase 03 Plan 06: Daemon Lifecycle — Config, Startup Gate, Boot Orphan Kill, Graceful Shutdown Summary

**A daemon config file, a startup gate that refuses to open a newer schema and copy-then-migrates an older one, a boot-time orphan kill attributed by PID and process start time, and a graceful shutdown that gives workers a real grace window on both platforms.**

## Performance

- **Duration:** Spanned a maintainer-decision checkpoint (Task 1) between 2026-08-19T18:23 and 2026-08-20T06:03 (wall clock includes the pause awaiting the decision, not active execution time)
- **Started:** 2026-08-19T18:23:18+02:00 (first task commit)
- **Completed:** 2026-08-20T06:03:36+02:00 (last task commit)
- **Tasks:** 3 code tasks completed (Task 2, 3, 4); Task 1 was a `checkpoint:decision` resolved by the maintainer (option-a)
- **Files modified:** 17

## Accomplishments

- Extended `DaemonConfigSchema` in place (`@adl/core`) with `lease_ttl_ms`, `heartbeat_interval_ms`, `worker_stop_grace_ms`, `concurrency`, `api`, `gc`, and `repos` — no duplicate schema, enforced by an identity test
- `loadDaemonConfig`/`ensureDaemonConfig` in `@adl/manager`: zero-config first run (mints a bearer token with `crypto.randomBytes(32)`), owner-only file permissions (`0o600`/`0o700`, documented Windows no-op); reads/writes `.adl/daemon.json` as JSON (the `03-04` checkpoint's locked format, per `daemon-config.ts`'s own docblock — superseding D-36's original YAML-cascade description) via the single `DaemonConfigSchema` re-exported from `@adl/core/config`, never redeclared
- `runStartupGate`: refuses a stored schema newer than `DAEMON_SCHEMA_VERSION` (derived from the highest-numbered migration file, per the Task 1 maintainer decision) or a non-integer version, writing nothing in either case — proven by comparing file digests before/after
- Pre-migration copies are checkpointed (WAL `PASSIVE`) and written beside the database as `<db-file>.pre-<version>-<timestamp>`, kept forever (no delete path exists, by design)
- `reconcileRepos`: watched repos from the daemon config are upserted into the `repos` table; a row absent from config is left in place and logged, never deleted
- `killBootOrphans`: signals a PID only when `processIsAlive` is true **and** the recorded process start time (`/proc/<pid>/stat` field 22) matches exactly; dead, unavailable (Windows), or mismatched cases are all left alone and logged — a Linux-gated test forks a real child with a deliberately wrong start time and asserts it survives
- `gracefulShutdown`/`stopWorkerGracefully`: stops dispatch, sends IPC `soft_stop` to every worker, waits `worker_stop_grace_ms`, `SIGKILL`s anything still alive, closes the HTTP server, destroys the DB handle, flushes the logger — factored so `03-07`'s `adl kill` can share the same escalation
- `daemon.ts` wires the full D-37 boot order into `startDaemon`: schema gate → `reconcileRepos` → `killBootOrphans` → `expireAllLeasesAtBoot` → dispatch; a refusal throws before the API server binds
- `test/boot/daemon-restart.test.ts` proves ROADMAP criterion 4 directly: state, `rounds`, and `usage_events` survive a restart, and `feature_events.seq` is contiguous with no gap or duplicate

## Task Commits

Each task was committed atomically:

1. **Task 2: Extend DaemonConfigSchema and load the daemon config file** - `2296fc8` (feat)
2. **Task 3: The startup gate — refuse newer, copy before migrating, reconcile repositories** - `5388512` (feat)
   - **Deviation fix (Rule 2 - missing critical):** owner-only permissions (`0o600`/`0o700`) on `.adl/daemon.json` - `1e67282` (fix) — T-3-04 in the threat model requires the bearer-token-holding config file to have restricted permissions; this was added as part of closing out Task 3's config-file surface
3. **Task 4: Boot orphan kill by PID and start time, and graceful shutdown** - `d59966b` (feat)

**Plan metadata:** (this commit, following SUMMARY.md)

_Note: Task 1 was a `checkpoint:decision` (gate="blocking") — no code commit; the maintainer's answer (option-a) is recorded in `startup.ts`'s module docblock and directly determined `DAEMON_SCHEMA_VERSION`'s derivation._

## Files Created/Modified

- `packages/core/src/config/effective-config.ts` - `DaemonConfigSchema` extended with lease timing, concurrency, api, gc, repos; `ConcurrencySchema`, `ApiConfigSchema`, `GcConfigSchema`, `WatchedRepoSchema` added; D-02 lease-timing `.refine()` rule
- `packages/manager/src/config/daemon-config.ts` - `loadDaemonConfig`, `ensureDaemonConfig`, `resolveDaemonConfigPath`, `DEFAULT_DAEMON_CONFIG_PATH`, `mintApiToken`, `DaemonConfigError`
- `packages/manager/src/boot/startup.ts` - `runStartupGate`, `reconcileRepos`, `DAEMON_SCHEMA_VERSION`, `resolveMigrationsDir`, `SchemaVersionRefusalError`
- `packages/manager/src/boot/orphans.ts` - `encodeLeaseOwner`/`decodeLeaseOwner`, `readProcessStartTime`, `killBootOrphans`
- `packages/manager/src/boot/shutdown.ts` - `gracefulShutdown`, `stopWorkerGracefully`
- `packages/manager/src/daemon.ts` - `startDaemon` now runs the full boot sequence and calls `gracefulShutdown` on stop; `schemaVersion` option removed in favor of the derived `DAEMON_SCHEMA_VERSION`, `migrationsDir` option added
- `packages/manager/src/index.ts` - barrel exports for the four new modules
- `packages/manager/README.md` - documents daemon config zero-config first run, startup copy/disk-growth behavior, and the Windows orphan-kill degradation
- `packages/manager/test/config/daemon-config.test.ts`, `packages/core/test/config/daemon-config-schema.test.ts`, `packages/manager/test/boot/startup-gate.test.ts`, `packages/manager/test/boot/orphans.test.ts`, `packages/manager/test/boot/daemon-restart.test.ts` - the plan's full test suite
- `packages/manager/test/smoke.test.ts` - barrel-resolution test timeout bumped to 30s (see Deviations)
- `packages/manager/test/tracer/end-to-end.test.ts` - adapted to the `schemaVersion` → `migrationsDir` option change

## Decisions Made

- **Task 1 checkpoint resolved: option-a.** `DAEMON_SCHEMA_VERSION` is derived from the highest applied migration name in `packages/db/migrations/`, never a hand-maintained constant — this is the number every future daemon compares a database's `schema_version` against, and deriving it from the migrations directory means it structurally cannot drift from the code. Pre-migration copies are written beside the database file as `<db-file>.pre-<version>-<timestamp>` and are kept forever (no pruning). This was the maintainer's explicit choice, communicated mid-execution after the checkpoint was surfaced.
- `lease_owner` was extended by JSON-encoding a `{pid, startTime}` record into the existing TEXT column rather than adding a schema column — `git diff --stat packages/db/src/schema.ts` is empty and the schema-drift test still passes.
- The dispatcher (`scheduler/dispatcher.ts`) needed no changes: it still writes the plain `'manager'` descriptive string as `lease_owner` at acquisition time; the real `{pid, startTime}` record is written separately by `recordLeaseOwnerOnReady` in `daemon.ts`, bound to the supervisor's `onReady` hook (the earliest point the manager knows the worker's real OS PID) and fenced by the lease token.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Owner-only permissions on `.adl/daemon.json`**
- **Found during:** Task 3 (startup gate / daemon config)
- **Issue:** The daemon config file holds the control-plane bearer token (`api.token`, T-3-04 in the threat model). Writing it with default permissions would leave a secret world-readable on multi-user POSIX hosts.
- **Fix:** File written with `0o600`, containing directory with `0o700`; documented as a no-op on Windows (no POSIX mode-bit equivalent) with the guidance to protect the containing directory instead.
- **Files modified:** `packages/manager/src/config/daemon-config.ts`, `packages/manager/README.md`
- **Verification:** `[ADL][SKIPPED][T-3-04]` line confirms the POSIX-only assertion is correctly gated on Windows; the assertion itself runs where the platform supports it.
- **Committed in:** `1e67282`

**2. [Rule 1 - Bug] Barrel-resolution smoke test timeout bump**
- **Found during:** Task 4 (wiring `DAEMON_SCHEMA_VERSION` derivation into the barrel's import graph)
- **Issue:** `@adl/manager`'s `index.ts` now transitively imports `./boot/startup.js`, which derives `DAEMON_SCHEMA_VERSION` via `import.meta.resolve('@adl/db')` plus a synchronous directory read at module-load time. This real, one-time work occasionally exceeded the default 5s Vitest timeout under full-parallel-suite contention.
- **Fix:** Bumped `smoke.test.ts`'s barrel-resolution test to a 30s timeout, with a comment explaining why (not a change to the derivation's own deliberately-synchronous shape, per D-37).
- **Files modified:** `packages/manager/test/smoke.test.ts`
- **Verification:** `pnpm --filter @adl/manager test` passes reliably.
- **Committed in:** `d59966b`

**3. [Rule 3 - Blocking] Adapted `tracer/end-to-end.test.ts` to the `schemaVersion` → `migrationsDir` option change**
- **Found during:** Task 4 (removing `StartDaemonOptions.schemaVersion` in favor of the internally-derived `DAEMON_SCHEMA_VERSION`)
- **Issue:** The tracer test's `startDaemon(...)` call still passed `schemaVersion: 7`, a field that no longer exists on `StartDaemonOptions` after Task 4 wired the schema gate — this was a straightforward compile-time break from an intentional API change.
- **Fix:** Removed `schemaVersion`; added `migrationsDir: MIGRATIONS_DIR` pinned to the same source-`.ts` migrations directory the test's own `migrateToLatest` call already applied, so the gate's internal migration call records checksums against identical bytes.
- **Files modified:** `packages/manager/test/tracer/end-to-end.test.ts`
- **Verification:** `pnpm --filter @adl/manager test` passes; tracer suite green.
- **Committed in:** `d59966b`

---

**Total deviations:** 3 auto-fixed (1 missing critical/security, 1 bug/flakiness, 1 blocking/API-adaptation)
**Impact on plan:** All three were necessary for correctness or to keep the suite green after an intentional, plan-described API change (dropping the caller-supplied `schemaVersion` in favor of the derived constant). No scope creep.

## Issues Encountered

- This plan's execution was interrupted mid-Task-4 by a worker/context handoff. On resumption, the executor discovered a different worktree (`worktree-agent-a8034238f19f3ca02`) than the one it was originally spawned in, carrying real, verified commits for Tasks 2 and 3 plus uncommitted Task 4 work matching the plan's file list exactly. The base commit matched the expected orchestrator base (`640a425a`), the branch was in the correct `worktree-agent-*` namespace, and the uncommitted diff was internally coherent with Task 4's action description — so execution continued from that worktree rather than treating the discrepancy as a fatal drift. All verification (test, typecheck, lint, format) was re-run from scratch before committing Task 4, and passed clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- ROADMAP criterion 4 (restart survival) holds, proven directly by `test/boot/daemon-restart.test.ts`.
- `03-07`'s `adl kill` can reuse `stopWorkerGracefully` directly rather than re-deriving the soft_stop/SIGKILL escalation.
- **Flagged assumptions carried forward, unresolved by this plan (see plan frontmatter):** EXEC-01's two-manager-against-one-database scenario has no single-instance guard (accepted for v1, T-3-31 in the threat register); EXEC-06's "transcripts survive restart" clause is treated as satisfied by construction because transcripts don't exist yet (Phase 4 / OBS-02) — a reviewer may want this recorded as partially deferred rather than checked off.
- Operators should be aware (documented in `packages/manager/README.md`) that pre-migration `.pre-*` copies accumulate without bound next to the database file — no pruning tool exists yet.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-20*

## Self-Check: PASSED

All key files and all task/summary commits verified present on `worktree-agent-a8034238f19f3ca02`.
