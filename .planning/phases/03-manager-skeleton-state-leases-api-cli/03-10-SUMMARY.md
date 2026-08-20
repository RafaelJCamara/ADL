---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 10
subsystem: infra
tags: [sqlite, kysely, pause, dispatch, boot-sequence, control-plane]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: "the in-memory dispatch brake and pause/resume/kill control surface (03-07), and the boot sequence's schema-gate/repo-reconciliation order (03-06) this plan's restore step slots into"
provides:
  - "GLOBAL_PAUSE_KEY and a discriminated GlobalPauseResult (absent/valid/invalid) on MetaRepository, mirroring getSchemaVersion's shape"
  - "createControlState(deps) — now requires a ControlStateDeps carrying the db handle; setGlobalPause persists before flipping memory and throws GlobalPausePersistError on a failed write, leaving memory untouched"
  - "restoreGlobalPause(deps) in boot/startup.ts — reads the persisted flag at boot (absent->false silently, valid->its boolean warn-logged if true, invalid->true error-logged with the raw value) and never writes it back"
  - "daemon.ts wires the restore between repo reconciliation and the API bind/first dispatch tick"
  - "POST /control/pause|resume answer 500 naming dispatch unchanged when the persist write fails"
affects: ["phase-6 (any future persisted-flag pattern can reuse the absent/valid/invalid + persist-then-flip shape this plan establishes)"]

# Actuals (#2632)
actuals:
  tokens: 11163
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "A second meta-table flag (global_pause) reuses the discriminated absent/valid/invalid shape getSchemaVersion already established, rather than inventing a new one"
    - "Persist-then-flip: a mutable in-memory flag backed by a database row always writes the row first and only updates memory if the write succeeds — the shape any future persisted control-plane flag should copy"

key-files:
  created:
    - packages/manager/test/control/pause-persistence.test.ts
  modified:
    - packages/db/src/repository/meta.ts
    - packages/db/src/repository/index.ts
    - packages/db/test/repos-meta.test.ts
    - packages/manager/src/control/state.ts
    - packages/manager/src/boot/startup.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/api/routes/control.ts
    - packages/manager/src/index.ts
    - packages/manager/test/control/pause.test.ts
    - packages/manager/test/control/kill.test.ts
    - packages/manager/README.md

key-decisions:
  - "createControlState now takes a required ControlStateDeps (db, optional initialGlobalPause) instead of zero arguments — a constructor that could be built without a database could silently reintroduce G-03-3"
  - "The tracer test seeds its dispatch-eligible feature AFTER the pause request, not before: pauseScope's own synchronous park-the-queue loop would otherwise move a pre-existing queued feature straight to 'paused', making the negative assertion vacuous (it would pass even if the persisted flag did nothing)"
  - "The failed-write tests use a real unmigrated in-memory Kysely handle (createDb(':memory:'), no meta table) rather than a destroyed file handle on the shared temp file — a destroyed second connection to the same WAL-mode file produced EBUSY unlink errors during withTempDb's Windows teardown; the in-memory-no-schema handle produces the same genuine 'no such table: meta' write failure with zero file-locking risk"

requirements-completed: [OBS-03]

coverage:
  - id: D1
    description: "A global adl pause survives a daemon restart: setGlobalPause persists to a meta row before flipping the in-memory brake, and restoreGlobalPause reads it back at boot before the API binds or the first dispatch tick"
    requirement: "OBS-03"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/pause-persistence.test.ts#a daemon paused via POST /control/pause stays paused across a restart, and only adl resume lets it dispatch"
        status: pass
      - kind: unit
        ref: "packages/manager/test/control/pause.test.ts#persists the global_pause meta row on pause, and clears it on resume (G-03-3)"
        status: pass
    human_judgment: false
  - id: D2
    description: "absent boots unpaused (no operator noise); an unreadable stored value boots paused and logs at error with the raw value and the adl resume remedy; a paused stored value logs at warn"
    requirement: "OBS-03"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/pause-persistence.test.ts#restoreGlobalPause"
        status: pass
      - kind: unit
        ref: "packages/db/test/repos-meta.test.ts#metaRepository getGlobalPause/setGlobalPause"
        status: pass
    human_judgment: false
  - id: D3
    description: "The in-memory brake and the persisted row never disagree, including when the write fails: a real persistence failure rejects with GlobalPausePersistError, leaves isGlobalPaused() unchanged, a following dispatchOnce still dispatches, and the matching route answers 500 naming dispatch unchanged"
    requirement: "OBS-03"
    verification:
      - kind: unit
        ref: "packages/manager/test/control/pause-persistence.test.ts#the failed write (G-03-3)"
        status: pass
    human_judgment: false
  - id: D4
    description: "README documents which pause survives a restart (global) and which does not (repo-scoped), and the unreadable-value-boots-paused remedy"
    verification: []
    human_judgment: true
    rationale: "Documentation quality/clarity is a human judgment call, not something a passing test proves"

