---
phase: 02-workspace-the-exec-boundary
plan: 02
subsystem: infra
tags: [eslint, lint-as-test, no-restricted-imports, no-restricted-syntax, flat-config, vitest, work-02]

# Dependency graph
requires:
  - phase: 01-core-contracts
    provides: "eslint.config.js's architecture rule set (CORE_PURITY_RULES, VERDICT_SCHEMA_RULES, the ARCHITECTURE_RULE_IDS exhaustiveness test) and the deliberate-violation fixture convention under test/lint/fixtures/"
provides:
  - "The no-direct-spawn boundary (WORK-02) as a build property: node:child_process, child_process, execa, and simple-git all fail pnpm lint at severity 2 outside packages/workspace, in all three import forms"
  - "FORBIDDEN_SPAWN_SPECIFIERS as a named export of eslint.config.js — the single specifier tuple both enforcement layers derive from"
  - "A single, resolvable-from-config exemption for packages/workspace/**/*.ts"
  - "Resolved-config regression guards proving Phase 1's node:fs, @adl/*, and refine()/superRefine() bans survived the merge"
  - "Four spawn fixtures covering the form-by-specifier grid, including the non-builtin dynamic-import case"
affects: [02-03-workspace-package, phase-03-manager-worker, phase-04-agent-backends, phase-05-harnesses]

actuals:
  tokens: 9900
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Single-tuple derivation: one specifier list drives both the no-restricted-imports path list and the no-restricted-syntax selector list, so the two layers cannot cover different sets"
    - "One complete rule object per files glob — bans are MERGED into the existing object for an overlapping glob, never registered as a second entry"
    - "Resolved-config assertions via calculateConfigForFile, not source-level reads of architectureConfigs"
    - "Narrowly-scoped base-rule exceptions for fixtures (files-scoped config entry, never an inline disable comment)"

key-files:
  created:
    - test/lint/fixtures/spawn-direct-import.ts
    - test/lint/fixtures/spawn-require.ts
    - test/lint/fixtures/spawn-dynamic-import.ts
    - test/lint/fixtures/spawn-dynamic-execa.ts
  modified:
    - eslint.config.js
    - test/lint/no-restricted-imports.test.ts

key-decisions:
  - "Both enforcement layers derive from FORBIDDEN_SPAWN_SPECIFIERS, exported so the suite iterates the tuple rather than restating it — a specifier added to the ban gains its assertions automatically"
  - "Per-specifier anchored selector patterns (eight selectors from four specifiers) instead of the research's single optional-`node:`-prefix alternation — the tuple already carries both spellings, so there is no hand-maintained alternation to drift"
  - "The ignores carve-outs, not the entry's position in architectureConfigs, are what protect Phase 1's bans — established empirically during execution and recorded in the config comment"
  - "@typescript-eslint/no-require-imports turned off for test/lint/fixtures/spawn-*.ts only, via a files-scoped baseConfigs entry rather than an inline disable comment"

patterns-established:
  - "Single-tuple derivation: a ban expressed once, consumed by every enforcement layer, so the layers are structurally incapable of covering different sets"
  - "Watched-failing guards: every regression guard in this plan was observed failing against the exact defect it exists to catch, then restored"
  - "Resolved-options assertions: guards read calculateConfigForFile output, because flat-config rule replacement is invisible to a source-level read and leaves pnpm lint green"

requirements-completed: [WORK-02]

coverage:
  - id: D1
    description: "A static import of node:child_process, child_process, execa, or simple-git outside packages/workspace fails pnpm lint at severity 2"
    requirement: WORK-02
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#test/lint/fixtures/spawn-direct-import.ts is reported by no-restricted-imports"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#covers every banned specifier in all three import forms for packages/db/src/index.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "The require() and dynamic import() forms fail too, for every banned specifier — not only for the builtin"
    requirement: WORK-02
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#test/lint/fixtures/spawn-require.ts is reported by no-restricted-syntax"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#test/lint/fixtures/spawn-dynamic-import.ts is reported by no-restricted-syntax"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#test/lint/fixtures/spawn-dynamic-execa.ts is reported by no-restricted-syntax"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#covers every banned specifier in all three import forms for packages/core/src/verdict/verdict.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "packages/workspace is the only exemption, checkable from the resolved config rather than by reading the config source"
    requirement: WORK-02
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#exempts packages/workspace, and nothing else"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every rule Phase 1 registered still resolves with the same restricted paths and patterns it had before this plan"
    requirement: WORK-02
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#did not delete the bans Phase 1 registered"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#resolves exactly one architecture configuration for %s (4 cases)"
        status: pass
      - kind: integration
        ref: "pnpm lint (exit 0) + pnpm -r typecheck (exit 0)"
        status: pass
    human_judgment: false

