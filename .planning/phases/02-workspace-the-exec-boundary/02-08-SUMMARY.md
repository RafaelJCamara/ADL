---
phase: 02-workspace-the-exec-boundary
plan: 08
subsystem: workspace
tags:
  [
    git-config-poisoning,
    shared-worktree-config,
    host-rooted-backend,
    manager-git-client,
    credential-boundary,
    exec-boundary,
    WORK-02,
    WORK-07,
  ]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    plan: 03
    provides: 'run() as the single exec boundary, buildChildEnv with the GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM neutralisers, createScratchHome'
  - phase: 02-workspace-the-exec-boundary
    plan: 06
    provides: 'workspaceRegistry + the sole-construction-site guard, assertWithinRoot / isWithinRoot, WorkspaceSpec.onTeardown, the teardown report mapping'
  - phase: 02-workspace-the-exec-boundary
    plan: 07
    provides: 'privilegeLauncher / warnPrivilegeModeOnce and applyWorkerAccess — layer 2 of the Pitfall 5 defence, whose layer 1 this plan is'
provides:
  - "hostGitWorkspace — ADL's own Workspace: the main repository as root, a stable ADL-owned git home, snapshot() refused, destroy() deleting nothing"
  - "The 'host-git' registry id and WorkspaceRegistryConfig.hostGit — the daemon's seam for ADL's git home"
  - 'managerGitClient / ManagerGitClient — the one manager-owned git client, with no reachable path to an invocation without the overrides'
  - 'NEUTRALISED_CONFIG / NEUTRALISE_ARGS — the eight executable configuration keys, and the argv form of them'
  - "ExecOwner on run() — 'adl' children are not dropped and do not spend WORK-05's once-per-process banner"
  - 'The Pitfall 5 proof suite: the leak reproduced, the planted hook observed running and then not running, and every key proven individually'
affects: [phase-03-manager-worker, phase-05-forge-push, phase-09-pr-operations]

actuals:
  tokens: 20164
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - 'A private argv builder as a security control: the neutralisation is unskippable because there is no exported route to the exec that omits it'
    - 'A CONTROL case beside every "it did not happen" assertion — the same operation without the guard, required to produce the effect'
    - 'A documentation-drift assertion as the trim guard for a list whose per-item loop shrinks rather than fails when trimmed'
    - 'Watched-failing continued from 02-02 through 02-07: two probes run against the exact defect each guard exists to catch, then restored'

key-files:
  created:
    - packages/workspace/src/git/host-backend.ts
    - packages/workspace/src/git/manager-git.ts
    - packages/workspace/test/git/poisoned-config.test.ts
    - packages/workspace/test/git/manager-git.test.ts
  modified:
    - packages/workspace/src/exec/run.ts
    - packages/workspace/src/registry.ts
    - packages/workspace/src/index.ts
    - packages/workspace/README.md
    - packages/workspace/test/contract/workspace-contract.test.ts
    - .planning/phases/02-workspace-the-exec-boundary/deferred-items.md

key-decisions:
  - "run() gained an `ExecOwner` parameter, because without it this plan would have BROKEN WORK-05's warning. An ADL-owned child carries no worker identity by design, so on a correctly configured Linux deployment it resolves to `worker-user-unset` — a manager-side `git status` running first would print \"ADL_WORKER_USER is not set\" at an operator who set it AND consume the one banner the next agent exec genuinely needed. Full reasoning below."
  - "The host backend's `destroy()` deletes NOTHING and reports `already-absent`. Every other backend's destroy removes a directory; this one's root is the user's repository and its scratchHome is the daemon's shared configuration directory. A contributor 'restoring symmetry' would ship the worst bug in the package, so the reasoning sits at the implementation rather than in a plan."
  - "The host backend is deliberately OUTSIDE `describeWorkspaceContract`, and that divergence is asserted rather than left as an omission: `manager-git.test.ts` requires the suite to name exactly `['worktree', 'stub']`. It IS inside the sole-construction-site guard, because the two properties are independent — behavioural interchangeability is not claimed, registry-only construction is."
  - "The ADL git home is REFUSED, not warned about, when it resolves inside the feature scratch root or inside the repository. A home an agent can write is a home an agent can put `core.hooksPath` in — the exact vector this plan closes — and a warning would be read once and scrolled past."
  - "`effectiveConfig` distinguishes exit 1 (unset) from exit 0 (set, possibly empty). Several neutralised values ARE the empty string, so collapsing the two would leave half the per-key assertions unable to tell a working override from a missing key."
  - "`status()` uses `--porcelain=v1 -z` and pairs rename records. The newline form quotes and escapes paths, so a line parser hands callers a path that does not exist on disk."
  - "CARRY-FORWARD DECIDED: the 02-06 `refs/adl-snapshots/*` GC gap is DEFERRED to Phase 3, with a reproduction, the shape of the fix, and its home written into `deferred-items.md` as D-2-06-1. Reasoning below."
  - 'No platform skip was added. The executable-bit gate the plan anticipated was probed and is not needed — git for Windows runs hooks through its bundled sh — so the case runs on both platforms instead of skipping visibly on one. A gate that can never fire is the decoration D-21 exists to prevent, arriving from the other direction.'