duration: ~17min
completed: 2026-08-20
status: complete
---

# Phase 03 Plan 10: Persist the Global Pause Flag Across a Daemon Restart (G-03-3) Summary

**A `meta` row (`global_pause`) that `setGlobalPause` writes before it flips the in-memory brake, restored at boot by `restoreGlobalPause` before the API binds or the first dispatch tick — proven end to end by two real `startDaemon` processes sharing one database file.**

## Performance

- **Duration:** ~17 min (first commit 09:37:10+02:00, last commit 09:43:32+02:00; reading/context-gathering preceded that)
- **Started:** 2026-08-20T09:37:10+02:00
- **Completed:** 2026-08-20T09:43:32+02:00
- **Tasks:** 2
- **Files modified:** 12 (1 created, 11 modified)

## Accomplishments

- `packages/db/src/repository/meta.ts`: `GLOBAL_PAUSE_KEY`, a discriminated `GlobalPauseResult` (`absent`/`valid`/`invalid`) mirroring `getSchemaVersion`'s own shape, and `getGlobalPause`/`setGlobalPause` on `MetaRepository`. No migration — this is a new row in the existing key/value `meta` table.
- `packages/manager/src/control/state.ts`: `createControlState` now requires a `ControlStateDeps` (`db`, optional `initialGlobalPause`); `setGlobalPause` returns `Promise<void>`, persists via `metaRepository(db).setGlobalPause` **before** flipping the in-memory flag, and throws the new exported `GlobalPausePersistError` (carrying the underlying cause via the standard `Error` `cause` option) on a failed write, leaving memory untouched.
- `packages/manager/src/boot/startup.ts`: `restoreGlobalPause(deps)` reads the persisted flag and resolves it into the boot-time seed — `absent` to `false` silently, `valid` to its boolean (`warn`-logged if `true`), `invalid` to `true` (`error`-logged with the raw value) — read-only, never writing the row back. Placed after `reconcileRepos`, matching its deps/export shape.
- `packages/manager/src/daemon.ts`: awaits `restoreGlobalPause({ db, logger })` and passes the result to `createControlState` as `initialGlobalPause`, at the exact D-37 slot — after the schema gate and repo reconciliation, before the supervisor, the API bind, and the first dispatch tick.
- `packages/manager/src/api/routes/control.ts`: `pauseScope`/`resumeScope` await `setGlobalPause` before the queued-feature parking loop; `POST /control/pause|resume` catch `GlobalPausePersistError` specifically and answer `500` naming dispatch as unchanged, letting any other error propagate to Hono's existing handling.
- `packages/manager/test/control/pause-persistence.test.ts` (new): the tracer's end-to-end proof — two real `startDaemon` processes share one database file; the first pauses and stops; the second boots still paused (a freshly-queued feature, seeded only after the pause request so it was never touched by the synchronous park-the-queue loop, stays `queued` with no lease and no worker forked across ~15 dispatch intervals); `adl resume` against the second daemon then dispatches that same feature — the non-vacuity half. Plus the two failure-edge suites: `restoreGlobalPause` against an unreadable/paused stored value, and a real persistence failure (an unmigrated in-memory `Kysely` handle, not a stub) proving the in-memory brake and persisted row never disagree, including the matching route-level 500.
- `packages/db/test/repos-meta.test.ts`: `getGlobalPause`'s `absent`/`valid`/`invalid` cases and `setGlobalPause`'s idempotence.
- `packages/manager/README.md`: documents the restore step in the startup sequence (with its position relative to the API bind and first dispatch tick), and states plainly in "Operating the daemon" that a global pause survives a restart while a repo-scoped pause does not, plus the unreadable-value-boots-paused case and its `adl resume` remedy.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end — a global pause survives a daemon restart, one path** - `d7c397c` (feat)
2. **Task 2: The two failure edges, and what the operator is told** - `84976e7` (test)

