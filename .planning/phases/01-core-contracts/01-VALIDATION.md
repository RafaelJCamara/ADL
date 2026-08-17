---
phase: 1
slug: core-contracts
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-17
updated: 2026-08-17
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `01-RESEARCH.md` § Validation Architecture. The Task ID / Plan / Wave columns and the Threat Refs were filled in on 2026-08-17 once the ten PLAN.md files existed; `/gsd-validate-phase` audits them after execution and sets `status: validated`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 |
| **Config file** | `vitest.workspace.ts` + `packages/core/vitest.config.ts` + `packages/db/vitest.config.ts` + `packages/plugin-sdk/vitest.config.ts` (all plan **01-02**), plus the root `vitest.config.ts` registering the `root` project (plan **01-03**) |
| **Vitest projects** | `core`, `db`, `plugin-sdk`, `root` |
| **Quick run command** | `pnpm vitest run --project core` |
| **Full suite command** | `pnpm -r typecheck && pnpm lint && pnpm format && pnpm -r test` |
| **Estimated runtime** | ~5 seconds quick (pure unit, no I/O) · ~45 seconds full (adds temp-file SQLite migrations + typecheck + lint) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --project core`
- **After every plan wave:** Run the full suite
- **Before `/gsd-verify-work`:** Full suite green **and** `pnpm --filter @adl/db test` (temp-DB migrations) **and** `pnpm --filter @adl/core emit:schema:check` (the emitted `verdict.schema.json` byte-matches its committed copy)
- **Max feedback latency:** 5 seconds (quick), 45 seconds (full)

### Wave-scoping note (why the full suite is not every plan's gate)

Wave 3 runs seven plans concurrently (01-03 through 01-07, 01-09, 01-10), six of which write under `packages/core/src/` or `packages/db/src/`. A workspace-wide `pnpm lint`, `pnpm -r typecheck`, or `pnpm -r test` inside any of those plans would read half-written sibling modules — failing for unrelated reasons, or passing on a lucky interleaving, which is worse. Those plans therefore gate on **path-scoped** runs over the files they own plus the settled files plan 01-02 committed.

The workspace-wide pass runs once, from **plan 01-08 Task 3** — Wave 4's only member and the phase's last plan, the first point at which every source file is final. That single run is also this document's Full suite command and the exact command CI runs. If it is not green, the phase is not done.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01.T1 | 01-01 | 1 | C-2 (supply chain) | T-1-SC, T-1-SC2, T-1-SC3 | Every package installed in this phase is legitimacy-checked against its registry page before the first `pnpm add`; `[ASSUMED]`/`[SUS]` entries are human-confirmed and `[SLOP]` entries are refused | checkpoint | *(blocking human checkpoint — see § Manual-Only Verifications)* | ❌ W0 | ⬜ pending |
| 01-02.T1 | 01-02 | 2 | CORE-01, CORE-05, SPEC-01 | T-1-05, T-1-06 | The tracer: a real ADL-template `spec.md` becomes addressable `AC-n` criteria, a six-outcome verdict validates, and aggregation reaches a green `RoundOutcome` — with the inconclusive variant proven not green | integration | `pnpm vitest run --project core packages/core/test/spine.e2e.test.ts` | ❌ W0 | ⬜ pending |
| 01-02.T2 | 01-02 | 2 | EXEC-07 (D-29/D-30) | T-1-35 | The tracer reaches persistence: `0001_initial.ts` applies to a real temp SQLite file, the spec hash round-trips byte-identically, and a second migration run applies nothing | integration | `pnpm vitest run --project db packages/db/test/migrate.smoke.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T3 | 01-04 | 3 | CORE-01 | T-1-16 | Exactly six outcomes parse; a seventh is rejected; `consumesRound` true only for `send_back` | unit | `pnpm vitest run packages/core/test/verdict/schema.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T1 | 01-04 | 3 | CORE-02 | T-1-17 | No multiset containing `inconclusive` yields green — all 3,002 cases (pipeline lengths 1–8) | unit | `pnpm vitest run packages/core/test/verdict/aggregate.exhaustive.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T1 | 01-04 | 3 | CORE-02 | T-1-17 | `aggregate` is permutation-invariant; empty list handled | property | `pnpm vitest run packages/core/test/verdict/aggregate.exhaustive.test.ts` | ❌ W0 | ⬜ pending |
| 01-05.T2 | 01-05 | 3 | CORE-03 | T-1-07 | `DeveloperOutcomeSchema.safeParse({kind:'pass'})` fails | unit | `pnpm vitest run packages/core/test/stage/developer-outcome.test.ts` | ❌ W0 | ⬜ pending |
| 01-05.T2 | 01-05 | 3 | CORE-03 | T-1-22 | A dispute missing `criterionRef`/fingerprint/argument is malformed, not a dispute (D-06) | unit | `pnpm vitest run packages/core/test/stage/developer-outcome.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T3 | 01-04 | 3 | CORE-04 | T-1-02 | A finding without `criterionRef` fails; fingerprint length enforced; location path is workspace-relative (no traversal) | unit | `pnpm vitest run packages/core/test/verdict/finding.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T3 | 01-04 | 3 | CORE-04 | T-1-06 | **JSON-Schema equivalence** — 40-fixture corpus accepted/rejected identically by Zod and by the emitted schema (Pitfall 1: `z.toJSONSchema()` silently drops `.refine()`), plus byte-identity against a fresh emission | contract | `pnpm vitest run packages/core/test/verdict/json-schema-equivalence.test.ts` | ❌ W0 | ⬜ pending |
| 01-04.T2 | 01-04 | 3 | CORE-04 | T-1-06, T-1-18 | Re-emitting the published schema is a byte-level no-op, and a hand-edit to the committed copy makes the check exit non-zero | integration | `pnpm --filter @adl/core emit:schema:check` | ❌ W0 | ⬜ pending |
| 01-06.T3 | 01-06 | 3 | CORE-05 | T-1-24 | Criterion `text` is a byte-exact source slice; `raw` round-trips unchanged | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ W0 | ⬜ pending |
| 01-05.T1 | 01-05 | 3 | CORE-06 | T-1-19, T-1-20, T-1-21 | Malformed verdict → `StageError{kind:'unparseable'}`, never a `Verdict`; the parse ladder makes at most one repair reprompt; `rawRef` is a pointer capped at 16 KB head + 16 KB tail | unit | `pnpm vitest run packages/core/test/stage/stage-error.test.ts` | ❌ W0 | ⬜ pending |
| 01-05.T1 | 01-05 | 3 | CORE-06 | T-1-19 | `StageError` is not assignable to `Verdict` and `Verdict` is not assignable to `StageError` — a refactor unifying them fails the typecheck | type | `pnpm vitest typecheck --project core packages/core/test/stage/type-boundary.test-d.ts` | ❌ W0 | ⬜ pending |
| 01-05.T3 | 01-05 | 3 | CORE-01…06 (D-25) | — | `@adl/plugin-sdk` re-exports by **reference**: `PluginSdk.VerdictSchema === Core.VerdictSchema` for all five schemas, so two definitions cannot diverge | unit | `pnpm vitest run --project plugin-sdk` | ❌ W0 | ⬜ pending |
| 01-06.T3 | 01-06 | 3 | SPEC-01 | T-1-24 | Headings-only template parses; missing `## Acceptance Criteria` errors; empty section errors; nested bullets stay inside their parent | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ W0 | ⬜ pending |
| 01-06.T2 | 01-06 | 3 | SPEC-02 | T-1-24 | Gherkin parses; `Background` excluded; `Rule`-nested scenarios included; outline retains `Examples`; all 9 degenerate inputs from Pitfall 2 behave as specified | unit | `pnpm vitest run packages/core/test/spec/gherkin.test.ts` | ❌ W0 | ⬜ pending |
| 01-06.T3 | 01-06 | 3 | SPEC-01, SPEC-02 | — | Both formats produce one flat `AC-n` sequence (D-02); IDs deterministic across repeat parses (`IdGenerator.incrementing()`, not `uuid()`) | unit | `pnpm vitest run packages/core/test/spec/criterion-ids.test.ts` | ❌ W0 | ⬜ pending |
| 01-06.T1 | 01-06 | 3 | SPEC-01, SPEC-02 (D-17) | T-1-25 | Both spec files present → load error; neither → load error | unit | `pnpm vitest run packages/core/test/spec/detect-format.test.ts` | ❌ W0 | ⬜ pending |
| 01-07.T1 | 01-07 | 3 | SPEC-03 | T-1-10 | YAML enters through exactly one pinned entry point: alias bombs, duplicate keys, multi-document input, merge keys, and prototype-pollution keys are each refused or neutralised, proven by execution | unit | `pnpm vitest run packages/core/test/config/yaml-security.test.ts` | ❌ W0 | ⬜ pending |
| 01-07.T1 | 01-07 | 3 | SPEC-03 (D-21) | T-1-02, T-1-05, T-1-11 | Durations are a bounded closed vocabulary (`^\d+(ms\|s\|m\|h)$`, bare integers and negatives rejected); a repo-supplied path cannot express an absolute path, a parent segment, a drive letter, a UNC prefix, or a NUL byte | unit | `pnpm vitest run packages/core/test/config/duration.test.ts packages/core/test/config/path-guard.test.ts` | ❌ W0 | ⬜ pending |
| 01-07.T2 | 01-07 | 3 | SPEC-03 | T-1-01 | `build`/`start`/`test`/`teardown` validate as `argv` arrays; a shell string is rejected | unit | `pnpm vitest run packages/core/test/config/adl-yml.test.ts` | ❌ W0 | ⬜ pending |
| 01-07.T2 | 01-07 | 3 | SPEC-04 | T-1-26 | Each `ready` probe kind validates; `ready` without `ready_timeout` is rejected | unit | `pnpm vitest run packages/core/test/config/adl-yml.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T2 | 01-08 | 4 | SPEC-05 | — | Cascade order is exactly `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`; `pickFirstPresent` returns the first present | unit | `pnpm vitest run packages/core/test/config/context-cascade.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T1 | 01-08 | 4 | SPEC-03 (D-22) | T-1-09, T-1-27, T-1-28 | `limits.*` may only be lowered from the daemon ceiling; a repo-set `backend` is ignored/rejected; the merged config is frozen | unit | `pnpm vitest run packages/core/test/config/effective-config.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T2 | 01-08 | 4 | SPEC-03 (D-21) | T-1-03 | `${ADL_PORT}` interpolates; `${PATH}` and `${ANTHROPIC_API_KEY}` are validation errors | unit | `pnpm vitest run packages/core/test/config/interpolate.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T3 | 01-08 | 4 | EXEC-07 (D-23) | T-1-29 | Unknown `harness:` id fails at config validation; `group:` parses then rejects with a v2 message; duplicate resolved stage ids are refused | unit | `pnpm vitest run packages/core/test/config/pipeline.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T3 | 01-08 | 4 | EXEC-07 | — | Adding a stage changes neither `transition()`'s bytes nor the migration count | integration | `pnpm vitest run packages/core/test/state/exec-07.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T3 | 01-08 | 4 | EXEC-07 | T-1-30, T-1-33 | `FEATURE_STATES` (plan 01-09) and the `features` state constraint in the migration sources (plans 01-02/01-10) agree in **both** directions, and `state_version` is declared — the one cross-package seam neither Wave 3 plan could assert against the other | integration | `pnpm vitest run packages/core/test/state/exec-07.test.ts` | ❌ W0 | ⬜ pending |
| 01-09.T2 | 01-09 | 3 | EXEC-07 | T-1-30, T-1-31, T-1-32 | `transition` is total across the full state-by-event cross product, emits its own audit record, carries the optimistic-concurrency guard, and mutates neither argument | unit | `pnpm vitest run packages/core/test/state/transition.test.ts` | ❌ W0 | ⬜ pending |
| 01-03.T1 | 01-03 | 3 | CORE-01…06 (D-27) | T-1-06, T-1-12, T-1-13, T-1-15 | The dependency-graph lint rule **fails** on a deliberate violating fixture, the negative control proves the failure is caused by that rule, and every architecture rule resolves to severity `error` | integration | `pnpm vitest run --project root test/lint/no-restricted-imports.test.ts` | ❌ W0 | ⬜ pending |
| 01-10.T1 | 01-10 | 3 | EXEC-07 (D-29/D-30) | T-1-35, T-1-36 | Migrations apply cleanly to a temp SQLite file; the deferred tables are absent; a second run applies nothing | integration | `pnpm vitest run --project db packages/db/test/migrate.test.ts` | ❌ W0 | ⬜ pending |
| 01-10.T1 | 01-10 | 3 | EXEC-07 (D-28) | T-1-08 | Live schema matches the committed `Database` types in both directions, by introspecting the migrated database's own catalogue; all four usage token columns are nullable with no zero default | integration | `pnpm vitest run --project db packages/db/test/schema-drift.test.ts` | ❌ W0 | ⬜ pending |
| 01-10.T2 | 01-10 | 3 | EXEC-07 (D-30) | T-1-04 | Mutating an applied migration's bytes makes the runner **fail** (Kysely's `kysely_migration` has no checksum column — guard is ADL-owned); deleting a checksum row also fails; the real migrations are digest-identical at teardown | integration | `pnpm vitest run --project db packages/db/test/checksum-guard.test.ts` | ❌ W0 | ⬜ pending |
| 01-10.T3 | 01-10 | 3 | EXEC-07 (D-31) | T-1-34 | Pricing a usage event dated 2026-08-15 differs from one dated 2026-09-15 (`claude-sonnet-5`); an unknown model yields `costSource: 'unknown'`, never 0 | integration | `pnpm vitest run --project db packages/db/test/model-prices.test.ts` | ❌ W0 | ⬜ pending |
| 01-03.T2 | 01-03 | 3 | C-1 (constraint) | T-1-14 | Installed TypeScript is exactly 6.0.3 and satisfies typescript-eslint's peer range | integration | `pnpm vitest run --project root test/toolchain.test.ts` | ❌ W0 | ⬜ pending |
| 01-08.T3 | 01-08 | 4 | *(all)* | *(all)* | The full suite over the whole workspace — the first and only run in which plan 01-03's architecture rules are checked against every module written after them | integration | `pnpm -r typecheck && pnpm lint && pnpm format && pnpm -r test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*Task ID is `{plan}.T{n}` — the task number inside that plan's `<tasks>` block. `File Exists: ❌ W0` means the test file does not exist yet and is created by the named task; every one of them is created in the same task that needs it, so there is no orphan Wave 0 dependency.*