patterns-established:
  - 'A CONTROL test that REQUIRES the attack to succeed, run immediately before the assertion that it does not — so "the sentinel is absent" cannot pass because the sentinel was never reachable'
  - 'A README-to-constant drift assertion standing in for a trim guard, where the natural per-item loop shrinks silently instead of failing'
  - 'A test that enumerates the subject under test and fails when a new member is added without coverage (the invocation map compared against the client’s own keys)'

requirements-completed: [WORK-02, WORK-07]

coverage:
  - id: D1
    description: 'A `core.hooksPath` written from inside a linked worktree leaks into the MAIN repository’s local configuration, and a manager-side operation afterwards does not execute the planted hook'
    requirement: WORK-07
    verification:
      - kind: integration
        ref: 'poisoned-config.test.ts#leaks a hooks path written inside the worktree into the MAIN repository; #does not execute the planted hook during a manager-side operation'
        status: pass
      - kind: integration
        ref: 'poisoned-config.test.ts#CONTROL: the planted hook really does execute during an unneutralised status — the same operation, without the overrides, REQUIRED to fire'
        status: pass
      - kind: other
        ref: 'Watched failing: with NEUTRALISE_ARGS emptied, the hook fired and 10 assertions went red'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Every key on the neutralisation list is overridden per invocation, proven one at a time'
    requirement: WORK-07
    verification:
      - kind: integration
        ref: 'poisoned-config.test.ts#every neutralised key, one at a time — 8 cases generated by iterating NEUTRALISED_CONFIG, each poisoning that key through a real agent-run `git config`'
        status: pass
      - kind: unit
        ref: 'manager-git.test.ts#documents every neutralised key, and no key that is not neutralised — the README drift assertion that catches a trim, since the loop above shrinks rather than fails'
        status: pass
      - kind: other
        ref: 'Watched failing: removing `core.fsmonitor=false` took the suite from 23 to 22 cases and turned the drift assertion red, naming the missing key'
        status: pass
    human_judgment: false
  - id: D3
    description: "ADL's own git runs with a HOME and GIT_CONFIG_GLOBAL in an ADL-owned directory outside every feature scratch root"
    requirement: WORK-07
    verification:
      - kind: integration
        ref: "manager-git.test.ts#does not read a .gitconfig an agent left in its scratch HOME — both files present at once, so a client ignoring global config entirely would fail"
        status: pass
      - kind: unit
        ref: 'manager-git.test.ts#refuses a git home inside the feature scratch root rather than warning'
        status: pass
    human_judgment: false
  - id: D4
    description: 'The manager git client launches through a registry-resolved Workspace, so there is exactly one lint exemption and no second exec primitive'
    requirement: WORK-02
    verification:
      - kind: unit
        ref: "grep -rl \"from 'execa'\" packages/workspace/src → exactly one file (exec/run.ts)"
        status: pass
      - kind: unit
        ref: 'manager-git.test.ts#exports no second entry point that could build an argv of its own; #puts every override before the subcommand, on every operation'
        status: pass
      - kind: unit
        ref: 'workspace-contract.test.ts#finds no module outside registry.ts importing a backend factory — extended to cover `hostGitWorkspace`'
        status: pass
    human_judgment: false
  - id: D5
    description: "The worker's Workspace has no configuration path by which a forge token could reach one of its children"
    requirement: WORK-02
    verification:
      - kind: unit
        ref: 'manager-git.test.ts#offers no member on a worker-launched workspace that could carry one (constructed with the full daemon configuration); #declares no field on ExecSpec … but `env`; #offers no credential field on the daemon-facing registry configuration'
        status: pass
    human_judgment: false
  - id: D6
    description: 'The registry knows three ids and the contract suite covers exactly the two feature backends'
    requirement: WORK-02
    verification:
      - kind: unit
        ref: 'manager-git.test.ts#knows three ids; #runs the contract suite over exactly the two FEATURE backends'
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 08: Poisoned Git Configuration, Closed Summary

**A `core.hooksPath` an agent writes from inside its worktree still lands in the main repository's configuration — the leak is reproduced in a test rather than asserted — and a hook planted through it is watched executing during an unneutralised `git status` and then watched not executing during the manager client's, with all eight executable keys proven one at a time and no exported route to a git invocation that omits them.**

## Performance

- **Duration:** ~75 min
- **Tasks:** 3
- **Commits:** 4
- **Files:** 10 changed (4 created, 6 modified), 1599 insertions, 7 deletions