**Plan metadata:** (this commit, following SUMMARY.md)

## Files Created/Modified

- `packages/db/src/repository/meta.ts` - `GLOBAL_PAUSE_KEY`, `GlobalPauseResult`, `getGlobalPause`/`setGlobalPause`
- `packages/db/src/repository/index.ts` - re-exports the two new symbols
- `packages/db/test/repos-meta.test.ts` - `getGlobalPause`/`setGlobalPause` test coverage
- `packages/manager/src/control/state.ts` - `ControlStateDeps`, `GlobalPausePersistError`, persist-then-flip `setGlobalPause`
- `packages/manager/src/boot/startup.ts` - `restoreGlobalPause`
- `packages/manager/src/daemon.ts` - wires the restore into the D-37 boot slot
- `packages/manager/src/api/routes/control.ts` - awaits `setGlobalPause`, catches `GlobalPausePersistError` for a 500
- `packages/manager/src/index.ts` - barrel exports for `restoreGlobalPause`, `GlobalPausePersistError`, `ControlStateDeps`
- `packages/manager/test/control/pause-persistence.test.ts` - the tracer proof plus both failure edges (new)
- `packages/manager/test/control/pause.test.ts` - `createControlState({ db })` call sites, `await` on `setGlobalPause`, the new meta-row persistence assertion
- `packages/manager/test/control/kill.test.ts` - `createControlState({ db })` call sites
- `packages/manager/README.md` - startup sequence step 5, "Operating the daemon" asymmetry note

## Decisions Made

- `createControlState` takes a required `ControlStateDeps` rather than an optional one or a zero-argument form — a constructor buildable without a database could silently reintroduce G-03-3.
- The tracer test seeds its dispatch-eligible feature **after** the pause request lands, not before: `pauseScope`'s own synchronous "park every currently-queued row" loop would otherwise move a pre-existing queued feature straight to `paused`, and the second daemon's "still queued, no lease" assertion would then hold trivially regardless of whether the persisted flag did anything at all.
- The failed-write tests use `createDb(':memory:')` with no migration run (no `meta` table) rather than a destroyed second `Kysely` handle on the shared temp file. The destroyed-handle approach produced `EBUSY: resource busy or locked, unlink ...db-shm` during `withTempDb`'s Windows teardown — a WAL-mode file-locking artifact, not a test-logic failure. The in-memory, unmigrated handle produces the same genuine "no such table: meta" write rejection with zero file-locking risk, on any platform.

## Deviations from Plan

None — plan executed exactly as written. Both auto-fix cycles below were caught and corrected by this executor's own test-run verification before committing, not discovered after the fact, so they are not tracked as post-commit deviations:
- The tracer test's original design (seeding the queued feature before pausing) produced a real assertion failure (`expected 'paused' to be 'queued'`) on first run, corrected before commit per the design decision above.
- The failed-write tests' original design (a destroyed file handle) produced a real `EBUSY` teardown failure on first run, corrected before commit per the design decision above.

## Issues Encountered

None beyond the two design corrections captured above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- G-03-3 is closed and OBS-03 is marked Complete in `REQUIREMENTS.md`.
- The persist-then-flip + discriminated absent/valid/invalid shape this plan establishes is available as a direct pattern for any future persisted control-plane flag (Phase 6's budget gate, if it ever needs a similarly durable brake).
- `packages/db/migrations/` is unchanged and `DAEMON_SCHEMA_VERSION` is unchanged — this plan added a row to the existing `meta` table, not a schema change.
- Two pre-existing `pnpm format` failures (`packages/cli/src/render/status-table.ts`, `packages/manager/src/scheduler/dispatcher.ts`) were found during verification, confirmed unrelated to this plan (predate it, not in its file list), and logged to `.planning/phases/03-manager-skeleton-state-leases-api-cli/deferred-items.md` rather than fixed — out of this plan's scope per the executor's scope-boundary rule.

---

*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-20*

## Self-Check: PASSED

All key files (`packages/db/src/repository/meta.ts`, `packages/manager/src/control/state.ts`,
`packages/manager/src/boot/startup.ts`, `packages/manager/test/control/pause-persistence.test.ts`,
`packages/manager/README.md`) verified present on disk. Both task commits (`d7c397c`, `84976e7`)
verified present in `git log`.