*Threat Refs were reconciled on 2026-08-17 against the `<threat_model>` blocks actually emitted by plans 01-01 through 01-10 (ASVS L1; block on `high`). `T-1-SC`/`T-1-SC2`/`T-1-SC3` are the supply-chain threats owned by plan 01-01's blocking human checkpoint.*

---

## Wave 0 Requirements

Legend: ☑ = a plan owns this item and the plan exists. The frontmatter's `wave_0_complete` flips to `true` only once those plans have executed green.

- [x] `vitest.workspace.ts` + per-package `vitest.config.ts` — **plan 01-02 Task 1** (root workspace file + `packages/core`), **Task 2** (`packages/db`, `packages/plugin-sdk` stub); the root-level `vitest.config.ts` registering the `root` project is **plan 01-03 Task 1**
- [x] `pnpm add -D -w vitest@4.1.10` — **plan 01-02 Task 1**, in the same install that pins `typescript@6.0.3`, `tsx`, `eslint`, `typescript-eslint`, and `prettier`
- [x] A JSON-Schema validator for the CORE-04 equivalence contract test — legitimacy-gated by **plan 01-01 Task 1** (recorded in `01-01-SUMMARY.md`, threat `T-1-SC2`) and installed as an `@adl/core` devDependency by **plan 01-02 Task 1**, so plan 01-04 installs nothing
- [x] `corepack prepare pnpm@11.22.0 --activate` — **plan 01-02 Task 1**, its first action; `packageManager` is pinned in the root `package.json` so contributors' installs match
- [x] `packages/core/test/fixtures/spec/` — **plan 01-02 Task 1** (`good/spec.md`, used by the tracer) and **plan 01-06 Task 2** (the `.feature` corpus and the 9 degenerate Gherkin inputs from Pitfall 2)
- [x] `packages/core/test/fixtures/verdicts/` — **plan 01-04 Task 3**, ~20 valid + ~20 invalid payloads, created in the same task as the equivalence test that consumes them
- [x] `packages/core/test/fixtures/adl-yml/` — **plan 01-07 Task 2**, one valid config per `ready` kind plus the shell-string, unknown-key, and missing-`ready_timeout` cases
- [x] `test/fixtures/lint/` — **plan 01-03 Task 1**, at `test/lint/fixtures/`: four deliberately violating modules for D-27's negative test, plus the negative control
- [x] `packages/db/test/helpers/temp-db.ts` — **plan 01-02 Task 2**, temp-file SQLite fixture with `finally` teardown

