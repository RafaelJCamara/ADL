---
phase: 01-core-contracts
plan: 10
subsystem: database
tags: [kysely, sqlite, migrations, checksum, cost-accounting, pricing]

# Dependency graph
requires:
  - phase: "01-02 (walking skeleton)"
    provides: "@adl/db package, createDb, migrateToLatest, the pathToFileURL-based DirectoryMigrationProvider, hand-written Database interface, 0001_initial migration, withTempDb test helper"
provides:
  - "Migration 0002_contracts: rounds, stage_attempts, waivers, verdicts, verdict_checked_criteria, findings, usage_events, model_prices"
  - "Migration 0003_seed_model_prices: bare-alias priced-model seed with a real temporal boundary"
  - "ADL-owned migration checksum guard (checksum.ts): CHECKSUM_TABLE, ensureChecksumTable, recordMigrationChecksum, assertMigrationsUnmodified, wrapMigrationWithChecksum"
  - "Temporal pricing lookup (pricing.ts): priceUsageEvent, CostSource, CostCategory"
  - "Narrow repository layer: featuresRepository, verdictsRepository, usageRepository"
  - "TABLE_COLUMNS + schema-drift.test.ts: the hand-written Database interface provably matches the live migrated schema in both directions"
affects: [01-08, 02, 03, 04, 05, 06]

actuals:
  tokens: 26700
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Re-entrant transaction proxy: a migration's own db.transaction().execute() call is intercepted at the runner boundary via a Proxy, so a checksum row commits inside the same real transaction as the migration's DDL, without the migration file needing to know the checksum guard exists. Verified empirically first — a literal nested db.transaction() on a Kysely Transaction throws."
    - "Compile-time-then-runtime schema exhaustiveness: TABLE_COLUMNS is checked against Database by a mapped-type assertion at compile time, then checked against the live migrated catalogue by schema-drift.test.ts at run time — drift fails the build in one direction and the test in the other."
    - "Cost vocabulary lives in the database (CHECK constraints), not duplicated as a TypeScript union in schema.ts — @adl/db never becomes a second source of truth for contracts @adl/core owns."
    - "Migration-mechanics tables (Kysely's own plus ADL's checksum table) are excluded from the drift check by an explicit BOOKKEEPING_TABLES list, not by convention."

key-files:
  created:
    - packages/db/migrations/0002_contracts.ts
    - packages/db/migrations/0003_seed_model_prices.ts
    - packages/db/src/checksum.ts
    - packages/db/src/pricing.ts
    - packages/db/src/repository/features.ts
    - packages/db/src/repository/verdicts.ts
    - packages/db/src/repository/usage.ts
    - packages/db/src/repository/index.ts
    - packages/db/test/migrate.test.ts
    - packages/db/test/schema-drift.test.ts
    - packages/db/test/checksum-guard.test.ts
    - packages/db/test/model-prices.test.ts
  modified:
    - packages/db/src/schema.ts
    - packages/db/src/migrator.ts
    - packages/db/src/index.ts
    - packages/db/test/migrate.smoke.test.ts

key-decisions:
  - "Column types in the Database interface are widened to string rather than narrowed to the CHECK-constrained union, so @adl/db never duplicates @adl/core's contract vocabulary as a second TypeScript source of truth."
  - "The checksum guard's own table (adl_migration_checksums) is read/written entirely via raw sql, not through the Database interface — it is migration infrastructure, not domain schema, the same category as Kysely's own kysely_migration."
  - "A mid-migration failure test (write a table, then throw before commit) proves the checksum insert and the migration's DDL share one real transaction — this was verified empirically with a throwaway probe script before being relied on in the implementation, given the plan's explicit requirement that the crash-consistency property be observed rather than assumed."
  - "'No dollar figure in source' is enforced as two separate checks: a literal $-digit scan across all of src/ (catches illustrative comments), and a stronger zero-decimal-literal scan scoped to pricing.ts alone (the file where a real hardcoded rate would land). A single blanket decimal-literal regex over all of src/ was rejected after it produced false positives on ordinary version-number comments (e.g. 'Kysely 0.29.5')."

