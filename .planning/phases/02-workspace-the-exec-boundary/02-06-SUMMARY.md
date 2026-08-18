---
phase: 02-workspace-the-exec-boundary
plan: 06
subsystem: workspace
tags:
  [
    containment,
    path-guard,
    symlink-escape,
    registry,
    swappable-backend,
    conformance-suite,
    snapshot,
    teardown-report,
    WORK-01,
    WORK-03,
  ]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    plan: 03
    provides: 'run() with extendEnv:false and reject:false, buildChildEnv, createScratchHome, worktreeWorkspace, withTempRepo'
  - phase: 02-workspace-the-exec-boundary
    plan: 04
    provides: 'createWorktree / destroyWorktree / featureIdFromBranch / listManagedWorktrees, and openTempRepo'
  - phase: 02-workspace-the-exec-boundary
    plan: 05
    provides: 'destroyScratchHome returning ScratchHomeTeardown — the report this plan stopped discarding'
  - phase: 01-core-contracts
    provides: 'isRepoRelativePath (reused rather than reimplemented); the frozen-const-plus-derived-union pattern; the structural-assertion shape from test/lint/no-restricted-imports.test.ts'
provides:
  - 'assertWithinRoot / resolveWithinRoot / isWithinRoot — the D-02 containment guard, shared verbatim by every backend'
  - 'ContainmentError — a sibling of WorkspaceError, so a refused path and a missing file stay distinguishable'
  - 'Workspace.read / write, implemented on the worktree backend through the guard'
  - 'WorkspaceSpec / ManagedWorkspace / WorkspaceBackend / WorkspaceTeardownReport in @adl/core/stage — the backend side of the port'
  - 'workspaceRegistry + WORKSPACE_BACKEND_IDS — the sole site naming either factory (D-04)'
  - 'stubWorkspace / listStubWorkspaces — the second backend, real exec path, real root'
  - 'A real snapshot() on both backends, refusing rather than capturing partially'
  - 'describeWorkspaceContract — the parameterised conformance suite BACK-03 reuses in Phase 11'
affects: [02-07, 02-08, phase-03-manager-worker, phase-11-backends, phase-16-backends]

actuals:
  tokens: 22340
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - 'Watched-failing continued from 02-02/02-03/02-04/02-05: five guards observed failing against the exact defect each exists to catch, then restored'
    - 'A parameterised conformance suite as the proof of swappability — the same 13 cases run twice with only the registry id differing'
    - 'A structural assertion over the source tree as the guard against an architectural regression that no runtime test could see'

key-files:
  created:
    - packages/workspace/src/paths.ts
    - packages/workspace/src/registry.ts
    - packages/workspace/src/stub/backend.ts
    - packages/workspace/src/teardown.ts
    - packages/workspace/test/paths.test.ts
    - packages/workspace/test/registry.test.ts
    - packages/workspace/test/helpers/contract.ts
    - packages/workspace/test/contract/workspace-contract.test.ts
  modified:
    - packages/core/src/stage/workspace.ts
    - packages/core/src/stage/index.ts
    - packages/workspace/src/errors.ts
    - packages/workspace/src/index.ts
    - packages/workspace/src/worktree/backend.ts

