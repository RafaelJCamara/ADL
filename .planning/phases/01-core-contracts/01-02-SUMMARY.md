---
phase: 01-core-contracts
plan: 02
subsystem: core-contracts
tags: [walking-skeleton, tracer, zod, verdict, spec-loader, kysely, sqlite, pnpm-workspace]

# Dependency graph
requires:
  - "01-01 (package legitimacy verdicts and exact pinned versions)"
provides:
  - "pnpm 11.22.0 workspace on TypeScript 6.0.3 with three members: @adl/core, @adl/db, @adl/plugin-sdk"
  - "Six-outcome VerdictSchema + consumesRound (CORE-01)"
  - "FindingSchema with required criterionRef, fingerprintFinding, sortFindings (CORE-04)"
  - "CriterionRefSchema, WaiverSchema, SeveritySchema"
  - "aggregate() -> RoundOutcome, total and structurally unable to return green with inconclusive (CORE-02)"
  - "loadAdlTemplateSpec producing addressable AC-n criteria with byte-exact verbatim text (CORE-05, SPEC-01)"
  - "NormalizedSpec / AcceptanceCriterion / ContextRef types"
  - "@adl/db: createDb, migrateToLatest, hand-written Database interface, 0001_initial"
  - "withTempDb helper for real-file SQLite migration tests"
  - "Complete pnpm-lock.yaml covering all three workspace members, so no Wave 3 plan needs to install"
affects: [01-03, 01-04, 01-05, 01-06, 01-07, 01-08, 01-09, 01-10]

actuals:
  tokens: 63000
  tasks: 2
  commits: 2

tech-stack:
  added:
    - "pnpm 11.22.0 (workspaces + catalog:)"
    - "typescript 6.0.3 (exact pin, no caret)"
    - "vitest 4.1.10"
    - "zod 4.4.3"
    - "mdast-util-from-markdown 2.0.3"
    - "@cucumber/gherkin 42.0.1 + @cucumber/messages 34.2.1 (installed, consumed by 01-06)"
    - "yaml 2.9.0 (installed, consumed by 01-07)"
    - "ajv 8.20.0 (devDependency, consumed by 01-04)"
    - "kysely 0.29.5 + better-sqlite3 13.0.3 + ulid 3.0.2"
    - "@types/node 22.20.1, @types/better-sqlite3 9.6.0"
    - "eslint 10.8.1, typescript-eslint 8.67.0, prettier 3.9.6, tsx 4.23.12"
  patterns:
    - "Structural-only Zod constraints under verdict/ — no .refine()/.superRefine(), because z.toJSONSchema() drops them silently"
    - "Every schema and every discriminated-union member carries .meta({ id }) so emitted $defs names are stable, not positional __schemaN"
    - "Verbatim source slicing by node offset, never AST re-serialisation"
    - "Subpath exports with no shared root barrel, so concurrent plans never edit one index.ts"
    - "Hand-written Kysely Database interface paired with a runtime column list and a compile-time exhaustiveness assertion"
    - "Explicit db.transaction() inside every migration up(), because Kysely takes the non-transactional path on SQLite"

key-files:
  created:
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
    - vitest.config.ts
    - .npmrc
    - .gitignore
    - pnpm-lock.yaml
    - packages/core/package.json
    - packages/core/tsconfig.json
    - packages/core/vitest.config.ts
    - packages/core/README.md
    - packages/core/src/errors.ts
    - packages/core/src/hash.ts
    - packages/core/src/verdict/criterion-ref.ts
    - packages/core/src/verdict/waiver.ts
    - packages/core/src/verdict/finding.ts
    - packages/core/src/verdict/verdict.ts
    - packages/core/src/verdict/aggregate.ts
    - packages/core/src/verdict/index.ts
    - packages/core/src/spec/types.ts
    - packages/core/src/spec/markdown.ts
    - packages/core/src/spec/index.ts
    - packages/core/test/fixtures/spec/good/spec.md
    - packages/core/test/spine.e2e.test.ts
    - packages/db/package.json
    - packages/db/tsconfig.json
    - packages/db/vitest.config.ts
    - packages/db/migrations/0001_initial.ts
    - packages/db/src/schema.ts
    - packages/db/src/migrator.ts
    - packages/db/src/index.ts
    - packages/db/test/helpers/temp-db.ts
    - packages/db/test/migrate.smoke.test.ts
    - packages/db/test/spine.persist.test.ts
    - packages/plugin-sdk/package.json
    - packages/plugin-sdk/tsconfig.json
    - packages/plugin-sdk/vitest.config.ts
    - packages/plugin-sdk/src/index.ts
  modified: []