patterns-established:
  - "Every migration after 0001 remains additive; 0001_initial.ts and 0002_contracts.ts are both verified byte-unchanged (git diff --exit-code) after every task in this plan."
  - "A checksum guard proves itself by being watched to fail: checksum-guard.test.ts copies real migrations into a private temp directory, mutates a byte, and asserts the migrator refuses to run — never mutating packages/db/migrations/ itself, and proving that via a beforeAll/afterAll digest comparison of the real directory rather than git diff (which would report success unconditionally on untracked files)."

requirements-completed: [EXEC-07]

coverage:
  - id: D1
    description: "Migrations apply cleanly to a temp SQLite file created per test and torn down after, and applying them twice is idempotent"
    requirement: "EXEC-07"
    verification:
      - kind: unit
        ref: "packages/db/test/migrate.test.ts — 'creates exactly the phase tables the interface declares, plus bookkeeping' and 'applies nothing on a second run'"
        status: pass
    human_judgment: false
  - id: D2
    description: "The tables Phases 1-5 need all exist after migration (meta, repos, features, feature_events, rounds, stage_attempts, verdicts, findings, waivers, usage_events, model_prices); the outbox, forge-event, and artifact tables deliberately do not"
    requirement: "EXEC-07"
    verification:
      - kind: unit
        ref: "packages/db/test/migrate.test.ts — 'contains every table Phases 1 through 5 need' and 'does not contain the tables deliberately deferred to later phases'"
        status: pass
    human_judgment: false
  - id: D3
    description: "The live schema of the migrated database matches the hand-written type interface exactly, in both directions"
    verification:
      - kind: unit
        ref: "packages/db/test/schema-drift.test.ts — all three tests"
        status: pass
    human_judgment: false
  - id: D4
    description: "Mutating an already-applied migration's bytes makes the migrator refuse to run, naming the migration and showing both digests truncated"
    requirement: "EXEC-07"
    verification:
      - kind: unit
        ref: "packages/db/test/checksum-guard.test.ts — 'refuses to run when an applied migration file was mutated afterwards, naming the migration' and 'names both the recorded and the found digest, truncated, in the failure message'"
        status: pass
    human_judgment: false
  - id: D5
    description: "A migration recorded as applied with no corresponding checksum row also refuses to run; the checksum is written in the same transaction as the migration's own statements, verified by a mid-migration failure leaving neither record"
    requirement: "EXEC-07"
    verification:
      - kind: unit
        ref: "packages/db/test/checksum-guard.test.ts — 'refuses to run when a checksum row for an applied migration was deleted' and 'leaves neither an applied record nor a checksum row when a migration fails partway'"
        status: pass
    human_judgment: false
  - id: D6
    description: "The verdicts table stores verdicts as rows with cited criteria as child rows, so the coverage table is a join rather than a scan over JSON blobs"
    verification:
      - kind: unit
        ref: "packages/db/test/migrate.test.ts — 'stores one verdict per stage attempt with its cited criteria as child rows' and 'rejects a seventh verdict outcome'"
        status: pass
    human_judgment: false
  - id: D7
    description: "usage_events records the four token counters separately, each nullable with no default, plus a constrained cost_source and cost_category"
    verification:
      - kind: unit
        ref: "packages/db/test/migrate.test.ts — 'usage_events records enough to reconstruct cost' describe block, all five tests"
        status: pass
    human_judgment: false
  - id: D8
    description: "Pricing a usage event dated before the introductory-pricing boundary yields a different cost from one dated after it, exercised by real seeded data (the sonnet-5 two-row case)"
    verification:
      - kind: unit
        ref: "packages/db/test/model-prices.test.ts — 'prices an event before the introductory boundary differently from one after it' and 'seeds at least two rows for the model whose introductory price lapses, with different effective-from dates'"
        status: pass
    human_judgment: false
  - id: D9
    description: "An unrecognised model id, and an event predating every price row for a known model, both yield cost_source 'unknown' and no cost — never zero"
    requirement: "EXEC-07"
    verification:
      - kind: unit
        ref: "packages/db/test/model-prices.test.ts — 'records an unrecognised model id as unknown' and 'records an event predating every price row ... as unknown, not the earliest price'"
        status: pass
    human_judgment: false
  - id: D10
    description: "Model prices contain no date-suffixed model ids and no price appears anywhere in TypeScript source outside the seed migration"
    verification:
      - kind: unit
        ref: "packages/db/test/model-prices.test.ts — 'gives every seeded model id a bare alias with no date suffix' and the 'prices never live in TypeScript source' describe block"
        status: pass
    human_judgment: false