key-decisions:
  - 'The guard realpaths the DEEPEST EXISTING part of the resolved candidate, not the parent. Pitfall 12 literally says "realpath the parent directory"; that misses the case where the LEAF is the symlink — `root/link -> /etc` passes a parent-only check and open() follows the link anyway. Watched failing: with the parent-only form restored, exactly one case (the symlinked directory itself) went red.'
  - 'ContainmentError is a SIBLING of WorkspaceError, not a subclass. Subclassing would make every `instanceof WorkspaceError` assertion also satisfied by a containment rejection, so the contract suite could not tell "the interface refused this path" from "the file was not there" — and those are the two events that most need to stay apart.'
  - 'assertWithinRoot RETURNS the contained absolute path rather than only asserting. Two resolutions of one candidate is two chances to disagree, and the one the guard blessed would not necessarily be the one that gets opened. It is also what lets the stub key its map by the guard`s own output rather than a parallel computation.'
  - 'assertWithinRoot THROWS when the root itself does not exist, rather than proceeding. A root with no filesystem presence makes the realpath climb walk past the intended boundary to an unrelated real ancestor, and containment stops being tested while still returning cleanly. Making it an error is what converts the stub`s real-root requirement from a comment into a mechanism.'
  - 'CARRY-FORWARD DECIDED (a): destroy() keeps its `Promise<void>` signature; the teardown report is pushed to an optional `WorkspaceSpec.onTeardown` sink instead. Full reasoning below.'
  - 'CARRY-FORWARD DECIDED (b): `ScratchHomeTeardown` IS added to the package barrel — its producer `destroyScratchHome` was already exported while the type of what it returns was not, which is a hole rather than a boundary.'
  - 'snapshot() anchors the `git stash create` commit under `refs/adl-snapshots/<featureId>/<sha>` and release() deletes that ref. `stash create` writes NO ref at all (verified) — the commit is dangling and a `git gc` away from disappearing, so an unanchored handle is a restore that fails at the worst possible moment.'
  - 'restore() is `git checkout <sha> -- .`, not `git stash apply`. Apply computes a diff and CONFLICTS when the working tree has moved on — which is precisely the situation a restore exists for. Reproduced during probing.'
  - 'The stub backend refuses a second live workspace for the same feature id, mirroring createWorktree`s refusal. Reclaiming from what happens to be in memory would be the same WORK-04 violation as reclaiming from what happens to be on disk.'

patterns-established:
  - 'A conformance-suite helper whose factory is a THUNK, so the calling file`s beforeAll fixtures are built after the cases are declared'
  - 'A structural assertion that strips comments before matching, so the file`s own prose about the banned identifiers cannot make the guard untrustworthy in either direction'
  - 'A vacuity check beside every structural assertion: a second case asserts the allowed site really does contain what the guard looks for, so deleting the subject entirely cannot make the guard pass'

requirements-completed: [WORK-01, WORK-03]

coverage:
  - id: D1
    description: 'read() and write() reject `..`, absolute, drive-letter, UNC, NUL, empty, the root itself, and a sibling-prefix path'
    requirement: WORK-03
    verification:
      - kind: unit
        ref: 'packages/workspace/test/paths.test.ts#containment: the lexical half (13 cases)'
        status: pass
      - kind: other
        ref: 'Watched failing: with isWithinRoot reduced to a bare startsWith, exactly the 3 separator-guard cases went red'
        status: pass
    human_judgment: false
  - id: D2
    description: 'read() and write() reject a path that resolves inside the worktree lexically but escapes through a symlink'
    requirement: WORK-03
    verification:
      - kind: integration
        ref: 'paths.test.ts#rejects a symlink inside the root that points at the sibling; #rejects the symlinked directory itself'
        status: pass
      - kind: other
        ref: 'Watched failing twice: with no realpath step both went red; with the parent-only realpath Pitfall 12 prescribes, the leaf-symlink case alone went red'
        status: pass
    human_judgment: false
  - id: D3
    description: 'Both backends run the SAME containment guard against a root that really exists, so the realpath step is not vacuous on either'
    requirement: WORK-03
    verification:
      - kind: integration
        ref: 'contract.ts#exposes a root that is a real directory while the workspace is live; #rejects a write to ... (3 cases, ContainmentError by type)'
        status: pass
      - kind: other
        ref: 'Watched failing: with a synthetic stub root, ALL 13 stub cases went red while all 13 worktree cases and both structural cases stayed green'
        status: pass
    human_judgment: false
  - id: D4
    description: 'Both `worktree` and `stub` resolve through one registry and pass one parameterised contract suite unchanged'
    requirement: WORK-03
    verification:
      - kind: integration
        ref: 'packages/workspace/test/contract/workspace-contract.test.ts — 26 cases, 13 per backend, no per-backend conditional anywhere in helpers/contract.ts'
        status: pass
    human_judgment: false
  - id: D5
    description: 'registry.ts is the only module naming either backend factory'
    requirement: WORK-03
    verification:
      - kind: unit
        ref: 'workspace-contract.test.ts#finds no module outside registry.ts importing a backend factory; #confirms registry.ts really does name both'
        status: pass
      - kind: other
        ref: 'Watched failing: a deliberate `import { stubWorkspace }` added to src/worktree/gc.ts produced a failure naming worktree/gc.ts; reverted'
        status: pass
    human_judgment: false
  - id: D6
    description: 'Resolving an unknown backend id fails naming the id and listing the registered ids'
    requirement: WORK-03
    verification:
      - kind: unit
        ref: 'packages/workspace/test/registry.test.ts#throws on an unknown id, naming it and listing what is registered'
        status: pass
    human_judgment: false
  - id: D7
    description: 'snapshot() returns a real RestoreHandle on both backends; restore() returns the captured state and release() discards it without a dangling ref'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'contract.ts#captures, restores, and then releases a snapshot — run over both backends; a restore after release throws'
        status: pass
    human_judgment: false
  - id: D8
    description: 'snapshot() refuses rather than silently capturing a partial state'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'registry.test.ts#names the untracked paths instead of returning a handle that omits them'
        status: pass
    human_judgment: false
  - id: D9
    description: 'destroy() surfaces what it reclaimed, and a second destroy reports already-absent'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'contract.ts#reports what destroy reclaimed, and reports the second destroy as already absent — run over both backends'
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 06: Swappability, Proved — One Registry, Two Backends, One Suite Summary