**Third workspace member front-loading (concurrency requirement).** `packages/plugin-sdk/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}` are created as an empty stub by **plan 01-02 Task 2**, one wave before plan 01-05 fills them in. This is deliberate: it completes `pnpm-lock.yaml` and `node_modules` before Wave 3 starts, so no Wave 3 plan has to run `pnpm install` and mutate the shared store underneath six concurrently-running siblings.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy for every package installed in this phase (plan 01-01 Task 1, threats `T-1-SC`/`T-1-SC2`/`T-1-SC3`) | C-2 (supply chain) | A registry page's provenance, publish cadence, and repository link are judgement calls no automated check settles; GSD forbids auto-approving a legitimacy checkpoint regardless of `workflow.auto_advance` | For each `[ASSUMED]`/`[SUS]` package, open its `npmjs.com/package` page and confirm the repository link, publish history, and maintainer before approving. Any `[SLOP]` entry is refused outright |
| CI matrix actually exercises the declared `engines` floor | C-1 (constraint) | Local dev runs Node 22.23.2; the Node 24 dev target and the `>=22.12.0` floor can only both be proven by a CI matrix, which cannot run on the dev machine | Confirm `.github/workflows/ci.yml` declares `node-version: [22, 24]`, carries no `continue-on-error`, and that both legs are green on the first push |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 45s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