duration: 105min
completed: 2026-08-17
status: complete
---

# Phase 1 Plan 10: Contract Tables, Migration Checksum Guard, and Priced-Model Seed Summary

**Migration 0002 adds the eleven Phase 1-5 tables with a four-counter, zero-default usage ledger; an ADL-owned checksum guard (proven by a test that mutates a migration and watches the runner refuse to start) makes an edited migration impossible to ship silently; and migration 0003 seeds model_prices with a real two-row Claude Sonnet 5 introductory-pricing boundary that a temporal lookup returning cost_source: 'unknown' (never zero) is tested against.**

## Performance

- **Duration:** ~105 min
- **Tasks:** 3 (all `type="auto" tdd="true"`)
- **Commits:** 6 (RED/GREEN pair per task)
- **Files created:** 12
- **Files modified:** 4
- **Tests:** 41 passing in `@adl/db` (up from 22 after plan 01-02)

## Accomplishments

- Migration `0002_contracts.ts` adds `rounds`, `stage_attempts`, `waivers`, `verdicts`, `verdict_checked_criteria`, `findings`, `usage_events`, and `model_prices` — additive, `0001_initial.ts` untouched and verified byte-identical after every task.
- `usage_events` carries four separately nullable token counters with no zero default, so a backend that never reports cache tokens stays distinguishable from one reporting zero — the distinction Phase 6's cost reconstruction depends on and cannot recover if lost at write time.
- `verdicts` is a table with cited criteria as child rows (`verdict_checked_criteria`), so `verdictsRepository.coverage()` is a join, not a scan over stored JSON.
- ADL's own migration checksum guard (`checksum.ts`) refuses to run when an applied migration's bytes changed or its checksum row was deleted, naming the migration and showing both digests truncated. The mid-migration-failure case is not asserted from documentation — it is a test that actually throws partway through a migration's transaction and confirms neither the applied record nor the checksum row survives.
- Migration `0003_seed_model_prices.ts` seeds bare-alias model ids with per-row cache multipliers; the two `claude-sonnet-5` rows encode the real 2026-08-31 introductory-pricing lapse, so the temporal lookup is exercised by an actual boundary rather than a synthetic date.
- `pricing.ts`'s `priceUsageEvent` prefers a backend-reported cost, computes from the table when none was reported, and returns `cost_source: 'unknown'` with `cost_usd: null` — never zero — for both an unrecognised model and an event predating every price row for an otherwise-known model.
- A narrow repository layer (`features.ts`, `verdicts.ts`, `usage.ts`) is now the only surface `@adl/db` exposes for domain operations, containing the eventual driver swap to one package (D-28).

## Task Commits

Each task followed the RED → GREEN TDD gate:

1. **Task 1: Migration 0002 — the tables Phases 1-5 need, with a lossless usage ledger**
   - `dffb323` test: failing migration and schema-drift tests (RED)
   - `c7db13f` feat: migration 0002, schema types, repository layer (GREEN)
2. **Task 2: ADL's own migration checksum guard, proven by watching it fail**
   - `0e37b2a` test: failing checksum-guard tests that mutate a migration (RED)
   - `93b2153` feat: checksum.ts, wired into migrator.ts (GREEN)
3. **Task 3: The priced-model seed and a temporal lookup that degrades visibly**
   - `f0dd78f` test: failing model-prices tests for the temporal lookup (RED)
   - `b04634a` feat: migration 0003, pricing.ts (GREEN)

_No REFACTOR commits — GREEN passed cleanly in every task without a subsequent cleanup pass._

## Files Created/Modified