**Two workspace backends now resolve through one named registry and pass one parameterised contract suite unchanged — thirteen cases, run twice, with no case naming a backend and no module outside `registry.ts` naming a factory — and addressing a path outside the feature's worktree is unrepresentable through the interface, including through a sibling-prefix name and through a symlink.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3
- **Commits:** 3
- **Files:** 13 changed (8 created, 5 modified), 1793 insertions

## Task Commits

1. **Task 1: The containment guard — reject at the interface, not by convention** — `9c0bd00` (feat)
2. **Task 2: The named registry and the second backend** — `ec1901a` (feat)
3. **Task 3: One contract suite, run over both backends** — `1232c94` (test)

## Accomplishments

- **Success criterion 3 stopped being a claim.** The 13 contract cases live entirely in `test/helpers/contract.ts`, written against `Workspace` and nothing else; `workspace-contract.test.ts` contains no expectation of its own beyond two invocations and one structural assertion. When the stub's root was temporarily made synthetic, **all 13 stub cases went red and all 13 worktree cases stayed green** — the two halves discriminate, which is the only thing that makes "unchanged" mean anything.
- **The singular assumption now has a tripwire.** A deliberate `import { stubWorkspace }` added to `src/worktree/gc.ts` made the structural assertion fail with a message naming `worktree/gc.ts`. Every other test in the repository stayed green through it, which is exactly why the guard exists: an architectural regression of this shape is invisible to runtime tests.
- **Pitfall 12's literal advice is insufficient, and now provably so.** The research says realpath the *parent*. That leaves `root/link -> /etc` open — the guard passes and `open()` follows the link. Restoring the parent-only form turned exactly one case red. The implemented form realpaths the deepest *existing* prefix, which covers the leaf-symlink case and the not-yet-existing write target with one rule.
- **The stub's real root is enforced, not merely commented.** `assertWithinRoot` throws when the root has no filesystem presence, so "a stub whose root does not exist fails even if every contract case is green" is stronger in practice: with a synthetic root *nothing* is green.
- **02-05's open carry-forward is closed with a decision, not a deferral** — see below.

## The 02-05 carry-forward, decided

**(a) Should `destroy()` surface the teardown report? No — the signature is unchanged, and the report goes to an optional sink instead.**

Two reasons, and the second is the load-bearing one.

`destroy()` is a port method that `@adl/plugin-sdk` republishes, so changing it is a one-way decision under D-01. That alone is only an argument for care, not for refusal. The decisive argument is *what* the report is: `ScratchHomeTeardown` is a **worktree-backend mechanism**. Putting it in the shared return type would oblige every future backend — a container backend, which has no scratch `HOME` in that sense — to model one, and would make the port's shape a record of which implementation happened to be built first. That is precisely the demotion this plan's assumption-delta decision exists to prevent, applied to the return type instead of to a call site.

So the report is pushed to `WorkspaceSpec.onTeardown`, an optional sink declared in `@adl/core/stage`, carrying a deliberately generic `{ workspaceId, resource, outcome, reason? }` — a `resource` string the backend names for itself, and the three outcomes any reclamation has. `WorkspaceSpec` is new in this plan, so this is additive with no breakage anywhere.

