---
phase: 02-workspace-the-exec-boundary
plan: 04
subsystem: workspace
tags:
  [
    worktree,
    reclamation,
    gc,
    teardown,
    idempotency,
    porcelain,
    dependency-injection,
    simple-git,
  ]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    plan: 03
    provides: 'createWorktree / destroyWorktree / branchNameFor and the withTempRepo fixture, hardened in place here rather than rewritten'
  - phase: 02-workspace-the-exec-boundary
    plan: 02
    provides: 'The adl/no-direct-spawn exemption for packages/workspace, which gc.ts inherits transitively through lifecycle.ts'
  - phase: 01-core-contracts
    provides: 'TERMINAL_STATES and its deliberate escalated exclusion; isRepoRelativePath; the featuresRepository shape the sweep lookup is bound to in the test'
provides:
  - 'destroyWorktree: forced two-step teardown with per-step idempotency, safe to re-run over a half-torn-down feature'
  - 'createWorktree: feature-id guard plus refusal to reuse a live worktree or an existing adl/ branch'
  - 'featureIdFromBranch: exact-prefix ref → feature id, so prefix-sharing ids are never confused'
  - 'parseWorktreeList: pure porcelain -z parser, testable with no git binary'
  - 'listManagedWorktrees: D-20 mechanism — ordered inventory scoped to ADL branches'
  - 'sweepOrphans / GcDeps / FeatureStateLookup / SweepFailure: the GC backstop over an injected lookup, with no runtime database dependency'
  - 'openTempRepo: the beforeAll/afterAll form of the temp-repo fixture'
affects: [02-05, 02-06, 02-07, 02-08, phase-03-manager-worker, phase-05-harnesses]

actuals:
  tokens: 32000
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - 'Watched-failing guards continued from 02-02/02-03: the branch half of teardown and the escalated exclusion were each observed failing against the exact defect they exist to catch, then restored'
    - 'Mechanism/policy split expressed as separate modules: list.ts reports what exists, gc.ts decides what goes, and the barrel comments name the split'
    - 'Containment by injected function: gc.ts reaches feature state through a parameter, so the database dependency is structurally unavailable rather than merely unused'

key-files:
  created:
    - packages/workspace/src/worktree/list.ts
    - packages/workspace/src/worktree/gc.ts
    - packages/workspace/test/worktree/lifecycle.test.ts
    - packages/workspace/test/worktree/list.test.ts
    - packages/workspace/test/worktree/gc.test.ts
  modified:
    - packages/workspace/src/worktree/lifecycle.ts
    - packages/workspace/src/worktree/backend.ts
    - packages/workspace/src/index.ts
    - packages/workspace/package.json
    - packages/workspace/test/helpers/temp-repo.ts
    - pnpm-lock.yaml

key-decisions:
  - '"Already gone" is detected from git''s message ONLY, not from an exit status, because simple-git@3.36.0''s GitError carries exactly two own properties — task and message — and no exit code at all. Verified against the installed package: e.exitCode, e.code and e.status are all undefined. The plan asked for "message and exit status"; the second half is not obtainable through this client.'
  - 'worktree remove --force needs no special handling for a directory deleted out from under git: it exits 0 and clears the administrative entry itself (verified against git 2.49). The prune fallback is therefore reached only for a genuinely unregistered path.'
  - 'sweepOrphans returns the removed ids and reports failures through an optional onFailure callback, rather than returning a compound result. This keeps the signature the plan specified (Promise<readonly string[]>) while still satisfying "report the failures alongside the removals".'
  - 'createWorktree refuses an existing directory or branch instead of reclaiming it. Reclamation from a filesystem signal is exactly what WORK-04 forbids; the sweep reclaims, and the sweep asks feature state.'
  - 'The feature-id guard reuses isRepoRelativePath from @adl/core/config rather than writing a second path guard, and adds only the constraint a single path SEGMENT has over a relative path (no separators).'

patterns-established:
  - 'openTempRepo/cleanup alongside withTempRepo, so a suite can amortise git init across cases without losing the callback form''s un-forgettable finally'
  - 'Cross-package test-fixture reuse: the workspace GC test imports the db package''s own withTempDb rather than standing up a second database fixture that could drift from the real schema'

requirements-completed: [WORK-01, WORK-04]

