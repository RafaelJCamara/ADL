---
phase: 01-core-contracts
plan: 08
subsystem: config
tags: [effective-config, interpolation, context-cascade, pipeline, exec-07, security]

# Dependency graph
requires:
  - "01-07 (adl.yml schema — AdlYmlSchema, LimitsSchema, AgentsConfigSchema, PipelineEntrySchema, RepoRelativePathSchema, DurationSchema)"
  - "01-09 (FEATURE_STATES, transition.ts — the lifecycle EXEC-07's proof must leave untouched)"
  - "01-10 (packages/db/migrations/ — the migration set EXEC-07's proof counts, and the features.state column EXEC-07's proof constrains)"
provides:
  - "mergeConfig — the three-way EffectiveConfig fold with daemon-enforced clamps (packages/core/src/config/effective-config.ts)"
  - "interpolate — closed-allowlist ${VAR} substitution, never process.env (packages/core/src/config/interpolate.ts)"
  - "resolveContextFiles/pickFirstPresent/CONTEXT_FILE_CASCADE — SPEC-05's four-file cascade behind an injected predicate (packages/core/src/config/context-cascade.ts)"
  - "resolvePipeline — built-in/npm/repo-path harness resolution (packages/core/src/config/pipeline.ts)"
  - "The EXEC-07 mechanical proof (packages/core/test/state/exec-07.test.ts)"
  - "0004_feature_state_constraint.ts — the features.state CHECK constraint (packages/db/migrations/)"
affects: []

actuals:
  tokens: 22300
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "mergeConfig clamps limits via an explicit per-field table (LIMITS_FIELDS), never a generic deep merge with an exception — a newly added limit field cannot arrive unclamped"
    - "interpolate's closed allowlist is the caller-supplied values object's own key set, not a hardcoded list inside the function — the caller decides what is substitutable per call site"
    - "pickFirstPresent/resolveContextFiles take an injected existence predicate; @adl/core performs no filesystem access itself, matching context-cascade's Architectural Responsibility Map split"
    - "resolvePipeline's registry (builtIns/npmPackages/repoPaths) is precomputed by the caller — resolution is a pure membership lookup in fixed tier order, never I/O"
    - "SQLite's 12-step table-rebuild dance (documented in 0001_initial.ts's header, never previously exercised) used to add a CHECK constraint without editing an applied migration"

key-files:
  created:
    - packages/core/src/config/effective-config.ts
    - packages/core/src/config/interpolate.ts
    - packages/core/src/config/context-cascade.ts
    - packages/core/src/config/pipeline.ts
    - packages/core/test/config/effective-config.test.ts
    - packages/core/test/config/interpolate.test.ts
    - packages/core/test/config/context-cascade.test.ts
    - packages/core/test/config/pipeline.test.ts
    - packages/core/test/state/exec-07.test.ts
    - packages/db/migrations/0004_feature_state_constraint.ts
    - .planning/phases/01-core-contracts/deferred-items.md
  modified:
    - packages/core/src/config/index.ts
    - packages/core/src/config/adl-yml.ts
    - packages/core/src/verdict/criterion-ref.ts
    - packages/core/src/verdict/finding.ts
    - packages/core/src/verdict/waiver.ts
    - packages/db/test/migrate.test.ts

key-decisions:
  - "EffectiveConfig's commands/context/pipeline/features_dir flow verbatim from the parsed AdlYml (already fully resolved by AdlYmlSchema's own defaults) — only limits and agents genuinely three-way-merge, since backend/model selection and cost ceilings are the only fields D-22 makes daemon-authoritative."
  - "mergeConfig does not resolve the context-file cascade. Cascade resolution needs real filesystem access (an injected predicate), which mergeConfig's pure, synchronous signature cannot accept — EffectiveConfig.context.files may still be undefined; a later phase with real I/O calls resolveContextFiles separately against the frozen EffectiveConfig."
  - "interpolate() throws LoadError rather than returning a discriminated result, matching parseDuration's established throw-based style in this same directory (adl-yml.ts's own parseAdlYml is the one function in this directory that returns rather than throws, and only because it batches many independent field errors)."

requirements-completed: [SPEC-03, SPEC-05, EXEC-07]