The shape is not invented: it follows `GcDeps.onFailure`, which `02-04` introduced in this same package for the identical problem — a thing that must not throw and must not vanish. Both backends now report through it, and the contract suite asserts it on both: `destroy()` reports at least one `reclaimed` resource, every report carries the workspace's own id, and the **second** `destroy()` reports at least one `already-absent`. That last assertion is what makes idempotency observable rather than merely true, which is exactly the property `02-05` argued for when it turned `force: true` off.

The practical consequence: a leaked scratch `HOME` is now visible to an operator without any other backend having to know what a scratch `HOME` is. `credentials.test.ts`'s double-teardown probe is no longer the only route to the report, though it was left untouched — it tests something slightly different (that `destroy()` really removed the directory) and rewriting a passing test from a neighbouring plan is not this plan's business.

**(b) Does `ScratchHomeTeardown` belong on the barrel? Yes.**

`destroyScratchHome` was already exported from `src/index.ts` while the type of its return value was not. A consumer could call it and then have no name for the value in their hands. That is a hole rather than a boundary — unlike `buildChildEnv`, which is absent from the barrel *deliberately*, because a second caller would be a second door into the exec boundary. Nothing analogous applies to a return type. It is now exported alongside its producer, with the reasoning inline so a future reader does not mistake it for drift.

## Verification observations (the watched-failing evidence)

All five were run during execution and then restored; the working tree is byte-identical to its committed state.

**1. The separator guard discriminates.** With `isWithinRoot` reduced to `foldedTarget.startsWith(foldedRoot)` — the bare prefix test Pitfall 12 warns about:

```
× rejects a sibling directory whose name extends the root's
× rejects a symlink inside the root that points at the sibling
× rejects the symlinked directory itself, not only files under it
   Tests  3 failed | 15 passed
```

The sibling and the symlink cases fail together because the link points at `feat-1-evil` while the root is `feat-1` — one fixture exercising both defects, which is why it was built that way.

**2. The realpath step is load-bearing.** With `realTarget = resolved` (no realpath at all):

```
× rejects a symlink inside the root that points at the sibling
× rejects the symlinked directory itself, not only files under it
   Tests  2 failed | 16 passed
```

**3. Pitfall 12's parent-only advice leaves the leaf open.** With `realTarget = join(realpath(dirname(resolved)), basename(resolved))` — the form the research literally prescribes:

```
× rejects the symlinked directory itself, not only files under it
   Tests  1 failed | 17 passed
```

This is new information about the research, not about the code: the parent-only rule is correct about *why* the leaf cannot be realpathed unconditionally (a `write` target does not exist yet) and wrong about the remedy. Climbing to the deepest existing prefix satisfies both halves.

**4. The sole-construction-site guard names the offender.** With `import { stubWorkspace } from '../stub/backend.js';` prepended to `src/worktree/gc.ts`:

```
× finds no module outside registry.ts importing a backend factory
AssertionError: expected [ Array(1) ] to deeply equal []
+   "worktree/gc.ts: import { stubWorkspace } from '../stub/backend.js' — only src/registry.ts
     may name a workspace backend; every other consumer resolves an id through the registry
     and receives a Workspace"
```

**5. A synthetic stub root disarms nothing quietly — it disarms everything loudly.** With `const root = join(tmpdir(), 'adl-stub-imaginary-' + featureId)` and no `mkdtemp`:

```
   Tests  13 failed | 15 passed (28)
```

Every one of the 13 failures is a `stub` case; the 13 `worktree` cases and the 2 structural cases passed. The plan anticipated the containment cases passing *vacuously* in this situation; because `assertWithinRoot` refuses an absent root outright, they fail instead. That is the better outcome and it is deliberate — see the decision on the root-existence throw.

## New information about this repository

**`git stash create` writes no ref, and `git stash apply` is the wrong restore primitive.** Both probed directly against git 2.49 in a throwaway repository:

```
clean stash create        -> ""                                    (empty — nothing to stash)
dirty stash create        -> "23c2488…"                            (a dangling commit)
after update-ref          -> refs/adl-snapshots/23c2488… present
after checkout <sha> -- . -> "captured"                            (working tree restored)
after update-ref -d       -> only refs/heads/master remains
```

Three consequences, all encoded: a clean tree captures `HEAD` because there is nothing to stash and the current commit *is* the state; the object must be anchored under a ref or a `git gc` can collect the handle out from under the caller; and `restore()` checks the tree out by path rather than applying a diff, because apply conflicts precisely when the working tree has moved on — which is the only situation a restore is ever used in.