coverage:
  - id: D1
    description: 'Teardown removes the worktree AND the branch, asserted as two independent checks'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'packages/workspace/test/worktree/lifecycle.test.ts#removes the worktree AND the branch'
        status: pass
      - kind: other
        ref: 'Watched failing: with branch -D removed, the two worktree assertions (lines 185-186) PASSED and only the branch assertion (line 187) failed — confirming the halves discriminate'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Teardown survives a dirty worktree and is safe to run twice, including after dying between the two steps'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'lifecycle.test.ts#succeeds on a worktree carrying modified and untracked files; #is a no-op the second time; #finishes a teardown that died between the two steps'
        status: pass
    human_judgment: false
  - id: D3
    description: 'A non-"already gone" teardown failure rethrows rather than being swallowed'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'lifecycle.test.ts#rethrows a failure that is not "already gone"'
        status: pass
    human_judgment: false
  - id: D4
    description: 'createWorktree rejects unusable feature ids and refuses to reuse a live worktree or existing branch'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'lifecycle.test.ts#createWorktree: the feature-id guard (6 rejection cases + 2 refusal cases)'
        status: pass
    human_judgment: false
  - id: D5
    description: 'feat-1 and feat-1-evil get separate directories and branches, and neither teardown nor the inventory confuses them'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'lifecycle.test.ts#does not confuse two features whose ids share a prefix; list.test.ts#keeps prefix-sharing feature ids apart'
        status: pass
      - kind: unit
        ref: 'lifecycle.test.ts#takes the remainder whole, so a prefix-sharing id is not truncated'
        status: pass
    human_judgment: false
  - id: D6
    description: 'listManagedWorktrees returns an empty array on a repository with no ADL worktrees, in git emission order, stably across calls'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'list.test.ts#returns an empty array on a repository with no ADL worktrees; #lists ADL worktrees in git’s emission order, stably'
        status: pass
    human_judgment: false
  - id: D7
    description: 'The sweep removes merged, abandoned, and unknown-id worktrees and leaves escalated and running ones in place'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'gc.test.ts#collects terminal and unknown features, and spares the rest — against a real migrated database'
        status: pass
      - kind: other
        ref: 'Watched failing: with TERMINAL_STATES replaced by a transcribed list including escalated, kept-escalated appeared in the removal list and the assertion went red'
        status: pass
    human_judgment: false
  - id: D8
    description: 'A second consecutive sweep returns an empty list and throws nothing'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'gc.test.ts#is a no-op on a second consecutive pass'
        status: pass
    human_judgment: false
  - id: D9
    description: 'Many features created, then swept, leave no ADL worktree and no adl/* branch — success criterion 1'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'gc.test.ts#leaves a repository with no worktree and no adl/* branch (success criterion 1) — 8 features, two of them crash-orphaned by deleting the directory out from under git'
        status: pass
    human_judgment: false
  - id: D10
    description: 'A per-entry failure does not abort the pass, and the failed entry is left fully intact'
    requirement: WORK-04
    verification:
      - kind: integration
        ref: 'gc.test.ts#continues past a per-entry failure and reports it'
        status: pass
    human_judgment: false
  - id: D11
    description: 'packages/workspace declares no runtime dependency on the database package'
    requirement: WORK-04
    verification:
      - kind: other
        ref: 'node -e manifest checks: @adl/db absent from dependencies (exit 0) and present in devDependencies (exit 0); grep for @adl/db across packages/workspace/src finds only an explanatory comment, no import'
        status: pass
    human_judgment: false

duration: 38min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 04: Reclamation — Ordered Teardown and the GC Backstop Summary

**Teardown now removes the worktree *and* the branch in the only order git permits, each step independently idempotent, and a `sweepOrphans` backstop collects whatever a crash skipped — with the collection decision made from feature state alone, through an injected lookup that keeps the swappable backend free of any database dependency.**

## Performance

- **Duration:** ~38 min
- **Tasks:** 3
- **Commits:** 3
- **Files:** 11 changed (5 created, 6 modified), 1298 insertions

## Accomplishments

- **The half-satisfied success criterion is closed, and proven closed.** Plan `02-03` watched `worktree remove` leave `adl/tracer-1` behind while the worktree assertion still passed. This plan's teardown test asserts the two halves independently, and the branch half was watched failing against exactly that defect: with `branch -D` removed, lines 185 and 186 (`worktree list` no longer names the path; the directory is gone) both **passed**, and only line 187 failed. A worktree-only test would have been green.
- **Teardown is idempotent per step, not per function.** The four ways a teardown can be interrupted — never started, worktree gone, branch gone, both gone — all converge on the same end state. The `finishes a teardown that died between the two steps` case is the one that matters for the backstop: it is the exact state a worker crash produces.
- **`escalated` is spared automatically, not by remembering to spare it.** `TERMINAL_STATES` is imported from `@adl/core/state`, so the exclusion the lifecycle diagram draws holds without `gc.ts` knowing why. Watched failing with a transcribed list: `kept-escalated` was collected.
- **The database dependency is structurally absent, not merely unused.** `sweepOrphans` takes a `FeatureStateLookup` function. There is no import to remove later, no clock read, and no `maxAge` parameter — an age heuristic (T-2-15) has nowhere natural to appear.
- **Success criterion 1 is testable now rather than in Phase 3.** The GC test creates eight features, retires four cleanly and crash-orphans two by deleting their directories out from under git, sweeps once, and asserts on both `git worktree list` and `git branch --list 'adl/*'`.

