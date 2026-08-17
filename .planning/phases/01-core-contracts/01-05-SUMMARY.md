---
phase: 01-core-contracts
plan: 05
subsystem: stage-contracts
tags: [stage-error, developer-outcome, plugin-sdk, type-boundary, zod, tdd]

# Dependency graph
requires:
  - "01-02 (walking skeleton — VerdictSchema, Finding, CriterionRef, the pnpm workspace, the pre-stubbed @adl/plugin-sdk member)"
provides:
  - "StageErrorSchema + StageOutcome = Verdict | StageError, outside the six-outcome union (D-12, CORE-06)"
  - "stageErrorPolicy / shouldEscalate / NON_TRANSIENT_ESCALATION_THRESHOLD (D-15)"
  - "capRawOutput: 16 KB head + 16 KB tail retention cap, UTF-8-safe (T-1-21)"
  - "parseStageOutput: the one-repair parse ladder (D-13)"
  - "reconcileCriterionRefs: the D-04 asymmetry (demote a finding, fail a pass citation)"
  - "DeveloperOutcomeSchema / DisputeSchema / DEVELOPER_OUTCOME_ROUND_COST (D-05, D-06, CORE-03)"
  - "Stage / StageContext / StageKind / CostClass — the gate interface (ARCHITECTURE.md §3, updated for D-12)"
  - "@adl/plugin-sdk: the empty stub filled with re-exports by reference (D-25)"
  - "Compile-time proof that StageError and Verdict are mutually non-assignable"
affects: [01-08]

actuals:
  tokens: 58000
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Vitest typecheck wired via a dedicated non-emitting tsconfig.test.json, so a *.test-d.ts file is actually compiled rather than silently skipped"
    - "pretypecheck/pretest run `tsc -b ../core` for any package that type-imports @adl/core's subpaths, mirroring @adl/db's existing pattern"
    - "Reference-identity re-export test (toBe, not toEqual) as the mechanical proof a package re-exports rather than redeclares"
    - "Opaque forward-declaration interfaces (a comment-only optional never property) rather than {}, so an empty object can't accidentally satisfy the placeholder type"

key-files:
  created:
    - packages/core/src/stage/stage-error.ts
    - packages/core/src/stage/developer-outcome.ts
    - packages/core/src/stage/stage.ts
    - packages/core/src/stage/index.ts
    - packages/core/test/stage/stage-error.test.ts
    - packages/core/test/stage/developer-outcome.test.ts
    - packages/core/test/stage/type-boundary.test-d.ts
    - packages/core/tsconfig.test.json
    - packages/plugin-sdk/README.md
    - packages/plugin-sdk/test/reexport-identity.test.ts
  modified:
    - packages/core/vitest.config.ts
    - packages/plugin-sdk/src/index.ts
    - packages/plugin-sdk/package.json
    - packages/plugin-sdk/vitest.config.ts

key-decisions:
  - "capRawOutput never splits a UTF-8 character at either the head or tail seam — it backs the cut off by up to 3 bytes rather than emit a replacement character, since a corrupted debug artifact is a worse trade than a slightly-off byte count."
  - "reconcileCriterionRefs and parseStageOutput are both pure functions taking the already-spent attempt count as a parameter, rather than owning mutable retry state — the caller (Phase 4/6's loop) supplies the counter, so the bound is visible in the type signature."
  - "Stage's forward-declared collaborator types (Workspace, FeatureView, StageConfig, AgentRunner, ArtifactSink, RoundSummary) are opaque interfaces with a single optional never-typed property, not {} — an empty interface is satisfied by any non-nullish value, which would silently defeat the point of the placeholder."
  - "@adl/plugin-sdk gained pretypecheck/pretest scripts running `tsc -b ../core`, matching the pattern @adl/db already established, because plugin-sdk's src genuinely type-imports @adl/core's subpaths and needs real declaration output to resolve — unlike @adl/db, whose only @adl/core reference is a comment."

patterns-established:
  - "Vitest 4's experimental typecheck mode, scoped to *.test-d.ts via a dedicated non-emitting tsconfig, is how a compile-time-only invariant becomes part of the automated test run rather than a manual `tsc` step someone forgets."

