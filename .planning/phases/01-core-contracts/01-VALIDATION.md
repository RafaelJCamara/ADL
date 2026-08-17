---
phase: 1
slug: core-contracts
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-17
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `01-RESEARCH.md` § Validation Architecture. Task IDs are assigned by the planner; `/gsd-validate-phase` fills the Task ID / Plan / Wave columns once PLAN.md files exist.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 |
| **Config file** | none — Wave 0 installs (`vitest.workspace.ts` + per-package `vitest.config.ts`) |
| **Quick run command** | `pnpm vitest run --project core` |
| **Full suite command** | `pnpm -r test && pnpm -r typecheck && pnpm lint` |
| **Estimated runtime** | ~5 seconds quick (pure unit, no I/O) · ~45 seconds full (adds temp-file SQLite migrations + typecheck + lint) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --project core`
- **After every plan wave:** Run `pnpm -r test && pnpm -r typecheck && pnpm lint`
- **Before `/gsd-verify-work`:** Full suite green **and** `pnpm --filter @adl/db test` (temp-DB migrations) **and** the emitted `verdict.schema.json` byte-matches its committed copy
- **Max feedback latency:** 5 seconds (quick), 45 seconds (full)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | CORE-01 | — | Exactly six outcomes parse; a seventh is rejected; `consumesRound` true only for `send_back` | unit | `pnpm vitest run packages/core/test/verdict/schema.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-02 | — | No multiset containing `inconclusive` yields green — all 3,002 cases (pipeline lengths 1–8) | unit | `pnpm vitest run packages/core/test/verdict/aggregate.exhaustive.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-02 | — | `aggregate` is permutation-invariant; empty list handled | property | `pnpm vitest run packages/core/test/verdict/aggregate.exhaustive.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-03 | — | `DeveloperOutcomeSchema.safeParse({kind:'pass'})` fails | unit | `pnpm vitest run packages/core/test/verdict/developer-outcome.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-03 | — | A dispute missing `criterionRef`/fingerprint/argument is malformed, not a dispute (D-06) | unit | `pnpm vitest run packages/core/test/verdict/developer-outcome.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-04 | T-1-02 | A finding without `criterionRef` fails; fingerprint length enforced; location path is workspace-relative (no traversal) | unit | `pnpm vitest run packages/core/test/verdict/finding.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-04 | — | **JSON-Schema equivalence** — 40-fixture corpus accepted/rejected identically by Zod and by the emitted schema (Pitfall 1: `z.toJSONSchema()` silently drops `.refine()`) | contract | `pnpm vitest run packages/core/test/verdict/json-schema-equivalence.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-05 | — | Criterion `text` is a byte-exact source slice; `raw` round-trips unchanged | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-06 | — | Malformed verdict → `StageError{kind:'unparseable'}`, never a `Verdict`; `StageError` not assignable to `Verdict` (type test) | unit + type | `pnpm vitest run packages/core/test/verdict/stage-error.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-01 | — | Headings-only template parses; missing `## Acceptance Criteria` errors; empty section errors; nested bullets stay inside their parent | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-02 | — | Gherkin parses; `Background` excluded; `Rule`-nested scenarios included; outline retains `Examples`; all 9 degenerate inputs from Pitfall 2 behave as specified | unit | `pnpm vitest run packages/core/test/spec/gherkin.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-01, SPEC-02 | — | Both formats produce one flat `AC-n` sequence (D-02); IDs deterministic across repeat parses (`IdGenerator.incrementing()`, not `uuid()`) | unit | `pnpm vitest run packages/core/test/spec/criterion-ids.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-01, SPEC-02 (D-17) | — | Both spec files present → load error; neither → load error | unit | `pnpm vitest run packages/core/test/spec/detect-format.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-03 | T-1-01 | `build`/`start`/`test`/`teardown` validate as `argv` arrays; a shell string is rejected | unit | `pnpm vitest run packages/core/test/config/adl-yml.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-04 | — | Each `ready` probe kind validates; `ready` without `ready_timeout` is rejected | unit | `pnpm vitest run packages/core/test/config/adl-yml.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-05 | — | Cascade order is exactly `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`; `pickFirstPresent` returns the first present | unit | `pnpm vitest run packages/core/test/config/context-cascade.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-03 (D-22) | T-1-01 | `limits.*` may only be lowered from the daemon ceiling; a repo-set `backend` is ignored/rejected | unit | `pnpm vitest run packages/core/test/config/effective-config.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SPEC-03 (D-21) | T-1-03 | `${ADL_PORT}` interpolates; `${PATH}` and `${ANTHROPIC_API_KEY}` are validation errors | unit | `pnpm vitest run packages/core/test/config/interpolate.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-07 (D-23) | — | Unknown `harness:` id fails at config validation; `group:` parses then rejects with a v2 message | unit | `pnpm vitest run packages/core/test/config/pipeline.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-07 | — | Adding a stage changes neither `transition()`'s bytes nor the migration count | integration | `pnpm vitest run packages/core/test/state/exec-07.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CORE-01…06 (D-27) | — | The dependency-graph lint rule **fails** on a deliberate violating fixture | integration | `pnpm vitest run test/lint/no-restricted-imports.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-07 (D-29/D-30) | — | Migrations apply cleanly to a temp SQLite file; schema matches the committed `Database` types | integration | `pnpm vitest run packages/db/test/migrate.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-07 (D-30) | T-1-04 | Mutating an applied migration's bytes makes the runner **fail** (Kysely's `kysely_migration` has no checksum column — guard is ADL-owned) | integration | `pnpm vitest run packages/db/test/checksum-guard.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-07 (D-31) | — | Pricing a usage event dated 2026-08-15 differs from one dated 2026-09-15 (`claude-sonnet-5`); an unknown model yields `costSource: 'unknown'`, never 0 | integration | `pnpm vitest run packages/db/test/model-prices.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | C-1 (constraint) | — | Installed TypeScript is exactly 6.0.3 and satisfies typescript-eslint's peer range | integration | `pnpm vitest run test/toolchain.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*Threat Refs are placeholders until the planner emits `<threat_model>` blocks (ASVS L1, block on `high`); `/gsd-validate-phase` reconciles them.*