## Task Commits

1. **Task 1: Teardown that removes both halves, in the only order git permits, twice safely** — `1167511` (feat)
2. **Task 2: The disk inventory — a pure porcelain parser and `listManagedWorktrees`** — `777a5e5` (feat)
3. **Task 3: `sweepOrphans` — the GC pass, database-free by construction** — `0ab7b36` (feat)

## Verification observations (the watched-failing evidence)

**1. The branch half of teardown discriminates.** With the `branch -D` block replaced by a no-op:

```
AssertionError: expected [ 'adl/clean-1' ] to not include 'adl/clean-1'
 ❯ test/worktree/lifecycle.test.ts:187:45
```

Lines 185–186 — the two worktree assertions — passed. This reproduces `02-RESEARCH.md § Pitfall 3` against this plan's own test rather than against a scratch repo, and is the direct answer to the defect `02-03` recorded.

**2. The `escalated` exclusion discriminates.** With `TERMINAL_STATES` replaced by `['merged', 'abandoned', 'escalated']`:

```
  [
    "gone-abandoned",
    "gone-merged",
    "gone-unknown",
+   "kept-escalated",
  ]
 ❯ test/worktree/gc.test.ts:137:37
```

The transcribed list is exactly the mistake a future contributor makes when they cannot be bothered to import a constant, and it destroys the worktree a human was coming back to (T-2-12).

## Decisions Made

See `key-decisions` in the frontmatter. The two worth expanding:

**"Already gone" is detected from the message alone, because there is no exit status to read.** The plan specifies detecting the idempotent case "by inspecting the error's message and exit status rather than by pre-checking the filesystem". The first and third parts are implemented as written; the second is not available. `simple-git@3.36.0` raises a `GitError` whose own property list is exactly `["task"]` — `exitCode`, `code`, and `status` are all `undefined` (verified against the installed package, both for `worktree remove` on a non-existent tree and `branch -D` on a missing branch). Git's own exit codes for these are 128 and 1 respectively; neither reaches the caller. The message match is anchored on git's stable phrasings (`is not a working tree`, `branch ... not found`) and the reasoning is recorded at both predicates so a later reader does not assume the exit status was simply forgotten. **The pre-check the plan warned against is genuinely avoided** — nothing stats the filesystem before removing, so there is no window for a concurrent sweep to race into.

**The prune fallback is reached less often than the research suggested.** `02-RESEARCH.md`'s example runs `worktree prune` whenever removal reports "already gone". Probing git 2.49 showed that the most common crash shape — the directory deleted while git's administrative entry survives — is handled by `worktree remove --force` itself, which exits **0** and clears the entry. The fallback is kept (it is correct for a path git has no record of at all), but the GC test's crash-orphan case exercises the exit-0 path, and that is why it passes without a prune.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Bootstrapped pnpm and dependencies in the worktree**

- **Found during:** Task 1 setup
- **Issue:** The worktree had no `node_modules`, `pnpm` was not on `PATH`, and `@adl/core` had no `dist/`, so `@adl/core/config` could not resolve and no verification could run.
- **Fix:** Used the existing corepack shims (`$HOME/.corepack-shims`, pnpm 11.22.0 — the pinned version), ran `pnpm install --frozen-lockfile`, then `pnpm -r build`.
- **Files modified:** none (`node_modules/` and `dist/` are gitignored)
- **Committed in:** n/a

**2. [Rule 3 — Blocking] Added `openTempRepo` to the shared temp-repo fixture**

- **Found during:** Task 1
- **Issue:** The plan directs the suite to use one temp repository per file via `beforeAll`, but `withTempRepo` exposes only the callback form, which cannot be held across `beforeAll`/`afterAll`.
- **Fix:** Added `openTempRepo()` returning an `OpenedTempRepo` with `cleanup()`, and re-expressed `withTempRepo` in terms of it so there is still exactly one fixture rather than two that can drift. `withTempRepo`'s behaviour and signature are unchanged, so `02-03`'s tracer test is unaffected.
- **Note:** `test/helpers/temp-repo.ts` is not in the plan's `files_modified`. It is not owned by the concurrently-running plan `02-05` (which owns `exec/env.ts` and `exec/scratch-home.ts`), so the merge risk is small and the change is additive.
- **Committed in:** `1167511`