**An already-aborted `AbortSignal` resolves rather than rejecting, and reports exit code 1 on Windows.** Probed through `run()` itself:

```
aborted-signal run RESOLVED: {"exitCode":1,"durationMs":273}
```

No `signal` field on this platform. The contract case therefore asserts `exitCode !== 0` rather than pinning a value — a POSIX machine reports `null` with a signal, and pinning either would be red on the other. This is the same platform-split reasoning `deferred-items.md` D-2-03-1 records for `binary_missing`, reached independently.

**`node -e '<script>' arg` puts the first user argument at `process.argv[1]`, not `[2]`.** Verified before writing the contract suite's two-stream child, because getting it wrong would have produced a child that exits 0 in the case that exists to prove a non-zero exit is data.

## Decisions Made

See `key-decisions` in the frontmatter and the carry-forward section above. Two more worth expanding:

**`assertWithinRoot` returns the path.** The plan's artifact list names `assertWithinRoot` and `resolveWithinRoot` without saying which returns what, and the acceptance criteria require the *stub* to call `assertWithinRoot`. The stub also needs the resolved path, to key its map by. Had the asserting form returned `void`, the stub would have had to resolve a second time — two computations of one answer, where the one the guard blessed is not necessarily the one that gets used. So `assertWithinRoot` is assert-and-return, `resolveWithinRoot` is the pure synchronous half it is built from, and `isWithinRoot` is exported as a third so the sibling-prefix case can be asserted directly rather than only through a symlink.

**`WorktreeWorkspaceDeps` was replaced by `WorkspaceSpec`, not aliased to it.** The two types were field-for-field identical, and the stub's signature has to match the worktree factory's *exactly* for the registry to treat them as peers. Keeping a second name for one type would have left a per-backend vocabulary in place while claiming there was none. The three existing test files that construct these were unaffected — all three pass object literals.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug in the plan's prescribed technique] The containment guard realpaths the deepest existing prefix, not the parent**

- **Found during:** Task 1, writing the symlink cases
- **Issue:** `§ Pitfall 12` and the plan's action text both say to realpath the *parent* of the resolved path. That misses the case where the leaf itself is the symlink: `realpath(dirname('root/link'))` is `root`, containment passes, and the subsequent `open()` follows the link out of the sandbox. T-2-24 is not mitigated by the prescribed form.
- **Fix:** climb from the leaf to the deepest *existing* ancestor and realpath that, re-attaching the segments climbed past — which are `..`-free by step 1, so they cannot walk back out.
- **Evidence:** watched failing (observation 3 above).
- **Committed in:** `9c0bd00`

**2. [Rule 2 — Missing critical functionality] `assertWithinRoot` refuses a root that does not exist**

- **Found during:** Task 1
- **Issue:** with a root that has no filesystem presence, the realpath climb walks past the intended boundary to an unrelated real ancestor and the guard returns cleanly while testing nothing. The plan identified this hazard and addressed it by *requiring the stub to own a real directory* — a convention, enforced by a comment.
- **Fix:** the guard throws. The convention became a mechanism, and the plan's "a stub whose root does not exist fails this criterion" is now true by construction rather than by a reviewer noticing.
- **Committed in:** `9c0bd00`

**3. [Rule 2 — Missing critical functionality] `src/teardown.ts` and `WorkspaceSpec.onTeardown`**

- **Found during:** Task 2, deciding the 02-05 carry-forward
- **Issue:** the alternative to changing `destroy()`'s signature was to leave the teardown report discarded, which is what "a leaked scratch HOME is invisible to an operator" means.
- **Fix:** an optional generic sink on `WorkspaceSpec`, plus one shared mapping module so the three-outcome translation exists once rather than twice. Reasoning in full above.
- **Files added beyond `files_modified`:** `packages/workspace/src/teardown.ts`
- **Committed in:** `ec1901a`

**4. [Rule 3 — Blocking] Bootstrapped pnpm and dependencies in the worktree**

- **Found during:** setup
- **Issue:** no `node_modules`, no `dist/`, and `pnpm` not on `PATH`.
- **Fix:** `$HOME/.corepack-shims` on `PATH`, `pnpm install --frozen-lockfile` (pnpm 11.22.0, the pinned version), `pnpm -r build`.
- **Files modified:** none — both are gitignored.