## Task Commits

1. **Task 1: The host-rooted workspace** — `e895f15` (feat)
2. **Task 2: The manager git client and the unconditional neutralisation list** — `c141758` (feat)
3. **Task 3: Prove a poisoned configuration does not fire, one key at a time** — `73e1b07` (test)
4. **The 02-06 carry-forward, decided** — `4038abc` (docs)

## Accomplishments

- **`§ Pitfall 5` stopped being a research finding and became a test.** The leak is reproduced through the agent's own workspace — a real `git config` subprocess with no privilege it was not given — read back out of the main repository, and found in `.git/config`. Then a `post-index-change` hook planted through that poisoned path is **observed firing** during an unneutralised `git status`, and observed not firing during `managerGitClient.status()`. The control is the load-bearing half: without it, "the sentinel is absent" would pass against a hook that was never reachable in the first place.

- **Trimming the list now breaks something.** The per-key loop is generated from `NEUTRALISED_CONFIG`, which the threat register (T-2-37) correctly notes means a removed entry removes its own assertion — the loop *shrinks* rather than failing. That gap is closed by the README drift assertion: deleting `core.fsmonitor=false` took the suite from 23 cases to 22 **and turned one case red naming the missing key**. Watched, both halves.

- **There is still exactly one process launch in the repository.** `grep -rl "from 'execa'" packages/workspace/src` returns one file. The manager client owns no exec primitive, imports no git library, and names no backend — it builds argv and reads output, and the workspace it was handed does everything else. D-17's one extra registry entry bought that.

- **The bypass is unrepresentable, not merely absent.** The argv builder is private and unreachable from the returned object; `manager-git.test.ts` drives every exported member and finds the full prefix before the subcommand in each captured argv, asserts the module exports exactly one function, and compares its invocation map against the client's own keys — so a push method added in Phase 5 fails this suite until it is covered.

- **A defect this plan would otherwise have introduced was caught and fixed.** See below: without `ExecOwner`, adding ADL's own git would have silently disarmed WORK-05's operator warning.

## The decision that was not in the plan: `ExecOwner` on `run()`

The host backend runs ADL's own git and therefore carries no worker identity — it wants none. `privilegeLauncher` maps an empty identity on Linux to `worker-user-unset`, and `run()` fed that to `warnPrivilegeModeOnce`, which fires **once per process**.

So on a correctly configured Linux deployment — worker user provisioned, drop working, everything as documented — a manager-side `git status` running before the first agent exec would have:

1. printed `ADL_WORKER_USER is not set` at an operator who had set it, sending them to the wrong file entirely; and
2. **consumed the one banner**, so a genuine non-drop on the agent's workspace immediately afterwards would have said nothing at all.

The second is the serious one. T-2-32 is a *repudiation* threat — the failure it describes is an operator believing a run was contained when it was not — and losing the real warning to a false one is that threat arriving through the front door, introduced by the plan whose job was to close a different one.

`ExecOwner` is the fix: `'adl'` children skip the privilege decision entirely rather than making it and discarding the answer. It defaults to `'agent'`, so the containment-relevant behaviour is what a caller gets by *forgetting* rather than by remembering. It also makes a second thing true by construction that was previously true by accident: ADL's own git must **not** be dropped, because the file it has to be able to write — `<mainRepo>/.git/config` — is precisely the one `applyWorkerAccess` takes group and world write off of, in plan `02-07`, so the worker user cannot reach it. A dropped manager would be locked out of its own repository.

## The 02-06 carry-forward, decided: deferred with a reproduction

`02-06` left `refs/adl-snapshots/*` open — a process dying between `snapshot()` and `release()` leaks a ref the GC sweep cannot see. **Decision: defer to Phase 3, recorded as `D-2-06-1` in `deferred-items.md` with a verified reproduction.**

The reproduction turned out sharper than the carry-forward suggested. After `destroy()` the worktree and the `adl/*` branch are gone, `sweepOrphans` returns `[]` — it iterates the worktree inventory, and by then there is no entry to iterate — and:

```
the captured commit is still an object: commit
unreachable objects git gc would collect: (none — the ref keeps it reachable)
```

The ref keeps the stash commit **reachable**, so `git gc` never collects the objects behind it either. It is a pinned tree, not a stray ref file. That is worth knowing before anyone triages it as cosmetic.