---

## Wave 0 Requirements

- [ ] `vitest.workspace.ts` + per-package `vitest.config.ts` — no test infrastructure exists (greenfield repo, zero tracked source files)
- [ ] `pnpm add -D -w vitest@4.1.10` — framework install
- [ ] A JSON-Schema validator for the CORE-04 equivalence contract test (`ajv` is the obvious candidate but is **not** yet version-verified — treat as an open install decision for the planner)
- [ ] `corepack prepare pnpm@11.22.0 --activate` — pnpm is not installed on this machine; corepack 0.34.6 is
- [ ] `packages/core/test/fixtures/spec/` — good and bad markdown + `.feature` corpora, including all 9 degenerate Gherkin inputs from Pitfall 2
- [ ] `packages/core/test/fixtures/verdicts/` — ~20 valid + ~20 invalid payloads for the JSON-Schema equivalence contract test
- [ ] `packages/core/test/fixtures/adl-yml/` — valid configs per `ready` kind, plus clamp-violation and unknown-key cases
- [ ] `test/fixtures/lint/` — a deliberately violating import, for D-27's negative test
- [ ] `packages/db/test/helpers/temp-db.ts` — temp-file SQLite fixture with teardown

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CI matrix actually exercises the declared `engines` floor | C-1 (constraint) | Local dev runs Node 22.23.2; the Node 24 dev target and the `>=22.12.0` floor can only both be proven by a CI matrix, which cannot run on the dev machine | Confirm the workflow file declares `node-version: [22, 24]` and that both legs are green on the first push |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 45s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