**5. [Rule 2] Two test files beyond the plan's `files_modified`**

- **Found during:** Tasks 2 and 3
- **Issue:** the plan lists `test/paths.test.ts`, `test/helpers/contract.ts` and `test/contract/workspace-contract.test.ts`, but several of Task 2's acceptance criteria (registry resolution, the unknown-id message, the untracked-snapshot refusal) are not expressible in a suite that must contain no backend-specific case.
- **Fix:** `test/registry.test.ts` carries exactly that residue and nothing else, with a docblock saying so, so a later reader does not migrate its cases into the shared suite. `test/paths.test.ts` was created as planned.
- **Committed in:** `ec1901a`

### Deliberate scope boundaries held

- **`@adl/plugin-sdk` was not touched.** `WorkspaceBackend` and friends are the *backend* side of the port; a third-party harness receives a `Workspace` and has no use for them. Adding them would widen D-01's one-way published surface for nobody's benefit. Stated in a comment at the core re-export so it reads as a decision rather than an omission.
- **`eslint.config.js` was not touched**, so 02-02's per-glob `ignores` carve-outs are untouched and the resolved-config regression test needed no re-run beyond the routine one (`--project root`, 30 tests, green).
- **`deferred-items.md` D-2-03-1 was read and not re-litigated.** No exec-failure classification was added; `run.ts` is byte-identical to its committed state and was not modified at all this plan.
- **`reject: false`, `force`-less `destroyScratchHome`, and `buildChildEnv`'s workspace-owned-variable rejection were all left exactly as 02-03 and 02-05 built them.** The contract suite's "a failing child is an exit code, not a rejection" case is now a standing guard on the first of those.
- **`credentials.test.ts`'s double-teardown probe was left in place** even though `onTeardown` now offers a direct route. It asserts something subtly different and it passes; rewriting a neighbouring plan's green test is not this plan's business.

**Total deviations:** 5 auto-fixed (2 missing-functionality, 1 technique bug, 1 blocking-environmental, 1 additional test file). No Rule 4 architectural changes; no scope creep.

## Threat Model Verification

| Threat ID | Disposition | Status |
| --------- | ----------- | ------ |
| T-2-23 | mitigate | **Mitigated.** `isRepoRelativePath` runs before resolution (absolute, `..` segment, drive-letter, UNC, NUL, empty), then a separator-guarded prefix test. Eight rejection cases, one per class. |
| T-2-24 | mitigate | **Mitigated, and more strongly than specified.** The realpath step covers the leaf as well as the parent; the parent-only form the research prescribes was watched failing against a symlinked directory. |
| T-2-25 | mitigate | **Mitigated.** Equality-or-root-plus-separator, asserted directly against `isWithinRoot` with a constructed `feat-1` / `feat-1-evil` pair and again through a link between them. Watched failing under a bare `startsWith`. |
| T-2-26 | mitigate | **Mitigated.** `resolve` throws naming the id and listing the registered ones; no undefined return, no default fallback. The parameter is typed `string`, not the union, so the runtime path is reachable and tested rather than compiled away. |
| T-2-27 | accept | **Accepted as planned.** The stub uses the same `run`, the same `buildChildEnv`, the same scratch `HOME`, and the same containment guard — the contract suite proves all four. Only durability is weaker, and it is loud. Revisit when the container backend makes the id set heterogeneous in its guarantees. |
| T-2-28 | mitigate | **Mitigated.** `ContainmentError`'s message carries the candidate and the reason; asserted explicitly that it contains neither the root nor the scratch parent. The backends' read/write errors follow the same rule — relative path and OS code only. |

## Threat Flags

None. This plan adds no network endpoint, no auth path, and no schema change. It narrows an existing surface — `read`/`write` went from unimplemented to implemented-with-a-guard — and adds an in-process backend that reaches no resource the worktree backend does not.

## Known Stubs

None. Every symbol on the `Workspace` interface is now implemented on both backends. The `stub` backend is a *stub* in the sense of durability only, which is its purpose rather than an unfinished edge; `T-2-27` records the acceptance and the contract suite holds it to the same behaviour as its peer on every other axis.

## Carry-forward for later plans