Why it was not closed here: the fix is small but it is not this plan's. `02-08` owns the configuration boundary; its file list, acceptance criteria, and threat register say nothing about snapshot refs. Closing it means either changing `sweepOrphans`'s exported signature — which `02-04` and `02-06` own, and whose policy/mechanism split is D-20 — or adding a second exported sweep with its own tests to the last plan of a phase whose reviewers were asked to check something else. So the entry names the shape that looks right (`sweepSnapshotRefs` beside `sweepOrphans`, same D-16 policy, deleting with `update-ref -d`) and its home (Phase 3, with the sweep's schedule and state binding), so picking it up is a task rather than a rediscovery.

## New information about this repository and its dependencies

**`simple-git` refuses to configure all eight neutralised keys — by name.** Discovered by this suite going red on exactly eight cases and nothing else:

```
Error: Configuring core.hooksPath is not permitted without enabling allowUnsafeHooksPath
Error: Configuring core.fsmonitor is not permitted without enabling allowUnsafeFsMonitor
Error: Configuring core.pager is not permitted without enabling allowUnsafePager
Error: Configuring core.editor is not permitted without enabling allowUnsafeEditor
Error: Configuring core.sshCommand is not permitted without enabling allowUnsafeSshCommand
Error: Configuring credential.helper is not permitted without enabling allowUnsafeCredentialHelper
Error: Configuring diff.external is not permitted without enabling allowUnsafeDiffExternal
Error: Configuring protocol.allow is not permitted without enabling allowUnsafeProtocolOverride
```

Two consequences. The library ADL already depends on classifies **precisely this key set** as unsafe-to-configure, which is independent corroboration that `NEUTRALISED_CONFIG` is the right list rather than one assembled from a blog post. And that refusal protects nobody here: an agent does not use `simple-git`, it runs `git`. The per-key loop therefore poisons through the agent's workspace exec — the only route that works and the only one that models the threat.

**`post-index-change` fires when git *writes* the index, which needs a CLEAN file with stale stat data — not a dirty one.** The obvious setup (dirty the file so status has something to report) is exactly wrong: a file whose content differs from the index stays "modified", so no stat entry is updated and nothing is written back. It produced a control that passed in isolation and failed in the full suite. Restoring the file to `HEAD`'s content and pushing its mtime into the future makes git re-read it, find it clean, update the cached stat data, write the index, and call the hook — deterministically. Four consecutive full-suite runs green after the change.

**The test fixture's own `git checkout` executed the attacker's hook.** `plantHook` restores the tracked file through `repo.git`, which writes the index too — and therefore fires the planted hook, through a handle carrying none of ADL's overrides. It made the neutralised case fail for a reason that had nothing to do with the code under test. The setup now removes the sentinel it produced, and the incident is written into the test rather than quietly patched: *a plain, unremarkable git command run by a process that is not the manager client executed an attacker-planted program, in this suite, by accident.* That is the whole threat in one line.

**`--end-of-options` is supported by both `rev-parse` and `config`** on the git this repository builds against, so a revision or key beginning with `-` is data rather than a flag. **`git config --get` exit codes** distinguish unset (1, no output) from set-to-empty (0, empty output) — load-bearing, since several neutralised values are the empty string.

## Verification observations (the watched-failing evidence)

Both were run during execution and then restored; `manager-git.ts` is byte-identical to its committed state (`git diff` empty).

**1. The neutralisation is load-bearing, not decorative.** With `NEUTRALISE_ARGS` replaced by `[]`:

```
× puts every override before the subcommand, on every operation
× does not execute the planted hook during a manager-side operation
× sees "" for core.hooksPath however the repository is poisoned
× sees "false" for core.fsmonitor …
× sees "cat" for core.pager …
× sees "false" for core.editor …
× sees "" for core.sshCommand …
× sees "" for credential.helper …
× sees "" for diff.external …
× sees "never" for protocol.ext.allow …
   Tests  10 failed | 13 passed (23)
```

The second line is the one that matters: with the overrides gone, the planted hook **ran** and wrote its sentinel during `managerGitClient.status()`.

**2. Trimming the list is caught, and named.** With `'core.fsmonitor=false'` removed from `NEUTRALISED_CONFIG`:

```
× documents every neutralised key, and no key that is not neutralised
AssertionError: expected [ 'core.editor', …(7) ] to deeply equal [ 'core.editor', …(6) ]
   Tests  1 failed | 21 passed (22)
```

Note the case count: 23 → 22. The per-key loop got *smaller*, exactly as T-2-37 predicts, and passed. The README drift assertion is what went red. That is why the README section was added rather than left to a later documentation pass — it is the trim guard, not decoration.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] `ExecOwner` on `run()`**

- **Found during:** Task 1, wiring the host backend's `exec` to `run`
- **Issue:** an ADL-owned child would have emitted a false `ADL_WORKER_USER is not set` banner on a correctly configured deployment and consumed WORK-05's once-per-process warning, suppressing the genuine one for the next agent exec (T-2-32).
- **Fix:** a fifth parameter on `run()`, defaulting to `'agent'`. `'adl'` skips the privilege decision entirely. Not a "suppress the warning" flag — it also encodes that ADL's own git must not be dropped, which `02-07`'s `.git/config` protection makes a correctness requirement rather than a preference.
- **Files beyond the plan's list:** `packages/workspace/src/exec/run.ts`
- **Committed in:** `e895f15`

