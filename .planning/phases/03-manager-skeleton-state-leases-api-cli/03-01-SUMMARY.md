---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 01
subsystem: infra
tags: [pnpm-workspace, hono, commander, vitest, ci-matrix, monorepo-scaffolding]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    provides: "@adl/workspace's package.json/tsconfig.json/vitest.config.ts/src barrel as the template both new packages copy"
provides:
  - "@adl/manager — a real, installed, typechecked, tested package with hono, @hono/node-server, pino, croner, ulid, @adl/db (dependency), @adl/core, @adl/workspace"
  - "@adl/cli — a real, installed, typechecked, tested package with commander and a bin entry, structurally unable to resolve @adl/db or @adl/manager"
  - "A three-leg CI matrix (ubuntu/22, ubuntu/24, windows/22) with Linux-only steps gated by runner.os"
  - "packages/manager/test/helpers/platform.ts — requirePlatform/windowsOnly visible-skip gate for D-33's Windows-only assertions"
affects: [03-02, 03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 5700
  tasks: 3
  commits: 2

tech-stack:
  added: [hono@4.13.2, "@hono/node-server@2.1.1", pino@10.3.1, croner@10.0.1, ulid@3.0.2, commander@15.0.0, yaml@2.9.0 (root devDependency)]
  patterns:
    - "New package scaffold copies packages/workspace's package.json/tsconfig.json/vitest.config.ts verbatim, adjusting only name/description/deps"
    - "A package that must not reach another package's internals (CLI vs @adl/db/@adl/manager) enforces that by omission from package.json, not by lint rule — pnpm's strict node_modules makes the omission a resolve-time failure"
    - "Visible-skip test helper: re-declare the shape in the new package's own test/helpers/ rather than importing across a package boundary; SKIP_PREFIX stays a literal-identical greppable string"
    - "CI matrix os dimension with exclude entries to drop unsupported (os, node-version) pairs, rather than a second matrix or job"

key-files:
  created:
    - packages/manager/package.json
    - packages/manager/tsconfig.json
    - packages/manager/vitest.config.ts
    - packages/manager/src/index.ts
    - packages/manager/test/smoke.test.ts
    - packages/manager/test/helpers/platform.ts
    - packages/manager/test/helpers/platform.test.ts
    - packages/cli/package.json
    - packages/cli/tsconfig.json
    - packages/cli/vitest.config.ts
    - packages/cli/src/index.ts
    - packages/cli/test/smoke.test.ts
    - test/ci-matrix.test.ts
  modified:
    - .github/workflows/ci.yml
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "Added yaml@2.9.0 as a root devDependency (already pinned at this exact version via @adl/core) so test/ci-matrix.test.ts can parse .github/workflows/ci.yml as structured YAML rather than grepping raw text — the plan's acceptance criteria required asserting on parsed structure, and no YAML parser was reachable from the workspace root."
  - "packages/manager/test/helpers/platform.ts re-declares SKIP_PREFIX/the gate shape rather than importing packages/workspace/test/helpers/platform.ts, per the plan's explicit instruction: it lives in a different package's test/ directory and is not on any barrel."

requirements-completed: [EXEC-01, EXEC-02]

coverage:
  - id: D1
    description: "@adl/manager and @adl/cli exist as real, installable, typechecked, tested packages (no placeholders)"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "packages/manager/test/smoke.test.ts#@adl/manager barrel > resolves"
        status: pass
      - kind: unit
        ref: "packages/cli/test/smoke.test.ts#@adl/cli barrel > resolves"
        status: pass
      - kind: other
        ref: "pnpm -r typecheck (manager and cli included, exit 0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "@adl/cli structurally cannot resolve @adl/db or @adl/manager"
    requirement: EXEC-02
    verification:
      - kind: other
        ref: "node -e \"const p=require('./packages/cli/package.json');...\" exits 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "CI runs on windows-latest as well as ubuntu-latest, with Linux-only steps gated"
    requirement: EXEC-01
    verification:
      - kind: unit
        ref: "test/ci-matrix.test.ts#.github/workflows/ci.yml — the D-33 cross-platform matrix (6 assertions)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A platform-gated assertion in @adl/manager writes a stated reason to stderr when it skips, and fails rather than skips silently when misconfigured on the platform where it applies"
    requirement: EXEC-01
    verification:
      - kind: unit
        ref: "packages/manager/test/helpers/platform.test.ts (5 assertions covering skip/run for both requirePlatform and windowsOnly)"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-19
status: complete
---

# Phase 3 Plan 01: Manager Skeleton Wave-0 Scaffolding Summary

**Stood up `@adl/manager` and `@adl/cli` as real, tested pnpm packages, added a three-leg (ubuntu/22, ubuntu/24, windows/22) CI matrix with Linux-only steps gated by `runner.os`, and shipped a windows-only visible-skip test helper for `@adl/manager` following the D-21 discipline `@adl/workspace` established.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-08-19T15:00:00Z (approx, prior dispatch's Task 1 checkpoint resolution carried forward)
- **Completed:** 2026-08-19T15:55:00Z (approx)
- **Tasks:** 3 (Task 1 checkpoint pre-resolved from a prior dispatch; Tasks 2-3 executed this dispatch)
- **Files modified:** 16 (13 created, 3 modified)

## Accomplishments

- `@adl/manager`: real package depending on `@adl/core`, `@adl/db` (production dependency — the manager is the only DB writer), `@adl/workspace`, `hono@4.13.2`, `@hono/node-server@2.1.1`, `pino@10.3.1`, `croner@10.0.1`, `ulid@3.0.2`. Typechecks and passes its test suite (smoke test + platform-gate unit tests).
- `@adl/cli`: real package with `commander@15.0.0` and a `bin: { adl: "./dist/index.js" }` entry. Structurally cannot resolve `@adl/db` or `@adl/manager` — neither is listed in its `package.json`, verified by a `require()`-based script that exits non-zero if either key is present in the merged dependency set.
- `.github/workflows/ci.yml` now runs three legs (ubuntu/22, ubuntu/24, windows/22) instead of two (ubuntu/22, ubuntu/24). The Linux-only worker-user provisioning step and its `sg`-wrapped test step are gated `if: runner.os == 'Linux'`; a sibling `Test (non-Linux)` step runs plain `pnpm -r test` on the Windows leg; the workspace-root-suite step remains unconditional.
- `packages/manager/test/helpers/platform.ts` exports `SKIP_PREFIX`, `PlatformGate`, `requirePlatform`, and `windowsOnly` — a Windows-focused sibling of `@adl/workspace`'s `linuxOnly`/`posixOnly`, re-declared (not imported) because it lives in a different package's `test/` directory and is not on any barrel.
- `test/ci-matrix.test.ts` parses `.github/workflows/ci.yml` as YAML and asserts the matrix, the `runs-on: ${{ matrix.os }}` interpolation, and the `if:` gating on the provisioning and test steps — so a later edit that silently deletes the Windows leg or its gating turns the local suite red instead of leaving CI's meaning quietly degraded (threat T-3-10).

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy gate — hono and @hono/node-server** — pre-resolved from a prior dispatch of this plan (human approved both `hono` and `@hono/node-server` against npmjs.com, confirming the `[SUS]`/`too-new` flag as a false positive). No file changes; approval recorded in Task 2's commit message.
2. **Task 2: Scaffold @adl/manager and @adl/cli as real packages** - `59a475c` (feat)
3. **Task 3: The windows-latest CI leg and the manager's visible-skip gate** - `c51dd07` (feat)

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

_Note: this plan had no `tdd="true"` tasks, so there is no RED/GREEN/REFACTOR sequence to report._

## Files Created/Modified

- `packages/manager/package.json` - `@adl/manager` manifest: hono/pino/croner/ulid deps, @adl/db as production dependency
- `packages/manager/tsconfig.json` - copied from `@adl/workspace`, comment adjusted for `child_process.fork`/HTTP server rationale
- `packages/manager/vitest.config.ts` - project name `manager`
- `packages/manager/src/index.ts` - empty barrel with header comment (nothing to export yet)
- `packages/manager/test/smoke.test.ts` - imports and resolves the barrel
- `packages/manager/test/helpers/platform.ts` - `requirePlatform`/`windowsOnly` visible-skip gate
- `packages/manager/test/helpers/platform.test.ts` - unit tests for both skip and run cases
- `packages/cli/package.json` - `@adl/cli` manifest: commander only, `bin` entry, no `@adl/db`/`@adl/manager`
- `packages/cli/tsconfig.json` - copied from `@adl/workspace`, comment adjusted for CLI-entry rationale
- `packages/cli/vitest.config.ts` - project name `cli`
- `packages/cli/src/index.ts` - empty barrel with header comment
- `packages/cli/test/smoke.test.ts` - imports and resolves the barrel
- `test/ci-matrix.test.ts` - parses and asserts on `.github/workflows/ci.yml`'s structure
- `.github/workflows/ci.yml` - `os` matrix dimension, `exclude` entry, `defaults.run.shell: bash`, Linux-only gating, new non-Linux test step
- `package.json` - added `yaml@2.9.0` devDependency for `test/ci-matrix.test.ts`
- `pnpm-lock.yaml` - records the two new packages and their dependencies, plus `yaml` at the workspace root

## Decisions Made

- Added `yaml@2.9.0` as a root devDependency, matching the exact version already pinned in `@adl/core`. The root test suite had no YAML parser available (pnpm's strict `node_modules` means nothing hoists implicitly), and the plan's acceptance criteria required `test/ci-matrix.test.ts` to assert on parsed YAML structure, not raw substrings.
- `packages/manager/test/helpers/platform.ts` re-declares the visible-skip shape rather than importing `@adl/workspace/test/helpers/platform.ts` across the package boundary — this was explicit in the plan's `<action>` and matches the project's existing pattern of package-local test helpers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `yaml` as a root devDependency to make `test/ci-matrix.test.ts` possible**
- **Found during:** Task 3 (writing `test/ci-matrix.test.ts`)
- **Issue:** The plan's acceptance criteria require asserting on `.github/workflows/ci.yml`'s parsed structure ("Assert on parsed structure where practical rather than on raw substrings"), but no YAML parser was reachable from the workspace root under pnpm's strict `node_modules`.
- **Fix:** Added `yaml@2.9.0` to the root `package.json`'s `devDependencies`, at the exact version already used by `@adl/core` for `adl.yml` parsing — not a new, unvetted dependency, the same package already present in the lockfile at the same version.
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm vitest run --project root -- ci-matrix` passes (6 assertions across 6 `it` blocks); `pnpm format`/`pnpm lint` still exit 0.
- **Committed in:** `c51dd07` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Necessary to satisfy the plan's own acceptance criteria for `test/ci-matrix.test.ts`. No scope creep — `yaml` was already a vetted, in-repo dependency at the exact version added.

## Issues Encountered

- The sandboxed shell in this worktree does not have `pnpm` directly on `PATH` (only `corepack`); all `pnpm` invocations in this dispatch were run as `corepack pnpm ...`. This is an environment quirk of the execution sandbox, not a repository or CI issue — `.github/workflows/ci.yml`'s own `Activate pnpm via corepack` step already runs `corepack enable && corepack prepare pnpm@11.22.0 --activate` before any `pnpm` invocation, so CI is unaffected. Verified equivalence by running `corepack pnpm -r test` (all 6 packages, 665+ tests) and `corepack pnpm vitest run --project root -- ci-matrix` separately rather than the composed root `pnpm test` script, since that script's own body shells out to `pnpm` by bare name.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@adl/manager` and `@adl/cli` exist as real packages other Wave-1+ plans in this phase (03-02 through 03-09) can add source files to without re-scaffolding.
- The CI matrix's Windows leg is live and asserted by `test/ci-matrix.test.ts`, so later plans that add Linux-only or Windows-only test cases have `windowsOnly`/`linuxOnly`/`posixOnly` gates already available in both `@adl/manager` and `@adl/workspace`.
- No blockers for the rest of Phase 3's plans.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-19*

## Self-Check: PASSED

All created files and commit hashes verified present on disk / in git log.
