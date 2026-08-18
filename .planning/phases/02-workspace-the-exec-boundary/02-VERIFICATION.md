---
phase: 02-workspace-the-exec-boundary
verified: 2026-08-18T23:15:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  previous_sha: 8ccbd9a
  verified_against: 84d1d16
  gaps_closed:
    - >-
      SC2 enforcement (WR-11) — the spawn ban, its one exemption, the CR-01
      `simple-git` carve-out and both source-tree guards now reach
      `.mts`/`.cts`/`.tsx`. Confirmed by direct probe at HEAD and by mutation,
      not by reading the diff.
  gaps_remaining: []
  regressions: []
  also_closed:
    - >-
      WR-01 — `ExecSpec.cwd` is enforced against the workspace root in all three
      backends, with a contract case that runs once per backend and a structural
      guard that names any new `run()` caller lacking it. Mutation-proven.
    - >-
      WR-02 — `buildChildEnv` refuses the git-configuration / git-invoked-program
      family by case-folded PREFIX, with a positive control that goes red if the
      ban is widened to the whole `GIT_` namespace. Both halves mutation-proven.
    - >-
      Audit trail — WR-07, the WR-12 residual, WR-13, WR-14 and IN-01..IN-05 now
      have one entry each in `deferred-items.md` as `D-2-R-3`..`D-2-R-11`, each
      with a reproduction (or an explicit non-reproduction) and an owning phase.
      The prior pass's fourth `human_verification` item is therefore CLOSED.
  new_findings:
    - >-
      WARNING — the ban covers TypeScript spellings only. A `.mjs` outside
      `packages/workspace` importing `execa` still lints CLEAN (demonstrated at
      HEAD). Narrower and far more visible than the gap it replaced, but the same
      shape. Routed to human for fix-or-accept, not scored as a failure.
    - >-
      WARNING — the "the exemption reaches `.{ext}`" half of the new lint
      assertion cannot fail from narrowing the exemption alone:
      `adl/no-simple-git-in-workspace-src` replaces `no-restricted-imports` for
      every path under `packages/workspace/src`, masking the measurement.
      Demonstrated by mutation.
closed_gaps:
  - truth: "No code path anywhere launches a process except through the workspace exec path, enforced by a lint rule that fails the build on a direct spawn outside the workspace module. (ROADMAP SC2; 02-02-PLAN must_have: 'A static import of node:child_process, child_process, execa, or simple-git anywhere outside packages/workspace fails pnpm lint at severity 2')"
    status: closed
    reason: >-
      The runtime property held at the prior pass — verified repo-wide, the only import
      of `execa` was `packages/workspace/src/exec/run.ts` and no `child_process` use
      existed anywhere. The ENFORCEMENT half did not. The `adl/no-direct-spawn` entry
      was registered with `files: ['**/*.ts']`, so a `.mts`, `.cts` or `.tsx` file
      anywhere outside `packages/workspace` could `import { execa }` and `pnpm lint`
      stayed green. Demonstrated empirically, not inferred. The same glob gap also
      silenced the two source-tree guards in `test/contract/workspace-contract.test.ts`,
      whose `typescriptSources()` walker filtered on `entry.name.endsWith('.ts')`.
    artifacts:
      - path: "eslint.config.js"
        issue: "`adl/no-direct-spawn` and `adl/no-simple-git-in-workspace-src` were registered with `files: ['**/*.ts']` / `['packages/workspace/src/**/*.ts']`."
      - path: "packages/workspace/test/contract/workspace-contract.test.ts"
        issue: "`typescriptSources()` filtered on `.ts` only."
    missing:
      - "Extend the spawn-ban globs to `**/*.{ts,tsx,mts,cts}` (and the workspace-src carve-out to `packages/workspace/src/**/*.{ts,tsx,mts,cts}`). — DONE"
      - "Extend `typescriptSources()` in the contract suite to the same extension set. — DONE"
      - "Add a `.mts` deliberate-violation fixture beside the four existing `test/lint/fixtures/spawn-*.ts` fixtures. — DONE, three fixtures, one per extension and one per import form"
      - "If the gap is instead accepted, record it in `deferred-items.md`. — NOT APPLICABLE, it was fixed"
    resolution:
      status: verified_closed
      closed_by: "fix(02): make the spawn ban and the source guards reach .mts/.cts/.tsx (2803d48)"
      verifier_evidence: >-
        Re-verified independently at `84d1d16`. Probes: `packages/db/src/probe.{mts,cts,tsx}`
        each now report a severity-2 architecture error (`no-restricted-imports` on the
        static form, `no-restricted-syntax` on the `require()` and dynamic-`import()`
        forms). The exemption widened WITH the ban — `packages/workspace/src/probe.mts`
        permits `execa` and refuses `simple-git`; `packages/workspace/test/probe.cts`
        is clean of architecture rules. Mutation: narrowing `adl/no-direct-spawn`
        back to `files: ['**/*.ts']` turns 3 root tests red; reverted, 40/40 restored.
deferred:
  - truth: "An agent can run git inside its own worktree on a provisioned Linux deployment"
    addressed_in: "Phase 4"
    evidence: >-
      `deferred-items.md` § D-2-08-1. Phase 4 goal: "Claude Code headless makes a real
      commit through the workspace, streamed live" — the first phase in which an agent
      runs git in its worktree, and the phase whose success criteria this blocks. It
      fails no WORK-01..07 wording: WORK-01 promises the feature *gets* a worktree
      (it does, created by the daemon), not that the dropped worker can run git in it.
