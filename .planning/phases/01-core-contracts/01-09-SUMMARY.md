---
phase: 01-core-contracts
plan: 09
subsystem: state-machine
tags: [feature-lifecycle, state-machine, pure-function, exec-07, tdd]

# Dependency graph
requires:
  - "01-02 (walking skeleton — verdict layer's consumesRound, packages/db's features/state columns)"
provides:
  - "@adl/core/state: FEATURE_STATES, FeatureState, TERMINAL_STATES, FeatureEvent, TransitionCtx, TransitionResult, TransitionEffect, CounterDeltas, InvalidTransition, transition()"
  - "The one pure function permitted to change a feature's lifecycle state"
  - "Structural proof (compile-time exhaustiveness assertion, not just documentation) that the gate pipeline cannot enter the transition context"
affects: [01-08]

actuals:
  tokens: 10958
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Frozen array as the runtime source of truth, with the union type derived from it via (typeof ARR)[number] — the list and the type cannot drift"
    - "Compile-time exhaustiveness assertion (Exclude<T, ArrLiteral> extends never) pairing a type with its runtime enumeration, applied to both FeatureEventKind and TransitionCtx's own field set"
    - "Deriving a downstream rule from its owning module rather than restating it: the round delta is computed by asking consumesRound() a synthetic probe verdict, so the transition layer and the verdict layer cannot silently diverge"
    - "Returning InvalidTransition instead of throwing, so the caller (not this module) decides whether an unmatched state/event pair is a bug or a benign at-least-once replay"

key-files:
  created:
    - packages/core/src/state/feature-state.ts
    - packages/core/src/state/transition.ts
    - packages/core/test/state/transition.test.ts
  modified:
    - packages/core/src/state/index.ts

key-decisions:
  - "TransitionCtx carries currentStageIndex as the caller's already-read value, and the transition returns the *delta* to apply — for dev_committed and send_back, the delta is -ctx.currentStageIndex, resetting the pipeline to zero for the new round without the transition function needing to know what 'zero' means beyond arithmetic. This keeps CounterDeltas composable with a version-guarded UPDATE rather than requiring an absolute overwrite."
  - "The round-consumption rule is not restated in transition.ts. SEND_BACK_ROUND_DELTA is computed once at module load by calling consumesRound() from ../verdict/verdict.ts against a synthetic send_back verdict. If verdict.ts ever stops treating send_back as round-consuming, this module's behavior changes in the same commit rather than silently disagreeing."
  - "Pause/limit_exceeded/unrecoverable are handled once, before the per-state switch, for every non-terminal state — rather than repeated in each of the nine state branches. Terminal-state rejection is checked first, ahead of even those three, so merged/abandoned truly accept nothing."
  - "escalated has a resume edge (the diagram's 'human retry' arrow), distinct from paused's resume edge — both land on queued, but they are reached from different states and via different circumstances. No separate event was invented for it; resume covers both, consistent with the diagram drawing one arrowhead into escalated and one into paused from the same edge label."

patterns-established:
  - "Exhaustiveness assertions used twice in one file for two different purposes: once to keep FEATURE_EVENT_KINDS in sync with the FeatureEvent union (a data/type pairing), and once to keep TRANSITION_CTX_FIELDS in sync with TransitionCtx's keys (a structural no-stage-identity guard, verified empirically by temporarily adding a stageId field and confirming tsc fails)"

requirements-completed: [EXEC-07]