- `packages/db/migrations/0002_contracts.ts` - the eight new tables, additive, `0001_initial.ts` never touched
- `packages/db/migrations/0003_seed_model_prices.ts` - the priced-model seed with the real sonnet-5 boundary
- `packages/db/src/checksum.ts` - `CHECKSUM_TABLE`, `ensureChecksumTable`, `recordMigrationChecksum`, `assertMigrationsUnmodified`, `wrapMigrationWithChecksum`
- `packages/db/src/pricing.ts` - `priceUsageEvent`, `CostSource`, `CostCategory`
- `packages/db/src/repository/{features,verdicts,usage,index}.ts` - the narrow domain-operation surface
- `packages/db/src/schema.ts` - one interface per new table, `TABLE_COLUMNS`, `PHASE_TABLES`, `DEFERRED_TABLES`, `BOOKKEEPING_TABLES`
- `packages/db/src/migrator.ts` - wires the checksum guard in before migrating, wraps each migration for in-transaction checksum recording
- `packages/db/src/index.ts` - re-exports every new symbol
- `packages/db/test/migrate.test.ts` - the full-chain, deferred-tables, and usage-ledger assertions
- `packages/db/test/schema-drift.test.ts` - live catalogue vs. `TABLE_COLUMNS`, both directions
- `packages/db/test/checksum-guard.test.ts` - the guard watched failing, plus the deletion-bypass and partial-failure cases
- `packages/db/test/model-prices.test.ts` - the temporal-boundary headline case plus six supporting cases
- `packages/db/test/migrate.smoke.test.ts` - two assertions narrowed from exact-count to containment (see Deviations)

## Decisions Made

Beyond the frontmatter `key-decisions`:

1. **The checksum-recording re-entrant proxy was verified empirically before being relied on.** Rather than assume Kysely's transaction semantics, a throwaway probe script (`node` against the built `better-sqlite3`/`kysely` in this worktree, then deleted) confirmed: (a) a literal nested `db.transaction()` call on a `Transaction` throws — `"calling the transaction method for a Transaction is not supported"`; (b) a `Proxy` intercepting `.transaction()` and redirecting it to the real handle's transaction works, with the migration's own DDL and a checksum insert both landing inside one real transaction; (c) a throw from inside that transaction rolls back both together. All three facts are load-bearing for `wrapMigrationWithChecksum`, and the plan's `<behavior>` section explicitly requires the crash-consistency property be proven by a test that actually crashes a migration, not merely documented.
2. **`adl_migration_checksums` joins `BOOKKEEPING_TABLES`, not `TABLE_COLUMNS`.** It is ADL's own table, but it is migration infrastructure — read and written entirely through raw `sql`, never through the `Database` interface — the same category as Kysely's own `kysely_migration`/`kysely_migration_lock`, and for the same reason: none of the three is domain schema the drift check exists to police.
3. **"No dollar figure in source" is two checks, not one.** An initial single regex matching any two-decimal-digit literal produced false positives on ordinary version-number comments elsewhere in the package (`Kysely 0.29.5`, `better-sqlite3 13.0.3`). The final design is a literal `$digit` scan across all of `src/` (the actual "dollar figure" the plan's language asks about) plus a stronger, file-scoped zero-decimal-literal check on `pricing.ts` alone — the one file with no legitimate reason to contain any numeric rate, since every rate it uses comes from `model_prices`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `migrate.smoke.test.ts`'s exact-count assertions broke on an additive migration**

- **Found during:** Task 1, first full `pnpm --filter @adl/db test` after adding migration 0002
- **Issue:** Two assertions from plan 01-02's smoke test asserted the migration chain had exactly one result and the database had exactly the four `0001_initial` tables plus Kysely bookkeeping. Both are true only when 0002 does not exist — the smoke test never claimed to own the whole chain, but its literal `toHaveLength`/`toEqual` assertions accidentally did.
- **Fix:** Narrowed both to containment (`toContain` / a length check scoped to `0001_initial` results specifically) rather than exact equality — the smoke test still proves what it originally proved (0001 applies once, its four tables exist), and ownership of the full chain moved to the new `migrate.test.ts`, which was always where it belonged given plan 01-10's scope.
- **Files modified:** `packages/db/test/migrate.smoke.test.ts`
- **Commit:** `c7db13f` (part of Task 1's GREEN commit)

**2. [Rule 1 - Bug] `adl_migration_checksums` was absent from `BOOKKEEPING_TABLES`, failing the drift check against its own guard's table**

- **Found during:** Task 2, first full `pnpm --filter @adl/db test` after wiring the checksum guard into `migrateToLatest`
- **Issue:** Once the guard ran on every migration, `adl_migration_checksums` existed in the live database but was declared in neither `TABLE_COLUMNS` nor `BOOKKEEPING_TABLES`, so `schema-drift.test.ts` and `migrate.test.ts`'s exact-table-set assertion both failed — correctly: an undeclared table is exactly the drift these tests exist to catch.
- **Fix:** Added `adl_migration_checksums` to `BOOKKEEPING_TABLES` (imported from `checksum.ts`'s `CHECKSUM_TABLE` constant rather than re-declared as a string literal, so the two files cannot drift from each other), with the doc comment updated to explain why an ADL-owned table still belongs in the "not domain schema" list.
- **Files modified:** `packages/db/src/schema.ts`
- **Commit:** `93b2153` (part of Task 2's GREEN commit)

**3. [Rule 1 - Bug] An illustrative dollar figure in a docstring would have tripped the check it preceded**

- **Found during:** Task 3, before writing `model-prices.test.ts`'s source-purity check
- **Issue:** `repository/usage.ts`'s docstring for `spendByCategory` used `"$4.12 so far, and 3 events we could not price"` as a made-up illustrative example. It is prose, not a real price constant, but a literal-minded `$digit` scan (the check the plan calls for) cannot distinguish "illustrative example in a comment" from "an actual hardcoded rate" — and a checker with a hand-carved exception for its own author's comment undermines the point of making the rule machine-checked rather than remembered.
- **Fix:** Reworded the docstring to make the same point without a dollar figure ("two separate, honest numbers instead of one number that quietly excludes some of them").
- **Files modified:** `packages/db/src/repository/usage.ts`
- **Commit:** `f0dd78f` (part of Task 3's RED commit, since the rewrite happened before the check that would have caught it)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — bugs in this plan's own new code, caught by its own tests before they could ship).
**Impact on plan:** All three are necessary corrections surfaced by the plan's own verification loop; none touch files outside this plan's declared set, and none required an architectural decision.

## Issues Encountered

None beyond the three deviations above. `corepack pnpm install --frozen-lockfile` and the full `pnpm -r build`/`pnpm -r typecheck`/`pnpm --filter @adl/db test` sequence all ran clean on the first attempt after each task's implementation.

## User Setup Required

None. Migrations 0002 and 0003 apply automatically the next time `migrateToLatest` runs against any database file — no manual step, no environment variable, no external service.

## Next Phase Readiness

`@adl/db` now exposes the full Phase 1-5 schema plus a narrow repository layer and a temporal pricing lookup. Carry-forwards for whoever consumes this next:

- **Phase 2 (manager, lease/queue mechanics):** `featuresRepository.compareAndSwapState` is the optimistic-concurrency primitive over `features.state_version`; `insertRound`/`latestRound` and `appendEvent`/`listEvents` are ready for the lifecycle state machine to write through.
- **Phase 4/5 (agent invocation, cost recording):** `usageRepository.record` and `priceUsageEvent` are ready to receive real backend usage. `priceUsageEvent` takes an optional `reportedCostUsd` — pass the backend's own reported figure when available (`claude -p --output-format json`'s `total_cost_usd`, for example) rather than computing, per `.claude/CLAUDE.md`'s cost-accounting guidance.
- **Phase 6 (budget/accountant):** `usageRepository.spendByCategory` returns `feature`, `overhead`, `total`, and `unpricedEvents` separately — the budget gate should surface `unpricedEvents > 0` to the maintainer rather than silently treating it as fully accounted spend.
- **Plan 01-08** (per the phase's own verification note) is the one that runs `pnpm -r test` across the whole workspace once Wave 4 closes; this plan intentionally ran only `pnpm --filter @adl/db test`, since Wave 3 has six other concurrent writers under `packages/core/src/`.
- **One open item for whoever builds the daemon startup path (Phase 3):** `migrator.ts` carries a comment cross-referencing the database-file-copy-before-migrating half of D-30's mitigation (01-RESEARCH.md § Pitfall 5, point 2) — that half is Phase 3's, not this plan's, since Phase 1 has no daemon startup path to hook into.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