key-decisions:
  - "Root vitest.config.ts with test.projects replaces the planned vitest.workspace.ts — Vitest 4 removed standalone workspace files, and the planned file would have been silently ignored dead weight."
  - "aggregate([]) returns escalate rather than green or unverified: zero gates ran, so nothing was verified, and the reason string can say exactly that."
  - "A send_back brief carries findings from warn verdicts as well as send_back verdicts — 'every gate that raised one', read literally."
  - "@adl/db ships a small pathToFileURL-based MigrationProvider instead of Kysely's FileMigrationProvider, which builds bare Windows drive paths that Node's ESM loader rejects (verified: ERR_UNSUPPORTED_ESM_URL_SCHEME)."
  - "Kysely's migration API is imported from the kysely/migration subpath; the root entrypoint now exports a KyselyTypeError that says so."
  - "@types/node added as a devDependency of @adl/core and @adl/db, with explicit compilerOptions.types — TypeScript 6 no longer auto-includes @types packages."
  - "packages/db compiles with rootDir '.' so migrations/ ships compiled beside src/; a migration that only exists as TypeScript cannot run in an adopter's installation."
  - "@adl/db's pretest runs `tsc -b ../core` so `pnpm -r test` is green from a clean checkout without a separate build step."

patterns-established:
  - "Tracer-slice execution: one thin path through every layer, production-quality, verified end-to-end before any expansion"
  - "Compile-time exhaustiveness assertions pairing a TypeScript interface with its runtime key list, so schema drift fails the build rather than a test"
  - "pnpm allowBuilds as an explicit, commented allowlist of packages permitted to execute install scripts"

requirements-completed: [CORE-01, CORE-04, CORE-05, SPEC-01]

coverage:
  - id: D1
    description: "A spec.md written to the ADL headings-only template loads into a NormalizedSpec whose criteria are addressable AC-1..AC-n in document order, each carrying byte-exact source text"
    requirement: "SPEC-01, CORE-05"
    verification:
      - kind: automated_test
        ref: "packages/core/test/spine.e2e.test.ts — 'parses the ADL template into addressable AC-n criteria in document order' and 'retains each criterion verbatim as a contiguous source slice'"
        status: pass
    human_judgment: false
  - id: D2
    description: "VerdictSchema accepts exactly the six outcome literals and rejects a seventh with invalid_union naming all six"
    requirement: "CORE-01"
    verification:
      - kind: automated_test
        ref: "packages/core/test/spine.e2e.test.ts — 'rejects a seventh outcome, naming the six that exist'"
        status: pass
    human_judgment: false
  - id: D3
    description: "aggregate() cannot return green when any verdict is inconclusive; the unverified variant is proven under permutation"
    requirement: "CORE-02"
    verification:
      - kind: automated_test
        ref: "packages/core/test/spine.e2e.test.ts — 'is not green once any gate says it could not tell'"
        status: pass
    note: "Exhaustive enumeration over all 3,002 multisets is plan 01-04's job; this plan proves the path, not the space."
    human_judgment: false
  - id: D4
    description: "0001_initial applies once to a real temp SQLite file, applies nothing on a second run, and produces exactly the four ADL tables"
    requirement: "EXEC-07 (D-29/D-30)"
    verification:
      - kind: automated_test
        ref: "packages/db/test/migrate.smoke.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "The features column set matches the hand-written Database['features'] interface"
    verification:
      - kind: automated_test
        ref: "packages/db/test/migrate.smoke.test.ts — PRAGMA table_info compared to FEATURES_COLUMNS"
        status: pass
    human_judgment: false
  - id: D6
    description: "The spine reaches persistence: the loader's specHash and the green round outcome survive a write-and-read round trip"
    requirement: "CORE-05"
    verification:
      - kind: automated_test
        ref: "packages/db/test/spine.persist.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "@adl/core imports no filesystem, child_process, or process.env; no package outside @adl/db names better-sqlite3"
    verification:
      - kind: other
        ref: "grep over packages/core/src (0 matches) and packages/**/*.ts for better-sqlite3 (only packages/db/src/migrator.ts)"
        status: pass
    human_judgment: false
  - id: D8
    description: "Fingerprint normalisation strength — rephrasings collide, genuinely different findings do not"
    verification:
      - kind: manual_procedural
        ref: "BACKSTOP. The normalisation is implemented as specified (NFKC, lowercase, whitespace collapse, trailing line-ref strip, NUL-separated fields), but whether two differently-worded findings are the SAME finding is a judgement no unit test settles. 01-RESEARCH.md § Open Questions 1 defers tuning to Phase 6 evidence; plan 01-04 ships the fixture corpus."
        status: deferred
    human_judgment: true
    rationale: "Marked verification: backstop in the plan's must_haves for exactly this reason — too strict never fires stall detection, too loose fires falsely, and neither failure is visible until real agent output exists."