human_verification:
  - test: >-
      Run D-2-R-1's cross-feature reproduction on the Linux CI runner: provision two
      worktrees under the scratch root for features `feat-a` and `feat-b`, then as the
      `adl-worker` identity attempt `echo x >> /srv/adl/scratch/feat-b/src/index.ts`.
    expected: >-
      Confirm whether the write succeeds (exploit confirmed) or is refused (exploit
      refuted). `deferred-items.md` marks this "[NOT YET REPRODUCED ON A LINUX HOST —
      derived from the code and the mode bits]" and explicitly says to run it before
      treating the exploit as confirmed AND before treating it as refuted.
    why_human: >-
      Requires a provisioned Linux host with two live workspaces and a real uid drop.
      The maintainer's machine is Windows, where the drop does not apply at all. The
      whole finding currently rests on code reading, which is exactly the "control
      assessed for the wrong reason" shape this phase keeps producing.
    carried_forward_from: "initial verification (unchanged)"
  - test: >-
      Decide whether D-2-R-1 (one worker identity for every concurrent feature, so
      feature A's agent can read and rewrite feature B's worktree and scratch HOME) is
      an acceptable residual for Phase 2 to ship on.
    expected: >-
      An explicit accept/reject. Verifier assessment, unchanged on re-verification: it
      does NOT contradict WORK-05 or SC4 as written — both say "a dedicated unprivileged
      OS user with a per-run scratch HOME", singular, and both are delivered. It IS a real
      supply-chain path from an untrusted spec (D-22) into a human-approved PR. It is
      stated at the definition (`WorkerIdentity` docblock), in `README.md` § "What is not
      isolated", and in `deferred-items.md` with a proposed pool design.
    why_human: >-
      A scope/risk acceptance, not a code fact. Phase 3 SC5 ("concurrency is
      configurable and defaults to one feature in flight") materially bounds the
      exposure and is the natural owner, but nothing in Phase 3's success criteria
      names per-feature worker identities, so it is not automatically covered.
    carried_forward_from: "initial verification (unchanged)"
  - test: >-
      ACCEPT OR REJECT the WR-12 residual (D-2-R-4): a committed `.gitattributes`
      selecting an attacker-named `filter.<driver>.clean` executes an arbitrary program
      during ADL's own `snapshot()`, with the full `NEUTRALISE_ARGS` set in force.
    expected: >-
      An accept/reject against WORK-07's wording. The OWNERSHIP half of this item is now
      closed and the verifier accepts the home: `D-2-R-4` files it against **Phase 15**
      as a PROPOSAL, with the honest caveat that Phase 15's success criteria would have
      to gain a line about configuration neutralisation first. That is the right document
      — the published threat model is where an accepted residual either appears with its
      reasoning or silently stops being accepted — and "proposed, not assigned, and here
      is what is missing from the target phase" is a better disposition than a
      confident-looking assignment. What remains open is only the acceptance itself.
    why_human: >-
      Requires a judgement about whether "agent-written configuration cannot affect
      ADL's own git operations" (WORK-07) is satisfied by covering the eight fixed-name
      keys plus an OS layer that is Linux-only, with the wildcard driver family open on
      every other platform. The evidence needs nothing further: the hole is demonstrated
      by a PASSING test that asserts it is open, with a `git check-attr` control so it
      cannot pass vacuously.
    carried_forward_from: "initial verification (owner resolved; acceptance still open)"
  - test: >-
      NEW — decide whether the spawn ban should reach `.js`/`.mjs`/`.cjs`, or accept the
      TypeScript-only scope explicitly. Reproduction: write
      `packages/db/src/probe.mjs` containing `import { execa } from 'execa'` and run
      `npx eslint packages/db/src/probe.mjs`.
    expected: >-
      Today it reports CLEAN — zero architecture errors — which the verifier confirmed at
      `84d1d16`. Either widen the constant (rename `TS_SOURCE_EXTENSIONS`, add the three
      JS spellings, add a fourth fixture), or record the scope in `deferred-items.md`
      with this reproduction and an owning phase, on the same standard `D-2-R-3`..`R-11`
      meet.
    why_human: >-
      A scope call, not a defect. The verifier did NOT score this as a failure of SC2 and
      the reasoning should be visible so it can be disagreed with: the repository is
      TypeScript-only; the two `.js`/`.cjs` files that exist are `eslint.config.js` itself
      and one test helper inside the workspace exemption; no `include` in any tsconfig
      compiles a `.mjs`; and — the material difference from the gap this replaced — the
      extension set is now NAMED, exported, and documented at length, so the boundary's
      scope is a stated decision rather than an invisible coincidence repeated across six
      literals. The counter-argument is equally visible: `execa@10` is ESM-only, and
      `TS_SOURCE_EXTENSIONS`' own docblock argues that "a build property that holds
      because of a file-naming coincidence is a review property wearing the rule's
      clothes" — which applies verbatim to `.mjs`.
  - test: >-
      NEW — decide whether to strengthen the "the one exemption must cover `.{ext}` too"
      assertion in `test/lint/no-restricted-imports.test.ts:501-507`. Reproduction:
      narrow `WORKSPACE_EXEMPTION` back to `['packages/workspace/**/*.ts']` while leaving
      the ban wide, then run `npx vitest run --project root`.
    expected: >-
      Today: 40/40 PASS — the assertion does not detect it. The cause is structural rather
      than sloppy: it measures at `packages/workspace/src/exec/run.{ext}`, and
      `adl/no-simple-git-in-workspace-src` (whose `files` glob is still wide) REPLACES
      `no-restricted-imports` for every path under `src/`, so the resolved options are the
      carve-out's regardless of the exemption. Measuring at a path under
      `packages/workspace/test/` instead — outside the `src` carve-out, inside the
      exemption — would make the assertion able to fail. Verified: under that mutation,
      `packages/workspace/test/**/*.mts` DOES pick up the ban.
    why_human: >-
      A judgement about how much a control is worth. This is the phase's signature defect
      shape — an assertion green for a reason that is not the one it names — but its
      blast radius is small and the wrong direction is the safe one: the undetected
      failure mode is a lint FALSE POSITIVE on a `packages/workspace/test/*.mts`, which
      announces itself as a red build. The ban half, whose failure mode is a silent hole,
      IS covered and does go red (verified by mutation).
---

# Phase 2: Workspace & the Exec Boundary — Verification Report

**Phase Goal:** Every process ADL launches — including agent CLIs — runs through one swappable workspace, with the worker's blast radius bounded before any adapter exists to break the rule.
**Verified:** 2026-08-18T23:15:00Z (re-verification) — initial pass 2026-08-18T22:15:00Z
**Status:** human_needed (was `gaps_found`) — the one gap is closed; what remains are scope decisions, not code facts
**Re-verification:** Yes — after gap closure. See § Re-verification at the end for what was re-checked and how.
**Verified against:** `84d1d16` (working tree clean apart from two untracked research-cache files; identical to the SHA CI run `32184817674` executed, green on both legs)

## Method note

Every claim below was checked against source or against a command I ran, never against a SUMMARY. Where a must-have rests on a test, I state whether that test could actually fail — and on both passes I proved it by breaking the code and watching the suite go red, or by constructing the violation the rule claims to catch. The re-verification pass ran **five** such mutations; all five are recorded, including the one that did **not** produce a failure.

`ROADMAP.md` marks this phase `Mode: mvp`, but its goal is not a User Story (`As a …, I want to …, so that ….`). MVP-mode User Flow Coverage was therefore not applied; the phase's five Success Criteria are a complete and well-formed contract and were used as the must-have set, merged with the eight PLANs' `must_haves.truths`. Flagging the mode/goal mismatch as an observation, not a defect — Phase 1 and Phases 3–18 carry the same `Mode: mvp` line with non-User-Story goals, so this is a project-wide default rather than anything this phase did.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each feature gets its own git worktree, and a finished feature leaves behind no worktree and no branch — verified by running many features and then a GC pass | ✓ VERIFIED | `test/worktree/gc.test.ts:203` creates **8** features reaching the end by two different real routes (clean terminal transition ×6, crashed-with-directory-deleted ×2), sweeps, then asserts **both halves independently**: `git worktree list` names no path under the scratch root, `listManagedWorktrees()` returns `[]`, AND `git branch --list 'adl/*'` is empty. The test's own comment records that plan 02-03 proved the first assertion passes while the second fails — i.e. the second half is there because it caught a real defect. Idempotency, prefix-collision (`feat-1` vs `feat-1-evil`), and per-entry-failure-continues cases all present. Re-ran green at `84d1d16`; green on Linux CI at the same SHA. |
| 2 | No code path anywhere launches a process except through the workspace exec path, enforced by a lint rule that fails the build on a direct spawn outside the workspace module | ✓ **VERIFIED** *(was ⚠️ PARTIAL)* | **Runtime half TRUE**, re-verified repo-wide at HEAD: the only `execa` import in source is `packages/workspace/src/exec/run.ts`; the only other hits are three deliberate-violation lint fixtures that nothing compiles or imports; zero `child_process` uses outside one comment. **Enforcement half now TRUE for every TypeScript spelling**, proven by probe and by mutation — see § Re-verification. One narrower residual (`.js`/`.mjs`/`.cjs`) routed to a human scope decision, not scored as a failure; the reasoning is stated in the frontmatter so it can be disagreed with. |
| 3 | A second workspace backend is registered and the loop runs against it unchanged — proven with an in-repo stub backend and zero call-site edits | ✓ VERIFIED | `registry.ts` is the sole factory site; `test/contract/workspace-contract.test.ts` proves it by reading every `src/` file and reporting offenders by filename, **with a positive control** ("confirms registry.ts really does name both, so the guard is not vacuous"). `test/helpers/contract.ts` contains **zero backend-id branching** and its cases run twice via `describeWorkspaceContract('worktree', …)` / `('stub', …)`. The contract suite gained three cases this pass (the WR-01 cwd refusals) and they too run once per backend. Re-ran: contract + registry + credentials + gc + git = **90 passed**. |
| 4 | The worker runs as a dedicated unprivileged OS user with a per-run scratch `HOME`; agent-written `.npmrc`, `.gitconfig`, or hooks-path configuration does not survive the run and never affects ADL's own git operations | ✓ VERIFIED | Both clauses, at depth — see the dedicated section below. Linux CI run `32184817674` at this SHA: **205 passed, 0 skipped, zero `[ADL][SKIPPED]` lines** on both node 22 and node 24 (I pulled and grepped the log myself). Strengthened this pass rather than weakened: `poisoned-config.test.ts` gained a cross-platform CONTROL for the stand-in it depends on, and an assertion that the WR-01 guard cannot be quietly removed. |
| 5 | Forge tokens and model API keys are absent from the worker's ambient environment — asserted by dumping a child process's environment in a test | ✓ VERIFIED | `test/exec/credentials.test.ts` sets real sentinels in the *parent*, spawns a real `.cjs` child that dumps its own environment, and asserts nine credential-name patterns and both literal values absent — **with a positive control** (`expect(dumped).toContain('PATH')`) so an empty dump cannot satisfy it. The scoping case asserts **from both sides**. `buildChildEnv` reads `process.env` **never**; `execa` is called with `extendEnv: false`. Reinforced this pass by WR-02: the caller-supplied-env door is now narrowed as well as the inheritance door. |

**Score: 5/5 truths verified** (was 4/5). 0 behaviour-unverified.

### Success Criterion 4, in detail — the phase's own subject matter

The brief warned that this phase's recurring defect is controls that pass for the wrong reason. Each control below is reported with what would make it fail.

**Would the Linux privilege evidence fail if the drop were broken?** Yes, four independent ways:

- `test/helpers/platform.ts` `linuxOnly()` **throws** — not skips — on a Linux runner with `ADL_WORKER_USER` or `ADL_WORKER_GROUP` unset. A CI job that forgot provisioning goes red instead of green-and-empty.
- CI log for run `32184817674` at this exact SHA contains **zero** `[ADL][SKIPPED]` lines and reports 205/205 with 0 skipped on both legs, so the Linux-only cases genuinely executed. The provisioning steps (`groupadd --system`, `useradd --system`, `usermod --append`, the `NOPASSWD:SETENV:` sudoers entry, `Defaults>adl-worker !secure_path`) are all present in the log.
- The T-2-30 supplementary-group assertion is guarded against vacuity by `expect(daemonOnly.length).toBeGreaterThan(0)`.
- The assertion is on the child's **group list**, not its uid — stated in the module docblock precisely because a uid comparison passes cleanly on the `execa({uid, gid})` implementation that does not call `setgroups`.

**Would the "worker cannot write `.git/config`" negative control fail if layer 2 were removed?** Partially. It is asserted from both sides — non-zero exit *and* `readFile(config)` not containing the marker. But note honestly: on a default-umask repository `.git/config` is `0644` and owner-writable only, so the denial would hold even if `protectFromWorker()` never ran. The control proves the *property*; it does not isolate *which layer* delivers it. `protectFromWorker`'s value is the permissive-umask case, and that case is not covered by a test.

**Would the config-neutralisation evidence fail if the fix were reverted?** Yes — proved on the first pass by mutating `src/git/adl-git.ts` to build `argv: [...binary, ...args]` (dropping `NEUTRALISE_ARGS`), which turned 4 cases red. `test/git/adl-git.test.ts` additionally carries a **CONTROL that requires the planted hook to fire** through a bare `simpleGit` handle before concluding anything from its absence on the `adlGit` path.

**Is each neutralised key proven individually?** Yes. `test/git/poisoned-config.test.ts` drives its loop off `NEUTRALISED_CONFIG` itself, so deleting an entry deletes its own proof. All 8 keys, each poisoned into the *main* repository from inside a *linked worktree*. The suite carries a CONTROL requiring the `post-index-change` hook to actually execute under an unneutralised `git status`, and asserts the poison is **still in the file** afterwards, forbidding a "detect and clean up" implementation.

**Does the Linux drop make that suite vacuous?** No. Under the drop the agent *cannot* write `.git/config`, so `poisonFromWorktree()` branches, and the branch is an **assertion, not a skip**: it requires the agent's write to be *refused* and then re-performs the write from the same linked worktree as the repository owner. `beforeAll` runs `git --version` as the dropped worker and **throws** if it fails, so "refused" cannot be satisfied by a broken launcher.

**Did the WR-01 fix weaken that suite?** No — I diffed it rather than taking the claim. `inWorktreeAsOwner` moved from `runIn(host, argv, feature.root)` (the repository-rooted workspace pointed outside its own root — the call site 02-REVIEW.md named as relying on the gap) to a `host-git` workspace **rooted at the worktree**. Same identity (`'adl'`, undropped), same cwd, same `run()`, same neutralisation; no assertion relaxed, none deleted. The pass **added** two:

- a CONTROL asserting the stand-in works on *every* platform — that the write through the worktree-rooted workspace succeeds AND lands in `<mainRepo>/.git/config` — so its mechanism is not first exercised on CI behind a Linux-only branch;
- a case asserting that the OLD shape now **throws `ContainmentError`**, so the fix cannot be quietly reverted without a red test.

**CR-01 / CR-02 (the criticals):** still closed. `grep -rn "simple-git" packages/workspace/src/` returns only comments. `execa` is imported in exactly one source file. Three independent guards, all of which now reach four extensions rather than one.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/core/src/stage/workspace.ts` | Workspace/ExecSpec/NetworkPolicy declarations, no `node:` imports | ✓ VERIFIED | `readonly argv: readonly string[]`; no field accepts a shell command string; `readonly path: string` required; `networkPolicy`/`resources` present from day one. **Updated this pass:** the `ExecSpec.cwd` docblock no longer describes a guard that does not exist — it describes the one that does, and states what it does NOT claim (a running child may still `chdir` out) |
| `packages/workspace/src/exec/run.ts` | The one process launch | ✓ VERIFIED | Sole `execa` import repo-wide; `extendEnv: false`; sole caller of `buildChildEnv`, always with both args |
| `packages/workspace/src/exec/env.ts` | Zero-inherit builder | ✓ VERIFIED | Never reads `process.env`; neutralisers point *inside* the scratch home; case-fold collision detection; `undefined` rejected by name. **Extended this pass (WR-02):** `GIT_EXECUTION_ENV_PREFIXES` refuses the git-config/git-invoked-program family by case-folded PREFIX, so the indexed `KEY_n`/`VALUE_n` evasion is covered |
| `packages/workspace/src/exec/privilege.ts` | Launcher-based drop | ✓ VERIFIED | `sudo --preserve-env --non-interactive --user <u> --`, each flag load-bearing; four-member `PrivilegeMode`; `applyWorkerAccess` skips symlinks, never sets a world bit |
| `packages/workspace/src/exec/scratch-home.ts` | Per-run disposable HOME | ✓ VERIFIED | `mkdtemp` under a daemon-owned `0700` root; owner marker beside, not inside |
| `packages/workspace/src/git/adl-git.ts` | The single ADL-side git chokepoint | ✓ VERIFIED | Routes through `run(...,'adl')`; splices `NEUTRALISE_ARGS` before the subcommand; forces `C` locale; mutation-tested |
| `packages/workspace/src/git/manager-git.ts` | Neutralisation list + client | ✓ VERIFIED | `NEUTRALISED_CONFIG` frozen, 8 keys each with a stated reason; `NEUTRALISATION_RESIDUAL_RISK` names what is *not* covered |
| `packages/workspace/src/registry.ts` | Named backend registry | ✓ VERIFIED | Three ids; unknown id throws naming the id; no credential field anywhere on the config type |
| `packages/workspace/src/stub/backend.ts` | Second backend | ✓ VERIFIED | Real `realpath(mkdtemp())` root, same `assertWithinRoot` — **and it does carry the `assertCwdWithinRoot` guard at line 139.** Checked directly rather than trusting the fixer's account of the `git checkout --` incident that briefly discarded it |
| `packages/workspace/src/git/host-backend.ts` | ADL's own workspace (D-17) | ✓ VERIFIED | `assertCwdWithinRoot(root, execSpec.cwd)` at line 190, with a docblock stating why it matters most here — its children are undropped |
| `packages/workspace/src/paths.ts` | D-02 containment guard | ✓ VERIFIED | Resolve + separator guard + realpath of the *deepest existing* ancestor. **Extended this pass:** `assertCwdWithinRoot`, with its three deliberate differences from `assertWithinRoot` (root allowed, absolute allowed, containment tested after resolution) each argued from what a cwd is |
| `packages/workspace/src/worktree/{lifecycle,list,gc}.ts` | Lifecycle, inventory, sweep | ✓ VERIFIED | `gc.ts` reaches feature state through an injected `FeatureStateLookup`; `@adl/db` is a devDependency only |
| `eslint.config.js` | The spawn boundary | ✓ **VERIFIED** *(was ⚠️ PARTIAL)* | `TS_SOURCE_EXTENSIONS = ['ts','tsx','mts','cts']` named once and every `files`/`ignores` glob in the `adl/*` family derived from it via `ts()`. Ban, exemption and CR-01 carve-out widened **together** — probed from both directions. Residual `.js`/`.mjs`/`.cjs` surface routed to a human scope decision |
| `packages/workspace/test/contract/workspace-contract.test.ts` | Source-tree backstops | ✓ VERIFIED | Walker is `/\.(?:ts\|tsx\|mts\|cts)$/` and has its **own** fixture-directory case (planting `.ts`/`.tsx`/`.mts`/`.cts`/`.d.ts` plus negative `script.js`/`notes.md`/`stale.tsx.bak`), because a walker case run against `src/` would be green either way. New guard: every module importing `exec/run.js` must call `assertCwdWithinRoot`, with the sole documented exception pinned and asserted to still exist |
| `.github/workflows/ci.yml` | Linux privilege provisioning | ✓ VERIFIED | Verified in the run `32184817674` log itself, not only in the file |
| `packages/workspace/README.md` | Install story | ✓ VERIFIED | Sudoers rule stated up front; `§ What is not isolated` present and linked from the top |
| `packages/plugin-sdk/src/index.ts` | Reference-identity re-export | ✓ VERIFIED | `type Workspace` re-exported from `@adl/core/stage` |
| `test/lint/fixtures/spawn-{esm.mts,cjs.cts,jsx.tsx}` | Extension regression fixtures | ✓ VERIFIED | Three exist, one per newly-reached extension AND one per import form (static / `require()` / dynamic `import()`), each with a docblock recording the defect it guards |
| `.planning/.../deferred-items.md` | Residue record | ✓ VERIFIED | `D-2-R-3`..`D-2-R-11` present, each with reproduction-or-explicit-non-reproduction, proposed shape, and an owning phase. Spot-checked `D-2-R-3` and `D-2-R-4` in full — they meet the standard of the seven pre-existing entries |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `src/exec/run.ts` | `src/exec/env.ts` | `buildChildEnv(spec, scratchHome)` — one call site, both args | ✓ WIRED |
| `src/worktree/backend.ts` | `src/exec/run.ts` | `run(execSpec, scratchHome.path, log, worker)` | ✓ WIRED |
| `src/{worktree,stub,git/host}/backend.ts` | `src/paths.ts` | `assertCwdWithinRoot(root, execSpec.cwd)` — all three, before the spawn, pinned by a structural guard that names any new `run()` caller lacking it | ✓ WIRED (new) |
| `src/git/adl-git.ts` | `src/git/manager-git.ts` | `NEUTRALISE_ARGS` imported, not re-declared | ✓ WIRED |
| `src/worktree/{lifecycle,list,backend}.ts` | `src/git/adl-git.ts` | `adlGit()` — all three, pinned by an exact-module-list assertion | ✓ WIRED |
| `src/registry.ts` | `src/{worktree,stub,git}/…backend.ts` | Sole factory site, guarded with a positive control | ✓ WIRED |
| `src/worktree/gc.ts` | `@adl/core` `TERMINAL_STATES` | Runtime value imported, not a transcribed list | ✓ WIRED |
| `test/exec/credentials.test.ts` | `test/helpers/env-dump-child.cjs` | Real child, real dump | ✓ WIRED |
| `eslint.config.js` `TS_SOURCE_EXTENSIONS` | every `adl/*` `files`/`ignores` glob | `ts()` helper — derived, not transcribed, so ban/exemption/carve-out cannot drift apart | ✓ WIRED (new) |
| `src/exec/privilege.ts` `privilegeModeMismatch()` | *(no caller)* | Detector shipped, wiring deferred as D-2-R-2 | ⚠️ ORPHANED — documented, non-blocking |

### Behavioral Spot-Checks (re-verification pass)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Spawn ban reaches `.mts` outside the workspace | `npx eslint packages/db/src/probe.mts` (`import { execa }`) | 1 error, severity 2, `no-restricted-imports` | ✓ PASS |
| Spawn ban reaches `.cts` in `require()` form | `npx eslint packages/db/src/probe.cts` | severity 2 `no-restricted-syntax` for `require('node:child_process')` | ✓ PASS |
| Spawn ban reaches `.tsx` in dynamic-`import()` form | `npx eslint packages/db/src/probe.tsx` | severity 2 `no-restricted-syntax` for `import('execa')` | ✓ PASS |
| **Exemption widened WITH the ban** — `execa` still permitted in a workspace `.mts` | `npx eslint packages/workspace/src/probe.mts` | `execa` clean; **`simple-git` refused** (CR-01 carve-out reaches the new extension) | ✓ PASS |
| Workspace `test/` `.cts` inside exemption, outside carve-out | `npx eslint packages/workspace/test/probe.cts` | zero architecture errors | ✓ PASS |
| **Spawn ban on `.mjs`** | `npx eslint packages/db/src/probe.mjs` (`import { execa }`) | **CLEAN** — zero architecture errors | ⚠️ **WARNING** — see human item 4 |
| WR-02 refusal is real | `vitest run test/exec/env.test.ts` | 12 passed, incl. family-driven loop, indexed pairs at index 17, case-folded spellings, and the positive control | ✓ PASS |
| WR-01 guard is real, per backend | `vitest run test/contract` | cwd refusal cases run once for `worktree` and once for `stub`, asserting `ContainmentError` specifically | ✓ PASS |
| Full workspace suite | `npx vitest run` in `packages/workspace` | **201 passed / 4 skipped** (Windows) — matches the claim exactly | ✓ PASS |
| Root project suite | `npx vitest run --project root` | **40 passed** | ✓ PASS |
| Targeted regression on carry-forward truths | `vitest run test/contract test/registry test/exec/credentials test/worktree/gc test/git` | **90 passed** | ✓ PASS |
| Gates | `npx eslint .` / `prettier --check .` / `pnpm -r typecheck` | exit 0 / "All matched files use Prettier code style" / every package Done | ✓ PASS |
| CI ran the Linux-only privilege assertions | `gh run view 32184817674 --log` | SHA = `84d1d16` exactly, both legs success, workspace **205 passed / 0 skipped**, **0** `[ADL][SKIPPED]` lines, provisioning steps present | ✓ PASS |
| Runtime half of SC2 re-checked repo-wide | grep for `execa` / `child_process` across all five extensions | only `src/exec/run.ts` + three never-compiled fixtures; one `child_process` mention in a comment | ✓ PASS |
| Debt markers in every file changed since `8ccbd9a` | grep `TBD\|FIXME\|XXX` over the 16 changed source files | none | ✓ PASS |

### Mutation Testing (re-verification pass)

The standard this report holds itself to: prefer evidence that a property would FAIL if broken over evidence that a test is green. Five mutations, all reverted, working tree confirmed clean afterwards.

| # | Mutation | Result | Reading |
|---|----------|--------|---------|
| 1 | `adl/no-direct-spawn` narrowed back to `files: ['**/*.ts']` | **3 failed** — the `.mts`/`.cts`/`.tsx` resolved-config cases, each with the WR-11 message | The ban half of the fix is load-bearing |
| 2 | `WORKSPACE_EXEMPTION` narrowed to `.ts` only, ban left wide | **40 passed — NO failure** | ⚠️ The exemption half is NOT covered. See below |
| 3 | `assertCwdWithinRoot` removed from `stub/backend.ts` only | **4 failed** — 3 behavioural contract cases for `stub` (the child actually RAN in the parent directory, `exitCode: 0`) plus the structural guard, which named the offending module | WR-01 is enforced, not documented |
| 4 | `namesGitExecution` short-circuited to `false` | **3 failed** — every family member reported `ACCEPTED`, including `GIT_CONFIG` bare which the reserved set does not cover | WR-02 is load-bearing |
| 5 | `'GIT_CONFIG'` widened to `'GIT_'` (over-refusal) | **1 failed** — the POSITIVE CONTROL | The WR-02 cases cannot be satisfied by banning the namespace wholesale |

**Mutation 2 is the finding worth reading.** The new assertion at `test/lint/no-restricted-imports.test.ts:501-507` says "the one exemption must cover `.{ext}` too — a ban wider than its exemption makes the one exec primitive unwritable in that spelling". It cannot fail from narrowing the exemption, because it measures at `packages/workspace/src/exec/run.{ext}` and `adl/no-simple-git-in-workspace-src` — whose `files` glob is still wide — **replaces** `no-restricted-imports` for every path under `src/`. The resolved options are the carve-out's regardless. Probed under the mutation to be sure of the mechanism rather than inferring it: `packages/workspace/src/exec/probe-run.mts` came back CLEAN (masked), while `packages/workspace/test/tmpprobe/probe.mts` picked up `no-restricted-imports` — which is the real, untested breakage. Measuring at a `packages/workspace/test/` path would make the assertion able to fail.

This is the phase's signature defect shape and it is worth naming as such. It is nonetheless a WARNING and not a gap: the undetected failure mode is a lint **false positive**, which announces itself as a red build, whereas the direction that fails silently — the ban not reaching an extension — is covered and does go red.

### Requirements Coverage

| Requirement | Source Plans | Status | Evidence |
|-------------|--------------|--------|----------|
| **WORK-01** — Each feature gets its own git worktree | 02-01, 02-03, 02-04, 02-06 | ✓ SATISFIED | `createWorktree` on `adl/<featureId>`; duplicate-feature refusal; prefix-collision separation; id validation rejects empty/whitespace/separator-bearing ids |
| **WORK-02** — Every process launch, including agent CLIs, goes through the workspace's exec path | 02-01, 02-02, 02-03, 02-08 | ✓ **SATISFIED** *(was PARTIAL)* | Runtime property true and re-verified repo-wide, including ADL's own git (D-17's host-rooted backend is a third registry entry rather than a second lint exemption). Lint enforcement now covers every TypeScript spelling in all three import forms, proven by probe and by mutation. Strengthened further by WR-01: a caller can no longer choose *where* a child starts, only that it starts inside the workspace |
| **WORK-03** — Backend swappable for a container/sandbox implementation without changes to the loop | 02-06 | ✓ SATISFIED | Registry + parameterised contract suite over two backends with zero branching; the WR-01 cwd cases were added to the shared helper, so the container backend inherits them the day it registers an id |
| **WORK-04** — Worktrees and branches reclaimed after a feature finishes | 02-04 | ✓ SATISFIED | `destroy()` primary (D-14), `sweepOrphans` crash backstop (D-15); collection keyed on feature state only |
| **WORK-05** — Worker runs as a dedicated unprivileged OS user with a per-run scratch home | 02-05, 02-07 | ✓ SATISFIED **as worded** | Both clauses delivered and proven on Linux CI at this SHA. The residual D-2-R-1 (one identity shared across concurrent features) does not contradict this wording. Flagged for human acceptance, not scored as unmet — unchanged from the initial pass |
| **WORK-06** — Credentials never enter the worker's ambient environment; model keys reach only the model subprocess | 02-03, 02-05 | ✓ SATISFIED | Zero-inherit by construction plus a real-child dump proof; per-`ExecSpec` allowlist proven scoped from both sides; structurally reinforced. WR-02 closes the complementary door — the allowlist itself can no longer carry git configuration |
| **WORK-07** — Agent-written configuration cannot persist to the host or affect ADL's own git operations | 02-05, 02-07, 02-08 | ✓ SATISFIED against SC4's enumeration; residual open and owned | All three items SC4 names are closed, each proven per-key with a firing control. Residual: the wildcard `filter.<driver>` / `diff.<driver>` family, *demonstrated open* by a passing test, now filed as `D-2-R-4` against Phase 15 as a proposal. The acceptance decision remains human |
| WORK-08, WORK-09 | — | n/a | Mapped to Phase 15 in `REQUIREMENTS.md`. Correctly not claimed here. **No orphaned requirements** |

`REQUIREMENTS.md` still shows WORK-01..07 as `Pending` in the traceability table. That is bookkeeping for the orchestrator, not a code gap.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| every file changed since `8ccbd9a` (16 source files) | `TBD` / `FIXME` / `XXX` | — | **NONE.** The debt-marker gate passes cleanly |
| `packages/workspace/**` | `TODO` / `HACK` / `PLACEHOLDER` / stub prose | — | **NONE** |
| `packages/workspace/package.json` | `simple-git@3.36.0` is a runtime `dependency` although `src/` no longer uses it | ℹ️ INFO | Unchanged from the initial pass. Post-CR-01 it is a test-only dependency, and the `description` field still reads "The only package that touches execa and simple-git." Cosmetic; move to `devDependencies` when convenient |

## Re-verification

**The gap is closed.** Not accepted, not documented away — fixed and independently confirmed.

The prior pass's single gap was Success Criterion 2's enforcement half: `files: ['**/*.ts']` did not match `.mts`, `.cts` or `.tsx`, so the repository's headline architecture rule was a build property only for files that happened to be named `.ts`. I re-ran the original reproduction and then went further, because the fix had a failure mode of its own that the reproduction could not see: a ban widened without its exemption would make a `.mts` beside `src/exec/run.ts` a lint error rather than a hole, and an exemption widened without the CR-01 carve-out would reopen a critical for one extension.

Probed from **both directions** at HEAD, not inferred from the config:

- outside the workspace, all three new extensions now report at severity 2, one per import form;
- inside `packages/workspace/src`, a `.mts` may still import `execa` and may **not** import `simple-git`;
- inside `packages/workspace/test`, a `.cts` is clean of architecture rules.

That is the shape the fix claimed, measured rather than read. The mechanism is worth a sentence too: `TS_SOURCE_EXTENSIONS` is named once, exported, and every glob is derived from it through a `ts()` helper, so the three properties above cannot come apart in a future edit — which is a stronger guarantee than four correct literals.

**The two in-scope items the prior pass routed to a human were fixed rather than filed**, and both are enforced rather than described. WR-01's `assertCwdWithinRoot` is called before the spawn in all three backends; removing it from just the stub turns four tests red, and in the failure output the child visibly *ran in the parent directory* (`exitCode: 0`) rather than merely failing to be rejected. WR-02's prefix matching is driven by an exported list the test iterates, so deleting an entry deletes its own proof, and the positive control fails if the ban is widened to `GIT_` wholesale — so neither over- nor under-refusal can satisfy it.

**The `poisoned-config.test.ts` rework relaxed nothing.** I diffed it rather than accepting the account. `inWorktreeAsOwner` now runs through a `host-git` workspace rooted at the worktree instead of the repository-rooted one pointed outside its own root; same identity, same cwd, same neutralisation. Two assertions were added, both in the right direction: a cross-platform control proving the stand-in's write succeeds and lands in the main repository's config, and a case asserting the old shape now throws `ContainmentError` so the fix cannot be silently reverted.

**The `git checkout --` incident did not cost anything.** `packages/workspace/src/stub/backend.ts` carries its `assertCwdWithinRoot` guard at line 139, with a docblock explaining why it is the shared function and not a variant. Confirmed by reading the file and by mutation, not by trusting the report of the re-apply.

**The audit-trail item is genuinely closed.** `D-2-R-3` through `D-2-R-11` exist, one per untracked finding, each with a reproduction or an explicit statement that it is unreproduced and why, a proposed shape, and an owning phase. I read `D-2-R-3` (WR-07 TOCTOU) and `D-2-R-4` (WR-12 residual) in full: they meet the standard of the seven entries that were already there. `D-2-R-3` is notable for extending its own finding to the guard added this pass — `assertCwdWithinRoot` has the same check-then-use window — which is the opposite of a fix pass marking its own work complete.

**On the WR-12 home: I accept Phase 15.** The published threat model is the right document for an accepted residual, because it is the one place where an accepted risk either appears with its reasoning or silently stops being accepted. And filing it as a *proposal* with the caveat that Phase 15's success criteria would first have to gain a line about configuration neutralisation is a better disposition than a confident assignment to a phase whose contract does not currently mention it. What is still open is only the acceptance itself, and that is correctly a human call.

**Two new warnings, both found by mutation rather than by reading.** Neither is a gap; both are in the frontmatter as human items with reproductions.

1. The ban covers TypeScript spellings only. A `.mjs` outside `packages/workspace` importing `execa` lints clean today — I checked. This is narrower than the gap it replaced (no tsconfig compiles a `.mjs`; the only `.js`/`.cjs` files in the repository are the eslint config itself and one test helper inside the exemption) and, crucially, it is now a *stated* scope rather than an invisible one: the constant is named, exported, and its docblock argues its own boundary. That is the qualitative change the prior gap asked for. It should still be recorded or closed, on the same standard `D-2-R-3`..`R-11` meet.
2. The "the exemption reaches `.{ext}`" assertion cannot fail from narrowing the exemption, because a later config entry replaces the rule at the path it measures. Detailed under § Mutation Testing.

**Verdict on the goal.** *"Every process ADL launches — including agent CLIs — runs through one swappable workspace, with the worker's blast radius bounded before any adapter exists to break the rule."* **Achieved, and now enforced on the axis it previously was not.** One workspace, one exec primitive, one child-environment builder, one ADL-side git chokepoint; a second backend registered and passing the same suite unchanged; the blast radius bounded by a real uid drop proven from inside a real child on Linux; and — the change since the last pass — the boundary is durable against future edits in every spelling of TypeScript, with a caller no longer able to choose where a child starts or to hand it git configuration.

The status is `human_needed` rather than `passed` only because five items require a decision a verifier cannot make: two Linux/scope calls on D-2-R-1, the WORK-07 acceptance on D-2-R-4, and the two new warnings above. None of them is a missing implementation.

---

## Appendix: the original gap and its resolution

> Written by the fix pass, kept verbatim as the record. The verifier's independent
> confirmation of each claim is in § Re-verification above and in § Mutation Testing.

**What changed**

| Item | Change |
|------|--------|
| `eslint.config.js` | The extension set is named once as `TS_SOURCE_EXTENSIONS` and every `files`/`ignores` glob in the architecture family is derived from it — `adl/no-direct-spawn`, its three `ignores`, `WORKSPACE_EXEMPTION`, `WORKSPACE_SRC` (the CR-01 carve-out), `adl/core-purity`, `adl/verdict-schema`, and all four fixture entries. |
| `packages/workspace/test/contract/workspace-contract.test.ts` | `typescriptSources()` walks `.ts`, `.tsx`, `.mts`, `.cts` instead of `endsWith('.ts')`, which restores both source-tree guards the report named. |
| `test/lint/fixtures/` | Three new deliberate-violation fixtures, one per newly-reached extension and one per import form: `spawn-esm-extension.mts` (static import), `spawn-cjs-extension.cts` (`require()`), `spawn-jsx-extension.tsx` (dynamic `import()`). |
| `test/lint/no-restricted-imports.test.ts` | A resolved-config case per extension, asserting the ban reaches `packages/db/src/index.<ext>` in every import form AND that the exemption reaches `packages/workspace/src/exec/run.<ext>` while the `simple-git` carve-out still applies there. |
| `packages/workspace/test/contract/…` | A walker case over a fixture directory containing one file per extension plus `script.js`, `notes.md` and `stale.tsx.bak`. |

**How each new guard was demonstrated failing** (fix pass's own record; independently re-run by the verifier as mutations 1 and 2):

| Mutation | Result |
|----------|--------|
| `adl/no-direct-spawn` narrowed back to `files: ['**/*.ts']` | 3 failed (the `.tsx`/`.mts`/`.cts` resolved-config cases) |
| `adl/no-direct-spawn-fixtures` narrowed back to `.ts` only | 40 passed. The fixtures are also matched by the main entry, so this alone is not observable — recorded rather than hidden |
| Both narrowed together | 6 failed |
| Contract walker reverted to `endsWith('.ts')`, with a `packages/workspace/src/leak.mts` naming `simpleGit` planted | The walker case goes red; the `simple-git` scan goes GREEN over a file that names `simpleGit` |
| Same leak file, walker fixed | The `simple-git` scan reports `leak.mts` by name |

**Also fixed in the same pass:** WR-01 (`ExecSpec.cwd` validated against the workspace root through the same containment guard `read`/`write` use, in all three backends) and WR-02 (`buildChildEnv` refuses `GIT_CONFIG*`, `GIT_SSH*`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR` and `GIT_PROXY_COMMAND` by case-folded prefix). WR-02 was reproduced live before the fix: a spec carrying `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=user.name` / `GIT_CONFIG_VALUE_0=injected-by-execspec-env` produced a child in which `git config --get user.name` printed the injected value.

**Gates at the closing commit:** `pnpm -r test` (core 404, plugin-sdk 10, db 43, workspace 201 passed / 4 skipped), `pnpm vitest run --project root` (40 passed), `pnpm -r typecheck`, `pnpm lint`, `pnpm format` — all green on Windows. All independently re-run by the verifier at `84d1d16`.

---

_Initial verification: 2026-08-18T22:15:00Z — status `gaps_found`, 4/5_
_Re-verified: 2026-08-18T23:15:00Z — status `human_needed`, 5/5_
_Verifier: Claude (gsd-verifier)_