**3. [Rule 2 — Missing critical functionality] A tracked file in the fixture's initial commit**

- **Found during:** Task 1
- **Issue:** The fixture committed `--allow-empty`, so there was no tracked file to modify, and the plan's required "teardown of a worktree containing a **modified tracked** file" case could not be written honestly — only untracked files could be created.
- **Fix:** The initial commit now contains `tracked.txt`. Without this, the `--force` test would have proven only half of what `§ Pitfall 9` documents.
- **Committed in:** `1167511`

**4. [Rule 1 — Bug] The test helper stripped the wrong branch marker**

- **Found during:** Task 1 (first test run — 2 failures)
- **Issue:** `git branch --list` marks a branch checked out in a **linked worktree** with `+`, not `*`. The helper stripped only `*`, so every assertion comparing against `adl/<id>` saw `+ adl/<id>`.
- **Fix:** Strip a leading `[*+]`. This was a defect in the new test code, not in `lifecycle.ts`.
- **Committed in:** `1167511`

**5. [Rule 2 — Missing critical functionality] `onFailure` on `GcDeps`**

- **Found during:** Task 3
- **Issue:** The plan requires the sweep to "report the failures alongside the removals so a caller can surface them", while also specifying the return type as `Promise<readonly string[]>`. A swallowed failure with no channel out is an invisible stuck worktree.
- **Fix:** An optional `onFailure` callback on `GcDeps` plus an exported `SweepFailure` type. The declared return type is unchanged.
- **Committed in:** `0ab7b36`

**6. [Rule 3 — Blocking] `pretest` now builds `../db` as well as `../core`**

- **Found during:** Task 3
- **Issue:** The GC test imports `@adl/db`, which resolves to `dist/`. With `pretest` building only core, `pnpm -r test` would run the workspace suite against a missing or stale db build.
- **Fix:** `"pretest": "tsc -b ../core ../db"` in `packages/workspace/package.json` (a file the plan already scopes to this task).
- **Committed in:** `0ab7b36`

**7. [Rule 1] Prettier formatting**

- **Found during:** Tasks 1–3
- **Issue:** `pnpm format` (a repository check that would go red in CI) failed on the new files.
- **Fix:** `prettier --write` on each before its commit.
- **Committed in:** all three commits

---

**Total deviations:** 7 auto-fixed (3 blocking-environmental/structural, 2 bugs, 2 missing-functionality). No Rule 4 architectural changes; no scope creep.

### Deliberate scope boundaries held

`exec/env.ts` and `exec/scratch-home.ts` were **not touched** — they belong to plan `02-05`, which ran concurrently. `read`/`write`/`snapshot` remain `02-06`'s stubs. `STATE.md` and `ROADMAP.md` were not modified; the orchestrator owns them. The deferred `binary_missing` classification (`deferred-items.md` D-2-03-1) was read and deliberately not re-litigated — no exec-failure classification was added.

## Issues Encountered

- **The GC test's cross-package fixture import.** `gc.test.ts` imports `withTempDb` from `../../../db/test/helpers/temp-db.js`. This is deliberate — the plan names that fixture as the one to compose with, and a second database fixture would be free to drift from the real schema — but it is a relative path across a package boundary, which is unusual in this repository. It resolves cleanly under Vitest and is not part of any package's `tsconfig` `include`, so it affects no build.
- **No `pnpm-lock.yaml` resolution churn.** Adding `@adl/db` as a `workspace:*` devDependency changed three lines and required no network resolution; the supply-chain policy check passed unchanged.

## Threat Model Verification