duration: 22min
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 02: Walking Skeleton Summary

**The contract spine stands end to end: a real `spec.md` parses to addressable `AC-n` criteria with byte-exact text, six-outcome verdicts validate by schema, `aggregate()` reaches a green `RoundOutcome` that `inconclusive` provably cannot reach, and both the spec hash and that outcome round-trip through migrations applied to a real temp SQLite file — on a pnpm 11.22.0 / TypeScript 6.0.3 workspace where `pnpm -r test` is green from a clean checkout.**

## Performance

- **Duration:** ~22 min
- **Tasks:** 2 (1 tracer, 1 auto)
- **Commits:** 2
- **Files created:** 38
- **Tests:** 11 passing (core 5, db 6, plugin-sdk 0 by design)
- **Quick-run latency:** `pnpm vitest run --project core` — 417 ms against a 5 s budget

## Accomplishments

- Provisioned the pinned toolchain: pnpm 11.22.0 via corepack, TypeScript **6.0.3 exact** (npm `latest` is 7.0.2, which breaks `typescript-eslint@8.67.0`), `engines: >=22.12.0`, `module: nodenext`, no bundler.
- Installed every runtime dependency the whole phase needs — including the four packages human-approved at plan 01-01's gate, at exactly the recorded versions — so **no Wave 3 plan has to touch the lockfile**.
- Built the contract layer whose six outcomes and required `criterionRef` are enforced by schema rather than convention.
- Built the ADL-template spec loader producing `AC-n` criteria whose text is a verbatim source slice.
- Built `@adl/db` with a hand-written `Database` interface, migration `0001_initial`, and a temp-file test harness.
- Stubbed `@adl/plugin-sdk` one wave early and deliberately empty, so Wave 3's seven concurrent plans never race on `pnpm install`.

---

## The prohibitions, and how they are enforced

The plan carried two prohibitions. Both are structural now, not conventions:

**1. "ADL must never present an unverified or unknown result as verified."**

`aggregate()` returns `{ kind: 'green' }` from exactly **one** place, and reaching it requires having already fallen through three guards — no `fail`, no `send_back`, no `inconclusive`. Green is a conclusion, never a default. The empty verdict list is the sharpest version of this: zero gates ran, so `aggregate([])` returns `escalate` with a reason saying so, rather than green-by-vacuous-truth.

**2. "A waiver or a skipped gate must never render as acceptance-criterion coverage."**

`SkipVerdict` has no `checked` field at all — only `reason` and an optional `waiver`. Coverage can only come from `PassVerdict.checked`, which the schema requires to be non-empty. A gate that did not run is structurally incapable of contributing a criterion to the coverage table.

---

## Deviations from Plan

Five, all Rule 1/2/3 auto-fixes. Nothing architectural; no Rule 4 decision arose.

### 1. [Rule 3 - Blocking] `vitest.workspace.ts` replaced by root `vitest.config.ts`

- **Found during:** Task 1, first attempt at `pnpm vitest run --project core`
- **Issue:** Vitest 4 removed support for the standalone `vitest.workspace.ts` file (deprecated in v3). The file was silently ignored and the run failed with `No projects matched the filter "core"` — which the plan names as an explicit acceptance criterion.
- **Fix:** Created root `vitest.config.ts` declaring `test.projects: ['packages/*/vitest.config.ts']` and deleted the dead `vitest.workspace.ts`. Leaving an ignored file in place would have been worse than removing it: a future reader would reasonably assume it was wired up.
- **Downstream note:** 01-VALIDATION.md expects plan **01-03** to register a `root` project. That is now an *edit* to an existing `vitest.config.ts` rather than a file creation — no collision, since 01-03 is the only Wave 3 plan that touches it.
- **Commit:** `11417c8`