- **`restore()` does not delete files created after the capture.** It puts the captured contents back. Removing post-capture additions would mean running `git clean` inside a directory an agent is working in, which is a data-loss primitive this backend deliberately does not hold. If v2's `group:` parallel stages need a true rollback, that is the decision to reopen — with a plan, not as an implementation detail.
- **`WorkspaceRegistryConfig.backends` is the seam, but only the first third of D-04's resolution order.** Built-in id works; "then npm package, then repo-relative path" is unbuilt and belongs with whoever wires daemon config in Phase 3.
- **The stub's inventory is module-level state.** That is the honest analogue of the worktree backend reading the git repository, but it means two registries in one process share one stub inventory. Harmless today (the contract suite scopes by `mainRepo`); worth knowing before anything runs two daemons in one process.
- **`refs/adl-snapshots/*` is a new ref namespace.** The GC sweep does not know about it. A released handle deletes its own ref, but a process that dies between `snapshot()` and `release()` leaves one behind. A backstop for that belongs wherever the sweep gains its schedule (Phase 3).

## Verification

| Check | Exit |
| ----- | ---- |
| `pnpm vitest run --project workspace` | 0 (100 tests, 10 files) |
| `pnpm vitest run --project workspace -t "containment"` | 0 (18 tests) |
| `pnpm vitest run --project workspace test/contract/workspace-contract.test.ts` | 0 (28 tests) |
| `pnpm vitest run --project root` | 0 (30 tests) |
| `pnpm -r test` | 0 (db 43, plugin-sdk 10, workspace 100) |
| `pnpm -r typecheck` | 0 |
| `pnpm -r build` | 0 |
| `pnpm lint` | 0 |
| `pnpm format` | 0 |

Acceptance-criteria spot-checks:

- `grep -c 'isRepoRelativePath' packages/workspace/src/paths.ts` → 4 (≥1 required)
- `grep -c 'realpath' packages/workspace/src/paths.ts` → 11 (≥1)
- `grep -c 'WORKSPACE_BACKEND_IDS' packages/workspace/src/registry.ts` → 2 (≥1)
- `grep -c 'WorkspaceBackend' packages/core/src/stage/workspace.ts` → 1 (≥1)
- `grep -c 'assertWithinRoot' packages/workspace/src/stub/backend.ts` → 5 (≥1) — the stub calls the shared guard, not a lexical variant
- `grep -c 'describeWorkspaceContract(' packages/workspace/test/contract/workspace-contract.test.ts` → **exactly 2**

Against `<success_criteria>`:

- Two backends registered, one suite, no call-site edits between them. ✅ (26 contract cases; the structural guard watched failing)
- Reading or writing outside the feature's worktree is unrepresentable through the interface. ✅ (three watched-failing probes on the guard)
- `snapshot()` is real on both backends and refuses rather than silently capturing a partial state. ✅

## Self-Check

**PASSED**

- `packages/workspace/src/paths.ts` — FOUND
- `packages/workspace/src/registry.ts` — FOUND
- `packages/workspace/src/stub/backend.ts` — FOUND
- `packages/workspace/src/teardown.ts` — FOUND
- `packages/workspace/src/errors.ts` — FOUND (`ContainmentError` added)
- `packages/workspace/src/index.ts` — FOUND (registry + guard + `ScratchHomeTeardown` exported)
- `packages/workspace/src/worktree/backend.ts` — FOUND (read/write/snapshot implemented)
- `packages/core/src/stage/workspace.ts` — FOUND (`WorkspaceSpec`, `WorkspaceBackend`, `ManagedWorkspace`, `WorkspaceTeardownReport`)
- `packages/workspace/test/paths.test.ts` — FOUND
- `packages/workspace/test/registry.test.ts` — FOUND
- `packages/workspace/test/helpers/contract.ts` — FOUND
- `packages/workspace/test/contract/workspace-contract.test.ts` — FOUND
- Commit `9c0bd00` — FOUND
- Commit `ec1901a` — FOUND
- Commit `1232c94` — FOUND
- No file deletions in any commit — CONFIRMED (`git diff --diff-filter=D` empty for all three)
- All five watched-failing probes restored — CONFIRMED (`git status` clean; `src/worktree/gc.ts` and `src/exec/run.ts` show no diff against the base)
- Probe file `packages/workspace/probe-02-06.mts` — removed, never tracked
- `STATE.md` and `ROADMAP.md` — NOT modified, as instructed

---

_Phase: 02-workspace-the-exec-boundary_
_Completed: 2026-08-18_
