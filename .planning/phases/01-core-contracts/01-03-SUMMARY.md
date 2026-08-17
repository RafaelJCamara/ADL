---
phase: 01-core-contracts
plan: 03
subsystem: infra
tags: [eslint, typescript-eslint, prettier, vitest, ci, architecture-rules, dependency-graph]

# Dependency graph
requires:
  - phase: "01-02"
    provides: "pnpm/TypeScript workspace, @adl/core and @adl/db source, root vitest.config.ts using test.projects"
provides:
  - "Flat ESLint config (eslint.config.js) with the D-27 dependency-graph rule, the @adl/core purity ban, and the verdict refinement ban — all at error severity"
  - "Four deliberate-violation fixtures proving each architecture rule fails, plus a negative control proving the failures are caused by those rules"
  - "test/toolchain.test.ts asserting TypeScript is pinned exactly at 6.0.3 and falls inside typescript-eslint's own declared peer range"
  - ".github/workflows/ci.yml running typecheck, lint, format, and both vitest suites on a Node [22, 24] matrix with no soft-failing leg"
  - "Root 'test' script and CI step that actually execute the 'root' vitest project (pnpm -r test alone silently skips it)"
affects: ["01-08"]

actuals:
  tokens: 7830
  tasks: 2
  commits: 3

tech-stack:
  added:
    - "eslint 10.8.1 flat config with typescript-eslint 8.67.0 helpers"
    - "prettier 3.9.6 (.prettierrc.json, .prettierignore)"
  patterns:
    - "Architecture rule sets defined once as named constants (CORE_PURITY_RULES, VERDICT_SCHEMA_RULES) and applied to two files globs — real source and the fixture glob — so the fixture test exercises the exact same rule objects, never a copy that can drift"
    - "Deliberate-violation fixtures under test/lint/fixtures/, globally ignored by eslint.config.js so 'eslint .' is not permanently red, but re-included via ESLint({ ignore: false }) inside the test that proves each rule fires"
    - "Toolchain version pins asserted against the dependency's own installed peer-range metadata (read via createRequire), never hardcoded, plus a fabricated-version unit test proving the range evaluator has teeth"

key-files:
  created:
    - eslint.config.js
    - .prettierrc.json
    - .prettierignore
    - test/lint/fixtures/core-fs-import.ts
    - test/lint/fixtures/core-env-read.ts
    - test/lint/fixtures/verdict-refine.ts
    - test/lint/fixtures/core-imports-db.ts
    - test/lint/no-restricted-imports.test.ts
    - test/toolchain.test.ts
    - .github/workflows/ci.yml
  modified:
    - vitest.config.ts
    - package.json

key-decisions:
  - "Edited the existing root vitest.config.ts to register the 'root' project rather than creating vitest.workspace.ts — Vitest 4 removed workspace-file support and 01-02 already resolved this; a fresh vitest.workspace.ts would have been silently ignored."
  - "The two @adl/core import bans (node:fs/child_process builtins, and sibling @adl/* packages) live in ONE no-restricted-imports entry rather than two, because ESLint allows only one configuration object per rule per file — a second entry would silently replace the first, which is exactly the kind of decorative misconfiguration Pitfall 8 warns about."
  - "test/lint/fixtures/** is globally ignored in eslint.config.js so the plain 'eslint .' (the lint script, and CI) is not permanently red by files that exist to fail. The proof test bypasses the ignore via ESLint({ ignore: false }) against the same real config file, so it is checking the identical rule objects CI runs."
  - "package.json's root 'test' script changed from 'pnpm -r test' to 'pnpm -r test && vitest run --project root' — pnpm -r iterates workspace packages only and reports 'Scope: 3 of 4 workspace projects', silently never running test/. Left as-is, the architecture-rule fixtures and the toolchain assertion would exist in the repository but never execute in CI — Pitfall 8 arriving through a different door than the one it names."
  - "prettier's endOfLine set to 'auto' rather than 'lf' — the repository has core.autocrlf on and no .gitattributes (noted as an open item in 01-02-SUMMARY.md), so 'lf' would make every existing CRLF file report as unformatted for a reason that has nothing to do with these rules."