| Threat ID | Disposition | Status |
| --------- | ----------- | ------ |
| T-2-11 | mitigate | **Mitigated.** Two-step teardown with both halves asserted independently in `lifecycle.test.ts`, watched failing; `sweepOrphans` is the backstop, and the success-criterion test proves eight features leave neither a worktree nor an `adl/*` branch. |
| T-2-12 | mitigate | **Mitigated.** Feature state is the only signal — `gc.ts` reads no clock and accepts no age parameter. `TERMINAL_STATES` is imported, so the `escalated` exclusion is automatic; watched failing with a transcribed list. `kept-escalated` and `kept-developing` are both asserted to survive, worktree and branch. |
| T-2-13 | mitigate | **Mitigated.** `--force` is unconditional; per-entry failures are reported through `onFailure` and the pass continues (asserted: the entry after the failing one is still collected); each teardown step is independently idempotent so a re-run finishes the job. |
| T-2-14 | mitigate | **Mitigated.** `featureIdFromBranch` matches the prefix exactly and takes the remainder whole. Asserted as a unit case, in the teardown suite (`feat-1` destroyed, `feat-1-evil` intact in both halves), and in the inventory suite. |
| T-2-15 | accept | **Accepted as planned.** The injected-lookup signature makes the state store a required argument. Reinforced beyond the plan: `gc.ts` has no time input at all, and its header records the prohibition explicitly. |

## Threat Flags

None. This plan adds no network endpoint, no auth path, and no schema change. It *removes* filesystem surface (a destructive operation gated more tightly than before) rather than adding any.

## Known Stubs

None introduced by this plan. `read`/`write`/`snapshot` on the worktree backend remain plan `02-06`'s stubs, unchanged and untouched here.

## User Setup Required

None.

## Next Phase Readiness

- **Phase 3 (manager/worker)** owns the three bindings this plan deliberately did not make, all named in `gc.ts`'s header so they cannot be mistaken for oversights: wiring `lookupFeatureState` to `featuresRepository.findById`, running the periodic backstop schedule, and exposing the manual trigger as a CLI verb (D-15).
- **The D-20 boundary note in the plan's objective still applies** — the join lives in `packages/workspace` rather than the manager, and a verifier reading D-20 literally should read `gc.ts`'s header before flagging the manager as missing sweep work it never had.
- **`02-05`** is unaffected: `buildChildEnv`'s reachability is unchanged, and neither `exec/env.ts` nor `exec/scratch-home.ts` was modified.
- **Carry-forward for anyone touching `simple-git` error handling:** `GitError` has no exit code. Match on the message, and say so at the match site.
- **Open, non-blocking:** `deferred-items.md` D-2-03-1 remains open and untouched.

## Verification

Against the plan's `<verification>` block, all run at plan end:

| Check | Exit |
| ----- | ---- |
| `pnpm vitest run --project workspace` | 0 (32 tests, 4 files) |
| `pnpm lint` | 0 |
| `pnpm -r typecheck` | 0 |
| `pnpm -r test` | 0 (db 43, plugin-sdk 10, workspace 32) |
| `pnpm -r build` | 0 |
| `pnpm format` | 0 |
| `@adl/db` not a runtime dependency (`node -e`) | 0 |
| `@adl/db` is a devDependency (`node -e`) | 0 |
| `grep -c 'TERMINAL_STATES' src/worktree/gc.ts` | 4 |
| `grep -c "'--force'" src/worktree/lifecycle.ts` | 1 |
| `grep -c 'porcelain' src/worktree/list.ts` | 9 |
| `grep -c 'listManagedWorktrees' src/index.ts` | 1 |

Against `<success_criteria>`:

- Many features created, then swept, leave no ADL worktree and no `adl/*` branch — both halves proven. ✅ (`gc.test.ts` success-criterion case; branch half watched failing in `lifecycle.test.ts`)
- A dirty worktree, a double teardown, and a second sweep are all non-events. ✅
- The swappable backend package carries no runtime database dependency. ✅ (manifest checks in both directions; no import in `src/`)

## Self-Check

**PASSED**

- `packages/workspace/src/worktree/lifecycle.ts` — FOUND
- `packages/workspace/src/worktree/list.ts` — FOUND
- `packages/workspace/src/worktree/gc.ts` — FOUND
- `packages/workspace/src/worktree/backend.ts` — FOUND
- `packages/workspace/src/index.ts` — FOUND
- `packages/workspace/package.json` — FOUND (`@adl/db` in devDependencies only)
- `packages/workspace/test/worktree/lifecycle.test.ts` — FOUND
- `packages/workspace/test/worktree/list.test.ts` — FOUND
- `packages/workspace/test/worktree/gc.test.ts` — FOUND
- `packages/workspace/test/helpers/temp-repo.ts` — FOUND
- Commit `1167511` — FOUND
- Commit `777a5e5` — FOUND
- Commit `0ab7b36` — FOUND
- No file deletions in any commit — CONFIRMED (`git diff --diff-filter=D` empty for all three)
- No untracked files left behind — CONFIRMED
- Watched-failing probes both restored; `pnpm -r test` green afterwards — CONFIRMED

---

_Phase: 02-workspace-the-exec-boundary_
_Completed: 2026-08-18_
