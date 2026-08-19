---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 02
subsystem: database
tags: [kysely, better-sqlite3, sqlite-wal, lease-queue, optimistic-concurrency]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 01)
    provides: "@adl/manager and @adl/cli scaffolding, three-leg CI matrix — this plan touches only packages/db"
provides:
  - "featuresRepository.acquireLease/renewLease/expireLease/releaseLease/listExpiredLeases/listLeased/listQueued — the lease queue as repository methods, with leaseToken required (never optional) on every lease-scoped input type"
  - "packages/db/src/time.ts — nowIso()/assertIsoTimestamp(), the single writer/validator of every lease timestamp"
  - "reposRepository (upsert/findById/list) and metaRepository (get/set/getSchemaVersion/setSchemaVersion) for D-35's startup reconciliation and D-37's schema-version gate"
  - "createDb opens every connection in WAL journal mode, busy_timeout 2000, synchronous NORMAL (DEFAULT_PRAGMAS), asserted by pragmas.test.ts"
affects: [03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 11223
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Lease-scoped repository methods follow compareAndSwapState's exact shape: a conditional UPDATE, executeTakeFirst, Number(result.numUpdatedRows) === 1 returned as a boolean — never throw for a lost race"
    - "leaseToken is a required, non-optional field on every lease-scoped input interface (D-08), proven by a @ts-expect-error type-level test wired into a package-specific tsconfig.test.json so `pnpm --filter @adl/db typecheck` actually checks it (mirrors @adl/core's tsconfig.test.json pattern)"
    - "acquireLease's heartbeatAt parameter doubles as the caller-supplied 'now' the guard compares an existing lease_expires_at against — no separate clock read inside the repository, matching TransitionCtx.at's discipline"
    - "Every lease timestamp write and every lease timestamp parameter passes through nowIso()/assertIsoTimestamp() — the one place the ISO-8601 fixed-width format that makes lease_expires_at < ? a valid chronological comparison can be kept"
    - "reposRepository.upsert and metaRepository.set use Kysely's onConflict(...).doUpdateSet(...) for SQLite upserts, selectively preserving created_at"
    - "metaRepository.getSchemaVersion returns a discriminated {kind: 'absent'|'valid'|'invalid'} result rather than a bare number, so a corrupt stored value can never compare as NaN and silently let a startup gate through"
    - "DEFAULT_PRAGMAS applied on the raw better-sqlite3 handle inside createDb, before the Kysely instance wraps it"

key-files:
  created:
    - packages/db/src/time.ts
    - packages/db/src/repository/repos.ts
    - packages/db/src/repository/meta.ts
    - packages/db/test/lease.test.ts
    - packages/db/test/repos-meta.test.ts
    - packages/db/test/pragmas.test.ts
    - packages/db/tsconfig.test.json
  modified:
    - packages/db/src/repository/features.ts
    - packages/db/src/repository/index.ts
    - packages/db/src/index.ts
    - packages/db/src/migrator.ts
    - packages/db/test/helpers/temp-db.ts
    - packages/db/test/schema-drift.test.ts
    - packages/db/package.json

key-decisions:
  - "Added packages/db/tsconfig.test.json and wired it into the 'typecheck' npm script (tsc --noEmit && tsc --noEmit -p tsconfig.test.json), mirroring @adl/core's existing pattern. packages/db/tsconfig.json only includes src/ and migrations/ — without this, tsc --noEmit never opened test/lease.test.ts, so the plan's own acceptance criterion ('omitting leaseToken turns pnpm --filter @adl/db typecheck red') could not be true. Verified empirically: making a lease-scoped leaseToken optional does turn the command red."
  - "acquireLease's guard uses heartbeatAt as both the write value for heartbeat_at and the comparison value for the existing row's lease_expires_at < ? predicate, rather than adding a separate now parameter — the plan's literal input signature listed only {id, leaseOwner, leaseToken, leaseExpiresAt, heartbeatAt}, and heartbeatAt is exactly nowIso()'s output at call time."
  - "releaseLease has an identical predicate and effect to expireLease (nulls lease_owner/lease_token/lease_expires_at) — the separate method exists purely so a call site's own name distinguishes 'the worker finished' from 'the lease timed out', per the plan's explicit rationale."

requirements-completed: [EXEC-02, EXEC-04, EXEC-06]

coverage:
  - id: D1
    description: "A stale lease token cannot write, proven at the repository layer with no manager code in the test (D-06's SQL-layer fence)"
    requirement: EXEC-04
    verification:
      - kind: unit
        ref: "packages/db/test/lease.test.ts#renewLease > with a stale token returns false and changes nothing"
        status: pass
      - kind: unit
        ref: "packages/db/test/lease.test.ts#expireLease > with a stale token returns false"
        status: pass
      - kind: unit
        ref: "packages/db/test/lease.test.ts#acquireLease > fails against a row whose lease_expires_at is in the future, leaving every lease column unchanged"
        status: pass
    human_judgment: false
  - id: D2
    description: "A lease-scoped repository call without its leaseToken does not compile (D-08)"
    requirement: EXEC-04
    verification:
      - kind: unit
        ref: "packages/db/test/lease.test.ts#D-08: leaseToken is required, not optional, on every lease-scoped input (type-level)"
        status: pass
      - kind: other
        ref: "pnpm --filter @adl/db typecheck (tsc --noEmit -p tsconfig.test.json checks the @ts-expect-error proof; exit 0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The daemon has named lookups for watched repositories (reposRepository) and the stored schema version (metaRepository), for D-35/D-37"
    requirement: EXEC-06
    verification:
      - kind: unit
        ref: "packages/db/test/repos-meta.test.ts#reposRepository > upsert called twice with the same id leaves exactly one row, preserves created_at, and overwrites the rest"
        status: pass
      - kind: unit
        ref: "packages/db/test/repos-meta.test.ts#metaRepository > getSchemaVersion reports the absent case against a freshly migrated database — not 0, not a thrown error"
        status: pass
      - kind: unit
        ref: "packages/db/test/repos-meta.test.ts#metaRepository > reports a non-integer stored schema_version as a distinguishable failure, never a numeric value"
        status: pass
    human_judgment: false
  - id: D4
    description: "createDb opens in WAL mode with a non-zero busy_timeout, asserted rather than assumed"
    requirement: EXEC-06
    verification:
      - kind: unit
        ref: "packages/db/test/pragmas.test.ts#createDb: connection pragmas > opens in WAL journal mode"
        status: pass
      - kind: unit
        ref: "packages/db/test/pragmas.test.ts#createDb: connection pragmas > reports the configured busy_timeout"
        status: pass
      - kind: unit
        ref: "packages/db/test/pragmas.test.ts#createDb: connection pragmas > lets a second connection read while a write transaction is open on the first"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-19
status: complete
---

# Phase 3 Plan 02: Lease Queue, Repos/Meta Repositories, and WAL Pragmas Summary

**Added `acquireLease`/`renewLease`/`expireLease`/`releaseLease`/`listExpiredLeases`/`listLeased`/`listQueued` to `featuresRepository` (SQL-layer fence, `leaseToken` required at compile time), new `reposRepository`/`metaRepository` for daemon startup, and `WAL`/`busy_timeout`/`synchronous` pragmas on every `createDb` connection — no new tables, no new migration.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-08-19T15:15:00Z (approx)
- **Completed:** 2026-08-19T16:00:00Z (approx)
- **Tasks:** 3
- **Files modified:** 14 (7 created, 7 modified)

## Accomplishments

- `packages/db/src/time.ts`: `nowIso()` (the single writer of every lease timestamp), `assertIsoTimestamp()` (the guard every accepted timestamp parameter runs through), and `ISO_TIMESTAMP_PATTERN` — the property that makes `lease_expires_at < ?` a valid chronological comparison rather than an accidental lexicographic one now has exactly one place it can drift.
- `featuresRepository` gained the lease queue: `acquireLease`, `renewLease`, `expireLease`, `releaseLease`, `listExpiredLeases`, `listLeased`, `listQueued`, each mirroring `compareAndSwapState`'s conditional-`UPDATE`-returns-boolean shape. `leaseToken` is required (never optional) on every lease-scoped input type — proven by a `@ts-expect-error` type-level test wired into a new `tsconfig.test.json` so `pnpm --filter @adl/db typecheck` genuinely enforces D-08, not just documents it.
- `reposRepository` (`upsert`/`findById`/`list`) and `metaRepository` (`get`/`set`/`getSchemaVersion`/`setSchemaVersion`) — the two lookups the daemon's startup path needs for D-35's watched-repo reconciliation and D-37's schema-version gate. `getSchemaVersion` returns a discriminated `{kind: 'absent'|'valid'|'invalid'}` result rather than a bare number, so a corrupt stored value can never compare as `NaN` and silently let the gate through.
- `createDb` now sets `DEFAULT_PRAGMAS` (journal_mode `WAL`, busy_timeout `2000`, synchronous `NORMAL`) on the raw `better-sqlite3` handle before Kysely wraps it, asserted by `pragmas.test.ts` including a real cross-connection concurrent-read-during-open-write-transaction test.
- Zero migration files touched: `git diff --stat packages/db/migrations/` between this plan's start and end is empty, and `DEFERRED_TABLES` is unchanged — the lease columns already existed from Phase 1.

## Task Commits

Each task was committed atomically:

1. **Task 1: nowIso, and the lease-scoped methods on featuresRepository** - `6b42da4` (feat)
2. **Task 2: reposRepository and metaRepository** - `93b17f1` (feat)
3. **Task 3: WAL, busy_timeout, and synchronous pragmas on createDb** - `e0c5db2` (feat)

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

_Note: this plan's tasks carried `tdd="true"` in intent (tests written alongside behavior, following existing suite conventions) but the plan did not mandate a strict RED→GREEN commit split, so there is no separate RED/GREEN/REFACTOR commit sequence to report — each task's tests and implementation landed together in one commit, consistent with how the rest of `@adl/db`'s suite was built._

## Files Created/Modified

- `packages/db/src/time.ts` - `nowIso`, `assertIsoTimestamp`, `ISO_TIMESTAMP_PATTERN`
- `packages/db/src/repository/features.ts` - `AcquireLeaseInput`/`RenewLeaseInput`/`ExpireLeaseInput`/`ReleaseLeaseInput` types; `acquireLease`/`renewLease`/`expireLease`/`releaseLease`/`listExpiredLeases`/`listLeased`/`listQueued` on `FeaturesRepository`
- `packages/db/src/repository/repos.ts` - `NewRepo`, `ReposRepository`, `reposRepository(db)`
- `packages/db/src/repository/meta.ts` - `SCHEMA_VERSION_KEY`, `SchemaVersionResult`, `MetaRepository`, `metaRepository(db)`
- `packages/db/src/repository/index.ts` - registers the four new lease input types plus `reposRepository`/`metaRepository`
- `packages/db/src/index.ts` - exports `nowIso`/`assertIsoTimestamp`/`ISO_TIMESTAMP_PATTERN` and `DEFAULT_PRAGMAS`
- `packages/db/src/migrator.ts` - `DEFAULT_PRAGMAS` constant; `createDb` applies the three pragmas on the raw handle
- `packages/db/test/lease.test.ts` - behavior coverage for every lease method plus the D-08 type-level proof
- `packages/db/test/repos-meta.test.ts` - upsert idempotency/`created_at` preservation, all three `getSchemaVersion` outcomes
- `packages/db/test/pragmas.test.ts` - asserts the three reported pragma values and the concurrent-read-during-open-write-transaction behavior
- `packages/db/test/helpers/temp-db.ts` - extended teardown comment noting WAL's `-wal`/`-shm` sidecars don't change the destroy-before-remove ordering
- `packages/db/test/schema-drift.test.ts` - minimal type annotation fix (deviation, see below)
- `packages/db/tsconfig.test.json` - new non-emitting typecheck program covering `test/**/*.ts`, mirroring `@adl/core`'s pattern
- `packages/db/package.json` - `typecheck` script now runs both `tsconfig.json` and `tsconfig.test.json`

## Decisions Made

- Added `packages/db/tsconfig.test.json` and changed the `typecheck` script to `tsc --noEmit && tsc --noEmit -p tsconfig.test.json` — `packages/db/tsconfig.json`'s `include` is `src/**/*.ts` and `migrations/**/*.ts` only, so without this, `tsc --noEmit` would never open `test/lease.test.ts` and the plan's own stated acceptance criterion (omitting `leaseToken` turns `pnpm --filter @adl/db typecheck` red) would be false by construction. Mirrors `@adl/core/tsconfig.test.json`'s existing rationale exactly.
- `acquireLease`'s guard reuses `heartbeatAt` as the caller-supplied "now" for the `lease_expires_at < ?` comparison, rather than adding a separate `now` parameter — the plan's `<action>` text names an explicit `now` parameter in prose but the literal input signature it specifies is `{id, leaseOwner, leaseToken, leaseExpiresAt, heartbeatAt}`. Since `heartbeatAt` is always `nowIso()`'s output at call time, reusing it satisfies both the "explicit instant, not a clock read" requirement and the literal signature without introducing a redundant field.
- `releaseLease` and `expireLease` share one predicate and one effect (null `lease_owner`/`lease_token`/`lease_expires_at`) by design — two names for the same SQL, so a log line at the call site can say which happened.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `packages/db/tsconfig.test.json` and updated the `typecheck` script**
- **Found during:** Task 1 (writing `lease.test.ts`'s D-08 type-level proof)
- **Issue:** The plan's acceptance criteria require that omitting `leaseToken` "turns `pnpm --filter @adl/db typecheck` red." `packages/db/tsconfig.json`'s `include` is `["src/**/*.ts", "migrations/**/*.ts"]` — `test/` was never part of the program `tsc --noEmit` type-checks, so a `@ts-expect-error` inside a test file was invisible to that command regardless of whether the guarantee held.
- **Fix:** Added `packages/db/tsconfig.test.json` (non-emitting, `include: ["src/**/*.ts", "migrations/**/*.ts", "test/**/*.ts"]`), following `packages/core/tsconfig.test.json`'s exact rationale, and changed `packages/db/package.json`'s `"typecheck"` script to run both configs.
- **Files modified:** `packages/db/tsconfig.test.json` (new), `packages/db/package.json`
- **Verification:** Empirically confirmed both directions — with the fix in place, `pnpm --filter @adl/db typecheck` exits 0; temporarily relaxing `RenewLeaseInput.leaseToken` to optional and re-running the command turned it red (a downstream type error at the call site inside `renewLease`'s own implementation, which is an equally valid demonstration that the guarantee is load-bearing). Reverted after confirming.
- **Committed in:** `6b42da4` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed a pre-existing latent type error in `schema-drift.test.ts`, surfaced by the new typecheck coverage**
- **Found during:** Task 1, immediately after wiring `tsconfig.test.json` — `pnpm --filter @adl/db typecheck` failed on `test/schema-drift.test.ts(92,34)` (`Argument of type 'string' is not assignable to parameter of type 'never'`), a file this plan did not otherwise touch.
- **Issue:** `Object.entries(TABLE_COLUMNS)` widens to a union of narrow literal-tuple types across all table entries; `declared.includes(column)` (where `column: string`) failed because TypeScript inferred `declared`'s element type as the intersection-narrowed `never` for the union. This was a real, pre-existing type error — invisible before this plan because `test/` was never included in `tsc --noEmit`'s program — not something this plan's own changes introduced.
- **Fix:** Annotated the `Object.entries(TABLE_COLUMNS)` destructuring with an explicit `[string, readonly string[]][]` cast at the one call site.
- **Files modified:** `packages/db/test/schema-drift.test.ts`
- **Verification:** `pnpm --filter @adl/db typecheck` exits 0; `pnpm --filter @adl/db test` still reports all `schema-drift.test.ts` assertions passing (unchanged runtime behavior — the fix is type-only).
- **Committed in:** `6b42da4` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** Both were necessary to make this plan's own stated acceptance criteria true rather than aspirational. Neither touches migrations, the lease queue's runtime behavior, or any file outside `packages/db/`. No scope creep.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The data-layer half of D-06's fence exists and is tested independently of any manager IPC code — 03-04 (or whichever plan builds the manager's message handler) can add the IPC-layer half on top without re-deriving the SQL predicate.
- `reposRepository` and `metaRepository` are available for the daemon startup path (D-35 reconciliation, D-37 schema-version gate) that a later plan in this phase builds.
- `createDb`'s pragmas are in place for the manager's concurrent reaper/dispatcher/API-read access pattern; no further `@adl/db` changes are anticipated to support that pattern.
- No blockers for 03-03 (running in parallel in this wave, scoped to `packages/workspace/**` and `test/lint/**`) or for later plans in this phase.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-19*

## Self-Check: PASSED

All created files and commit hashes verified present on disk / in git log (see below).