duration: 18min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 02: The Lint Boundary Summary

**The no-direct-spawn boundary (WORK-02) enforced at build time: four banned specifiers × three import forms, derived from one exported tuple, with a single `packages/workspace` exemption and resolved-config guards proving Phase 1's purity bans survived the merge.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-08-18T05:20:00Z (approx.)
- **Completed:** 2026-08-18T05:38:00Z
- **Tasks:** 3
- **Files modified:** 6 (2 modified, 4 created)

## Accomplishments

- **The ban is not bypassable by changing the import form or the specifier.** `no-restricted-imports` (static form) and `no-restricted-syntax` (`require()` and dynamic `import()`) are both derived from `FORBIDDEN_SPAWN_SPECIFIERS` — eight selectors generated from four specifiers — so the two layers are structurally incapable of covering different sets.
- **Phase 1's bans provably survived.** `packages/core/src/verdict/verdict.ts` still resolves `node:fs`, the `@adl/*` sibling group, and both refinement selectors, *and* now additionally carries `execa`, `simple-git`, and all eight spawn selectors. Asserted by reading `calculateConfigForFile` output, because the failure mode is invisible to a source-level read.
- **Both guards were watched failing** against the exact defects they exist to catch, then restored — see *Verification observations* below.
- **The exemption is provable from both sides.** `packages/workspace/src/exec/run.ts` resolves zero restricted paths; `packages/db/src/index.ts` resolves the full spawn ban.
- Test count on the root project went from 18 to 30, with a named passing case for each of the four new fixtures.

## Task Commits

1. **Task 1: Compose the spawn ban as one complete rule object per glob** — `b8b46b7` (feat)
2. **Task 2: Four deliberate-violation fixtures** — `e02bbd5` (test)
3. **Task 3: Regression guards from the resolved config** — `ed2dc21` (test)

## Files Created/Modified

- `eslint.config.js` — `SPAWN_MESSAGE`, `FORBIDDEN_SPAWN_SPECIFIERS` (exported), `FORBIDDEN_SPAWN`, `SPAWN_SYNTAX`, `WORKSPACE_EXEMPTION`, `SPAWN_BAN_RULES`, `CORE_SPAWN_ADDITIONS`; spawn bans merged into `CORE_PURITY_RULES` and `VERDICT_SCHEMA_RULES`; `adl/no-direct-spawn` and `adl/no-direct-spawn-fixtures` entries; the spawn-ban row in the rule-table docblock; a fixtures-scoped `@typescript-eslint/no-require-imports: off`
- `test/lint/no-restricted-imports.test.ts` — four new `FIXTURES` rows plus a `the spawn boundary (WORK-02)` describe block carrying the Pitfall-1 regression guard, the tuple-driven per-specifier coverage assertion, the two-sided exemption proof, and the single-configuration invariant
- `test/lint/fixtures/spawn-direct-import.ts` — static `import` of `node:child_process`
- `test/lint/fixtures/spawn-require.ts` — `require('child_process')`, the bare spelling
- `test/lint/fixtures/spawn-dynamic-import.ts` — `await import('node:child_process')`
- `test/lint/fixtures/spawn-dynamic-execa.ts` — `await import('execa')`, the non-builtin case that watches the derivation rather than the rule

## Verification observations (the watched-failing evidence)

All three were run during execution and then restored. Each is required by the plan's acceptance criteria.

**1. Adding a fifth specifier changes nothing else.** With `'throwaway-probe'` appended to `FORBIDDEN_SPAWN_SPECIFIERS` and no other edit, the resolved config for `packages/db/src/index.ts` gained exactly one restricted path (`throwaway-probe`) and exactly two selectors (`CallExpression[callee.name='require'][arguments.0.value=/^throwaway-probe$/]` and `ImportExpression[source.value=/^throwaway-probe$/]`). Removed; lint and the suite returned to green.