requirements-completed: [CORE-03, CORE-06]

coverage:
  - id: D9
    description: "DeveloperOutcomeSchema.safeParse rejects every shape a 'pass' attempt could take, because no member of the union accepts it"
    requirement: "CORE-03, D-05"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/developer-outcome.test.ts — 'rejects a pass in every shape it could be attempted' (5 payload shapes) and 'declares exactly three members, and none of them is a pass'"
        status: pass
    human_judgment: false
  - id: D10
    description: "A dispute missing criterionRef, target, or argument is malformed rather than a weaker dispute; a target naming neither a fingerprint nor a stage id is rejected"
    requirement: "D-06"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/developer-outcome.test.ts — DisputeSchema describe block, 8 tests"
        status: pass
    human_judgment: false
  - id: D11
    description: "StageError is not assignable to Verdict and Verdict is not assignable to StageError, at compile time"
    requirement: "D-12, CORE-06"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/type-boundary.test-d.ts, run via vitest's typecheck mode; empirically confirmed to fail the build when a wrong assertion was temporarily added (see Verification below)"
        status: pass
    human_judgment: false
  - id: D12
    description: "stageErrorPolicy never sets consumesRound: true for any of the five kinds; retryable is true for exactly provider_error and timeout"
    requirement: "D-15, CORE-06, LOOP-07"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/stage-error.test.ts — 'routes %s exactly as decided' (5 kinds via it.each) and 'never lets an infrastructure failure cost the developer a round'"
        status: pass
    human_judgment: false
  - id: D13
    description: "The parse ladder yields StageError{unparseable} after exactly one repair attempt, never zero and never two"
    requirement: "D-13, T-1-20"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/stage-error.test.ts — parseStageOutput describe block, including 'refuses to climb past the bound even if asked'"
        status: pass
    human_judgment: false
  - id: D14
    description: "reconcileCriterionRefs demotes an unknown finding reference after one repair, but a pass verdict citing an unknown id always fails rather than being demoted, at every attempt count"
    requirement: "D-04"
    verification:
      - kind: automated_test
        ref: "packages/core/test/stage/stage-error.test.ts — reconcileCriterionRefs describe block, including 'never demotes a pass verdict — the asymmetry is the point' iterating attempts 0-3"
        status: pass
    human_judgment: false
  - id: D15
    description: "@adl/plugin-sdk's exported schemas are the same object (reference identity) as @adl/core's, not structurally-equal duplicates"
    requirement: "D-25, 01-RESEARCH.md § Open Questions 4"
    verification:
      - kind: automated_test
        ref: "packages/plugin-sdk/test/reexport-identity.test.ts — toBe assertions for 5 schemas, plus an 'orphans' scan confirming every exported value traces back to @adl/core"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 05: Stage Contracts & Plugin SDK Summary

**`StageError` sits outside the six-outcome `Verdict` union with a compile-time proof that the two can never be unified, `DeveloperOutcome` has no `pass` member so self-approval fails `parse()` structurally, and both — plus the `Stage` interface — are published through `@adl/plugin-sdk`, whose re-exports are reference-identical to `@adl/core`'s originals.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 3 (all `type="auto"`, Tasks 1-2 `tdd="true"`)
- **Commits:** 6 (test/feat pairs for Tasks 1-2, one commit for Task 3)
- **Files created:** 10
- **Tests:** 63 passing across the plan's surface (core stage/: 50 including 4 type-level; plugin-sdk: 8; whole workspace: core 55, db 6, plugin-sdk 8)

## Accomplishments