requirements-completed: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-06]

coverage:
  - id: D1
    description: "A fixture importing node:fs from inside @adl/core's rule scope makes ESLint report an error, and removing the architecture rules from the config makes the same fixture report zero errors (negative control)"
    requirement: "CORE-01"
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts — 'test/lint/fixtures/core-fs-import.ts is reported by no-restricted-imports' and 'reports every fixture only because of the architecture rules'"
        status: pass
    human_judgment: false
  - id: D2
    description: "A fixture reading process.env from inside @adl/core's rule scope makes ESLint report an error at severity 2"
    requirement: "CORE-02"
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts — 'test/lint/fixtures/core-env-read.ts is reported by no-restricted-properties'"
        status: pass
    human_judgment: false
  - id: D3
    description: "A fixture calling .refine() under packages/core/src/verdict/ makes ESLint report an error, protecting the published JSON Schema from silently diverging from the enforced Zod contract"
    requirement: "CORE-04"
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts — 'test/lint/fixtures/verdict-refine.ts is reported by no-restricted-syntax'"
        status: pass
    human_judgment: false
  - id: D4
    description: "A fixture importing @adl/db from inside @adl/core makes ESLint report an error naming the forbidden cross-package import (D-27's dependency-graph rule)"
    requirement: "CORE-03"
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts — 'test/lint/fixtures/core-imports-db.ts is reported by no-restricted-imports'"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every architecture rule resolves to severity error for real core source, never warn, verified by reading the resolved config rather than string-matching the file"
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts — 'registers every architecture rule at error, never warn' and 'declares no architecture rule at anything other than error'"
        status: pass
    human_judgment: false
  - id: D6
    description: "The path-scoped ESLint run over test/ plus plan 01-02's settled core modules (errors.ts, hash.ts, criterion-ref.ts, finding.ts, waiver.ts, verdict.ts) exits 0 — the rules are satisfiable by real code, not only by the fixtures"
    verification:
      - kind: integration
        ref: "pnpm exec eslint test packages/core/src/errors.ts packages/core/src/hash.ts packages/core/src/verdict/{criterion-ref,finding,waiver,verdict}.ts — exit 0"
        status: pass
    human_judgment: false
  - id: D7
    description: "The resolved TypeScript version is exactly 6.0.3 and satisfies typescript-eslint's own declared peer range, read from its installed manifest rather than hardcoded"
    requirement: "CORE-05"
    verification:
      - kind: unit
        ref: "test/toolchain.test.ts — 'resolves TypeScript at exactly the pinned version' and 'keeps TypeScript inside the peer range typescript-eslint declares'"
        status: pass
    human_judgment: false
  - id: D8
    description: "CI declares a Node [22, 24] matrix and runs typecheck/lint/format/test with no leg allowed to fail softly, proving both the engines floor and the CLAUDE.md dev target actually work"
    requirement: "CORE-06"
    verification:
      - kind: manual_procedural
        ref: "BACKSTOP — the local machine runs Node 22.23.2 and cannot exercise both matrix legs itself. per must_haves in 01-03-PLAN.md and 01-VALIDATION.md § Manual-Only Verifications, this is confirmed by a human reading the first green CI run once the workflow file reaches GitHub."
        status: unknown
    human_judgment: true
    rationale: "01-VALIDATION.md explicitly marks the CI-matrix verification as the phase's sole manual-only item — a human must read the first green CI run, which cannot happen inside this worktree before the branch is pushed."

duration: 26min (active work; interrupted mid-execution by a session rate limit and resumed)
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 03: Architecture Rules Summary

**A flat ESLint config landing the D-27 dependency-graph rule, the `@adl/core` purity ban, and the verdict-refinement ban — each one watched failing on a committed fixture before it ever had to catch a real violation — plus a TypeScript-pin assertion and a Node `[22, 24]` CI matrix.**

## Performance

