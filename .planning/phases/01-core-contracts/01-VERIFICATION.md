---
phase: 01-core-contracts
verified: 2026-08-17T19:00:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 1: Core Contracts Verification Report

**Phase Goal:** Every downstream component speaks one settled vocabulary — verdicts, findings,
criterion IDs, normalized specs, and target-repo configuration — so no later phase can force a
contract migration.
**Verified:** 2026-08-17T19:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

**Note on `Mode: mvp`:** ROADMAP.md tags this phase (and every other phase in the roadmap)
`Mode: mvp`, but the phase goal is a settled-vocabulary/contract statement, not a
`As a [role], I want [capability], so that [outcome].` user story
(`user-story.validate` returns `valid: false`, missing all three slots). Since every phase in
this roadmap carries the same tag and none are phrased as user stories, this reads as a
project-wide workflow toggle rather than a per-phase SPIDR-sliced MVP goal, and the task brief
supplied standard "must be TRUE" success criteria to verify against. Standard goal-backward
verification was used; this is flagged for awareness, not treated as a blocker.

## Goal Achievement

### Observable Truths

| # | Truth (= ROADMAP Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | A gate result is exactly one of six outcomes, only `send_back` consumes a round, a malformed/unparseable verdict is an infrastructure failure (never a gate failure costing a round), and a developer that believes a gate is wrong has an honest escalation outcome. | ✓ VERIFIED | `packages/core/src/verdict/verdict.ts` — `OUTCOMES` frozen 6-tuple, `VerdictSchema` discriminated union, `consumesRound()` returns true only for `send_back`. `packages/core/src/stage/stage-error.ts` — `StageError`/`StageOutcome` sit **outside** the `Verdict` union (`isStageError`), `parseStageOutput` routes unparseable payloads to `StageError{kind:'unparseable'}` after exactly one repair reprompt, `stageErrorPolicy('unparseable').consumesRound === false` for every kind. `packages/core/src/stage/developer-outcome.ts` — `DeveloperOutcomeSchema` has exactly 3 members (`committed`/`dispute`/`blocked`), no `pass`/`outcome` field, `DisputeSchema` requires `criterionRef`+`target`+`argument`, `DEVELOPER_OUTCOME_ROUND_COST` is 0 for all three kinds. Compile-time mutual non-assignability asserted in `test/stage/type-boundary.test-d.ts`. All exercised by 404 passing tests in `packages/core`. |
| 2 | No combination of verdicts containing `inconclusive` can compute to a green result — proven exhaustively — and every finding carries fingerprint, severity, source location, and its acceptance-criterion ID or fails validation. | ✓ VERIFIED | `packages/core/src/verdict/aggregate.ts` — precedence `fail → send_back → inconclusive → green`, green reachable from exactly one return statement gated behind the other three. `packages/core/test/verdict/aggregate.exhaustive.test.ts` — enumerates all 3,002 multisets (lengths 1–8, asserted per-length counts 6/21/56/126/252/462/792/1287), asserts zero offenders producing `green` while containing `inconclusive`, plus permutation-invariance and schema-validity across the whole set; test run confirmed passing. `packages/core/src/verdict/finding.ts` — `FindingSchema` requires `fingerprint` (64-char), `severity` (enum), `criterionRef` (required, not optional); `location.path` uses `RepoRelativePathSchema` (traversal/absolute/UNC/NUL rejected). `finding.test.ts` line 30 explicitly asserts "requires criterionRef". |
| 3 | A structured ADL spec and a Gherkin/BDD feature file both load into one normalized shape with individually addressable acceptance-criterion IDs, with the author's original text retained verbatim alongside. | ✓ VERIFIED | `packages/core/src/spec/types.ts` — `NormalizedSpec.raw` always the verbatim source, `acceptanceCriteria[].text` + `SourceSpan{start,end}` so `raw.slice(start,end) === text` is checkable. `packages/core/src/spec/criterion-ids.ts` — `assignCriterionIds` is the single format-blind assignment point producing one flat `AC-n` sequence for both `markdown.ts` (adl-template) and `gherkin.ts` loaders; refuses empty criteria sets. Exercised by `test/spec/markdown.test.ts`, `test/spec/gherkin.test.ts`, `test/spec/criterion-ids.test.ts`, `test/spec/detect-format.test.ts`, `test/spine.e2e.test.ts`. |
| 4 | An `adl.yml` validates its build, start, test, and teardown commands and its explicit `ready`/`ready_timeout` contract, and resolves context files through the `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` cascade when none are declared. | ✓ VERIFIED | `packages/core/src/config/adl-yml.ts` — `CommandsSchema` requires all four lifecycle commands (`argv` array, never a shell string); `StartCommandSpecSchema.superRefine` enforces `ready`/`ready_timeout` both-or-neither. `packages/core/src/config/context-cascade.ts` — `CONTEXT_FILE_CASCADE` is the exact 4-file, SPEC-05-ordered tuple; `resolveContextFiles` applies it only when `config.files` is absent/empty, via `pickFirstPresent`. Exercised by `test/config/adl-yml.test.ts`, `test/config/context-cascade.test.ts`, `test/config/duration.test.ts`, `test/config/path-guard.test.ts`, `test/config/yaml-security.test.ts`. |
| 5 | A new gate stage is added to the pipeline by configuration alone — the lifecycle transition function is untouched and no schema migration is required. | ✓ VERIFIED | `packages/core/src/state/transition.ts` — `gate_passed` edge moves `currentStageIndex` by a list index only; the module never references a stage id or stage name. `packages/core/test/state/exec-07.test.ts` — mechanically hashes `transition.ts`'s bytes and counts `packages/db/migrations/*.ts` before/after `resolvePipeline` is given a 4th stage (`{harness:'security'}`); asserts both are byte/count-identical, and separately cross-checks `FEATURE_STATES` against the migrations' `CHECK` constraint in both directions. Test run confirmed passing. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts (representative sample — 10 plans, ~120 files reviewed by 01-REVIEW.md)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/core/src/verdict/verdict.ts` | Six-outcome `Verdict` union + `consumesRound` | ✓ VERIFIED | Read in full; matches CORE-01 exactly |
| `packages/core/src/verdict/finding.ts` | `Finding` schema with fingerprint/severity/location/criterionRef | ✓ VERIFIED | Read in full; `location.path` uses `RepoRelativePathSchema` (WR-01 fix confirmed present) |
| `packages/core/src/verdict/aggregate.ts` | Pure `aggregate()` reducer, CORE-02 enforcement point | ✓ VERIFIED | Read in full; single `green` return path |
| `packages/core/src/stage/stage-error.ts` | `StageError` channel outside `Verdict` union, parse ladder | ✓ VERIFIED | Read in full |
| `packages/core/src/stage/developer-outcome.ts` | `DeveloperOutcome` (no `pass` member) | ✓ VERIFIED | Read in full |
| `packages/core/src/spec/types.ts`, `criterion-ids.ts`, `index.ts` | `NormalizedSpec` + `AC-n` assignment | ✓ VERIFIED | Read in full |
| `packages/core/src/config/adl-yml.ts` | `adl.yml` schema, commands, ready/ready_timeout | ✓ VERIFIED | Read in full (621 lines) |
| `packages/core/src/config/context-cascade.ts` | SPEC-05 4-file cascade | ✓ VERIFIED | Read in full |
| `packages/core/src/config/path-guard.ts` | `RepoRelativePathSchema` traversal guard | ✓ VERIFIED | Read in full; regex correctly rejects absolute/`..`/drive-letter/UNC/NUL |
| `packages/core/src/state/transition.ts` | Pure lifecycle `transition()` | ✓ VERIFIED | Read in full (272 lines); EXEC-07 property confirmed by code and by test |
| `packages/core/src/config/effective-config.ts` | `DEFAULT_CONFIG.limits` derivation | ✓ VERIFIED | WR-03 fix confirmed: now `LimitsSchema.parse({})` instead of a duplicated literal |
| `packages/db/src/checksum.ts` | Migration checksum guard | ✓ VERIFIED | WR-02 fix confirmed: `ensureChecksumTable`/`recordMigrationChecksum`/etc. now generic `<DB>`, `any` retained only where forced by Kysely's own `Migration.up(db: Kysely<any>)` interface |
| `packages/db/src/schema.ts` | `findings`/`verdicts` tables matching `Finding`/`Verdict` shape | ✓ VERIFIED | `FindingsTable` carries `fingerprint`, `severity`, `criterion_ref_kind`/`criterion_id`/`global_category`, `path`/`line`/`end_line` |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `finding.ts` `FindingLocationSchema.path` | `path-guard.ts` `RepoRelativePathSchema` | import | ✓ WIRED | Confirmed by direct read; closes 01-REVIEW.md WR-01 |
| `effective-config.ts` `DEFAULT_CONFIG.limits` | `adl-yml.ts` `LimitsSchema` | `LimitsSchema.parse({})` | ✓ WIRED | Closes 01-REVIEW.md WR-03; single source of truth |
| `transition.ts` `SEND_BACK_ROUND_DELTA` | `verdict.ts` `consumesRound()` | derived constant, not restated | ✓ WIRED | Prevents the two round-accounting rules from diverging |
| `aggregate.exhaustive.test.ts` | `aggregate.ts` | direct call across 3,002 generated cases | ✓ WIRED | Test executed during this verification; 0 offenders |
| `exec-07.test.ts` | `transition.ts` (hash) + `packages/db/migrations/*` (count) | filesystem read + `resolvePipeline` | ✓ WIRED | Test executed during this verification; both invariants hold |
| CI `Lint`/`Format` steps | `eslint.config.js` / `.prettierrc.json` | `pnpm lint` / `pnpm format`, no `continue-on-error` | ✓ WIRED | Closes 01-REVIEW.md WR-04 by genuinely fixing rather than masking; confirmed green in GitHub Actions run 32047082650 |

### Behavioral Spot-Checks / Test Execution

| Behavior | Command | Result | Status |
|---|---|---|---|
| Full workspace test suite (once) | `corepack pnpm -r test` | `core`: 404/404 passed · `db`: 43/43 passed · `plugin-sdk`: 8/8 passed (455 total) | ✓ PASS |
| Lint clean (post WR-02/WR-04) | `node_modules/.bin/eslint .` | 0 errors, 0 warnings | ✓ PASS |
| Format clean (post WR-04) | `node_modules/.bin/prettier --check .` | "All matched files use Prettier code style!" | ✓ PASS |
| JSON Schema equivalence (CORE-04, includes WR-01 path-guard) | `vitest run json-schema-equivalence.test.ts` | 50/50 passed | ✓ PASS |
| CI matrix, both `engines`-floor legs | `gh run view 32047082650` (latest push, on top of all 6 review-fix commits) | `verify (node 22)` ✓ 32s, `verify (node 24)` ✓ 32s | ✓ PASS |

### Code Review Fix Verification (WR-01 through WR-04)

| Finding | Commit | Verified Landed | Verified No Regression |
|---|---|---|---|
| WR-01: `FindingLocation.path` lacked traversal guard | `7287e02` | ✓ — `finding.ts` now imports `RepoRelativePathSchema`; `verdict.schema.json` re-emission (byte-identity test) still passes | ✓ — `json-schema-equivalence.test.ts` 50/50 green |
| WR-02: `Kysely<any>` only partially forced | `28be425` | ✓ — `checksum.ts`'s 4 ADL-owned functions are generic `<DB>`; the 6 occurrences forced by Kysely's own `Migration` interface remain `any`, now with a scoped, documented eslint-disable | ✓ — `db` package 43/43 tests green, `eslint .` clean |
| WR-03: `limits` defaults duplicated in two places | `ff022f9` | ✓ — `DEFAULT_CONFIG.limits` now derives from `LimitsSchema.parse({})` | ✓ — `core` package 404/404 tests green |
| WR-04: CI `Lint`/`Format` red on merged tree | `2a2e52b`, `6b95687`, `cf41260` | ✓ — option (a) taken: 15 lint errors resolved (4 generics + `ignoreRestSiblings: true` for the other 5), 55 files reformatted in a dedicated commit; no `continue-on-error` added | ✓ — confirmed independently via a fresh local `eslint .`/`prettier --check .` run (both clean) and via the live GitHub Actions run on the tip commit (both node legs green) |

`deferred-items.md` correctly documents this resolution and is internally consistent with what actually landed.

### Requirements Coverage

| Requirement | Source Plan(s) | Status | Evidence |
|---|---|---|---|
| CORE-01 | 01-02, 01-03 | ✓ SATISFIED | `verdict.ts`, `schema.test.ts` |
| CORE-02 | 01-03, 01-04 | ✓ SATISFIED | `aggregate.ts`, `aggregate.exhaustive.test.ts` |
| CORE-03 | 01-03, 01-05 | ✓ SATISFIED | `developer-outcome.ts` |
| CORE-04 | 01-02, 01-03, 01-04 | ✓ SATISFIED | `finding.ts`, `json-schema-equivalence.test.ts` |
| CORE-05 | 01-02, 01-03, 01-06 | ✓ SATISFIED | `types.ts`, `criterion-ids.ts`, `markdown.test.ts` |
| CORE-06 | 01-03, 01-05 | ✓ SATISFIED | `stage-error.ts`, `stage-error.test.ts` |
| SPEC-01 | 01-01, 01-02, 01-06 | ✓ SATISFIED | `markdown.ts`, `markdown.test.ts` |
| SPEC-02 | 01-01, 01-06 | ✓ SATISFIED | `gherkin.ts`, `gherkin.test.ts` |
| SPEC-03 | 01-07, 01-08 | ✓ SATISFIED | `adl-yml.ts`, `effective-config.ts` |
| SPEC-04 | 01-07 | ✓ SATISFIED | `StartCommandSpecSchema.superRefine` in `adl-yml.ts` |
| SPEC-05 | 01-08 | ✓ SATISFIED | `context-cascade.ts` |
| EXEC-07 | 01-08, 01-09, 01-10 | ✓ SATISFIED | `transition.ts`, `exec-07.test.ts`, `pipeline.ts` |

No orphaned requirements — the phase's 12 declared requirements (CORE-01..06, SPEC-01..05, EXEC-07) exactly match REQUIREMENTS.md's Phase 1 mapping (12/12), and every ID is claimed by at least one plan's `requirements:` frontmatter.

Note: `REQUIREMENTS.md`'s own traceability table still marks these 12 rows `Pending` rather than `Done` — a documentation-currency gap, not a functional one; the underlying implementation is verified above.

### Anti-Patterns Found

None. Scanned `packages/core/src`, `packages/db/src`, `packages/plugin-sdk/src` for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` (zero hits) and for stub-shaped empty returns (the 4 hits found are legitimate sentinel returns inside real markdown/context-cascade parsing logic, not stubs).

### Human Verification Required

None. The one item 01-VALIDATION.md flags as manual-only — "CI matrix actually exercises the declared `engines` floor, no `continue-on-error`, both legs green" — was independently confirmed via `gh run view` against the live GitHub Actions run on the current tip commit (`cf41260`), both `node 22` and `node 24` legs green, no `continue-on-error` present in `ci.yml`. The other manual-only item (plan 01-01's package-legitimacy checkpoint) is a blocking human gate that already occurred before Wave 2 could execute — the phase's 10/10 plans are marked executed, so it was cleared at the time.

### Gaps Summary

None found. All 5 ROADMAP success criteria are backed by direct source reads (not SUMMARY claims), all 12 requirement IDs are covered with no orphans, the 4 code-review warnings (WR-01 through WR-04) are confirmed landed via their commits and independently re-verified against the current tree (fresh lint/format/test runs, not re-trust of the commit messages), and the CI matrix is green on the tip commit for both supported Node versions.

---

_Verified: 2026-08-17T19:00:00Z_
_Verifier: Claude (gsd-verifier)_