**2. [Rule 2 — Missing critical functionality] The sole-construction-site guard was extended to the new backend**

- **Found during:** Task 1
- **Issue:** `workspace-contract.test.ts`'s guard enumerates backend modules and factory names. Without adding `git/host-backend.js` and `hostGitWorkspace`, this plan would have added a backend that was unimportable by rule and importable in fact.
- **Fix:** both lists extended, with a comment explaining why a backend outside the *contract suite* is still inside the *construction-site guard* — the two properties are independent.
- **Files beyond the plan's list:** `packages/workspace/test/contract/workspace-contract.test.ts`
- **Committed in:** `e895f15`

**3. [Rule 2 — Missing critical functionality] The README section on what ADL overrides**

- **Found during:** Task 2
- **Issue:** T-2-42 is dispositioned **accept**, and its stated justification is "the README's permission table states what is overridden so the behaviour is discoverable". No such table existed. An accepted risk whose justification is absent is an unaccepted risk.
- **Fix:** a `## What ADL's own git overrides` section listing every key, what it is overridden to, and what an attacker gets without it — plus a drift assertion that fails when it and `NEUTRALISED_CONFIG` disagree. That assertion turned out to be the only thing that catches a trimmed list (observation 2).
- **Files beyond the plan's list:** `packages/workspace/README.md`
- **Committed in:** `c141758`