coverage:
  - id: D1
    description: "A repo adl.yml raising a limit above the daemon's ceiling has that limit clamped; a repo lowering it keeps its lower value — for every field under limits, not one representative"
    requirement: "EXEC-07 (D-22)"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/effective-config.test.ts — 'mergeConfig — limits clamp down, never up' (6 tests, one per field plus absent/daemon-only cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A repo-supplied backend or model is rejected and reported, never merged in any form, asserted per agent role"
    requirement: "EXEC-07 (D-22)"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/effective-config.test.ts — 'mergeConfig — backend and model are daemon-only' (3 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "mergeConfig's result is deeply frozen, is pure, and validates against EffectiveConfigSchema"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/effective-config.test.ts — freeze/purity/schema-validation describe blocks (5 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "interpolate() substitutes only allowlisted names, never reads process.env; a system-path variable and an API-key variable both fail validation"
    requirement: "SPEC-03 (D-21)"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/interpolate.test.ts — 'interpolate — never reads the process environment' (2 tests, PATH and ANTHROPIC_API_KEY)"
        status: pass
    human_judgment: false
  - id: D5
    description: "CONTEXT_FILE_CASCADE is exactly the four documented filenames in the documented order; pickFirstPresent is pure, stateless, and short-circuits; resolveContextFiles applies the cascade only when nothing is declared"
    requirement: "SPEC-05"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/context-cascade.test.ts (12 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Harness resolution tries built-in, then npm, then repo-relative path in that order; an unknown id and a duplicate stage id both fail at resolution; the group: form is rejected as a future capability"
    requirement: "EXEC-07 (D-23)"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/pipeline.test.ts (13 tests)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Resolving a pipeline with an inserted stage leaves transition.ts's bytes and the migration count unchanged (self-relative), and FEATURE_STATES agrees with the features.state CHECK constraint in both directions"
    requirement: "EXEC-07"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/exec-07.test.ts (5 tests)"
        status: pass
    human_judgment: false

duration: ~3h
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 08: EffectiveConfig, Interpolation, Context Cascade, Pipeline Resolution Summary

**Defaults, daemon configuration, and a repository's `adl.yml` fold into one deeply frozen `EffectiveConfig` whose `limits` can only be lowered and whose agent backend/model are daemon-only and never merged; ADL's own `${VAR}` interpolation substitutes from a closed allowlist that never touches `process.env`; the SPEC-05 context-file cascade resolves through an injected existence predicate; harnesses resolve through a built-in/npm/repo-path registry; and `exec-07.test.ts` proves — by hashing bytes and cross-checking a newly added database CHECK constraint against `FEATURE_STATES` — that adding a gate touches neither the lifecycle module nor the migration set.**

## Accomplishments

- **`effective-config.ts`** — `mergeConfig(defaults, daemon, repo)` folds the three inputs with two explicit rules rather than a generic deep merge: every `limits` field is clamped down (never up) to the daemon's ceiling via a small field table (`LIMITS_FIELDS`), and every `DAEMON_ONLY_FIELDS` entry (`agents.{role}.backend`/`.model`) is taken from the daemon with the repo's attempt discarded and reported in `MergeReport`. The result is deeply frozen — `deepFreeze` walks nested objects before `Object.freeze`, so a mutation attempt on `config.limits.max_rounds` throws in strict mode.
- **`interpolate.ts`** — `interpolate(template, values)` matches only a linear `${bareIdentifier}` form and substitutes exclusively from the caller-supplied `values` object's own key set; an unrecognised name (including a plausible-looking ADL variable the caller simply did not pass) raises `LoadError` naming it. Never reads `process.env`; the negative tests assert this by setting `process.env.PATH`/`ANTHROPIC_API_KEY` to sentinel values and confirming they never appear in output.
- **`context-cascade.ts`** — `CONTEXT_FILE_CASCADE` is the frozen four-entry tuple `AGENTS.md → CLAUDE.md → .github/copilot-instructions.md → README.md` (quoted verbatim from `.planning/REQUIREMENTS.md` § Feature Intake). `pickFirstPresent` is a pure, stateless short-circuiting search over an injected predicate; `resolveContextFiles` applies the cascade only when `context.files` is absent or empty.
- **`pipeline.ts`** — `resolvePipeline(entries, registry)` resolves each entry against a three-tier registry (built-in → npm package → repo-relative path), rejecting an unresolvable id, a duplicate resolved stage id, and the `group:` syntax (as the exact rejection message `adl-yml.ts`'s schema itself uses) — all before any tier is consulted, the repo-relative path guard runs first and unconditionally.
- **`exec-07.test.ts`** — hashes `transition.ts`'s bytes and counts `packages/db/migrations/` before and after resolving a pipeline that gained a stage (self-relative, so a legitimate migration added by a concurrent plan cannot fail it for the wrong reason), then reads every migration file as text and cross-checks `FEATURE_STATES` against the `features.state` CHECK constraint in both directions, plus asserts `state_version` is declared.

## Deviations from Plan

Four deviations, all Rule 1 or Rule 2, none architectural (no Rule 4). Each is scoped to a single upstream file and independently verified not to break that plan's own test suite.

### 1. [Rule 2 — missing critical functionality] `features.state` had no CHECK constraint

- **Found during:** Task 3, writing `exec-07.test.ts`'s cross-check against the plan's own must_have: "`FEATURE_STATES` ... and the `features` table's state constraint ... agree in both directions."
- **Issue:** `0001_initial.ts` declared `state text not null` with no enumeration of valid values — there was nothing for the cross-check to check. `0002_contracts.ts` added CHECK constraints for every other enumerated column (`outcome`, `severity`, `cost_source`, …) but not this one.
- **Fix:** Added `packages/db/migrations/0004_feature_state_constraint.ts` — additive, per D-29. Rebuilds the `features` table via SQLite's table-rebuild dance (`0001_initial.ts`'s own header names this exact technique for exactly this situation) inside one ordinary `db.transaction()`. The dance's usual `PRAGMA foreign_keys` toggle-outside-transaction step is unnecessary here: verified by grep that `PRAGMA foreign_keys` is never enabled anywhere in this codebase, so SQLite raises no referential-integrity concern over the drop/recreate. `0001_initial.ts` through `0003_seed_model_prices.ts` are untouched (verified: `git diff --exit-code` against the pre-Task-3 tree for those three files).
- **Files added:** `packages/db/migrations/0004_feature_state_constraint.ts`; **files modified:** `packages/db/test/migrate.test.ts` (added two tests proving the constraint functionally — accepts all 11 states, rejects an unknown one — beyond `exec-07.test.ts`'s textual check).
- **Commit:** `6380c05`

### 2. [Rule 1 — bug] `HarnessEntrySchema.harness` (01-07) could never express an npm package name or a repo-relative path

- **Found during:** Task 3, implementing `resolvePipeline`'s three-tier resolution.
- **Issue:** `HarnessEntrySchema.harness` used `StageIdSchema` (`^[a-z][a-z0-9-]*$` — bare identifiers only). D-23's resolution order names an npm package name (which may contain `@scope/`) and a repo-relative path (which needs `/`) as two of the three candidate shapes; neither can ever pass that pattern, so two-thirds of the documented resolution order was structurally unreachable via the schema.
- **Fix:** Changed `HarnessEntrySchema.harness` to `RepoRelativePathSchema` — broad enough to admit a bare identifier, a scoped npm package name, or a real repo-relative path, while still rejecting traversal, absolute paths, and NUL bytes (needed regardless, since the value may be resolved as a filesystem path). No existing 01-07 test asserted the narrower pattern; `adl-yml.test.ts` still passes 38/38 unchanged.
- **Files modified:** `packages/core/src/config/adl-yml.ts` (also exported `GROUP_SYNTAX_REJECTION`, previously module-private, so `pipeline.ts` and its test can reuse the exact rejection message rather than duplicating the string).
- **Commit:** `6380c05`

### 3. [Rule 1 — bug] `ContextConfigSchema.files` (01-07) defaulted to `['README.md']`, silently defeating the cascade

- **Found during:** Task 2, implementing `resolveContextFiles`.
- **Issue:** `ContextConfigSchema.files` had `.default(['README.md'])`, and `AdlYmlSchema`'s own `context` default additionally supplied `files: ['README.md']` when `context:` was omitted entirely. Either default makes an undeclared `context.files` indistinguishable, after parsing, from one explicitly set to `['README.md']` — `resolveContextFiles` would see a populated array in both cases and never apply SPEC-05's actual four-file cascade.
- **Fix:** Removed both defaults; `files` is now `.optional()` with no default, `undefined` when the maintainer declares nothing. No existing 01-07 test asserted the removed default value; `adl-yml.test.ts` still passes 38/38 unchanged.
- **Files modified:** `packages/core/src/config/adl-yml.ts`.
- **Commit:** `ad3f85a`

### 4. [Rule 1 — bug, formatting only] Three 01-02 files and this plan's own new files were not Prettier-clean

- **Found during:** the dispatch context's own upstream note (three `verdict/` files) plus this plan's own whole-workspace `pnpm format` gate (this plan's twelve new/modified files).
- **Fix:** `prettier --write` on exactly those fifteen files. No logic changes; verified by re-running each affected package's test suite (core 404/404, db 43/43) after reformatting.
- **Files modified:** `packages/core/src/verdict/{criterion-ref,finding,waiver}.ts`, plus the twelve 01-08 files listed under `key-files`.
- **Commits:** `f5868bb`, `f628be5`

**Not fixed (documented, not this plan's scope):** `pnpm lint` and `pnpm format` both still fail at the whole-workspace level — 15 pre-existing ESLint errors (01-02, 01-05, 01-10) and 55 pre-existing Prettier diffs (01-01/01-02/01-05/01-07/01-09/01-10), all in files written before `eslint.config.js`/`.prettierrc.json` existed and outside this plan's `files_modified`. Full detail in `.planning/phases/01-core-contracts/deferred-items.md`, per the dispatch context's explicit instruction to report rather than fix.

## Decisions Made

Beyond the deviations above:

1. **`EffectiveConfig`'s `commands`/`context`/`pipeline`/`features_dir` are the parsed `AdlYml`'s values verbatim**, not independently merged — `AdlYmlSchema` already resolves its own defaults for these fields (or requires them outright, for `commands`/`pipeline`), and none of them is daemon-authoritative under D-22. Only `limits` and `agents` genuinely three-way-merge.
2. **`mergeConfig` does not itself resolve the context cascade.** Its signature is pure and synchronous; `resolveContextFiles` needs a real filesystem predicate. `EffectiveConfig.context.files` can be `undefined` after merging — a later phase with real I/O calls `resolveContextFiles` against the frozen `EffectiveConfig` separately.
3. **`interpolate`'s allowlist is the `values` argument's own key set**, not `ADL_VARIABLES` consulted internally. A caller that (correctly) passes only the variables relevant to one call site gets a validation error for any other name — including a legitimate ADL variable it simply did not supply this time. `ADL_VARIABLES` exists as the documented complete vocabulary for callers and tests to reference, not as an internal allowlist `interpolate` reads.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-09 (Elevation of Privilege — `mergeConfig` limits clamping) | mitigate | **Mitigated.** Per-field clamp table (`LIMITS_FIELDS`), never a generic deep merge; every clamp reported in `MergeReport.clamped`, asserted per field. |
| T-1-27 (Elevation of Privilege — repo-supplied backend/credential selection) | mitigate | **Mitigated.** `DAEMON_ONLY_FIELDS` discards repo-supplied `agents.*.backend`/`.model` entirely and reports the attempt, asserted per role. |
| T-1-03 (Information Disclosure — `interpolate` variable substitution) | mitigate | **Mitigated.** Closed allowlist via `values`'s key set; unknown names raise `LoadError`, never empty-string substitution; `process.env` is never read (asserted directly by sentinel-value tests, not merely by code inspection). |
| T-1-02 (Information Disclosure — harness path candidates and resolved context files) | mitigate | **Mitigated.** Every repo-relative harness path flows through `isRepoRelativePath` before any registry tier is consulted; `HarnessEntrySchema.harness` now uses the same guard at the schema layer (deviation 2). |
| T-1-28 (Tampering — mid-flight configuration change reaching a running feature) | mitigate | **Mitigated.** `mergeConfig`'s result is deeply frozen (`deepFreeze`); a nested property assignment throws in strict mode, asserted directly. |
| T-1-29 (Tampering — duplicate stage ids corrupting verdict/coverage joins) | mitigate | **Mitigated.** `resolvePipeline` rejects two entries resolving to the same stage id with a named `HarnessResolutionError`. |
| T-1-11 (DoS — the interpolation pattern) | accept | **Accepted as reviewed.** `VARIABLE_REF_PATTERN` matches only a bare identifier with no wildcard and no nested quantifier; reviewed against catastrophic backtracking, consistent with `path-guard.ts`'s and `duration.ts`'s established patterns in this same directory. |

## Known Stubs

None. Every exported function is fully implemented against its documented behaviour; no placeholder branches, no hardcoded empty returns.

## Threat Flags

None — every new trust-boundary-adjacent surface (interpolation, harness resolution, the config merge) was already named in this plan's own `<threat_model>` and is covered in the table above.

## Verification

| Command | Result |
|---|---|
| `pnpm vitest run --project core packages/core/test/config/effective-config.test.ts` | 14 passed |
| `pnpm vitest run --project core packages/core/test/config/interpolate.test.ts packages/core/test/config/context-cascade.test.ts` | 23 passed |
| `pnpm vitest run --project core packages/core/test/config/pipeline.test.ts packages/core/test/state/exec-07.test.ts` | 18 passed |
| `pnpm vitest run --project core` (full package) | 404 passed, 22 files |
| `pnpm --filter @adl/db test` | 43 passed (up from 41 — the two new state-constraint tests) |
| `pnpm --filter @adl/plugin-sdk test` | 8 passed |
| `pnpm exec vitest run --project root` | 18 passed |
| `pnpm -r typecheck` | 3/3 packages Done |
| `pnpm -r build` | 3/3 packages Done |
| `pnpm -r test` | core 404 · db 43 · plugin-sdk 8 = 455; + root 18 = **473 total** (up from 416 before this plan) |
| `pnpm exec eslint .` (whole workspace) | **15 errors, all outside 01-08's `files_modified`** — see Deviations and `deferred-items.md`. 01-08's own files individually lint-clean. |
| `pnpm exec prettier --check .` (whole workspace) | **55 files outside 01-08's `files_modified` still diff** — see Deviations and `deferred-items.md`. 01-08's own files individually Prettier-clean. |
| `git status --short` after build | clean — `dist/` correctly gitignored |

## Self-Check: PASSED

- All 11 created files and 6 modified files listed under `key-files` are present (`git ls-files` / `git diff --stat` against the wave-4 base).
- All 5 commits exist in `git log`: `60a6cda`, `ad3f85a`, `6380c05`, `f5868bb`, `f628be5`.
- No file deletions in any commit (`git diff --diff-filter=D` empty for every commit range checked).
- `0001_initial.ts`, `0002_contracts.ts`, `0003_seed_model_prices.ts` verified byte-unchanged (`git diff --exit-code`) throughout Task 3.

## User Setup Required

None.

## Next Phase Readiness

Phase 01 (Core Contracts) is complete — this was the phase's final plan. `@adl/core/config` now exports the full resolution surface (`mergeConfig`, `interpolate`, `resolveContextFiles`, `resolvePipeline`) alongside 01-07's validation surface. Carry-forwards for Phase 2 and beyond:

- **`EffectiveConfig` is the shape to snapshot into a feature row at lease time** (`ARCHITECTURE.md` §2) — it is already frozen; the manager only needs to store it, never re-merge it mid-flight.
- **`resolveContextFiles` and `resolvePipeline`'s registries both need real I/O from their caller** — a filesystem existence predicate and precomputed built-in/npm/repo-path sets respectively. `@adl/core` intentionally does not perform that I/O itself; Phase 2's workspace layer is where it belongs.
- **`0004_feature_state_constraint.ts` is now the SQLite table-rebuild dance's first real exercise** in this codebase — the technique `0001_initial.ts`'s header predicted but had never been used. Any future migration needing the same dance (e.g., a constraint on a heavily-referenced table where `PRAGMA foreign_keys` genuinely is enabled) should read this migration's file header first.
- **`.planning/phases/01-core-contracts/deferred-items.md`** lists every pre-existing ESLint/Prettier finding discovered by this plan's whole-workspace gate, organized by owning plan — the natural first stop for `/gsd-verify-work` or whoever next touches those files.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