- Built the infrastructure-failure channel (`StageError`) as a plain `z.object` outside the verdict union, with `stageErrorPolicy` routing all five kinds through a table that never sets `consumesRound: true`, a bounded one-repair parse ladder, a UTF-8-safe raw-output retention cap, and the D-04 asymmetric criterion-reference reconciliation.
- Built the developer's own union (`DeveloperOutcome`) with exactly three members — `committed`, `dispute`, `blocked` — and no `pass`, so self-approval is unrepresentable rather than rejected by a guard.
- Built a compile-time proof (`type-boundary.test-d.ts`, run via Vitest 4's typecheck mode) that `StageError` and `Verdict` are mutually non-assignable, and empirically confirmed the proof actually fails the build when violated (see Verification).
- Filled the `@adl/plugin-sdk` stub with a pure re-export surface — zero schema definitions of its own — verified by reference identity (`toBe`, not `toEqual`) against `@adl/core`.
- Published the `Stage`/`StageContext` interface from `ARCHITECTURE.md` §3, updated for D-12 (`run` returns `StageOutcome`, not `Verdict`) with six collaborator types as opaque forward declarations, each naming the phase that replaces it.

---

## The prohibitions, and how they are enforced

**1. "A broken gate must never be recorded as a gate that judged."**

Enforced three ways, not one: `StageError` is a separate Zod object (not a union member) so `VerdictSchema.safeParse` rejects it and vice versa at runtime; `stageErrorPolicy` returns `consumesRound: false` for all five kinds as a closed table, so a sixth kind added later without a policy decision is a compile error; and `type-boundary.test-d.ts` asserts the TypeScript types are mutually non-assignable, so a refactor that unified them fails the typecheck even if every runtime test still passed.

**2. "A dispute must never become a way for the developer to bypass a gate."**

`DisputeSchema` requires `criterionRef`, `target`, and `argument` — missing any one makes the payload malformed, not a weaker dispute (verified: dropping each field independently is rejected). `DEVELOPER_OUTCOME_ROUND_COST` is a closed table mapping every kind to `0`, and the module header records that a dispute escalates to a human and that no reconsideration round may be designed — REQUIREMENTS.md § Out of Scope excludes multi-agent arbitration.

---

## Deviations from Plan

Three, all Rule 1/3 auto-fixes discovered while making the plan's own acceptance criteria pass. Nothing architectural.

### 1. [Rule 3 - Blocking] Vitest's type-test mode needed a dedicated, non-emitting tsconfig

- **Found during:** Task 1, wiring `type-boundary.test-d.ts` into the automated suite
- **Issue:** `packages/core/tsconfig.json` deliberately includes only `src/**/*.ts` (it is the build program and emits to `dist/`; including `test/` would ship the suite to consumers). But Vitest's `test.typecheck` needs a program that *does* include the test file, and a `composite: true` project (which `tsconfig.json` is, per `tsconfig.base.json`) cannot disable emit.
- **Fix:** Added `packages/core/tsconfig.test.json` — extends the base config, sets `noEmit: true` and `composite: false`, includes both `src/**/*.ts` and `test/**/*.ts` — and pointed `vitest.config.ts`'s `test.typecheck.tsconfig` at it. `ignoreSourceErrors: true` keeps this program from double-reporting errors that `pnpm --filter @adl/core typecheck` already owns.
- **Verified the gate actually bites**, not just that it runs: temporarily added `expectTypeOf<StageError>().toExtend<Verdict>()` (a deliberately wrong assertion) and confirmed `pnpm vitest run --project core` failed with a `TypeCheckError` naming the exact mismatch, then reverted it before committing.
- **Commit:** `e31293b`

### 2. [Rule 3 - Blocking] `@adl/plugin-sdk`'s typecheck and test need `@adl/core` built first

- **Found during:** Task 3, first `pnpm --filter @adl/plugin-sdk typecheck` from a clean `dist/`
- **Issue:** Unlike `@adl/db` (whose only `@adl/core` reference is a comment, so its typecheck never actually resolves the package), `packages/plugin-sdk/src/index.ts` genuinely type-imports `@adl/core/verdict` and `@adl/core/stage`. TypeScript resolves those subpaths through `@adl/core`'s `exports` map, which points at `dist/*.d.ts` — absent on a clean checkout, both commands fail with `TS2307`/`Cannot find package`.
- **Fix:** Added `pretypecheck` and `pretest` scripts to `packages/plugin-sdk/package.json`, both running `tsc -b ../core` — the exact pattern `@adl/db` already established for its own `pretest`. Verified the plan's literal verify command (`pnpm --filter @adl/plugin-sdk typecheck && pnpm vitest run --project plugin-sdk`) passes from a `rm -rf packages/*/dist` state.
- **Note:** This means `pnpm vitest run --project plugin-sdk` run in isolation (bypassing the package script) still requires `@adl/core`'s `dist/` to exist — confirmed by testing that exact case, which fails with a clear `Cannot find package '@adl/core/verdict'` error rather than something confusing. `pnpm -r build` (which plan 01-08's authoritative Wave-4 typecheck runs after) always builds `core` before its dependents, so this is not a problem in the normal `pnpm -r` sequence — only a note for anyone invoking `vitest` directly against a fresh checkout.
- **Commit:** `c1898a1`