**2. Hand-written `child_process`-only selectors fail the coverage assertion by name.** Replacing the derived `SPAWN_SYNTAX` with the two selectors from `02-RESEARCH.md § Pitfall 2` produced, for both `packages/db/src/index.ts` and `packages/core/src/verdict/verdict.ts`:

```
execa: no require() selector
execa: no dynamic import() selector
simple-git: no require() selector
simple-git: no dynamic import() selector
```

Two side-findings worth recording: the coverage assertion also reported the two `child_process` spellings as uncovered, because the hand-written alternation `/^(node:)?child_process$/` is not the anchored per-specifier pattern the guard requires — the guard is stricter than "does the selector match", which is the right direction. And the `spawn-dynamic-import.ts` fixture failed too, not for lack of a matching selector but because the hand-written form carries a single generic `SPAWN_MESSAGE` that never names the specifier, tripping the pre-existing "the report must name the thing that was banned" assertion. The derivation restored; 30/30 green.

**3. The Pitfall-1 regression guard, and what actually protects against it.** The plan predicted that reordering `architectureConfigs` so the broad spawn entry registers last would fail the guard. **It did not** — with the `ignores` carve-outs intact, the reorder was a complete no-op (30/30 still passed). The carve-outs, not the entry order, are the enforcement mechanism. Dropping the `packages/core/src/**/*.ts` carve-out from the reordered entry *did* reproduce Pitfall 1 exactly:

```
the @adl/core purity ban on node:fs no longer resolves for
packages/core/src/verdict/verdict.ts — an overlapping no-restricted-imports
entry has replaced CORE_PURITY_RULES (Pitfall 1):
expected [ 'node:child_process', …(3) ] to include 'node:fs'
```

**`pnpm lint` exited 0 in that broken state.** The regression guard was the only signal. Both edits restored; this finding is recorded as a comment on the `adl/no-direct-spawn` entry so a future contributor does not mistake the entry's position for the safety mechanism.

## Decisions Made

- **Per-specifier anchored patterns over the research's `/^(node:)?child_process$/` alternation.** The tuple already carries both spellings as separate entries, so a single derivation rule replaces a hand-maintained alternation that could drift from the import list. Eight selectors from four specifiers.
- **`-` deliberately not escaped in `specifierPattern`.** `\-` is an error under the `u` flag and is meaningless outside a character class; `simple-git` needs no escaping. Every genuine metacharacter is escaped.
- **The exemption covers the whole `packages/workspace` package, not just `src/`.** The package's own test suite has to stand up a temp git repository and exercise the exec path, and success criterion 2's wording is "outside the workspace module".
- **The test duplicates the anchoring rather than importing a helper from the config**, so the assertions can disagree with the config. A future specifier containing a regex metacharacter turns this red — the safe direction for a guard.
- **The `mentions: 'execa'` row is load-bearing.** A single catch-all selector would report *something* on `spawn-dynamic-execa.ts`; only the per-specifier derivation can name `execa` in the message. Observation 2 above confirms this discriminates.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed workspace dependencies in the worktree**
- **Found during:** Task 1 (running `pnpm lint`)
- **Issue:** The git worktree had no `node_modules`, and `pnpm` was not on `PATH`. No verification command could run.
- **Fix:** Resolved pnpm 11.22.0 through `corepack` (the version already pinned in `packageManager`) and ran `pnpm install --frozen-lockfile`. No manifest or lockfile change; all 179 packages reused from the local store.
- **Files modified:** none (`node_modules/` is gitignored)
- **Verification:** `pnpm lint`, `pnpm -r typecheck`, `pnpm vitest run --project root` all execute
- **Committed in:** n/a — no tracked file changed

**2. [Rule 1 - Bug] Corrected the refinement-selector filter in the Pitfall-1 guard**
- **Found during:** Task 3
- **Issue:** The guard filtered selectors with `.includes('refine')` and expected 2, but `superRefine` has a capital `R`, so only one matched. The guard failed on a correct config — a false positive, which would have trained a future contributor to distrust it.
- **Fix:** Lowercased the selector before matching, so both `refine` and `superRefine` are counted; the expected count of 2 is retained deliberately (both must survive, not merely one).
- **Files modified:** `test/lint/no-restricted-imports.test.ts`
- **Verification:** 30/30 pass; the guard still fails correctly under observation 3 above
- **Committed in:** `ed2dc21`