- **Duration:** ~26 min active work (session was interrupted by a rate limit between Task 1's completion and Task 2's `pnpm -r test` gap-fix; resumed from the exact point recorded in the prior turn)
- **Tasks:** 2
- **Files created:** 10
- **Files modified:** 2 (`vitest.config.ts`, `package.json`)
- **Commits:** 3 (1 RED, 1 GREEN for Task 1's TDD cycle, 1 for Task 2)

## Accomplishments

- `eslint.config.js`: four architecture rules, all at `error` severity, each defined once as a named constant and applied to both the real source glob and the fixture glob so the proof test exercises the exact rule objects CI runs — not a parallel copy.
- Four deliberate-violation fixtures under `test/lint/fixtures/`, each proven to fail, with a negative control proving the failures are caused by the rules and not by unrelated syntax problems.
- `test/lint/no-restricted-imports.test.ts`: 8 tests — one per fixture/rule pairing, the negative control, and two tests reading the resolved config's severities and exhaustiveness directly.
- `test/toolchain.test.ts`: 10 tests — the TypeScript pin, the peer-range check against `typescript-eslint`'s own manifest, the `packageManager` pin, and a self-test of the range evaluator against fabricated versions including the exact TS7 trap.
- `.github/workflows/ci.yml`: Node `[22, 24]` matrix, no `continue-on-error`, running typecheck, lint, format, both `pnpm -r test` and the `root` project explicitly.
- `.prettierrc.json` / `.prettierignore` added; `pnpm format` is clean over every file this plan touches.

## Task Commits

Each task was committed atomically, with Task 1 following its declared `tdd="true"` RED/GREEN cycle:

1. **Task 1 (RED): failing fixtures + assertion** - `eea3d37` (test)
2. **Task 1 (GREEN): the architecture rules that make them fail** - `9b49766` (feat)
3. **Task 2: toolchain assertion + CI matrix** - `7d6e6f3` (feat)

_No separate plan-metadata commit — the orchestrator owns STATE.md/ROADMAP.md updates for worktree-mode execution per this plan's execution instructions._

## Files Created/Modified

- `eslint.config.js` - flat config; `CORE_PURITY_RULES`, `VERDICT_SCHEMA_RULES`, `ARCHITECTURE_RULE_IDS`, `baseConfigs`, `architectureConfigs` all exported for the test to import
- `.prettierrc.json` / `.prettierignore` - formatting config, fixtures/planning/schema output excluded
- `test/lint/fixtures/core-fs-import.ts` - trips `no-restricted-imports` (node:fs)
- `test/lint/fixtures/core-env-read.ts` - trips `no-restricted-properties` (process.env)
- `test/lint/fixtures/verdict-refine.ts` - trips `no-restricted-syntax` (.refine())
- `test/lint/fixtures/core-imports-db.ts` - trips `no-restricted-imports` (@adl/db)
- `test/lint/no-restricted-imports.test.ts` - programmatic ESLint proof + negative control + severity/exhaustiveness assertions
- `test/toolchain.test.ts` - TypeScript pin + peer-range assertion + pnpm pin + range-evaluator self-test
- `.github/workflows/ci.yml` - Node `[22, 24]` matrix, full-suite steps
- `vitest.config.ts` - added the `root` project (edited, not replaced)
- `package.json` - root `test` script now also runs `vitest run --project root`

## Decisions Made

Beyond the frontmatter `key-decisions`:

1. **Fixture-glob dual registration.** Rather than writing a second, parallel rule config scoped to `test/lint/fixtures/`, each architecture rule set is a named JS constant applied to two `files` globs in the same `eslint.config.js`. This is what makes the proof test structurally unable to pass on a rule the real source isn't actually governed by.
2. **Fixtures globally ignored, then un-ignored inside the test.** `test/lint/fixtures/**` is in the top-level `ignores` array so `eslint .` (and therefore CI) is not permanently red by design — these files exist to fail. `test/lint/no-restricted-imports.test.ts` re-includes them via `new ESLint({ overrideConfigFile: CONFIG_FILE, ignore: false })`, loading the *same* config file CI loads, so what the test proves is what CI actually enforces.
3. **`pnpm -r test` does not run `test/`.** Discovered while verifying Task 2's acceptance criteria: `pnpm -r` reports `Scope: 3 of 4 workspace projects` and iterates only `packages/*`. Left alone, this plan's own fixtures and toolchain assertion would sit in the repository, fully written, and never execute in CI or in a contributor's `pnpm test` — the exact failure mode Pitfall 8 names, arriving through the workspace/root split rather than through the rule config itself. Fixed by chaining `vitest run --project root` onto the root `test` script and adding a matching CI step, with the reasoning recorded in a workflow comment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `pnpm -r test` silently excludes the `root` vitest project**
- **Found during:** Task 2, verifying the "full suite" acceptance criteria against the CI workflow being drafted
- **Issue:** `pnpm -r test` scopes to workspace *packages* (`packages/*`) and reports `Scope: 3 of 4 workspace projects` — it never runs the vitest `root` project this plan's own Task 1 registered. CI as drafted from the plan's literal instructions (`pnpm -r test`) would therefore never execute `test/lint/no-restricted-imports.test.ts` or `test/toolchain.test.ts` in the one place their result matters.
- **Fix:** Changed the root `package.json` `test` script to `pnpm -r test && vitest run --project root`, and added a matching CI step (`Test (workspace root suite)`) with a comment explaining why it exists separately from the `pnpm -r test` step above it.
- **Files modified:** `package.json`, `.github/workflows/ci.yml`
- **Verification:** `corepack pnpm vitest run --project root` continues to exit 0 with 18 tests passing; `.github/workflows/ci.yml` now contains both the `pnpm -r test` step and the explicit `pnpm vitest run --project root` step.
- **Committed in:** `7d6e6f3` (Task 2 commit)

**2. [Rule 3 - Blocking] `vitest.workspace.ts` vs `vitest.config.ts`, carried forward from 01-02**
- **Found during:** Task 1, before writing any code — flagged in the orchestrator's upstream-state briefing
- **Issue:** The plan's `files_modified` names both `vitest.workspace.ts` and `vitest.config.ts`. Vitest 4 removed standalone workspace-file support (01-02 already discovered and documented this); creating `vitest.workspace.ts` here would have produced a silently-ignored file.
- **Fix:** Edited the existing root `vitest.config.ts` to add a `root` project entry to `test.projects`, exactly as 01-02-SUMMARY.md's "Downstream note" anticipated. No `vitest.workspace.ts` was created.
- **Files modified:** `vitest.config.ts`
- **Verification:** `pnpm vitest run --project root` and `pnpm vitest run --project core` both resolve and run correctly.
- **Committed in:** `eea3d37` (Task 1 RED commit, since the project registration was needed for the test to even collect)

**3. [Rule 3 - Blocking] Workspace-wide `pnpm format` cannot pass during Wave 3, for the same reason `pnpm lint` cannot**
- **Found during:** Task 2, final verification sweep
- **Issue:** The plan's Task 1 acceptance criteria state `pnpm format` (unscoped, workspace-wide) must exit 0. It does not: three files plan 01-02 committed and this plan does not own — `packages/core/src/verdict/criterion-ref.ts`, `finding.ts`, `waiver.ts` — contain real Prettier formatting diffs (line-wrapped object properties), not CRLF artifacts. These files are outside this plan's declared `files_modified`, and the plan's own text explicitly carves out an identical situation for `pnpm lint` in the same task ("Do not run the workspace-wide `pnpm lint` as this task's gate... Prove satisfiability against the files that are settled instead"), naming exactly this set of 01-02 files as the settled scope for the lint gate. `pnpm format`'s unscoped acceptance criterion was not correspondingly narrowed in the plan text, but the underlying reasoning is identical: Wave 3 runs seven plans concurrently, and this plan cannot safely reach into files it does not own to reformat them without risking a collision with whichever later plan is responsible for them.
- **Fix:** Treated `pnpm format`'s gate the same way the plan treats `pnpm lint`'s gate — path-scoped to the files this plan created/touches plus the two settled files that already pass (`errors.ts`, `hash.ts`). `corepack pnpm exec prettier --check test eslint.config.js .prettierrc.json package.json vitest.config.ts .github/workflows/ci.yml packages/core/src/errors.ts packages/core/src/hash.ts` exits 0. The unscoped `pnpm format` is deferred to plan 01-08 Wave 4, exactly as the plan already defers unscoped `pnpm lint` there.
- **Files modified:** None (no files outside `files_modified` were touched)
- **Verification:** Path-scoped `prettier --check` exits 0; unscoped `pnpm format` will be re-run by 01-08 once every Wave 3 writer is settled.
- **Committed in:** N/A — no code change, a scoping decision recorded here for 01-08's awareness

---

**Total deviations:** 3 auto-fixed (all Rule 3 - blocking, resolved without touching files outside `files_modified`)
**Impact on plan:** No scope creep. Deviation 1 is a genuine correctness fix (untested code was about to ship). Deviations 2 and 3 both apply reasoning the plan itself already establishes for an adjacent gate, extended to a sibling gate the plan's acceptance-criteria wording did not explicitly narrow.

## Known Stubs

None. Every file this plan created is either a real, exercised architecture rule, a fixture that exists specifically to be caught, or a real assertion against installed package metadata.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers — no new network endpoints, auth paths, or trust-boundary-crossing surface was introduced. All five STRIDE entries (T-1-06, T-1-12, T-1-13, T-1-14, T-1-15) are mitigated as specified: see the `coverage` block above for the automated proof of each.

## Issues Encountered

- **Mid-execution session interruption.** The executing session hit a rate limit partway through Task 2, immediately after diagnosing the `pnpm -r test` scope gap and before committing the fix. On resume, `git status`/`git log` confirmed the worktree state matched exactly what the interrupted turn had described (uncommitted `package.json`, untracked `.github/` and `test/toolchain.test.ts`), so work continued from that point with no rework and no lost commits.
- No other issues. `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r test` (workspace packages) all remained green throughout, confirming this plan's additions did not regress plan 01-02's settled work.

## User Setup Required

None. `.github/workflows/ci.yml` activates on push/pull_request automatically once the branch reaches GitHub — no secrets or manual dashboard configuration needed for this workflow (it does not touch deployment or credentials).

## Next Phase Readiness

- **01-08 (Wave 4, workspace-wide gate):** run the unscoped `pnpm lint` and `pnpm format` once every Wave 3 sibling's writes have settled — both gates are deliberately path-scoped in this plan for the reasons above, and 01-08 is where they close. At time of writing, the only unscoped `pnpm format` failures are the three 01-02 files named in Deviation 3; 01-08 should re-check whether any Wave 3 sibling reformats them incidentally, and if not, format them as part of that plan's own gate.
- **Phase 2 (`WorkspaceBackend`, no-direct-spawn rule):** the mechanism D-27 promised is live and proven — `CORE_PURITY_RULES`'s sibling-package ban in `eslint.config.js` is the pattern to extend with a `no-direct-spawn` rule scoped the same way, and `ARCHITECTURE_RULE_IDS` / `architectureConfigs` are already exported for a future test to import.
- **Phase 11 (backend-identity rule):** the same `no-restricted-imports` mechanism carries this per the header comment in `eslint.config.js` — no new infrastructure needed, just a new pattern entry and a fixture.
- **CI matrix confirmation (D8 above) remains open** until a human reads the first green run on GitHub, per 01-VALIDATION.md's manual-only-verification note. This is the phase's sole manual backstop item and is not blocking for this plan's own completion.

## Self-Check: PASSED

- All 10 created files and 2 modified files verified present via `git status --short` (clean) and `git log --oneline -6` (three plan commits: `eea3d37`, `9b49766`, `7d6e6f3`, atop `7f59c9c`).
- `pnpm vitest run --project root` — 2 test files, 18 tests, all passing.
- `pnpm exec eslint test packages/core/src/errors.ts packages/core/src/hash.ts packages/core/src/verdict/{criterion-ref,finding,waiver,verdict}.ts` — exit 0.
- `pnpm -r build` and `pnpm -r typecheck` — 3/3 packages Done, no regressions against plan 01-02's settled work.
- Path-scoped `prettier --check` over every file this plan owns — exit 0.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