### 2. [Rule 3 - Blocking] `@types/node` added, with explicit `compilerOptions.types`

- **Found during:** Task 1 typecheck
- **Issue:** TypeScript 6 no longer pulls every `@types/*` package into global scope automatically. `node:crypto` and `Buffer` failed to resolve with `TS2591`.
- **Fix:** `@types/node@22.20.1` as a devDependency of `@adl/core` and `@adl/db`, plus `"types": ["node"]` in each package's tsconfig. `@adl/plugin-sdk` gets `"types": []` — the stub needs no ambient surface.
- **Note:** This package was not in the plan's declared install set, but it is not a discretionary addition — it is required infrastructure for any TypeScript project targeting Node, and nothing typechecks without it.
- **Commit:** `11417c8`

### 3. [Rule 1 - Bug] Section-heading matcher compared against the wrong string

- **Found during:** Task 1, implementing `markdown.ts`
- **Issue:** The reference snippet in 01-RESEARCH.md § Code Examples 2 matches headings with `nodeText(n).trim().toLowerCase() === '## Acceptance Criteria'`. An mdast heading node's text does **not** include the `##` marker, so that comparison can never be true — every spec would have raised "missing heading".
- **Fix:** Compare against the bare `'Acceptance Criteria'` at the heading node, with depth used for section termination.
- **Commit:** `11417c8`

### 4. [Rule 1 - Bug] Kysely's `FileMigrationProvider` is unusable on Windows

- **Found during:** Task 2
- **Issue:** `FileMigrationProvider` builds a migration path with `path.join()` and hands it to `import()`. On Windows that is a bare drive path, which Node's ESM loader rejects. **Verified empirically**, not assumed: `ERR_UNSUPPORTED_ESM_URL_SCHEME — Only URLs with a scheme in: file, data, and node are supported`.
- **Fix:** A ~20-line `DirectoryMigrationProvider` in `migrator.ts` that converts through `pathToFileURL()` before importing, and skips `.d.ts` so compiled output does not contribute a phantom no-op migration. Kysely's `Migrator` is still the runner.
- **Verified:** the compiled `dist/migrations` path applies `0001_initial` under the *same* migration name as the source path, so a developer running from source and an adopter running from `dist` record identical rows in `kysely_migration`.
- **Commit:** `fa74993`

### 5. [Rule 3 - Blocking] Kysely migration API moved to a subpath

- **Found during:** Task 2 typecheck
- **Issue:** `import { Migrator } from 'kysely'` now resolves to a `KyselyTypeError<"import from 'kysely/migration' instead">`.
- **Fix:** Import `Migrator`, `Migration`, `MigrationProvider`, and `MigrationResult` from `kysely/migration`.
- **Commit:** `fa74993`

### Two smaller corrections worth recording

- **`pretest` must not shell out to `pnpm`.** The first version ran `pnpm --filter @adl/core build`, which failed because `pnpm` is not on `PATH` when corepack shims are not enabled. Replaced with `tsc -b ../core`, which uses the binary already in the package's own `node_modules/.bin` and has no PATH dependency.
- **Literal NUL bytes removed from source.** `fingerprintFinding`'s separators were first written as raw NUL characters embedded in a template literal — invisible in an editor and trivially destroyed by a well-meaning reformat. Rewritten as an explicit `' '` escape joined across the three fields. The hash input is byte-identical; the source is now readable.

---

## Decisions Made

Beyond the deviations above:

1. **`aggregate([])` returns `escalate`, not `green` and not `unverified`.** Zero verdicts means zero gates ran. `unverified` carries the inconclusive verdicts that caused it, and there are none, so its payload would be vacuous; `escalate` carries a reason string that can state the situation plainly. It is a misconfiguration, and a human is the right recipient.
2. **A send-back brief carries `warn` findings too.** D-10 says the brief carries "every finding from every gate that raised one". Read literally, that includes non-blocking observations — and the developer is editing that code this round anyway, so it is the cheapest possible moment to act on them.
3. **`packages/db` compiles with `rootDir: "."`** so `migrations/` is emitted to `dist/migrations/` alongside `dist/src/`. A migration that exists only as TypeScript cannot run in an adopter's installation, and ADL ships schema upgrades into other people's databases.
4. **`FEATURES_COLUMNS` is paired with a compile-time exhaustiveness assertion.** `satisfies readonly (keyof FeaturesTable)[]` catches a name that is not a column; an `Exclude<...> extends never` assertion catches a column missing from the list. Drift fails the build in both directions, and the smoke test then compares that list to `PRAGMA table_info`.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-02 (Info disclosure — `Finding.location.path`) | mitigate | **Partially mitigated as planned.** `location` is optional, documented as workspace-relative, and no fixture carries a host path. The shared path guard rejecting absolute paths, `..`, drive letters, UNC prefixes, and NUL bytes is plan **01-07**'s, as the plan specifies. |
| T-1-05 (DoS — unbounded `spec.md`) | mitigate | **Mitigated.** `MAX_SPEC_BYTES = 1_048_576`, measured with `Buffer.byteLength(raw, 'utf8')` and enforced **before** `fromMarkdown` is called. |
| T-1-06 (Tampering — weakened published schema) | mitigate | **Mitigated for this plan's surface.** Zero `.refine()`/`.superRefine()` anywhere under `packages/core/src/verdict/`; every constraint is `z.literal`/`z.enum`/`.min()`/`.length()`/`.regex()`. The lint rule (01-03) and the 40-fixture equivalence test (01-04) still gate it mechanically. |
| T-1-11 (DoS — validation regexes) | accept | **Accepted as reviewed.** `^AC-\d+$` and the two helper regexes in `markdown.ts`/`finding.ts` are linear with no nested quantifiers. |
| T-1-SC (Tampering — parser/validator installs) | mitigate | **Mitigated.** Installed exactly the four versions recorded in 01-01-SUMMARY.md §1: `@cucumber/gherkin@42.0.1`, `@cucumber/messages@34.2.1`, `mdast-util-from-markdown@2.0.3`, `ajv@8.20.0`. No fresh resolution, no substitution. |

**One supply-chain addition beyond the gated set:** `@types/node@22.20.1` and `@types/better-sqlite3@9.6.0` — both DefinitelyTyped type-only packages with no runtime code and no install scripts. Recorded here rather than waved through silently.

**pnpm build-script allowlist:** pnpm 11 refuses install scripts unless allowlisted. Exactly two entries were added, each commented in `pnpm-workspace.yaml`: `esbuild` (links the platform binary Vitest needs) and `better-sqlite3` (`prebuild-install`). Notably, `better-sqlite3@13.0.3` ships prebuilds for all eight platform triples **inside the package**, so no download or `node-gyp` compilation occurred — verified by loading the driver directly.

## Known Stubs

| File | Stub | Why it is intentional | Resolved by |
|---|---|---|---|
| `packages/plugin-sdk/src/index.ts` | `export {}` and nothing else | Deliberate, and the reason is concurrency rather than scope: the workspace member must exist in `pnpm-lock.yaml` **before** Wave 3 begins, so that none of its seven concurrent plans has to run `pnpm install` and mutate the shared store underneath its siblings. The file carries a comment saying exactly this. | Plan **01-05** |

No other stubs. Nothing in `@adl/core` or `@adl/db` returns a hardcoded empty value, and no placeholder text was left behind.

## Issues Encountered

- **`corepack enable` is blocked in this sandbox**, so `pnpm` is not on `PATH`; every invocation went through `corepack pnpm`, which honours the `packageManager` field identically. This affected only how commands were typed here — it is why the `pretest` script was changed to call `tsc` directly rather than `pnpm`, which is a genuine robustness improvement for contributors whose corepack shims are not enabled either.
- **Git reports CRLF normalisation** on every file (`core.autocrlf` is on locally). Harmless for correctness — the byte-exactness assertions compare a slice of the same string that was read, so they hold under either line ending — but a `.gitattributes` would make the repository's line-ending policy explicit rather than per-developer. Not in this plan's file set; noted for whoever owns repo hygiene.

## Verification

Run from a dist-free working tree:

| Command | Result |
|---|---|
| `corepack pnpm install` | clean, lockfile up to date |
| `pnpm -r typecheck` | **3/3 packages Done** |
| `pnpm -r test` | **core 5 passed · db 6 passed · plugin-sdk 0 (by design)** |
| `pnpm -r build` | **3/3 packages Done** |
| `pnpm vitest run --project core` | 5 passed in **417 ms** (budget: 5 s) |
| `pnpm vitest run --project db` | 6 passed in 779 ms |
| `pnpm --filter @adl/db test` | 6 passed |
| `node -e "…packageManager"` | `pnpm@11.22.0` |
| `pnpm ls typescript --depth 0` | `typescript@6.0.3` (exact) |
| `grep -r "node:fs\|node:child_process\|process.env" packages/core/src` | **0 matches** |
| `grep -rl "better-sqlite3" packages --include=*.ts` | only `packages/db/src/migrator.ts` |
| `ls packages/core/src/index.ts` | does not exist, as required |
| `git status --short` | clean; `node_modules/`, `dist/`, `.gsd/` all ignored |

Additionally verified beyond the plan's checklist:
- The **compiled** migration path (`dist/migrations`) applies `0001_initial` under the same name as the source path.
- `better-sqlite3` loads from its bundled prebuild with no compilation.
- `pnpm -r test` is green after deleting every `dist/` directory, proving no hidden build prerequisite.

## Self-Check: PASSED

- All 38 files claimed above are present in `git ls-files`.
- Both commits exist: `11417c8`, `fa74993`.
- No file deletions in either commit.

## User Setup Required

None. `corepack prepare pnpm@11.22.0 --activate` is the only bootstrap step, and `packageManager` in `package.json` makes it automatic for anyone with corepack enabled.

## Next Phase Readiness

**All six Wave 3 plans are unblocked, and none of them needs to run `pnpm install`** — the lockfile already records all three workspace members and every dependency the phase uses.

Carry-forwards each Wave 3 plan should know:

- **01-03 (lint/CI):** the root `vitest.config.ts` already exists — add the `root` project to its `test.projects` rather than creating the file. The purity rule it enforces is already satisfied: `@adl/core/src` has zero filesystem, `child_process`, or `process.env` references, and `better-sqlite3` appears only in `packages/db/src/migrator.ts`.
- **01-04 (schema emission + exhaustive proof):** `ajv@8.20.0` is installed as an `@adl/core` devDependency. Import it from `ajv/dist/2020` per 01-01-SUMMARY.md §4a. `aggregate` is total and never throws, including on the empty list — where it returns `escalate`, which is the one behaviour worth confirming against your enumeration's expectations.
- **01-05 (`plugin-sdk`, stage):** `packages/plugin-sdk` is a working workspace member with `@adl/core` on the workspace protocol. Fill `src/index.ts`; no install needed. Note `@adl/core`'s `./stage` subpath is already declared in the exports map and awaits your `src/stage/index.ts`.
- **01-06 (Gherkin + format detection):** `@cucumber/gherkin@42.0.1` and `@cucumber/messages@34.2.1` are installed. `AcceptanceCriterion`'s `kind: 'scenario'` member already encodes A6's resolution — `examples?: { headers, rows }` sits beside the steps, one criterion per outline, **no per-row expansion**. `loadAdlTemplateSpec` currently assigns `AC-n` per-loader; D-02's one-flat-sequence-across-both-formats is yours to complete.
- **01-07 (`adl.yml`):** `yaml@2.9.0` is installed and `@adl/core`'s `./config` subpath is declared. The `FindingLocation` path guard (T-1-02) is yours; `FindingSchema.location` is currently `z.string().min(1)` on `path` and awaits it.
- **01-10 (contract tables + drift check):** `0001_initial.ts` is the only migration; add `0002_contracts.ts` beside it. `migrateToLatest` returns every result rather than logging it, and nothing writes to `kysely_migration` beyond Kysely itself — D-30's ADL-owned checksum table is clear to add. `FEATURES_COLUMNS` in `src/schema.ts` shows the pattern the generator-based drift check should extend.

**One open item for whoever owns documentation:** `D-26` in `01-CONTEXT.md` still reads "one dependency: Zod". `packages/core/README.md` now states the amended position ("Zod plus two parser families") with the reasoning, and 01-01-SUMMARY.md §3 records the amendment. The CONTEXT wording is still unreconciled.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