**4. [Rule 1 — Bug in the plan's prescribed technique] No platform skip was added; the anticipated gate is not needed**

- **Found during:** Task 3
- **Issue:** the plan requires extending `test/helpers/platform.ts` with a sibling predicate for "the platform cannot make a file executable". Probed rather than assumed: git for Windows runs hook scripts through its own bundled `sh` and does not consult the executable bit, and `chmod(0o755)` is required on POSIX and harmless on Windows. The planted hook fires on **both** platforms.
- **Fix:** the case runs everywhere and no predicate was added. A gate that can never return `skip` is untested code in a security suite and is the decoration D-21 and T-2-33 exist to prevent, arriving from the other direction — a visible skip is better than a silent one, but *running* is better than either. `platform.ts` is untouched; the test file's docblock states the reasoning so a reader does not read it as an omission.
- **Committed in:** `73e1b07`

**5. [Rule 3 — Blocking] Bootstrapped pnpm and dependencies in the worktree**

- **Found during:** setup
- **Issue:** no `node_modules`, no `dist/`, `pnpm` not on `PATH`.
- **Fix:** `$HOME/.corepack-shims` on `PATH`, `pnpm install --frozen-lockfile` (pnpm 11.22.0, the pinned version), `pnpm -r build`. Both gitignored; no tracked file changed.

### Deliberate scope boundaries held

- **`exec/env.ts` was read first and not modified.** It already carried `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, and the case-insensitive rejection of workspace-owned variables — so the host backend gets D-08 by supplying a different home to the *same* builder, and no neutraliser was re-implemented.
- **`eslint.config.js` was not touched**, so `02-02`'s per-glob `ignores` carve-outs are untouched. `--project root` was run anyway and is green (30 tests).
- **`assertWithinRoot`'s deepest-existing-prefix walk was left exactly as `02-06` built it.** The host backend calls the shared guard; the two lexical refusals it adds (a git home inside the scratch root or inside the repository) are a *different* question, answerable for a directory that does not exist yet, and are documented as such.
- **`deferred-items.md` D-2-03-1 and D-2-07-1 were read and not re-litigated.** No exec-failure classification and no cancellation change; `run.ts`'s only diff is `ExecOwner`.
- **`@adl/plugin-sdk` was not touched.** `ExecOwner` is a parameter on `run()`, which is `@adl/workspace`'s own function, not a change to the `Workspace` port D-01 republishes.

**Total deviations:** 5 auto-fixed (3 missing-functionality, 1 technique correction, 1 blocking-environmental). No Rule 4 architectural changes; no scope creep.

## Threat Model Verification

| Threat ID | Disposition | Status                                                                                                                                                                                                                                                                                     |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-2-36    | mitigate    | **Mitigated, and watched.** The overrides are applied in a private argv builder with no exported route around it. The planted hook was observed executing without them and not executing with them, in the same suite, minutes apart.                                                       |
| T-2-37    | mitigate    | **Mitigated — by the README assertion, not by the loop.** The per-key loop shrinks silently when the list is trimmed, exactly as the register predicted. Watched: removing one entry left the loop green at 22 cases and turned the drift assertion red naming the key. Each entry also carries a comment naming what it prevents. |
| T-2-38    | mitigate    | **Mitigated.** ADL's git home is a stable ADL-owned directory, refused if it resolves inside the scratch root or the repository, with `GIT_CONFIG_NOSYSTEM` on. An agent's `.gitconfig` and ADL's own were placed simultaneously; the client read ADL's.                                     |
| T-2-39    | mitigate    | **Mitigated.** Asserted three ways: no member on a worker-launched `Workspace` beyond the eight port members, no field on `ExecSpec` but `env`, and no credential field on `WorkspaceRegistryConfig`. The client holds no credential and reads none from the daemon's environment.           |
| T-2-40    | mitigate    | **Mitigated.** One file in `packages/workspace/src` imports `execa`. The client runs argv through a registry-resolved `Workspace`, and the construction-site guard now covers `hostGitWorkspace`.                                                                                           |
| T-2-41    | mitigate    | **Mitigated.** `GIT_CONFIG_NOSYSTEM=1` comes from `buildChildEnv`, which the host backend uses unchanged — two independent controls, the enumerated per-invocation list and the disabled system scope.                                                                                      |
| T-2-42    | accept      | **Accepted, and now actually discoverable.** The README table the acceptance depends on did not exist; it does now, and a test fails when it drifts from the constant.                                                                                                                      |

## Threat Flags

None. This plan adds no network endpoint, no auth path, and no schema change. It adds a workspace whose root is the repository ADL was installed into — which is new surface in the sense that ADL can now `read`/`write` there — and that surface goes through the same `assertWithinRoot` guard as every other backend, with `destroy()` explicitly unable to remove anything.

## Known Stubs

None. Every symbol on `ManagerGitClient` is implemented and exercised. The four operations are the ones Phase 2 can prove; Phase 5's push and Phase 9's PR operations are named in the docblock as additions to the same interface, which is a stated extension point rather than an unfinished edge.

## Carry-forward for later plans

- **`core.sshCommand=` is set to the empty string on every ADL git invocation.** Harmless today — Phase 5 pushes over HTTPS with a forge token — but an operator who deploys ADL against an SSH remote will find the transport unconfigurable. If Phase 5 grows SSH support, that entry needs a considered value rather than a silent removal, and the README table plus the drift assertion are where the change has to be made visible.
- **`ManagerGitClientOptions.path` defaults to the daemon's `process.env.PATH`.** That is the third place ADL reads its own environment (after the worker identity and the privilege launcher resolution). When Phase 3 owns daemon configuration, all three should arrive from it explicitly rather than from `process.env`.
- **The `host-git` workspace takes a `WorkspaceSpec`, whose `baseRef` it ignores and whose `featureId` it uses only as an id.** Phase 3 will want to decide whether the manager holds one long-lived host workspace or creates one per operation; nothing here forces either, and `destroy()` is free.
- **D-2-06-1 in `deferred-items.md`** — the snapshot-ref reclamation gap, deferred to Phase 3 with a reproduction and the shape of the fix.

## Verification

| Check                                                   | Exit                              |
| ------------------------------------------------------- | --------------------------------- |
| `pnpm vitest run --project workspace`                   | 0 (129 passed, 2 skipped, 13 files) |
| `pnpm vitest run --project workspace test/git`          | 0 (23 tests, 2 files)             |
| `pnpm vitest run --project root`                        | 0 (30 tests)                      |
| `pnpm -r test`                                          | 0 (core 404, plugin-sdk 10, db 43, workspace 129) |
| `pnpm -r typecheck`                                     | 0                                 |
| `pnpm -r build`                                         | 0                                 |
| `pnpm lint`                                             | 0                                 |
| `pnpm format`                                           | 0                                 |

The two skips are the pre-existing Linux-only privilege cases from `02-07`, which report their reason to standard error — correct on Windows, and unchanged by this plan.

Acceptance-criteria spot-checks:

- `grep -rl "from 'execa'" packages/workspace/src --include=*.ts` → **exactly 1** (`exec/run.ts`)
- `grep -c 'host-git' packages/workspace/src/registry.ts` → 5 (≥1 required)
- `grep -c` for `hooksPath`, `fsmonitor`, `sshCommand`, `credential.helper`, `diff.external` in `src/git/manager-git.ts` → all ≥1
- `workspaceRegistry().ids()` → `['worktree', 'stub', 'host-git']`
- `describeWorkspaceContract(` in the contract suite → **exactly 2**, naming `worktree` and `stub`
- `snapshot()` on the host workspace throws naming the unsupported operation; `destroy()` resolves and both the repository and the git home still exist afterwards

Against `<success_criteria>`:

- The shared-configuration leak is demonstrated in a test and then shown not to affect ADL's own git operations. ✅ (leak reproduced; hook watched firing, then watched not firing)
- Every key on the neutralisation list is individually proven, so trimming the list breaks the build. ✅ (8 generated cases; trim watched failing via the README drift assertion)
- ADL's own git runs from an ADL-owned home, through the same one exec boundary, with exactly one lint exemption in the repository. ✅

## Self-Check

**PASSED**

- `packages/workspace/src/git/host-backend.ts` — FOUND
- `packages/workspace/src/git/manager-git.ts` — FOUND
- `packages/workspace/test/git/poisoned-config.test.ts` — FOUND
- `packages/workspace/test/git/manager-git.test.ts` — FOUND
- `packages/workspace/src/exec/run.ts` — FOUND (`ExecOwner`)
- `packages/workspace/src/registry.ts` — FOUND (`'host-git'`, `WorkspaceRegistryConfig.hostGit`)
- `packages/workspace/src/index.ts` — FOUND (client, constants, host factory, `ExecOwner`)
- `packages/workspace/README.md` — FOUND (`## What ADL's own git overrides`)
- `packages/workspace/test/contract/workspace-contract.test.ts` — FOUND (guard extended)
- `.planning/phases/02-workspace-the-exec-boundary/deferred-items.md` — FOUND (`D-2-06-1`)
- Commit `e895f15` — FOUND
- Commit `c141758` — FOUND
- Commit `73e1b07` — FOUND
- Commit `4038abc` — FOUND
- No file deletions in any commit — CONFIRMED (`git diff --diff-filter=D` empty across the range)
- Both watched-failing probes restored — CONFIRMED (`git diff` on `src/git/manager-git.ts` empty)
- Probe files `packages/workspace/probe*.mjs` — removed, never tracked
- `STATE.md` and `ROADMAP.md` — NOT modified, as instructed

---

_Phase: 02-workspace-the-exec-boundary_
_Completed: 2026-08-18_

---

# ADDENDUM — Linux CI run `32149311523`, diagnosis and fix

**Added after the CI run that followed `02-07`'s `f7dd0c4` fix. Both matrix legs
(node 22 and node 24) were RED with 11 failures, all of them in
`test/git/poisoned-config.test.ts`; everything else on the job was green. This
addendum records what caused them and what changed. It is NOT evidence that the
phase gate is satisfied — only a human reading a green Linux run may say that.**

## What the red run produced, and what it was worth

The rest of the job is the evidence the phase was after, and it held:

| Observation                                                             | Reading                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `test/exec/privilege.test.ts` — 8/8 on both legs, zero `[ADL][SKIPPED]` | WORK-05's Linux-only assertions executed against a real `adl-worker` child. Unchanged by this fix.     |
| `test/exec/credentials.test.ts` — 3/3 on both legs                       | `02-07`'s `f7dd0c4` staging fix held.                                                                  |
| `does not execute the planted hook during a manager-side operation` — passing | The security property itself — layer 1, the per-invocation `-c` neutralisation — was never in doubt. |

The 11 failures split into two symptom groups that turned out to have **one**
cause.

## Root cause: git refuses the repository before it refuses the write

Eight cases in the per-key loop plus the `leaks a hooks path …` case failed on
the same statement — `expect(await asAgent(['git','config',key,poison])).toBe(0)`
— with `expected 128 to be +0`. The suite discarded the child's stderr, so
git's own explanation never reached the log.

Reproduced on Linux (WSL Ubuntu, git 2.43) rather than inferred from the number:

| Scenario                                                       | Exit    | git says                                                          |
| -------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `git config <key> <value>` in a worktree, repo owned by another user | **128** | `fatal: not in a git directory`                                    |
| `git status` in the main repo, same conditions                 | **128** | `fatal: detected dubious ownership in repository at '…'`           |
| `git config --get <key>`, same conditions                      | **1**   | *(nothing)* — indistinguishable from "that key is unset"           |
| `git config <key> <value>` with `.git` and `.git/config` unwritable | **255** | `error: could not lock config file …: Permission denied`           |
| `post-index-change` hook at `0755`, `core.hooksPath` poisoned   | 0       | hook **fires** during `git status`                                 |
| same hook at `0644`                                            | 0       | hook **ignored** (`advice.ignoredHook` hint on stderr)             |

So the 128 in CI is git's **ownership** refusal, not a permission one. Under
WORK-05's drop the agent runs as `adl-worker` while the fixture repository is
owned by the CI runner, and git's `safe.directory` check declines before it
consults a single permission bit. The 255 row is `applyWorkerAccess`'s
`protect` on `<mainRepo>/.git/config` — layer 2 of the § Pitfall 5 defence,
standing behind the ownership refusal and never reached.

**Both symptom groups follow from that one fact.** `core.hooksPath` was never
poisoned, so:

- the CONTROL found no hook directory to consult and saw nothing fire —
  `expected false to be true`;
- `still sees the poisoned value in the file` read back `''`, because
  `git config --get` on an unset key exits 1 with no output and `simple-git`
  resolves rather than rejects on an exit-1-with-empty-stderr.

The CONTROL failure was **not** the executable bit. `02-08`'s original reasoning
— probe the platform, do not add a skip predicate that can never return `skip` —
was correct, and the `chmod(hook, 0o755)` it already carried is what makes the
hook fire on Linux. That was verified in both directions above.

## What changed (commit `28c1fc3`)

`packages/workspace/test/git/poisoned-config.test.ts` only. No source file, no
security assertion removed, relaxed, or skipped.

1. **The poisoning step branches on the real privilege mode, and the branch is
   an assertion.** `privilegeLauncher({ worker: workerIdentityFromEnv(), … })` —
   the same decision the worktree backend made — rather than
   `process.platform === 'linux'`, which would get an unprovisioned Linux host
   wrong in the direction that hides a failure.
   - Drop **not** in force (Windows, macOS, unprovisioned Linux): the agent
     poisons and the write must succeed. Exactly as `02-08` wrote it.
   - Drop **in force**: the agent's write must **fail** — layer 2 asserted
     rather than assumed, which is an assertion the suite did not previously
     have — and the same write is then performed *from the same linked
     worktree* by the identity that owns the repository, so layer 1 is still
     proven. The claim in `leaks a hooks path …` is about git's worktree
     layout, not about which uid ran the command, and it is proven identically
     in both branches.
   - The refusal is asserted as `not.toBe(0)`, deliberately not `128`. When a
     later phase teaches git to trust a daemon-owned repository the refusal
     becomes the 255 permission one; pinning either number would turn that fix
     into a spurious failure here.
2. **Both streams are kept from every workspace exec, and git's stderr is
   attached to every assertion message** (`diagnose()`, which also prints
   whether the drop was in force). This is the deliverable that made this round
   diagnosable at all in `02-07`, applied here: a future red run reports git's
   `fatal:` line instead of a bare `expected 128 to be +0`.
3. **The drop is proven able to run `git` at all before any refusal is read as
   evidence.** `not.toBe(0)` is satisfied by a launcher that failed to start or
   a binary the worker cannot execute; a one-time `git --version` probe in
   `beforeAll` throws with a named reason instead.
4. The module docblock records the whole finding, including the exit-code table,
   so the next reader meets it before the code.

## Local gates after the fix (Windows, all exit 0)

| Check                                                | Result                           |
| ----------------------------------------------------- | ---------------------------------- |
| `pnpm vitest run test/git/poisoned-config.test.ts`   | 12 passed                        |
| `pnpm -r test`                                        | core 404, plugin-sdk 10, db 43, workspace 129 passed / 2 skipped |
| `pnpm vitest run --project root`                      | 30 passed                        |
| `pnpm -r typecheck`                                   | 0                                |
| `pnpm lint`                                           | 0                                |
| `pnpm format`                                         | 0                                |

The two skips are the pre-existing Linux-only privilege cases from `02-07`,
untouched.

**The drop-in-force branch was also exercised locally**, by temporarily forcing
`poisonFromWorktree` down the owner path and re-running: 12 passed. That
validates every line CI will execute under the drop *except* the `not.toBe(0)`
refusal assertion itself, which cannot be produced on Windows.

## Still UNVERIFIED until the next Linux run

| Claim                                                                                       | Why it cannot be checked here                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The dropped agent's `git config` write is refused (`not.toBe(0)`)                            | Requires a second OS user. Grounded in the CI-observed 128 and the WSL reproduction, but not executed on the real matrix.       |
| `inWorktreeAsOwner` writes the main repo's config when the cwd is a worktree owned by that user | Verified on Windows and reproduced as a raw `git` sequence on Linux; not yet executed as ADL code on Linux.                     |
| The planted hook fires on the CI runner's git (2.51.x, not 2.43)                              | Hook-ignoring behaviour is long-stable, but the version differs from the one reproduced against.                                |
| `git --version` probe passes as the dropped worker                                            | Implied by `credentials.test.ts:293` on the red run, not asserted there.                                                       |

## Carry-forward — a real gap this uncovered

**On a Linux deployment with the privilege drop active, the agent cannot run
`git` inside its own worktree at all.** Every command exits 128 with git's
dubious-ownership refusal, because the repository is owned by the daemon user
and the child runs as `adl-worker`. That is not a test-fixture artifact — it is
how a real installation is laid out, and an agent that cannot `git status`,
`git add`, or `git commit` cannot do the job ADL exists to give it.

It is deliberately NOT fixed here: the remedy is to teach git to trust the
daemon-owned repository (a `safe.directory` entry in the worker's scratch
`GIT_CONFIG_GLOBAL`, which the child environment already owns), and that is a
security-relevant design decision that belongs in a plan rather than in a test
fix. Logged to `deferred-items.md` as `D-2-08-1`. Note that fixing it does not
weaken layer 2: `applyWorkerAccess` still takes group and world write off
`<mainRepo>/.git/config`, which is the 255 refusal above.