coverage:
  - id: D1
    description: "transition(state, event, ctx) is pure, total, and never throws across the full state-by-event cross product (11 states x 15 event kinds = 165 pairs)"
    requirement: "EXEC-07"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/transition.test.ts — 'transition() is total across every state-by-event pair' (3 tests) and 'transition() is pure' (4 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The state set structurally excludes the gate pipeline: no state name is stage-flavoured, and TransitionCtx carries no stage identity field, both enforced by a compile-time exhaustiveness assertion rather than only by test"
    requirement: "EXEC-07"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/transition.test.ts — 'contains no stage-specific state' and 'carries no stage identity'; manually verified adding a stageId field to TransitionCtx fails tsc --noEmit"
        status: pass
    human_judgment: false
  - id: D3
    description: "gate_passed advances the pipeline by moving current_stage_index, staying in gating, for a pipeline of any length"
    requirement: "EXEC-07"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/transition.test.ts — 'gating --gate_passed--> gating, advancing the stage index without spending a round', 'accepts the last gate in the pipeline', 'refuses to walk the stage index past the end of the pipeline'"
        status: pass
    human_judgment: false
  - id: D4
    description: "Only the send-back edge increments the round; every other applied transition leaves it unchanged, and the rule is derived from the verdict layer's consumesRound rather than restated"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/transition.test.ts — 'changes the round on the send-back edge and on nothing else' (sweeps the full cross product)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every applied transition returns exactly one feature_event effect whose from/to state match, and the state version the caller must guard the write on"
    verification:
      - kind: automated_test
        ref: "packages/core/test/state/transition.test.ts — 'what every applied transition must carry' (2 tests, swept across the cross product)"
        status: pass
    human_judgment: false
---

# Phase 01 Plan 09: Feature Lifecycle Transition Function Summary

**The pure `transition(state, event, ctx)` function — 11 states, 15 event kinds, all 165 pairs proven total and non-throwing — with the gate pipeline structurally excluded from both the state set and the transition context, verified by a compile-time exhaustiveness assertion rather than only documented.**

## What Was Built

`@adl/core/state` now exports the lifecycle vocabulary and the one function permitted to move a feature through it:

- **`feature-state.ts`** — `FEATURE_STATES` (a frozen 11-entry array, `FeatureState` derived from it), `TERMINAL_STATES` (`merged`, `abandoned`), `FeatureEvent` (a 15-member discriminated union covering every labelled edge in `ARCHITECTURE.md` §2's diagram), `TransitionCtx`, `TransitionResult`, `TransitionEffect`/`FeatureEventEffect`, `CounterDeltas`, and `InvalidTransition`. The module header records the three ARCHITECTURE.md versioning rules (never rename/delete a state; `schema_version` gates startup; effective config snapshotted at lease time) and the reasoning for why the pipeline is absent from the state set.
- **`transition.ts`** — the function itself. A terminal-state check first, then the three edges available from any non-terminal state (`pause`, `limit_exceeded`, `unrecoverable`) handled once, then an exhaustive `switch` over the remaining nine states. Every accepted edge routes through one `applied()` helper that attaches the audit effect and the concurrency guard, so neither can be forgotten on a new edge.
- **`transition.test.ts`** — 43 tests: state-vocabulary assertions (Task 1, RED-then-GREEN), a cross-product totality sweep asserting exactly 165 defined outcomes, one named test per diagram edge, ceiling checks (round limit, pipeline-end), effect/counter/version assertions swept across the whole cross product, and four purity tests including an actual `setTimeout` to prove no clock is read.

## Deviations from Plan

None requiring Rule 4. Three points worth recording as Rule 1/3 auto-fixes and one clarification:

**1. [Rule 3 - Blocking] `pnpm exec eslint` and `pnpm exec prettier --check` cannot pass yet — no config exists in this worktree**

- **Found during:** final verification pass for Task 2's acceptance criteria
- **Issue:** The plan's acceptance criteria require `pnpm exec eslint packages/core/src/state` to exit 0. No `eslint.config.js` or `.prettierrc` exists anywhere in the repository yet — running eslint fails with "ESLint couldn't find an eslint.config.js file" before it can even evaluate the target files. Verified this is not specific to my new files: `prettier --check` against the already-merged `packages/core/src/verdict/` and `packages/core/src/spec/` (from plan 01-02) shows the identical "warn" state.
- **Fix:** None applied — this is out of scope. Per this plan's own parallel-execution context, root lint/tooling files belong to plan 01-03, which runs concurrently in Wave 3 and has not merged into this worktree. The plan's own `<verification>` section anticipates this: "The workspace-wide `pnpm lint` is plan 01-08's, run after Wave 4 closes." I ran `pnpm --filter @adl/core typecheck`, `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r test` instead, all green, and manually re-confirmed no line in the new files exceeds 100 columns (the project's apparent convention, inferred from the absence of any wider line anywhere else in `packages/core`).
- **Files affected:** none (no fix needed once eslint/prettier configs land from 01-03)
- **Action for wave close / 01-08:** re-run `pnpm exec eslint packages/core/src/state` and `pnpm format` once 01-03's configs are present in the merged tree.

**2. [Rule 1 - Bug] Six lines over 100 columns, fixed inline before commit**

- **Found during:** Task 2, pre-commit line-width check (done manually since eslint's `max-len`-equivalent isn't runnable yet)
- **Issue:** One line in `transition.ts` (an interpolated error message) and five lines in `transition.test.ts` (assertion calls with long template-literal messages) exceeded the ~100-column width every other file in the package holds to.
- **Fix:** Split the long string concatenation across two lines in `transition.ts`; in the test file, extracted a couple of inline `expect()` calls to a preceding `const` and shortened one test-name string. No behavior change; verified with `awk 'length > 100'` returning zero matches afterward.
- **Commit:** `1bb6fb1`

**3. [Clarification] `developer-outcome.ts` (plan 01-05) had not landed in this worktree**

- **Found during:** Task 1 `read_first`
- **Issue:** The plan's read list says to consult `packages/core/src/stage/developer-outcome.ts` "if plan 01-05 has landed; otherwise model the events on 01-CONTEXT.md § D-05." That file does not exist in this worktree (01-05 is a concurrent Wave 3 sibling writing to `packages/core/src/stage/` and `packages/plugin-sdk/`, not merged here).
- **Resolution:** Modeled `FeatureEvent`'s `dev_committed` directly on `ARCHITECTURE.md`'s diagram (`{ t: 'dev_committed'; sha: string }`), which is the same shape the architecture doc itself specifies and requires no knowledge of 01-05's internal developer-outcome vocabulary — the lifecycle event only needs the commit SHA, not the full developer-agent result. No divergence risk: the developing→gating edge is a single event with one payload field, already fully specified in `ARCHITECTURE.md` §2.

## Decisions Made

Beyond the deviations above:

1. **Counter deltas are relative, not absolute, for the pipeline-index reset.** On `dev_committed` (starting the pipeline) and on a successful `send_back` (restarting it for the next round), the transition returns `currentStageIndex: -ctx.currentStageIndex` rather than a hardcoded `0`. This composes correctly with the caller's version-guarded UPDATE (`current_stage_index = current_stage_index + ?`) without the transition function needing to assert an absolute value that could race with a concurrent read.
2. **The admission check sits inside the `send_back` branch, evaluated before the round delta is applied**, exactly where `ARCHITECTURE.md` §2 places it: "in the `gating → developing` send-back transition, inside the transaction." `ctx.round + SEND_BACK_ROUND_DELTA > ctx.maxRounds` checks what the round *would become*, not what it currently is — catching the boundary case where round 3 of a 3-round ceiling is the last one allowed to send back.
3. **`lease_expired` is not an edge out of `pr_open`.** The diagram places `pr_open` as "human territory; ADL only observes" — no worker holds a lease there, so there is nothing to expire. This is asserted directly by the "rejects lease_expired where no lease is held" test.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-30 (Tampering — stale worker overwrites newer state) | mitigate | **Mitigated.** Every `TransitionResult.expectedStateVersion` equals `ctx.stateVersion` as read; asserted across the full cross product in "carries the version the caller must guard the write on." The conditional `UPDATE` itself is Phase 3's job per the plan; this phase makes the guard structurally present in the return value. |
| T-1-31 (Repudiation — state change with no audit record) | mitigate | **Mitigated.** Every applied transition returns exactly one `FeatureEventEffect` with `fromState`/`toState`/`event`/`actor`/`at`/`seq`; asserted across the full cross product. |
| T-1-32 (Tampering — invalid transition silently absorbed) | mitigate | **Mitigated.** Undrawn pairs return `InvalidTransition` naming state and event; the cross-product test proves every one of the 165 pairs is a defined value, and "never throws" is asserted directly rather than inferred. |
| T-1-33 (DoS — state rename stranding in-flight features) | mitigate | **Mitigated.** `FEATURE_STATES` is `Object.freeze`d and its exact contents are asserted by test; the module header records the never-rename rule verbatim. |

## Known Stubs

None. `transition.ts` implements every edge the plan's `<behavior>` section specifies; no placeholder branches, no hardcoded empty returns.

## Verification

| Command | Result |
|---|---|
| `pnpm --filter @adl/core typecheck` | exits 0 |
| `pnpm vitest run --project core packages/core/test/state/transition.test.ts` | 43/43 passed |
| `pnpm -r build` | 3/3 packages Done |
| `pnpm -r typecheck` | 3/3 packages Done |
| `pnpm -r test` | core 48 passed (5 pre-existing + 43 new) · db 6 passed · plugin-sdk 0 (by design) |
| Manual: added a temporary `stageId` field to `TransitionCtx` | `tsc --noEmit` failed with `TS2322: Type 'true' is not assignable to type 'never'` at the ctx-field exhaustiveness assertion — confirmed the guard is structural, then reverted |
| `awk 'length > 100'` over the new files | 0 matches (after the line-width fix) |
| `pnpm exec eslint packages/core/src/state` | **cannot run** — no `eslint.config.js` in this worktree yet (01-03's Wave 3 deliverable); see Deviation 1 |

Cross-product coverage: 11 states × 15 event kinds = **165 pairs**, all defined, none throwing. Named-edge coverage: every arrow in `ARCHITECTURE.md` §2's diagram has its own test, including both `resume` edges (`paused → queued` and `escalated → queued`) and the ceiling boundary (round 2 of 3 still sends back; round 3 of 3 escalates instead).

## Self-Check: PASSED

- `packages/core/src/state/feature-state.ts` — FOUND
- `packages/core/src/state/transition.ts` — FOUND
- `packages/core/src/state/index.ts` — FOUND (modified, re-exports both modules)
- `packages/core/test/state/transition.test.ts` — FOUND
- Commit `587ac4a` — FOUND in `git log`
- Commit `1bb6fb1` — FOUND in `git log`
- No file deletions in either commit (`git diff --diff-filter=D` empty for both)
- No files created outside the plan's declared `files_modified`; `packages/core/test/state/exec-07.test.ts` (01-08's file) was not created

## User Setup Required

None.

## Next Phase Readiness

**Plan 01-08** (Wave 4) can proceed once this wave closes: `packages/core/src/state/transition.ts` exists at the exact path its EXEC-07 proof hashes, as a single file, and `FEATURE_STATES` is available for its migration cross-check against `packages/db/migrations/0001_initial.ts`'s `state` column. `01-08`'s own test file (`packages/core/test/state/exec-07.test.ts`) was deliberately left uncreated — that file is 01-08's, not this plan's.

**For whoever runs the workspace-wide lint/format pass after Wave 4 closes:** `packages/core/src/state/*.ts` and `packages/core/test/state/transition.test.ts` were hand-formatted to stay under 100 columns and match the surrounding code's style, but were never actually run through `eslint`/`prettier` since neither config exists in this worktree. Re-run both once 01-03 has landed.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