**3. [Rule 3 - Blocking] Narrowly-scoped base-rule exception for the require() fixture**
- **Found during:** Task 2 — anticipated by the plan, resolved empirically as instructed
- **Issue:** The negative control ("fixtures must be clean apart from the architecture rules") reported `@typescript-eslint/no-require-imports` on `spawn-require.ts`, whose entire reason for existing is to carry the `require()` call the architecture rule bans.
- **Fix:** One `files: ['test/lint/fixtures/spawn-*.ts']` entry in `baseConfigs` turning off that one rule, with a comment naming it and stating why. Not global, not an inline disable comment (which could also silence the architecture rule and make the fixture pass while proving nothing), and the negative control itself was not weakened.
- **Files modified:** `eslint.config.js`
- **Verification:** Negative control passes; `spawn-require.ts` is still reported by `no-restricted-syntax` at severity 2
- **Committed in:** `e02bbd5`

**4. [Rule 1 - Bug] Prettier formatting on the extended test file**
- **Found during:** Task 3
- **Issue:** `pnpm format` (`prettier --check .`) failed on `test/lint/no-restricted-imports.test.ts`. Not in the plan's verification list, but it is a repository check and would have gone red in CI.
- **Fix:** `prettier --write` on that file only.
- **Files modified:** `test/lint/no-restricted-imports.test.ts`
- **Verification:** `pnpm format` reports "All matched files use Prettier code style"; suite still 30/30
- **Committed in:** `ed2dc21`

---

**Total deviations:** 4 auto-fixed (2 blocking, 2 bugs)
**Impact on plan:** No scope creep. Deviation 3 was explicitly anticipated by the plan and resolved by the empirical procedure it prescribed. Deviations 2 and 4 were defects in this plan's own new code. Deviation 1 is environmental.

## Issues Encountered

- **The plan's third watched-failing prediction was wrong, and correcting it is the more valuable finding.** A pure reorder of `architectureConfigs` does not fail the regression guard; only removing the `packages/core/src/**` carve-out does. This is recorded in the config so the entry's position is not mistaken for the enforcement mechanism. The guard still works — it just guards the carve-outs, not the ordering.
- **`pnpm lint` stayed green while the `node:fs` purity ban was silently deleted.** This is the concrete confirmation that Pitfall 1 is a silent failure on this repository, and that lint alone cannot detect it.

## Threat Flags

None — this plan adds no network endpoint, auth path, file access pattern, or schema change. Its entire surface is lint configuration and never-executed fixtures. T-2-01 through T-2-05 from the plan's threat register are all `mitigate` and all now carry a passing assertion; T-2-05 (exemption widening) additionally survives as a `must_haves.prohibitions` item for a future verifier.

## Known Stubs

None. `test/lint/fixtures/spawn-*.ts` are deliberate-violation fixtures, not stubs: they are never compiled, executed, or imported, they are inside the global `test/lint/fixtures/**` ignore, and each is asserted to fail a specific rule at severity 2.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Ready for plan 02-03.** The exemption glob `packages/workspace/**/*.ts` and the `packages/workspace/src/exec/run.ts` exemption assertion are already in place, so the package can be created against a boundary that is already enforced — D-27's argument applied to the exec boundary. When 02-03 adds `execa` to `packages/workspace`'s manifest, no lint change is required.
- **Note for Phase 3:** the manager→worker `fork()` seam must land as a named export of `packages/workspace`, not as a second exemption. `SPAWN_MESSAGE` states this to anyone who trips the rule, and the `must_haves.prohibitions` entry makes a second exemption a verifier-visible violation.
- **No blockers.**

## Self-Check

**PASSED**

- `eslint.config.js` — FOUND
- `test/lint/no-restricted-imports.test.ts` — FOUND
- `test/lint/fixtures/spawn-direct-import.ts` — FOUND
- `test/lint/fixtures/spawn-require.ts` — FOUND
- `test/lint/fixtures/spawn-dynamic-import.ts` — FOUND
- `test/lint/fixtures/spawn-dynamic-execa.ts` — FOUND
- Commit `b8b46b7` — FOUND
- Commit `e02bbd5` — FOUND
- Commit `ed2dc21` — FOUND
- `pnpm lint` exit 0 — CONFIRMED
- `pnpm -r typecheck` exit 0 — CONFIRMED
- `pnpm vitest run --project root` exit 0, 30/30 — CONFIRMED

---
*Phase: 02-workspace-the-exec-boundary*
*Completed: 2026-08-18*
