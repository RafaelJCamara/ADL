# M02 — Workspace & the Exec Boundary

**Status:** 🟡 Code complete — one deferred check (needs a Linux host)
**Depends on:** M01
**Requirements:** WORK-01…07 (7)

**Goal:** every process ADL launches — including agent CLIs — runs through one swappable
workspace, with the worker's blast radius bounded before any adapter exists to break the
rule.

---

## Done when

- [x] Each feature gets its own git worktree, and a finished feature leaves behind no
      worktree and no branch — verified by running many features then a GC pass.
- [x] No code path launches a process except through the workspace exec path, enforced by
      a lint rule that fails the build on a direct spawn outside the workspace module.
- [x] A second workspace backend is registered and the loop runs against it unchanged —
      proven with an in-repo stub backend and zero call-site edits.
- [x] The worker runs as a dedicated unprivileged OS user with a per-run scratch `HOME`;
      agent-written `.npmrc` / `.gitconfig` / hooks-path config does not survive the run
      and never affects ADL's own git operations.
- [x] Forge tokens and model API keys are absent from the worker's ambient environment —
      asserted by dumping a child process's environment in a test.
- [ ] **Deferred:** the cross-feature isolation reproduction (D-2-R-1) runs on a real
      Linux host. See [`DEBT.md`](../DEBT.md) — the risk is _accepted for v1_, but the
      acceptance rests on reasoning rather than a demonstration.

---

## What shipped

- **Exactly one process-launch site** — `packages/workspace/src/exec/run.ts`.
  `extendEnv: false`, `reject: false` (a non-zero exit is data, not an exception),
  `buffer: false`, `killDescendants: true`, `cancelSignal`, `forceKillAfterDelay: 5000`.
  `grep -rl "from 'execa'" packages/workspace/src` returns exactly one file.
- **A child environment with one door** — `src/exec/env.ts`. `buildChildEnv` never reads
  `process.env`; it rejects undefined values by name, case-colliding keys, and the whole
  `GIT_CONFIG*` / `GIT_SSH*` / `GIT_ASKPASS` / … family by case-folded **prefix** (an
  indexed `KEY_n` / `VALUE_n` evasion was reproduced live before the fix). Deliberately
  absent from the package barrel so no second env-assembly site can exist.
- **Worktree lifecycle and reclamation** — `src/worktree/lifecycle.ts` creates
  `adl/<featureId>` with `--end-of-options` and git's own refname rules (14 rejection
  cases; `*` would have matched every ADL branch). `destroyWorktree` is a forced two-step
  teardown, each step independently idempotent.
- **GC over feature state, not a clock** — `src/worktree/gc.ts`. `sweepOrphans` takes an
  injected `FeatureStateLookup`, has no runtime `@adl/db` dependency and no `maxAge`.
  Proof: 8 features created, 2 crash-orphaned by deleting directories out from under git,
  one sweep, then both `git worktree list` and `git branch --list 'adl/*'` empty.
- **Credential absence proven from inside a real child** — `test/exec/credentials.test.ts`
  spawns a real child that dumps its own environment and asserts nine credential-name
  patterns absent, with a positive control so an empty dump can't satisfy it.
- **Disposable scratch HOME** — `src/exec/scratch-home.ts`. `mkdtemp` under a verified,
  daemon-owned `0700` `<tmp>/adl-homes` root, not bare `/tmp`.
- **Containment stronger than the research prescribed** — `src/paths.ts`.
  `assertWithinRoot` realpaths the **deepest existing prefix**, not the parent (the
  parent-only version leaves `root/link -> /etc` open; watched failing). `ContainmentError`
  is a _sibling_ of `WorkspaceError`, not a subclass, so "refused" and "not found" stay
  distinguishable.
- **Swappability proven, not claimed** — `src/registry.ts` is the sole backend-factory
  site (`worktree`, `stub`, `host-git`), enforced by a structural source-tree guard.
  `describeWorkspaceContract` runs the same 13 cases against both backends with zero
  branching.
- **Real OS privilege drop on Linux** — `src/exec/privilege.ts`. CI green on both legs
  with **zero skips**, and the assertion compares the child's _supplementary group list_,
  not just its uid.
- **Poisoned git configuration closed and demonstrated** — `src/git/manager-git.ts` holds
  `NEUTRALISED_CONFIG` (8 executable keys) spliced ahead of every subcommand by a private
  argv builder with no exported route around it. The test watches a planted
  `post-index-change` hook **fire** under plain `git status` and **not fire** under the
  manager client.

## Deliberately excluded

- No `binary_missing` vs. non-zero-exit classification — deferred with a reproduction
  rather than shipped half-working on one platform.
- No output-size cap — that's M15 (WORK-09).
- No per-feature worker identity: one `ADL_WORKER_USER` per deployment, by construction.
  This is the root of D-2-R-1.
- `restore()` puts captured contents back and deliberately does **not** delete
  post-capture files — `git clean` is a data-loss primitive this backend doesn't hold.
- `WorkspaceBackend` / `ManagedWorkspace` deliberately not in `@adl/plugin-sdk` — a
  third-party harness receives a `Workspace` and has no use for the backend side.

## Still open

Six tracked items, all in [`DEBT.md`](../DEBT.md). The two that matter:

- **D-2-R-1** — one worker identity for every concurrent feature, so features are not
  isolated from _each other_. Accepted for v1 with four named revisit triggers. **High.**
- **D-2-R-4** — an attacker-named `filter.<driver>.clean` from a committed
  `.gitattributes` still executes during ADL's own `snapshot()`. Demonstrated by a
  _passing_ test. Accepted for v1; owner M15.