### 3. [Rule 1 - Bug] Removed the now-stale `passWithNoTests` comment from `plugin-sdk/vitest.config.ts`

- **Found during:** Task 3
- **Issue:** The comment explained why the (then-empty) package collected zero tests. That is no longer true — `reexport-identity.test.ts` now exists — and leaving the comment would misdescribe the config to the next reader.
- **Fix:** Removed both the `passWithNoTests: true` setting and its comment; the suite now behaves like every other package's (fails if it collects zero tests, which is correct now that it should never be empty).
- **Commit:** `c1898a1`

---

## Decisions Made

Beyond the deviations above:

1. **`capRawOutput` costs up to 3 bytes per seam to stay UTF-8-safe.** A byte-exact 16384/16384 split would occasionally land mid-character on multi-byte UTF-8 input and emit a replacement character (`�`) into a debugging artifact — worse than a slightly smaller retained window. Verified with a fixture engineered so *both* the head and tail cuts land mid-sequence under a naive byte slice.
2. **`parseStageOutput` and `reconcileCriterionRefs` are pure, taking `attempt: number` as a caller-supplied parameter** rather than owning mutable retry state internally. The bound (`MAX_REPAIR_ATTEMPTS = 1`) is then visible in the return-type discriminant (`'repair'` can only be returned once; a second call with `attempt: 1` can only return `'parsed'` or `'failed'`), which is what "refuses to climb past the bound even if asked" verifies directly.
3. **Forward-declared collaborator types (`Workspace`, `FeatureView`, `StageConfig`, `AgentRunner`, `ArtifactSink`, `RoundSummary`) are opaque interfaces with one optional `never`-typed property, not `{}`.** An empty interface is satisfied by any non-nullish value (a number, a string), which would silently accept nonsense where a real implementation is supposed to go later. The `never` property makes the placeholder assignable only from itself or from a type that also declares (or omits) that exact property — good enough to hold the `Stage` interface's shape without accidentally typechecking against garbage.
4. **`fingerprintFinding`'s `title` was reused verbatim in `findingCiting` test fixtures** without re-deriving the fingerprint by hand — the test imports the real function from `01-04`'s (currently 01-02's) module rather than hardcoding a 64-character hex string, so a future change to the normalisation algorithm cannot silently desync the fixture from reality.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-07 (Spoofing — self-approval) | mitigate | **Mitigated.** `DeveloperOutcomeSchema.safeParse` rejects `pass` in 5 distinct attempted shapes, including one smuggling it via an `outcome` field (a leftover `Verdict`-shaped guess). Structural, not a runtime guard. |
| T-1-19 (Tampering — broken gate misclassified as failing gate) | mitigate | **Mitigated.** Schema disjointness asserted both directions at runtime; mutual non-assignability asserted at compile time via Vitest's typecheck mode, empirically confirmed to fail the build (see Deviation 1). |
| T-1-20 (DoS — unbounded repair reprompting) | mitigate | **Mitigated.** `MAX_REPAIR_ATTEMPTS = 1` is enforced in the return-type discriminant itself, not just by convention; `NON_TRANSIENT_ESCALATION_THRESHOLD = 2` asserted at both boundary sides (1 → false, 2 → true). |
| T-1-21 (Info disclosure — raw agent output in `StageError`) | mitigate | **Mitigated.** `rawRef` is `z.string().optional()` — a pointer type, never a blob field. `capRawOutput` implements the 16 KB + 16 KB cap with a byte-counting elision marker and UTF-8-safe seams; Phase 1 writes no file, `StageError.rawRef` is the contract Phase 3's artifact store implements against. |
| T-1-22 (Elevation of privilege — dispute used to bypass a gate) | mitigate | **Mitigated.** `DEVELOPER_OUTCOME_ROUND_COST` is a closed table at `0` for all three kinds; no waiver-issuing path exists on `DeveloperOutcome`; header comment records that no reconsideration round may be designed (REQUIREMENTS.md § Out of Scope). |

No threat surface beyond what the plan's own threat model already covered — `Stage`/`StageContext` are pure type declarations with no runtime logic, and the forward-declared collaborator types carry no data.

## Known Stubs

None that block this plan's goal. One item worth naming explicitly rather than treating as silent:

| File | What | Why it is intentional | Resolved by |
|---|---|---|---|
| `packages/core/src/stage/stage.ts` | `Workspace`, `FeatureView`, `StageConfig`, `AgentRunner`, `ArtifactSink`, `RoundSummary` — six opaque forward-declaration interfaces | `@adl/core` is pure (no filesystem, no child processes, no environment) and cannot depend on implementations of these that live in later phases. Each is documented at its declaration with the phase that replaces it (Phase 2, 3, 4, 5, or plan 01-07). This is the plan's own design, not a workaround — 01-CONTEXT.md § Integration Points names Phase 2 (`WorkspaceBackend`) as the first consumer. | Phase 2 (`Workspace`), plan 01-07 (`StageConfig`), Phase 3 (`ArtifactSink`), Phase 4 (`AgentRunner`), Phase 5 (`FeatureView`, `RoundSummary`) |

No hardcoded empty return values, no placeholder UI text, and no test left in a `.skip`/`.todo` state. `grep -rn "TODO\|FIXME\|not available\|coming soon\|placeholder"` over `packages/core/src/stage` and `packages/plugin-sdk/src` matches only the "Structural placeholder only; never read" doc-comments on the six forward declarations above — i.e., the same intentional item, not a second one.

## Issues Encountered

- **ESLint could not run** (`pnpm eslint packages/core/src/stage packages/plugin-sdk/src` — no `eslint.config.js` exists yet). This is expected: plan **01-03** (lint/CI) owns that file and runs concurrently with this plan in Wave 3. The plan's `<verification>` section lists this command as part of the phase-level check that plan 01-08 runs authoritatively once Wave 4 closes, after every Wave 3 sibling — including 01-03 — has landed. Not a blocker for this plan.
- **`@adl/plugin-sdk`'s typecheck/test now depend on `@adl/core`'s `dist/` existing** — see Deviation 2. Handled via `pretypecheck`/`pretest` scripts; the plan's literal verify command was tested from a clean `dist/` state and passes.

## Verification

Run from a dist-free working tree (`rm -rf packages/*/dist`):

| Command | Result |
|---|---|
| `pnpm vitest run --project core packages/core/test/stage/stage-error.test.ts` | 30 passed |
| `pnpm vitest run --project core packages/core/test/stage/developer-outcome.test.ts` | 16 passed |
| `pnpm vitest run --project core packages/core/test/stage/` (incl. type-boundary.test-d.ts) | 3 files, 50 tests passed, 0 type errors |
| `pnpm --filter @adl/core typecheck` | passes, includes the type-boundary test file in the program |
| `pnpm --filter @adl/plugin-sdk typecheck && pnpm vitest run --project plugin-sdk` | passes; 8 tests passed |
| `pnpm -r build` | **3/3 packages Done** |
| `pnpm -r typecheck` | **3/3 packages Done** |
| `pnpm -r test` | **core 55 passed · db 6 passed · plugin-sdk 8 passed** |
| `git diff --exit-code -- pnpm-lock.yaml` | exits 0 — confirmed twice, before and after the full build/typecheck/test cycle |
| Deliberately broke `type-boundary.test-d.ts` with a wrong assertion, re-ran `pnpm vitest run --project core` | **failed** with a `TypeCheckError` pinpointing the exact line — confirms the compile-time gate is load-bearing, not decorative — then reverted |

**Must-haves from the plan's frontmatter, individually re-checked:**
- `DeveloperOutcomeSchema.safeParse({ kind: 'pass' })` fails — confirmed, along with 4 other attempted shapes.
- A dispute missing any of `criterionRef`, target, or `argument` fails — confirmed for all three fields independently.
- `consumesRound` is never consulted for a `DeveloperOutcome` — confirmed structurally: `DEVELOPER_OUTCOME_ROUND_COST` is a separate table keyed on `DeveloperOutcomeKind`, and `consumesRound(verdict: Verdict)` from `../verdict/verdict.ts` is not imported into `developer-outcome.ts` at all.
- `StageError` not assignable to `Verdict` and vice versa — confirmed at compile time, gate verified to bite (see above).
- A malformed payload resolves to `StageError{kind:'unparseable'}`, never any `Verdict` — confirmed, including that `VerdictSchema.safeParse` rejects the resulting `StageError`.
- `stageErrorPolicy` reports `retryable`/round/budget correctly for all five kinds — confirmed via `it.each` over the full kind space, not sampled.
- `NON_TRANSIENT_ESCALATION_THRESHOLD` is 2, boundary asserted at both 1 (false) and 2 (true) — confirmed.
- Parse ladder: 0 reprompts first-try, exactly 1 on recoverable failure, `StageError` on a second — confirmed, plus a fifth "refuses to climb past the bound even if asked" case.
- D-04 asymmetry: finding demotes after 1 repair with a loud flag; pass verdict fails at every attempt, never demoted — confirmed, including an explicit "never demotes a pass verdict" sweep over attempts 0-3.
- `StageError.rawRef` is a pointer; 33 KB truncates to exactly 32 KB + marker, 32 KB passes untouched — confirmed, plus a UTF-8 seam-safety case beyond the plan's literal byte counts.
- `@adl/plugin-sdk` re-exports by reference (`===`), not structural copy — confirmed for `VerdictSchema`, `FindingSchema`, `CriterionRefSchema`, `WaiverSchema`, `StageErrorSchema`.

## Self-Check: PASSED

- All 10 created files present in `git ls-files`.
- All 6 commits exist: `151e570`, `e31293b`, `c0bb389`, `a696fca`, (task 3) `c1898a1`.
- No unexpected file deletions in any commit (`git diff --diff-filter=D` empty for each).
- `git status --short` clean at time of writing this summary.

## User Setup Required

None. No new dependencies were added; `pnpm-lock.yaml` is byte-identical to what plan 01-02 produced.

## Next Phase Readiness

- **01-08 (workspace-wide typecheck + CI close-out, Wave 4):** `@adl/core`'s `./stage` subpath now has real content (`Verdict | StageError`, `DeveloperOutcome`, `Stage`/`StageContext`). `@adl/plugin-sdk` is no longer an empty stub — its `dist/` now carries a real declaration surface, so any downstream package (or the eventual `packages/reviewer`/`packages/tester`) can depend on it. The `pnpm eslint packages/core/src/stage packages/plugin-sdk/src` command this plan's `<verification>` names is safe to run once 01-03's `eslint.config.js` lands — not run here, by design (01-03 owns that file, and I stayed inside my declared `files_modified`).
- **Phase 2 (Workspace):** `Workspace` in `packages/core/src/stage/stage.ts` is the forward declaration to replace. It has zero structural members today (deliberately — see Known Stubs), so Phase 2 is free to shape the real `exec`/`read`/`write`/`snapshot` interface without any existing shape to reconcile against.
- **Plan 01-07 (`adl.yml`):** `StageConfig` is the other near-term forward declaration — this stage's resolved config block from `adl.yml`. No shape assumed yet.
- **Phase 4/5/6/7 (Loop Runner, reviewer, tester):** `Stage.run` returns `Promise<StageOutcome>`. `parseStageOutput` and `reconcileCriterionRefs` are ready to be called from the agent-adapter code that will exist once `AgentRunner` (Phase 4) is real — they are pure functions today because the loop that supplies the `attempt` counter and the retry timing does not exist until then.
- **Phase 3 (artifact store):** `capRawOutput`'s contract (16 KB head + 16 KB tail, elision marker naming the byte count, UTF-8-safe cuts) is what the artifact sink needs to implement before `StageError.rawRef` can be populated with a real pointer instead of left `undefined`.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
