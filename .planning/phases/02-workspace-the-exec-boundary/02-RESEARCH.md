# Phase 2: Workspace & the Exec Boundary - Research

**Researched:** 2026-08-18
**Domain:** Process isolation, git worktree lifecycle, OS privilege boundaries, lint-enforced architecture
**Confidence:** HIGH (the five highest-risk claims were reproduced locally on this machine, not read about)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Workspace Interface Surface**

- **D-01:** `Workspace.exec()` streams output via a `log(chunk: LogChunk) => void` sink, reusing the `LogChunk`/`StageContext.log` shape already defined in Phase 1's `Stage` interface — one shape, real-time transcripts for free, and it's what OBS-02 (follow a running agent live) needs. — **Reversibility:** one-way — once `@adl/plugin-sdk` republishes `Workspace` with a real (non-forward-declared) shape, every third-party harness and both built-in backends depend on this signature.

- **D-02:** `Workspace.read()`/`write()` are scoped to the feature's worktree root only — paths outside it are rejected at the interface, not by convention (mirrors D-27's "make the wrong thing unrepresentable" philosophy from Phase 1). The scratch HOME is a separate concern, handled through process env at `exec()` time, not through `Workspace.read/write`. — **Reversibility:** reversible — widening the addressable root later is additive.

- **D-03:** `Workspace.snapshot()` is defined on the interface now (real signature, e.g. returning a restore handle) even though no Phase 2 backend needs concurrent access yet — v2's `group:` parallel syntax and `mutates` (Phase 1, D-27's sibling decision) will need it, and adding a method to a published interface later is the expensive direction. — **Reversibility:** reversible now (it's additive to define it), but *not* defining it would have been a one-way-door omission per D-27's philosophy.

- **D-04:** A second workspace backend registers through a named registry (e.g. `'worktree'`, `'stub'`) resolved once at manager startup from daemon config — mirrors Phase 1's D-23 harness registry (`harness:` ids resolve the same way), so contributors reuse one mental model for pluggability. — **Reversibility:** reversible.

**OS User & Scratch HOME Isolation**

- **D-05:** Privilege drop to a dedicated unprivileged OS user is **Linux-only in v1**; on Windows/macOS dev environments the worktree backend runs unsandboxed with a warning banner. Satisfies WORK-05 literally on the daemon's actual deployment target without blocking local development on this Windows machine. — **Reversibility:** reversible — additive per-OS support later.

- **D-06:** The dedicated unprivileged user is **pre-provisioned by install docs** (or a one-time documented `sudo` step in an install script), not created by the daemon at runtime — keeps the long-running manager process from ever needing root-capable permissions itself. — **Reversibility:** reversible.

- **D-07:** The per-run scratch `HOME` is a **fresh temp directory created before each run and deleted on teardown** — no reused/wiped directory, so WORK-07's "does not survive the run" is true because the directory stops existing, not because a wipe step ran correctly. — **Reversibility:** reversible.

- **D-08:** WORK-07's "never affects ADL's own git operations" is enforced **structurally**: ADL's own git operations (branch creation, any commits ADL itself makes) run with their own explicit `GIT_CONFIG_GLOBAL`/`HOME` pointing outside the scratch directory entirely. A leftover `.gitconfig` or hooks-path in the scratch HOME has nothing to reach, rather than relying on cleanup happening before ADL's next git call. — **Reversibility:** costly — this is a security property multiple later phases (5, 9) will build git operations against; loosening it later needs an audit of every manager-side git call site.

**Credential Boundary Mechanism**

- **D-09:** Model API keys reach the model subprocess via an **explicit env allowlist passed into that one `exec()` call** — the manager passes `ANTHROPIC_API_KEY` etc. only into the specific spawn that is the agent CLI invocation, never into the worker process's own environment or any other child. — **Reversibility:** reversible.

- **D-10:** `Workspace.exec()` defaults to **zero inherited environment** — every child starts with an explicit, minimal env (the caller supplies `PATH` and whatever else it needs), rather than inheriting the worker process's environment with sensitive vars stripped. Makes WORK-06 ("credentials never enter the worker's ambient environment") true by construction. — **Reversibility:** costly — an allowlist model requires every future caller to remember to pass what it needs; loosening the default later (e.g. to "inherit minus denylist") is a security regression that needs re-auditing every exec() call site added since.

- **D-11:** The success-criterion-5 test **spawns a real child process that dumps its environment** and asserts no forge token or model key pattern appears in the captured output — tests the actual boundary the child process sees, not just the code path that builds the env object. — **Reversibility:** reversible.

- **D-12:** ADL's own git operations that need forge credentials (push, remote calls) run through a **separate manager-owned git client, outside `Workspace.exec()` entirely** — the worker's `Workspace` never has forge-token-bearing exec calls to begin with, so there is no second credential-passing mechanism layered onto the general env-allowlist. — **Reversibility:** costly — Phase 5 (forge push) and Phase 9 (sticky comments, PR operations) build directly on this boundary; merging the two paths later means re-plumbing every manager-side git call.

**Worktree Lifecycle & GC**

- **D-13:** Branch naming is **`adl/<feature-id>`**, with the worktree checked out to a dedicated scratch root sibling to the main repo — consistent with Phase 1's D-16 (folder name is the feature id and the branch suffix), predictable, greppable, collision-safe since feature ids are already unique. — **Reversibility:** one-way — public convention once features start running; changing it breaks reconciliation logic (DETECT-05) that matches open PRs back to feature ids.

- **D-14:** Worktree/branch teardown happens **immediately on terminal state** (merged, closed, abandoned) — the worker removes its own worktree and branch as soon as the feature reaches a terminal state, not only during a periodic sweep. Keeps success criterion 1 continuously true rather than only true right after a GC pass. — **Reversibility:** reversible.

- **D-15:** A **periodic backstop sweep plus an explicit manual CLI trigger** both run the GC pass named in success criterion 1 — the sweep catches worktrees orphaned by a crash before immediate teardown could run; the CLI trigger gives the success-criterion test (and the maintainer) a deterministic way to invoke it. — **Reversibility:** reversible.

- **D-16:** GC decides a worktree is a safe-to-remove orphan by **cross-checking it against the DB's feature state** (Phase 1's schema) — list worktrees on disk, look up each by feature id, remove any whose feature is terminal or whose id doesn't exist in the DB at all. Reuses the DB as the single source of truth (EXEC-06) rather than inventing a second signal like filesystem age, which can't distinguish a slow-running feature from an abandoned one. — **Reversibility:** reversible.

**Carried in from ROADMAP.md Notes, not re-decided:** `networkPolicy` and `resources` must be present in the workspace spec from day one with `'full'` as the v1 value, so the future container backend is a drop-in rather than a call-site sweep.

### Claude's Discretion

The user selected the recommended option in all sixteen questions; nothing was explicitly delegated beyond what's noted above. Left to the researcher and planner:

- Exact `LogChunk` buffering/backpressure behavior when a consumer is slow to read the stream.
- The precise mechanism for Linux privilege drop (setuid-root helper binary vs `sudo -u` vs `su`) — D-05 only fixes that it's Linux-only in v1 and OS-gated.
- Scratch root directory location/naming convention (e.g. under a configured temp root vs alongside worktrees).
- Exact shape of the `snapshot()` restore handle from D-03, beyond "it exists on the interface."
- Registry key naming conventions beyond `'worktree'`/`'stub'` examples from D-04.

### Deferred Ideas (OUT OF SCOPE)

No scope creep occurred — discussion stayed inside the phase boundary throughout.

- **Container/sandbox workspace backend** — explicitly v2 (SCALE-02, REQUIREMENTS.md). Phase 2 only guarantees the swap is possible via the registry (D-04) and the `networkPolicy`/`resources` placeholder fields carried in from the roadmap notes.
- **Windows/macOS OS-user isolation** — D-05 defers real privilege-drop support on non-Linux dev environments; only a warning banner ships in v1.
- **Credential broker / short-lived tokens** — considered and passed over in favor of the simpler env-allowlist (D-09) for v1; would be the next step up if the env-allowlist model proves insufficient.
- **`group:` parallel pipeline stages** — still v2 per Phase 1's deferred list; D-03 only defines `snapshot()`'s signature now so the interface doesn't need to break later.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WORK-01 | Each feature gets its own git worktree | § Pattern 1 (worktree lifecycle), § Code Example 1 — `git worktree add -b adl/<id>` verified locally, branch naming per D-13 |
| WORK-02 | Every process launch — including agent CLIs — goes through the workspace's exec path | § Pattern 4 (lint boundary), § Pitfall 1 + 2 — the rule composition that makes this non-decorative; § Open Question 1 resolves the manager-git-client tension |
| WORK-03 | The workspace backend is swappable for a container/sandbox implementation without changes to the loop | § Pattern 3 (registry), § Pattern 5 (`ExecSpec` shape with `networkPolicy`/`resources` at `'full'`) |
| WORK-04 | Worktrees and branches are reclaimed after a feature finishes | § Pitfall 3 + 4 — `worktree remove` does NOT delete the branch and `prune` does not either (verified); § Code Example 2 (ordered teardown); § Code Example 3 (GC orphan detection against `TERMINAL_STATES`) |
| WORK-05 | Worker runs as a dedicated unprivileged OS user with a per-run scratch home directory | § Pitfall 8 (`spawn({uid,gid})` is not a privilege-drop primitive), § Open Question 2, § Pattern 6 (`mkdtemp` scratch HOME) |
| WORK-06 | Credentials never enter the worker's ambient environment; model keys reach only the model subprocess | § Pitfall 6 + 7 (empty env is not empty on Windows; execa PATH resolution), § Code Example 4, § Pattern 5 |
| WORK-07 | Agent-written configuration cannot persist to the host or affect ADL's own git operations | § Pitfall 5 — **the shared `.git/config` finding**, the single most important discovery in this phase; § Code Example 5 (config neutralisation), § Pattern 7 |
</phase_requirements>

## Summary

Phase 2 is not a "build a wrapper around `spawn`" phase. Three of the five success criteria are security properties, and empirical probing on this machine turned up two ways the phase can ship looking correct while being hollow.

**The first is git's shared local config.** Linked worktrees do not have their own `.git/config` — they share the main repository's. Running `git config core.hooksPath /tmp/evil` from inside a linked worktree writes the *main repo's* `.git/config`, and `git -C main-repo config --get core.hooksPath` then returns it [VERIFIED: reproduced locally, git 2.49.0.windows.1]. D-08 addresses `HOME`/`GIT_CONFIG_GLOBAL`, which is necessary and which I confirmed works — but neither of those touches local config, and git upstream has stated it has no plans to make dangerous local-config directives safe [CITED: github/copilot-cli GHSA-9ccr-r5hg-74gf]. WORK-07's "never affects ADL's own git operations" therefore needs a *third* control that D-08 does not name: every manager-side git invocation must neutralise the executable config keys per-invocation. Both `git -c core.hooksPath= …` and `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=` were verified to override the poisoned local value. D-12's single manager-owned git client is what makes this cheap — one chokepoint instead of an audit.

**The second is the lint rule.** Phase 1's `eslint.config.js` already warns that ESLint allows one configuration per rule per file. What it does not say — because Phase 1 had no overlapping globs — is that this applies *across config entries too*. I registered two flat-config entries, both with `files: ['**/*.ts']`, one banning `node:fs` and one banning `node:child_process`; the second silently erased the first [VERIFIED: reproduced with the repo's own eslint 10.8.1]. A Phase 2 spawn-ban entry glob'd over `packages/**/*.ts` would therefore *delete* `@adl/core`'s purity rules and the verdict `refine()` ban, and every existing lint test would still pass because the fixtures would trip the *new* rule. Separately, `no-restricted-imports` does not see `require('child_process')` or `await import('node:child_process')` at all [VERIFIED] — a spawn ban built on it alone is bypassable by four characters.

Everything else is comparatively mechanical, but two smaller findings matter: `git worktree remove` does not delete the branch and `git worktree prune` does not either (both verified — `adl/feat-3` survived a prune that removed its worktree), so WORK-04's teardown is strictly two ordered steps; and `env: {}` does not produce an empty environment on Windows, where Node injects eleven variables including `PATH` and `USERPROFILE` [VERIFIED]. D-11's phrasing — assert *no credential pattern appears*, rather than assert the env is empty — is already correct for this and should not be "tightened" during planning.

**Primary recommendation:** Build `packages/workspace` as the sole importer of `execa` and `node:child_process` in the repository; put the `Workspace`, `ExecSpec`, and `LogChunk`-consuming types in `@adl/core/stage` as pure types (core's purity ban permits this — a type needs no import); compose the lint rules as *one* `no-restricted-imports` object per `files` glob plus `no-restricted-syntax` selectors for `require()`/`import()`; and treat manager-side git-config neutralisation as a named deliverable of this phase rather than an implicit consequence of D-08.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `Workspace` / `ExecSpec` / `RestoreHandle` **types** | `@adl/core/stage` (pure) | `@adl/plugin-sdk` (re-export) | `StageContext.workspace` already references `Workspace` from here, and `plugin-sdk` re-exports it. A type declaration needs no runtime import, so core's `node:fs`/`node:child_process` ban is not violated. Putting the interface anywhere else means a second import path for third-party harnesses. |
| Worktree create / destroy / list | `packages/workspace` (worktree backend) | `git` binary via `simple-git` | Filesystem and process work — forbidden in `@adl/core` by the existing lint rule. |
| Process launch (`exec`) | `packages/workspace` | `execa` → OS | The one exec path (WORK-02). This module is the *only* legitimate import site for `execa`/`node:child_process`. |
| Env allowlist construction | Worker / caller of `exec()` | `packages/workspace` enforces the empty default | D-10 makes the default safe; the caller opts in to what it needs. Enforcement lives at the interface, policy lives at the call site. |
| Credential ownership + per-exec injection | Manager (EXEC-01, Phase 3) | passed through one `exec()` call (D-09) | Credentials never transit the worker's own process env, so there is nothing to strip. |
| Privilege drop to the worker OS user | OS (`sudo -u` / `setpriv` / systemd) | `packages/workspace` selects and invokes it | Node cannot do this safely on its own — see Pitfall 8. |
| Per-run scratch `HOME` lifecycle | `packages/workspace` | `node:fs/promises` `mkdtemp` + `node:os` `tmpdir` | Created before the run, deleted on teardown (D-07). |
| GC orphan detection | Manager (GC sweep) | `@adl/db` `featuresRepository` + `git worktree list --porcelain` | D-16: the DB is the source of truth; git supplies the disk inventory. |
| ADL's own credentialed git operations | Manager-owned git client (D-12) | **not** the worker's `Workspace` | Keeps forge tokens off the worker exec path entirely. See Open Question 1 for how this reconciles with success criterion 2. |
| Spawn-boundary enforcement | `eslint.config.js` | CI (`pnpm lint`) | Success criterion 2 is a *build* property, not a review property. |

## Project Constraints (from CLAUDE.md)

Directives extracted from `./.claude/CLAUDE.md` that bind this phase. The planner must not recommend an approach contradicting these.

| Directive | Binding on Phase 2 |
|-----------|--------------------|
| **Architecture: Manager (control plane) + separate-process workers (execution plane)** | The workspace lives in the worker's process tree. Phase 2 must not put exec on the manager's side. |
| **`node:child_process` `fork()` for manager → worker spawn** | Phase 3's concern, but Phase 2's lint rule must not ban `fork()` in a way that blocks it — the ban should be scoped so the manager/worker seam has a named exemption or uses the workspace path. |
| **`execa@10.0.1` for "everything the *worker* shells out to: `git`, `claude`/`codex`/`gemini`, and the `adl.yml` build/start/test/teardown commands"** | This is the blessed exec primitive. Do not introduce a second one. ESM-only, `engines: node >=22`. |
| **`simple-git@3.36.0`; "No dedicated `.worktree()` helper — use `git.raw(['worktree','add','--detach', path, ref])`"; CJS, use default import** | The blessed git client. `import simpleGit from 'simple-git'` from ESM. |
| **NOT `isomorphic-git`: "Fails on git worktrees — `.git` as a file produces 'Could not resolve reference'. Worktree-per-feature is a core requirement"** | Hard prohibition. Confirmed relevant: a linked worktree's `.git` **is** a file [VERIFIED]. |
| **NOT `nodegit`** | Native libgit2 build; install liability. |
| **NOT `pm2` / `forever` / `node-windows`: "The manager *is* the worker supervisor; the OS init system supervises the manager"** | Rules out a process-supervisor dependency for the privilege-drop mechanism. systemd unit + Dockerfile is the deployment shape. |
| **`tsc` only — "Do not add a bundler"**, `"module": "nodenext"` | `packages/workspace` uses `tsc -b`, matching `@adl/core` and `@adl/db`. |
| **TypeScript pinned exactly at `6.0.3`; `typescript-eslint@8.67.0` peers `<6.1.0`** | New package uses `typescript: catalog:`. Do not bump. |
| **`pnpm-workspace.yaml` `catalog:` for shared deps; `allowBuilds` gates install scripts** | `execa` and `simple-git` have no postinstall [VERIFIED: `npm view … scripts.postinstall` → `null` via the legitimacy seam], so no `allowBuilds` entry is needed. |
| **GSD workflow enforcement: no direct repo edits outside a GSD workflow** | Planning-process constraint, not a code constraint. |
| **`engines: node >=22.12.0`** | Anything relying on a Node 24+ API (e.g. `node:sqlite`) is out. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `execa` | **10.0.1** | The single process-launch primitive inside `packages/workspace` | Named in CLAUDE.md as the blessed choice for worker shell-outs. Gives `cancelSignal`, `forceKillAfterDelay` (default 5000ms), `killDescendants`, `timeout`, `uid`/`gid`, `extendEnv`, and line-oriented `iterable()` streaming — all four of which Phase 2 needs and none of which `node:child_process` gives for free. [VERIFIED: npm registry — `latest` 10.0.1, published 2026-07-31; API surface confirmed against the installed package and the official `docs/api.md`] |
| `simple-git` | **3.36.0** | git worktree and branch operations | CLAUDE.md's blessed git client; shells to the real `git` binary so worktree semantics are exactly git's. Use `git.raw([...])` — there is no `.worktree()` helper. CJS: `import simpleGit from 'simple-git'`. [VERIFIED: npm registry — `latest` 3.36.0, published 2026-04-12] |
| `node:fs/promises` (`mkdtemp`, `rm`) | built-in | Per-run scratch `HOME` create/destroy (D-07) | `mkdtemp` is the only correct way to make an unpredictable temp directory; hand-rolled random names race. |
| `node:os` (`tmpdir`, `platform`) | built-in | Scratch root default; D-05's OS gate | `platform() === 'linux'` is the gate for privilege drop and for the warning banner elsewhere. |
| `node:path` | built-in | D-02's containment check | `path.resolve` + prefix test with a separator guard — see Pitfall 12. |
| `zod` | **4.4.3** (`catalog:`) | Validating `ExecSpec`/backend-registry config if it crosses a trust boundary | Already the workspace-wide schema tool; `catalog:` keeps it aligned. [VERIFIED: `pnpm-workspace.yaml` catalog block] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@adl/core` | `workspace:*` | `Workspace`/`LogChunk`/`FeatureState` types | `packages/workspace` depends on core; **never** the reverse (the existing `FORBIDDEN_CORE_SIBLINGS` lint rule enforces this). |
| `@adl/db` | `workspace:*` | GC's DB cross-check (D-16) | Only the GC module needs it. Consider whether GC lives in `packages/workspace` or in the manager — see Open Question 3. |
| `ulid` | **3.0.2** | Scratch-run identifiers, if worktree/scratch names need one beyond the feature id | Already blessed in CLAUDE.md; lexicographically sortable. [VERIFIED: npm registry, published 2025-11-30] |
| `vitest` | **4.1.10** (`catalog:`) | `packages/workspace` test suite | Per-package `vitest.config.ts` with `name: 'workspace'` is auto-enrolled by the root `projects: ['packages/*/vitest.config.ts']` glob — no root edit needed. [VERIFIED: `vitest.config.ts` lines 12-24] |
| `eslint` | **10.8.1** | The WORK-02 boundary rule | Root devDependency already. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `execa` | raw `node:child_process.spawn` | One fewer dependency, but you re-implement timeout→SIGTERM→SIGKILL escalation, process-group kill, `AbortSignal` wiring, and line splitting. CLAUDE.md already chose execa; re-litigating it here is out of scope. |
| `simple-git` | `execa` calling `git` directly through `Workspace.exec()` | **Genuinely attractive** — it makes success criterion 2 literally true with zero exemptions and drops a dependency. Cost: you hand-write argv construction and error mapping for ~10 git operations. See Open Question 1. |
| `sudo -u <user>` for privilege drop | `setpriv --reuid --regid --init-groups --inh-caps=-all` (util-linux) | `setpriv` is more precise and does not need a sudoers rule, but it requires the *caller* to be root. `sudo` needs a NOPASSWD sudoers entry but lets the manager run unprivileged (D-06's spirit). |
| `sudo -u` | `spawn({ uid, gid })` | **Do not.** See Pitfall 8 — requires root anyway *and* does not drop supplementary groups. |
| `no-restricted-imports` alone | `dependency-cruiser` | Phase 1 evaluated and rejected `dependency-cruiser` (01-RESEARCH.md § Package Legitimacy Audit, per the `eslint.config.js` comment at lines 22-24). Do not reopen. |
| `no-restricted-imports` + `no-restricted-syntax` | a custom ESLint plugin rule | A custom rule is more precise and can be unit-tested directly, but it is a new build artifact and a new thing contributors must understand. Two built-in rules cover it. |

**Installation:**

```bash
# in packages/workspace
pnpm add execa@10.0.1 simple-git@3.36.0
pnpm add -D typescript@catalog: vitest@catalog: @types/node@22.20.1
pnpm add @adl/core@workspace:* @adl/db@workspace:*
```

**Version verification performed:**

```
npm view execa version      -> 10.0.1   (time.modified 2026-07-31)
npm view simple-git version -> 3.36.0   (time.modified 2026-04-12)
npm view ulid version       -> 3.0.2    (time.modified 2025-11-30)
```

## Package Legitimacy Audit

Run via `gsd-tools query package-legitimacy check --ecosystem npm execa simple-git ulid`.

| Package | Registry | Age (last publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|--------------------|-----------|-------------|---------|-------------|
| `execa` | npm | 2026-07-31 | 135,872,185/wk | `github.com/sindresorhus/execa` | **SUS** (`too-new`) | **Approved.** The `too-new` signal fires on the *release date of 10.0.1*, not on package identity: 135M weekly downloads and the canonical sindresorhus repo. `postinstall: null`. Named explicitly in CLAUDE.md's blessed stack. No checkpoint needed. |
| `simple-git` | npm | 2026-04-12 | 10,357,843/wk | `github.com/steveukx/git-js` | OK | Approved |
| `ulid` | npm | 2025-11-30 | 8,869,982/wk | `github.com/ulid/javascript` | OK | Approved (only if the plan actually needs it) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** `execa` — recency-only false positive, analysed above. The planner does **not** need a `checkpoint:human-verify` for it.

`postinstall` scripts checked for all three: none present, so no `pnpm-workspace.yaml` `allowBuilds` entry is required.

## Architecture Patterns

### System Architecture Diagram

```
  adl.yml ┐                ┌──────────────────────────────────────────────┐
  spec  ──┼───────────────▶│  MANAGER — control plane, credential owner    │
          │                │  (Phase 3; shown here for boundary context)   │
          │                │   • resolves workspace backend id from config │
          │                │   • holds forge tokens + model API keys       │
          │                └────────┬───────────────────────┬─────────────┘
          │                         │ fork() + IPC          │ D-12: manager-owned
          │                         │ (Phase 3)             │ git client
          │                         ▼                       ▼
          │        ┌────────────────────────────┐  ┌─────────────────────────────┐
          │        │ WORKER — one feature        │  │ push / remote / branch      │
          │        │ ambient env carries NO      │  │ HOME + GIT_CONFIG_GLOBAL    │
          │        │ forge token, NO model key   │  │   outside scratch  (D-08)   │
          │        └────────────┬───────────────┘  │ -c core.hooksPath= …        │
          │                     │                   │   (NEW — see Pitfall 5)    │
          │                     ▼                   └─────────────────────────────┘
          │   ┌──────────────────────────────────────────────┐
          └──▶│  WorkspaceRegistry.resolve(id)   (D-04)      │
              │    'worktree'  │  'stub'  │  v2:'container'  │
              └────────────────┬─────────────────────────────┘
                               ▼
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  Workspace — THE ONE EXEC BOUNDARY (WORK-02)                          ║
   ║                                                                       ║
   ║  create(featureId) ──▶ git worktree add -b adl/<id> <scratchRoot>     ║
   ║  read(p) / write(p) ─▶ resolve(p) ⊂ worktreeRoot  else  REJECT (D-02) ║
   ║  snapshot()        ──▶ RestoreHandle                       (D-03)     ║
   ║  destroy()         ──▶ worktree remove  ▶ THEN  branch -D   (ORDER!)  ║
   ║                                                                       ║
   ║  exec(spec: ExecSpec) ────────────────────────────────────────────┐   ║
   ║      env  := {} by default (D-10); caller supplies PATH + allowed │   ║
   ║      HOME := per-run mkdtemp scratch dir           (D-07)         │   ║
   ║      GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM / npm_config_*       │   ║
   ║              pinned to neutral values             (D-08, WORK-07) │   ║
   ║      uid/gid := privilege-drop launcher, Linux only (D-05)        │   ║
   ║      networkPolicy: 'full'   resources: {...}   ← v1 placeholders │   ║
   ╚══════════════════════════════════════════════════════════════════╪═══╝
                               │                                      │
              execa (the ONLY  │                                      │
              import site in   ▼                                      ▼
              the repository)  child process ───────────▶ log(chunk: LogChunk)
                                    │                     { stream, text }
                                    │                            │
              agent CLI ────────────┘                            ▼
              build/start/test/teardown              StageContext.log → OBS-02
              ready-probe exec (adl.yml)                  live transcript

   ┌───────────────────────────────────────────────────────────────────────┐
   │  GC SWEEP — periodic backstop + `adl gc` CLI trigger        (D-15)    │
   │                                                                       │
   │   git worktree list --porcelain -z ──┐                                │
   │   (disk inventory, incl. 'prunable') │                                │
   │                                       ├──▶ terminal? unknown id? ──▶  │
   │   featuresRepository.findById(id) ───┘        remove worktree,        │
   │   (@adl/db — the source of truth, D-16)       THEN delete branch      │
   └───────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/
├── core/src/stage/
│   ├── stage.ts              # Workspace forward decl REPLACED here (pure types only)
│   └── workspace.ts          # NEW: ExecSpec, ExecResult, RestoreHandle, NetworkPolicy,
│                             #      ResourceLimits — all type/const, no node: imports
├── plugin-sdk/src/index.ts   # re-export list updated: Workspace + new type names
└── workspace/                # NEW PACKAGE — the only importer of execa / child_process
    ├── src/
    │   ├── index.ts          # public surface: registry + backends
    │   ├── registry.ts       # D-04 named-backend registry, mirrors D-23 harness registry
    │   ├── exec/
    │   │   ├── run.ts        # THE exec implementation; only file importing execa
    │   │   ├── env.ts        # zero-inherit env builder + neutralisation vars (D-08/D-10)
    │   │   └── privilege.ts  # D-05 OS gate + launcher selection + warning banner
    │   ├── worktree/
    │   │   ├── backend.ts    # WorktreeWorkspace implements Workspace
    │   │   ├── lifecycle.ts  # create / destroy, ordered teardown
    │   │   ├── list.ts       # `worktree list --porcelain -z` parser
    │   │   └── gc.ts         # D-15/D-16 sweep
    │   ├── stub/backend.ts   # D-04's second backend — proves swappability (criterion 3)
    │   └── paths.ts          # D-02 containment guard
    ├── test/
    └── vitest.config.ts      # name: 'workspace'  (auto-enrolled by root config)
test/lint/fixtures/
├── spawn-direct-import.ts    # NEW deliberate-violation fixture
├── spawn-require.ts          # NEW — require('child_process')
└── spawn-dynamic-import.ts   # NEW — await import('node:child_process')
```

### Pattern 1: Worktree lifecycle — create, then two-step teardown

**What:** `git worktree add -b adl/<featureId> <scratchRoot>/<featureId>` on create; on destroy, `git worktree remove` **then** `git branch -D`, strictly in that order.

**When to use:** Every feature (WORK-01) and every terminal-state teardown (WORK-04, D-14).

**Why the order is not negotiable** — reproduced locally:

```
$ git branch -D adl/feat-1
error: cannot delete branch 'adl/feat-1' used by worktree at '…/wt-feat-1'
--- exit 1

$ git worktree remove ../wt-feat-1
--- exit 0
$ git branch --list 'adl/*'
  adl/feat-1                     ← branch SURVIVED the worktree removal
```

[VERIFIED: reproduced locally, git 2.49.0.windows.1]

`git worktree prune` behaves identically — after `rm -rf`-ing a worktree directory and running `git worktree prune -v`, the branch `adl/feat-3` was still listed. **A GC pass built on `prune` alone satisfies "no worktree" and silently fails "no branch",** which is exactly half of success criterion 1.

### Pattern 2: Parse `worktree list --porcelain`, never the human output

**What:** `git worktree list --porcelain -z` emits label-value lines, one worktree per blank-line-separated (NUL-separated with `-z`) record. Verified shape:

```
worktree C:/…/main-repo
HEAD a264880d434dc3ec6fbe446fc6860799aa441fa3
branch refs/heads/master

worktree C:/…/wt-feat-3
HEAD a264880d434dc3ec6fbe446fc6860799aa441fa3
branch refs/heads/adl/feat-3
prunable gitdir file points to non-existent location
```

[VERIFIED: reproduced locally] — and git documents this format as stable across versions and independent of user configuration, with `-z` recommended for scripting [CITED: git-scm.com/docs/git-worktree].

**When to use:** GC's disk inventory (D-16). The `prunable` line is a free orphan signal that complements the DB cross-check — but the DB remains the source of truth, per D-16.

### Pattern 3: Named backend registry, mirroring Phase 1's harness registry

**What:** `WorkspaceRegistry` maps a string id to a factory. Resolved once at manager startup from daemon config (D-04). Built-in ids for v1: `'worktree'`, `'stub'`.

**When to use:** Success criterion 3 — "a second workspace backend is registered and the loop runs against it unchanged, with zero call-site edits."

**How to make criterion 3 provable rather than asserted:** the stub backend must be exercised by a test that runs the *same* call sequence as the worktree backend, parameterised over `['worktree', 'stub']`. A conformance-suite shape (a `describeWorkspaceContract(factory)` helper) is the honest version — and it is also what BACK-03's "single conformance suite passed by every adapter" will want in Phase 11, so building the shape here pays twice.

### Pattern 4: The spawn ban — one rule object per glob, plus syntax selectors

**What:** Success criterion 2's lint rule. Three things must be true or it is decorative:

1. **Exactly one `no-restricted-imports` configuration applies to any given file.** Overlapping flat-config entries do not merge — the later one replaces the earlier one entirely. See Pitfall 1 for the reproduction.
2. **`no-restricted-syntax` selectors cover `require()` and dynamic `import()`.** `no-restricted-imports` does not see either. See Pitfall 2.
3. **Every new rule gets a deliberate-violation fixture.** `test/lint/no-restricted-imports.test.ts` asserts (lines 192-204) that the set of rule ids registered by `architectureConfigs` *exactly equals* the set exercised by `FIXTURES`. Adding a rule without a fixture fails that test — which is the mechanism working as designed, not an obstacle.

**Anti-pattern:** a single entry with `files: ['packages/**/*.ts']` for the spawn ban. It overlaps `packages/core/src/**/*.ts` (which carries `CORE_PURITY_RULES`) and `packages/core/src/verdict/**/*.ts` (which carries `VERDICT_SCHEMA_RULES`), silently deleting both.

### Pattern 5: `ExecSpec` with the v2 fields present from day one

**What:** The roadmap Notes lock `networkPolicy` and `resources` into the spec now with `'full'` as the v1 value. Shape recommendation:

```typescript
/** v1 always 'full'. The union exists so the v2 container backend is a value change,
 *  not a call-site sweep (ROADMAP.md § Phase 2 Notes). */
export type NetworkPolicy = 'full' | 'none' | 'allowlist';

export interface ResourceLimits {
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
}
```

**Why a union and not `'full'` alone:** a literal type `'full'` widens to a union later without breaking callers, but a *value* of `'full'` written at 40 call sites is 40 edits when the container backend lands. Declaring the union now costs nothing and is precisely the "expensive to retrofit" mistake the roadmap Notes call out.

**Also on `ExecSpec`:** `argv: readonly string[]` — never a shell string. Phase 1 already committed to this and said so explicitly, in `packages/core/src/config/adl-yml.ts` lines 144-151, verbatim:

> `argv` is a non-empty array of non-empty strings — never a shell string. No shell means no quoting bugs and no injection surface from repo config, and it keeps the shape compatible with the `ExecSpec` the workspace layer runs in Phase 2 (ARCHITECTURE.md §5, threat T-1-01).

`CommandSpecSchema` (same file, lines 144-163) already carries `argv`, `cwd`, `env`, `timeout` — `ExecSpec` should be recognisably the same shape so the `adl.yml` → exec path needs no translation layer.

### Pattern 6: Per-run scratch HOME, created and destroyed by the workspace

**What:** `await fs.mkdtemp(path.join(os.tmpdir(), 'adl-home-'))` before the run; `await fs.rm(dir, { recursive: true, force: true })` on teardown (D-07).

**Set in the child env, not the parent's:** `HOME` (POSIX), and on Windows additionally `USERPROFILE` — git for Windows falls back through `HOME` → `HOMEDRIVE`+`HOMEPATH` → `USERPROFILE`, so setting only `HOME` is sufficient on this machine [VERIFIED: `HOME=/tmp/gh git config --global --get user.email` returned the scratch value] but the Windows path is a dev-environment concern only under D-05.

**Deletion is a best-effort step, not an assertion.** On Windows, `fs.rm` on a directory a just-exited child still has open fails with `EBUSY`/`EPERM`. Since D-07's guarantee is "the directory stops existing," teardown should retry with a short backoff and surface a warning rather than throwing — the security property is delivered by the unpredictable name plus the fresh directory per run, not by the deletion succeeding on the first attempt.

### Pattern 7: Neutralise executable git config on every ADL-side git invocation

**What:** ADL's own git client passes a fixed set of `-c key=` overrides on every invocation. This is the control D-08 does not cover — see Pitfall 5 for why it is necessary.

Verified to work:

```
$ git -C main-repo -c core.hooksPath= config --get core.hooksPath
                                                   ← empty; override wins
$ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0= \
    git -C main-repo config --get core.hooksPath
                                                   ← empty; override wins
```

[VERIFIED: reproduced locally against a repo whose local config had been poisoned from inside a linked worktree]

Prefer the `-c` form over `GIT_CONFIG_COUNT`: it is per-invocation and visible in the argv, so it appears in logs and cannot be lost by an env-building refactor.

### Anti-Patterns to Avoid

- **`isomorphic-git` for anything touching worktrees.** CLAUDE.md prohibits it; the mechanism is confirmed — a linked worktree's `.git` is a *file* containing `gitdir: C:/…/main-repo/.git/worktrees/wt-feat-1` [VERIFIED], which is exactly the shape isomorphic-git fails on.
- **`spawn({ uid, gid })` as the privilege boundary.** See Pitfall 8.
- **Asserting the child env is empty in the WORK-06 test.** It is not empty on Windows [VERIFIED], and asserting emptiness makes the suite red on the maintainer's own dev machine. D-11 already says "assert no forge token or model key pattern appears" — keep that phrasing.
- **`git worktree prune` as the whole GC.** It leaves branches [VERIFIED].
- **A second exec primitive.** If the manager-side git client shells out via `simple-git` while the worker shells out via `execa`, success criterion 2's "no code path anywhere" is already false. Resolve deliberately — Open Question 1.
- **Widening `read`/`write` to "anything under the scratch root."** D-02 scopes them to the *worktree* root. The scratch HOME is reached through env at exec time only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Timeout → SIGTERM → SIGKILL escalation | A `setTimeout` + `child.kill()` pair | `execa` `timeout` + `forceKillAfterDelay` (default 5000) | A process that ignores SIGTERM needs an escalation you will get wrong once and then debug in production. execa's is tested. |
| Killing a runaway agent's whole process tree | Manual `process.kill(-pid)` | `execa` `killDescendants: true` | "On Unix, this spawns the subprocess in its own process group, then sends the signal to that group" [CITED: execa docs/termination.md]. Getting the detached/group-id dance right cross-platform is a known tarpit, and a leaked agent subtree is a budget leak (LOOP-04). |
| Cancelling on pause/shutdown | A bespoke cancellation flag | `execa` `cancelSignal` fed by `StageContext.signal` | `StageContext.signal` is already an `AbortSignal` (`packages/core/src/stage/stage.ts` line 119: `readonly signal: AbortSignal;`). It plugs straight in. |
| Splitting child output into lines | Manual buffer + `split('\n')` | `execa`'s `subprocess.iterable({ from: 'stdout' })` | Handles partial trailing lines and encoding. Verified locally: two concurrent loops over `stdout` and `stderr` yielded `[["stdout","out1"],["stderr","err1"],["stdout","out2"],["stderr","err2"]]` — preserving the stream tag `LogChunk` needs. `{ from: 'all' }` interleaves correctly but **loses the tag** (`["out1","err1","out2","err2"]`), so use two loops. |
| Parsing `git worktree list` | Regexing the human-readable output | `--porcelain -z` | Git guarantees porcelain stability across versions and user config [CITED: git-scm.com/docs/git-worktree]. The human format is explicitly not a contract. |
| git plumbing (refs, index, objects) | Reimplementing over `node:fs` | `simple-git` → the real `git` binary | Worktree semantics are subtle enough that only git gets them right; see the isomorphic-git prohibition. |
| Unpredictable temp directory names | `Math.random()` / `Date.now()` names | `fs.mkdtemp` | Atomic, unpredictable, and race-free by construction. |
| Dropping privileges | `process.setuid` in the worker, or `spawn({uid,gid})` | `sudo -u` / `setpriv --init-groups` / systemd `User=` | Correct privilege drop requires `setgroups()` before `setgid()` before `setuid()`, in that order, with errors checked at each step — the classic "Setuid Demystified" failure surface. See Pitfall 8. |

**Key insight:** every item on this list is a place where the hand-rolled version *works on the happy path*. A timeout that never fires because the child ignored SIGTERM, a branch that survives GC, a supplementary group that was never dropped — none of these produce a failing test until the exact circumstance that this phase exists to make impossible.

## Common Pitfalls

### Pitfall 1: Overlapping ESLint flat-config entries silently delete each other's rules

**What goes wrong:** Phase 2 adds a spawn-ban config entry whose `files` glob overlaps `packages/core/src/**/*.ts`. `@adl/core`'s purity rules — the `node:fs` ban and the `@adl/*` sibling ban that D-27 exists to enforce — stop applying. Nothing reports it.

**Why it happens:** ESLint's flat config *replaces* a rule's options when a later entry configures the same rule id for the same file; it does not merge them. `eslint.config.js` lines 79-84 already document this within one entry ("registering them as two entries would mean the second silently replaced the first") but the same hazard across entries is new to Phase 2, because Phase 1 had no overlapping globs.

**Reproduction** — two entries, both `files: ['**/*.ts']`, run with the repo's own eslint 10.8.1:

```
A only              -> ["'node:fs' import is restricted from being used. FS-BANNED"]
B only              -> ["'node:child_process' import is restricted from being used. SPAWN-BANNED"]
A then B (overlap)  -> ["'node:child_process' import is restricted from being used. SPAWN-BANNED"]
merged one entry    -> ["'node:child_process' … SPAWN-BANNED", "'node:fs' … FS-BANNED"]
```

[VERIFIED: reproduced locally] — `A then B` lost the `node:fs` ban entirely.

**How to avoid:** compose the *paths list* as shared constants and build one complete `no-restricted-imports` object per `files` glob. Concretely: extend `FORBIDDEN_CORE_BUILTINS` with the spawn entries for the core glob, and define a separate complete object for the non-core globs.

**Warning signs:** `pnpm lint` gets *quieter* after the Phase 2 lint change. Also: `test/lint/no-restricted-imports.test.ts`'s existing fixtures would still pass, because `core-fs-import.ts` also happens to be under a glob where the fs ban might survive — the negative control does not catch a *missing* rule, only a spurious one.

**Verification step for the plan:** add an assertion that `calculateConfigForFile('packages/core/src/verdict/verdict.ts')` still resolves `no-restricted-imports` options containing **both** `node:fs` and the sibling-group pattern, after the Phase 2 rules land. The existing severity test (lines 152-172) only checks the rule is *registered at error*, not what it bans.

### Pitfall 2: `no-restricted-imports` does not see `require()` or dynamic `import()`

**What goes wrong:** the spawn ban ships, CI is green, and `const cp = require('node:child_process')` compiles and lints clean.

**Reproduction** — a file containing a static import, a `require()`, and an `await import()` of `node:child_process`, linted with `no-restricted-imports` banning it:

```
static import   -> reported
require(...)    -> NOT reported
await import(…) -> NOT reported
```

Adding `no-restricted-syntax` selectors closed both gaps:

```
other/dyn.ts -> ["REQUIRE-SPAWN-BANNED","DYNIMPORT-SPAWN-BANNED"]
```

[VERIFIED: reproduced locally]

**How to avoid:** pair the import ban with these two selectors (both verified working):

```
CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]
ImportExpression[source.value=/^(node:)?child_process$/]
```

Ban both the `node:`-prefixed and bare specifier, exactly as `FORBIDDEN_CORE_BUILTINS` already does — `eslint.config.js` lines 47-51 give the reason verbatim: *"they resolve to the same builtin, and banning only one leaves the rule trivially bypassable by dropping four characters."*

**Warning signs:** none at runtime. This one is only caught by a fixture, which is why the fixture-per-rule invariant in the existing test matters.

### Pitfall 3: `git worktree remove` does not delete the branch — and neither does `prune`

**What goes wrong:** WORK-04 and success criterion 1 say "no worktree **and** no branch." A teardown that calls only `worktree remove` (or a GC that calls only `prune`) satisfies the first half and quietly fails the second. After many features, the repo accumulates `adl/*` branches forever.

**Reproduction:** after `git worktree remove ../wt-feat-1`, `git branch --list 'adl/*'` still printed `adl/feat-1`. After `rm -rf ../wt-feat-3 && git worktree prune -v`, `git branch --list 'adl/*'` still printed `adl/feat-3`. [VERIFIED: reproduced locally]

**How to avoid:** teardown is two operations. The success-criterion test must assert on `git branch --list 'adl/*'` being empty, not only on `git worktree list`.

### Pitfall 4: `git branch -D` fails while the branch is checked out in a worktree

**What goes wrong:** teardown deletes the branch first, gets a non-zero exit, and either throws mid-teardown (leaving the worktree) or swallows the error (leaving the branch).

**Reproduction:**

```
$ git branch -D adl/feat-1
error: cannot delete branch 'adl/feat-1' used by worktree at '…/wt-feat-1'
--- exit 1
```

[VERIFIED: reproduced locally]

**How to avoid:** fixed order — `worktree remove`, then `branch -D`. Make it a single `destroy()` operation so no caller can get the order wrong, and make the two steps individually idempotent (a missing worktree or a missing branch is a no-op, not an error) so the GC backstop can re-run over a partially torn-down feature.

### Pitfall 5: Linked worktrees share the main repo's `.git/config` — an agent write is a code-execution path into ADL's own git

**This is the most important finding in this phase.**

**What goes wrong:** D-08 protects ADL's git operations from a poisoned `.gitconfig` in the scratch HOME. It does not protect them from the *local* repository config, which linked worktrees do not own — they share it with the main repository.

**Reproduction:**

```
$ git -C wt-feat-9 config core.hooksPath /tmp/wtest/evilhooks
$ git -C main-repo config --get core.hooksPath
C:/Users/rafae/AppData/Local/Temp/wtest/evilhooks       ← leaked into the MAIN repo
$ grep -n hooksPath main-repo/.git/config
8:      hooksPath = C:/Users/rafae/AppData/Local/Temp/wtest/evilhooks
```

[VERIFIED: reproduced locally, git 2.49.0.windows.1]

**Why it happens:** git config resolution for a linked worktree reads `<main>/.git/config` for local scope. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` control *global* and *system* scope only — I confirmed both work for their own scopes (`GIT_CONFIG_GLOBAL=/dev/null` made a poisoned `~/.gitconfig` `core.hooksPath` unreadable, exit 1; adding `GIT_CONFIG_NOSYSTEM=1` left only `file:.git/config` entries in `git config --list --show-origin`) — and neither touches local.

**Why this is code execution, not just misconfiguration:** git config carries "core.fsmonitor or other executable config keys" that "specify arbitrary shell commands that git will execute as part of normal operations like status, diff, or rev-parse" — the documented set includes `core.hooksPath`, `core.fsmonitor`, `core.pager`, `core.editor`, `core.sshCommand`, `credential.helper`, `diff.external`, `diff.*.textconv`, `filter.*.clean`/`smudge`/`process`, `merge.tool`, and `alias.*` [CITED: github/copilot-cli GHSA-9ccr-r5hg-74gf; justinsteven/advisories 2022_git_buried_bare_repos_and_fsmonitor_various_abuses]. And crucially: *"Git currently has no plans to change the behaviour regarding potentially dangerous configuration directives in a repo's `.git/config` file"* [CITED: same]. There is no upstream fix coming.

**How to avoid — three layers, and the plan should carry all three:**

1. **Neutralise per-invocation.** Every manager-side git call passes `-c` overrides for the executable keys. Verified to override local config (Pattern 7). D-12's single manager-owned git client makes this one code site.
2. **Make the config file unwritable by the worker user.** On Linux under D-05, `<main>/.git/config` is owned by the ADL user, mode `0644` — the worker user can read but not write it. This is the structural version and it is exactly what WORK-05's dedicated OS user buys beyond "the agent can't read `/etc/shadow`." Note this only lands on the D-05 Linux path; on the Windows dev path it does not, which the warning banner should say.
3. **Assert it in a test.** Poison `core.hooksPath` from inside a worktree, then run a manager-side git operation and assert the hook did not fire. This is the test that makes WORK-07's "never affects ADL's own git operations" a property rather than a claim.

**Warning signs:** none. A poisoned `core.hooksPath` produces no output until the hook runs.

**Note for the planner:** D-08 as written is necessary but not sufficient. This is not a contradiction of a locked decision — D-08 locks the *mechanism* for the global/HOME scope. Layer 1 above is a strictly additional control that D-08 does not mention, and the plan should name it as its own task rather than folding it into "implement D-08."

### Pitfall 6: `env: {}` is not an empty environment on Windows

**What goes wrong:** the WORK-06 test asserts the child's environment is empty. It passes on Linux CI and fails on the maintainer's Windows dev machine, or — worse — someone "fixes" it by relaxing the assertion to something that no longer proves anything.

**Reproduction** — `spawnSync(node, [dump], { env: {} })` on Windows produced a child with:

```
HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT,
TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR
```

and `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` set in the parent were **absent** from the child. The same held for `execa` with `{ extendEnv: false, env: {} }`. The inherit case leaked both. [VERIFIED: reproduced locally, Node v22.23.2, execa 10.0.1]

**How to avoid:** D-11's phrasing is already correct — *"asserts no forge token or model key pattern appears in the captured output."* Keep it. Do not strengthen it to an emptiness assertion during planning.

**Second-order consequence:** the injected `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH` mean the scratch-HOME story on Windows requires setting those explicitly too, not just `HOME`. Under D-05 this is a dev-environment nicety, not a security guarantee.

### Pitfall 7: `extendEnv: false` changes how execa resolves the binary

**What goes wrong:** on Linux (where `env: {}` really is empty), `execa('git', […], { extendEnv: false, env: {} })` throws `ENOENT` — not because git is missing, but because execa resolves the binary using `options.env.PATH`, whereas Node's own `spawn` resolves using the *parent's* PATH while still handing the child the given env.

**Source:** *"execa("ls", [], {extendEnv: false}) execa will throw ENOENT because there is no PATH environment variable in env… This differs from how Node's built-in spawn works"* [CITED: sindresorhus/execa issue #366]. I could not falsify this locally because Windows injects `PATH` into every child regardless — bare-name resolution succeeded here with `env: {}` [VERIFIED locally, Windows only], which means **this pitfall is invisible on the maintainer's dev machine and appears only on the Linux deployment target.**

**How to avoid:** make `PATH` a required (or defaulted-and-documented) field of `ExecSpec` rather than an optional one the caller may forget. D-10 already says "the caller supplies `PATH` and whatever else it needs" — encode that in the type, so a missing PATH is a compile error rather than a Linux-only `ENOENT` at round 1 of a real feature.

### Pitfall 8: `spawn({ uid, gid })` is not a privilege-drop primitive

**What goes wrong:** the obvious implementation of WORK-05 is `execa(cmd, argv, { uid, gid })` (execa exposes both: *"uid — Sets the user identifier of the subprocess"*, *"gid — Sets the group identifier of the subprocess"* [CITED: execa docs/api.md]). It appears to work. Two things are wrong with it:

1. **It requires the caller to already be root.** `setuid(2)` from an unprivileged process fails with `EPERM`. So the manager must run as root — which is in tension with D-06's stated goal of "keeping the long-running manager process from ever needing root-capable permissions itself."
2. **It does not drop supplementary groups.** Node's documentation for `uid`/`gid` says only *"Sets the user identity of the process (see setuid(2))"* and *"Sets the group identity of the process (see setgid(2))"* [CITED: nodejs.org/api/child_process.html] — it is silent on `setgroups()`. A root parent's supplementary groups are inherited by the child, so the "unprivileged" worker retains group memberships it was never meant to have. The CERT secure-coding guidance is explicit that supplementary groups must be relinquished explicitly when dropping privileges via setgid/setuid [CITED: CERT C Secure Coding Standard, via search results].

**How to avoid:** use a launcher that does the full sequence correctly:

| Mechanism | Caller must be root? | Drops supplementary groups | Notes |
|-----------|---------------------|---------------------------|-------|
| `sudo -u <user> --` | no (needs a NOPASSWD sudoers rule) | yes | Preserves D-06's spirit — manager stays unprivileged. Cost: a documented sudoers snippet in install docs, which D-06 already anticipates ("a one-time documented `sudo` step in an install script"). |
| `setpriv --reuid=U --regid=G --init-groups --inh-caps=-all --` | yes | yes (`--init-groups`) | Most precise. util-linux; present on essentially all modern Linux. |
| `runuser -u <user> --` | yes | yes | util-linux; simpler than `su`. |
| systemd `User=` on the worker unit | n/a | yes | Only applies if workers are systemd units, which they are not — CLAUDE.md says "the manager *is* the worker supervisor." |
| `execa({ uid, gid })` | yes | **no** | Do not use as the boundary. |

**Recommendation:** `sudo -u` as the v1 mechanism, with `setpriv` as a documented alternative when the operator prefers not to configure sudoers. Both are OS-gated behind `os.platform() === 'linux'` per D-05, and the absence of the chosen launcher on `PATH` should degrade to the warning banner rather than throwing. See Open Question 2.

### Pitfall 9: `git worktree remove` refuses a dirty worktree

**What goes wrong:** teardown of a feature whose agent left untracked build output throws, and the worktree leaks.

**Reproduction:**

```
$ git worktree remove ../wt-feat-2
fatal: '../wt-feat-2' contains modified or untracked files, use --force to delete it
exit=128
$ git worktree remove --force ../wt-feat-2
force exit=0
```

[VERIFIED: reproduced locally]

**How to avoid:** teardown always uses `--force`. An ADL worktree at a terminal state has, by definition, nothing left worth preserving — the developer agent's work is on the branch and, by that point, pushed. Do *not* make `--force` conditional on a cleanliness probe; that is a race with any process the agent leaked.

### Pitfall 10: `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` is an env-based config injection vector

**What goes wrong:** the env allowlist is built by copying `GIT_*` variables through "because git needs them," and an agent that can influence the parent env — or a future refactor that widens the allowlist — gains arbitrary git config, i.e. arbitrary code execution.

**Reproduction:**

```
$ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=injected git config --get user.name
injected
```

[VERIFIED: reproduced locally]

**How to avoid:** D-10's zero-inherit default already makes this safe by construction — no `GIT_*` variable reaches a child unless a caller names it. The pitfall is the *refactor*: any future "just pass through the `GIT_*` prefix" convenience reopens it. Worth a comment at the env-builder site, in the style Phase 1 uses for its own hazards.

### Pitfall 11: Windows environment keys are case-insensitive, and Node keeps only one

**What goes wrong:** the env builder produces both `PATH` and `Path` (e.g. one from a default and one from a caller override). On Windows the child gets one of them, chosen lexicographically, and it may be the wrong one.

**Source:** *"On Windows, environment variables are case-insensitive. Node.js lexicographically sorts the `env` keys and uses the first one that case-insensitively matches. Only first (in lexicographic order) entry will be passed to the subprocess."* Also: *"`undefined` values in `env` will be ignored."* [CITED: nodejs.org/api/child_process.html]

**How to avoid:** the env builder should be a single function that owns key normalisation, and `undefined` values should be rejected rather than silently dropped — a caller writing `env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }` where the var is unset should get a clear failure, not a silently keyless agent invocation that fails ten minutes later inside the CLI.

### Pitfall 12: The D-02 containment check needs `path.resolve` plus a separator guard, and `.git` is a file

**What goes wrong:** `resolved.startsWith(worktreeRoot)` accepts `/scratch/feat-1-evil` when the root is `/scratch/feat-1`. Symlinks inside the worktree also escape a purely lexical check.

**How to avoid:**
- `path.resolve(root, candidate)`, then require the result to equal `root` or start with `root + path.sep`.
- Reject before resolution using the existing `RepoRelativePathSchema` from `packages/core/src/config/path-guard.ts` (lines 55-56) — it already rejects absolute paths, `..` segments, drive-letter and UNC prefixes, and NUL bytes, and its own docblock says (lines 29-31) that whether a path *exists* is *"Phase 2's question."* Reuse it rather than writing a second guard.
- For symlink escape, `fs.realpath` the resolved path before the containment test — but note this changes behaviour for a not-yet-existing file being written, so realpath the *parent directory*.
- Remember `.git` inside a linked worktree is a **file** (`gitdir: …`), not a directory [VERIFIED]. Any code that special-cases `.git` by `isDirectory()` will misbehave.

### Pitfall 13: `LogChunk` backpressure — a slow sink stalls or drops

**What goes wrong:** D-01's `log(chunk) => void` is a synchronous, non-awaitable sink. An agent CLI producing megabytes of output faster than the consumer (SSE to a dashboard, in Phase 17) can drain it either buffers unboundedly in memory or blocks the exec loop.

**How to avoid:** because `log` returns `void`, the workspace cannot apply backpressure to the consumer — so it must apply it to the *producer*. Two concurrent `for await` loops over `subprocess.iterable({ from: 'stdout' })` and `{ from: 'stderr' }` naturally pause the underlying stream while the loop body runs, which propagates backpressure to the child through the pipe. That is the right default. What it must *not* do is push every chunk into an unbounded array and drain later.

This is one of the discretion items CONTEXT.md leaves open ("Exact `LogChunk` buffering/backpressure behavior when a consumer is slow"). **Recommendation:** consume with the two-loop pattern, document that `log` must not block (it is called synchronously in the read path), and leave any buffering to the consumer. A `maxOutputBytes` cap on `ExecSpec` is worth considering but overlaps WORK-09 (Phase 15) — do not build the capping logic here, only leave the field if it is free.

## Code Examples

### Creating a feature worktree (WORK-01, D-13)

```typescript
// packages/workspace/src/worktree/lifecycle.ts
// Source: verified locally against git 2.49.0; simple-git raw form per CLAUDE.md.
import simpleGit from 'simple-git';           // CJS default import (CLAUDE.md)
import * as path from 'node:path';

export function branchNameFor(featureId: string): string {
  return `adl/${featureId}`;                   // D-13 — one-way convention
}

export async function createWorktree(
  mainRepo: string,
  scratchRoot: string,
  featureId: string,
  baseRef: string,
): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = path.join(scratchRoot, featureId);
  const branch = branchNameFor(featureId);
  await simpleGit(mainRepo).raw([
    'worktree', 'add', '-b', branch, worktreePath, baseRef,
  ]);
  return { worktreePath, branch };
}
```

### Ordered, idempotent teardown (WORK-04)

```typescript
// The order is not a style choice — `git branch -D` fails with
// "cannot delete branch 'X' used by worktree at ..." while the worktree exists,
// and `git worktree remove` does NOT delete the branch. Both verified.
export async function destroyWorktree(
  mainRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(mainRepo);

  // 1. Always --force: a terminal feature has nothing left worth preserving,
  //    and a cleanliness probe would race any process the agent leaked.
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    if (!isAlreadyGone(error)) throw error;       // idempotent for the GC backstop
    await git.raw(['worktree', 'prune']);         // clear the stale admin entry
  }

  // 2. Only now can the branch go.
  try {
    await git.raw(['branch', '-D', branch]);
  } catch (error) {
    if (!isAlreadyGone(error)) throw error;
  }
}
```

### GC orphan detection against the DB (D-15, D-16)

```typescript
// Source: `git worktree list --porcelain` format verified locally;
// TERMINAL_STATES read from packages/core/src/state/feature-state.ts:94.
import { TERMINAL_STATES } from '@adl/core/state';

interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;      // 'refs/heads/adl/<id>' when not detached
  readonly prunable?: string;    // reason, when git already considers it orphaned
}

/** Parses `git worktree list --porcelain -z`: label-value lines, records
 *  separated by an empty entry. Documented stable across git versions. */
export function parseWorktreeList(porcelainZ: string): WorktreeEntry[] { /* ... */ }

export async function sweep(deps: GcDeps): Promise<string[]> {
  const removed: string[] = [];
  const terminal = new Set<string>(TERMINAL_STATES);   // 'merged' | 'abandoned'

  for (const entry of parseWorktreeList(await deps.listWorktrees())) {
    const featureId = featureIdFromBranch(entry.branch);   // adl/<id> -> <id>
    if (featureId === undefined) continue;                 // not ours; leave alone

    // D-16: the DB is the source of truth, never filesystem age.
    const feature = await deps.features.findById(featureId);
    const isOrphan = feature === undefined || terminal.has(feature.state);
    if (!isOrphan) continue;

    await destroyWorktree(deps.mainRepo, entry.path, branchNameFor(featureId));
    removed.push(featureId);
  }
  return removed;
}
```

`TERMINAL_STATES` verbatim from `packages/core/src/state/feature-state.ts` line 94:

```typescript
export const TERMINAL_STATES = Object.freeze(['merged', 'abandoned'] as const);
```

Note the deliberate exclusion recorded in that file's comment (lines 88-92): *"`escalated` is deliberately **not** here: the diagram draws a human-retry edge out of it."* An escalated feature's worktree must survive GC — a human is going to look at it.

### Zero-inherit exec with a per-call allowlist (D-09, D-10, WORK-06)

```typescript
// packages/workspace/src/exec/run.ts — the ONLY file importing execa.
// Source: execa 10.0.1 API verified against the installed package + docs/api.md.
import { execa } from 'execa';

export async function run(spec: ExecSpec, log: (c: LogChunk) => void): Promise<ExecResult> {
  const subprocess = execa(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,

    // D-10: zero inherited environment. `extendEnv: false` means ONLY `env` is
    // used — process.env is not merged in. Note this also changes binary
    // resolution: on POSIX, execa resolves the executable from `env.PATH`, not
    // the parent's (execa#366). ExecSpec therefore REQUIRES `path`.
    extendEnv: false,
    env: buildChildEnv(spec),

    // D-05, Linux only. Present here for completeness; the real privilege drop
    // is the launcher wrapping argv (see privilege.ts) — uid/gid alone does not
    // drop supplementary groups.
    ...(spec.uid !== undefined ? { uid: spec.uid, gid: spec.gid } : {}),

    timeout: spec.timeoutMs ?? 0,
    cancelSignal: spec.signal,       // StageContext.signal plugs straight in
    forceKillAfterDelay: 5_000,      // execa's default, stated explicitly
    killDescendants: true,           // a leaked agent subtree is a budget leak
    buffer: false,                   // we stream; nothing accumulates in memory
  });

  // Two concurrent loops, NOT `{ from: 'all' }` — `all` interleaves correctly
  // but discards the stream tag that LogChunk carries. Verified locally.
  await Promise.all([
    (async () => { for await (const text of subprocess.iterable({ from: 'stdout' }))
                     log({ stream: 'stdout', text }); })(),
    (async () => { for await (const text of subprocess.iterable({ from: 'stderr' }))
                     log({ stream: 'stderr', text }); })(),
    subprocess,
  ]);
  // ...
}
```

`LogChunk` verbatim from `packages/core/src/stage/stage.ts` lines 44-48 — D-01 reuses exactly this shape:

```typescript
/** One chunk of streamed output from a running stage. */
export interface LogChunk {
  readonly stream: 'stdout' | 'stderr' | 'agent';
  readonly text: string;
}
```

### The child environment builder (D-07, D-08, D-10, WORK-06, WORK-07)

```typescript
// packages/workspace/src/exec/env.ts
//
// Every variable here is either (a) supplied by the caller, or (b) a
// NEUTRALISER that stops the child's own config from persisting or reaching
// back. Nothing is inherited. Do NOT add a "pass through the GIT_* prefix"
// convenience: GIT_CONFIG_COUNT/KEY_n/VALUE_n is arbitrary git config, i.e.
// arbitrary code execution (verified: KEY_0=user.name VALUE_0=injected works).
export function buildChildEnv(spec: ExecSpec): Record<string, string> {
  const env: Record<string, string> = {
    PATH: spec.path,                       // required by the type — see execa#366
    HOME: spec.scratchHome,                // D-07, fresh mkdtemp per run

    // WORK-07: agent-written config must not survive or reach ADL.
    // These point INTO the scratch dir, so they die with it.
    GIT_CONFIG_GLOBAL: join(spec.scratchHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    npm_config_userconfig: join(spec.scratchHome, '.npmrc'),
    npm_config_cache: join(spec.scratchHome, '.npm'),
    XDG_CONFIG_HOME: join(spec.scratchHome, '.config'),
    XDG_CACHE_HOME: join(spec.scratchHome, '.cache'),
    ...(process.platform === 'win32'
      ? { USERPROFILE: spec.scratchHome }  // git-for-Windows HOME fallback chain
      : {}),
  };

  // D-09: credentials arrive ONLY through this explicit per-call allowlist,
  // and only on the one exec() that is the agent CLI invocation.
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    // Node ignores `undefined` values in `env` silently — reject instead, so an
    // unset ANTHROPIC_API_KEY fails here rather than inside the CLI ten minutes on.
    if (value === undefined) throw new Error(`env var ${key} is undefined`);
    env[key] = value;
  }
  return env;
}
```

Verified behaviour of the neutralisers:

```
$ HOME=/scratch git config --get core.hooksPath
/tmp/wtest/evilhooks                                  ← leaks without the neutraliser
$ HOME=/scratch GIT_CONFIG_GLOBAL=/dev/null git config --get core.hooksPath
                                                       ← exit 1, nothing found
$ HOME=/scratch npm config get registry
https://evil.example.com/                              ← leaks without the neutraliser
$ HOME=/scratch npm_config_userconfig=/dev/null npm config get registry
https://registry.npmjs.org/                            ← neutralised
```

[VERIFIED: all four reproduced locally]

### Manager-side git config neutralisation (Pitfall 5, WORK-07)

```typescript
// packages/… — the manager-owned git client (D-12). ONE call site, so this list
// lives in one place. The local .git/config is SHARED with every linked worktree
// (verified), and git upstream will not make these directives safe, so ADL must
// neutralise them itself on every invocation.
const NEUTRALISED_CONFIG = [
  'core.hooksPath=',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.editor=false',
  'core.sshCommand=',
  'credential.helper=',
  'diff.external=',
  'protocol.ext.allow=never',
] as const;

const NEUTRALISE_ARGS = NEUTRALISED_CONFIG.flatMap((kv) => ['-c', kv]);
// simpleGit(mainRepo).raw([...NEUTRALISE_ARGS, 'push', ...]);
```

### The lint boundary (WORK-02, success criterion 2)

```javascript
// eslint.config.js — composed so that exactly ONE no-restricted-imports object
// applies to any given file. Overlapping entries REPLACE rather than merge
// (verified: an entry banning child_process silently erased an earlier entry
// banning node:fs when both matched the same file).

const SPAWN_MESSAGE =
  'Direct process launch is banned outside packages/workspace (WORK-02). Every ' +
  'process ADL starts — including agent CLIs — goes through Workspace.exec(), so ' +
  'the container backend in v2 is a registry entry rather than a call-site sweep.';

const FORBIDDEN_SPAWN = [
  'node:child_process', 'child_process', 'execa',
].map((name) => ({ name, message: `${name}: ${SPAWN_MESSAGE}` }));

// Both the node:-prefixed and bare specifier, for the reason the existing
// FORBIDDEN_CORE_BUILTINS comment gives: they resolve to the same builtin.
const SPAWN_SYNTAX = [
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]",
    message: SPAWN_MESSAGE },
  { selector: "ImportExpression[source.value=/^(node:)?child_process$/]",
    message: SPAWN_MESSAGE },
];

// @adl/core keeps its OWN complete object — the spawn paths are APPENDED to the
// existing core list rather than registered as a second entry over the same glob.
const CORE_PURITY_RULES = {
  'no-restricted-imports': ['error', {
    paths: [...FORBIDDEN_CORE_BUILTINS, ...FORBIDDEN_SPAWN],
    patterns: FORBIDDEN_CORE_SIBLINGS,
  }],
  'no-restricted-properties': [/* unchanged */],
};
```

**Glob discipline the plan must get right:** the non-core spawn-ban entry must not match `packages/core/src/**/*.ts` (which carries `CORE_PURITY_RULES`) nor `packages/core/src/verdict/**/*.ts` (which carries `VERDICT_SCHEMA_RULES`'s `no-restricted-syntax`), and must exempt `packages/workspace/src/**/*.ts`. Verified: an entry-level `ignores: ['ws/**']` does exempt the directory.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `child.kill()` + manual `process.kill(-pid)` for process trees | `execa` `killDescendants: true` — "spawns the subprocess in its own process group, then sends the signal to that group" | execa 10 | Removes the most-likely-to-be-wrong 30 lines in this phase. |
| `child_process` + manual buffering for line output | `subprocess.iterable({ from: 'stdout' })` | execa 9/10 | Direct match for `LogChunk`; no split/encode logic to own. |
| `~/.gitconfig` as the only global config knob | `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_NOSYSTEM` | git 2.32 (2021) | Makes D-08 a one-env-var control instead of a `HOME`-juggling hack. All available in git 2.49. |
| Trusting `.git/config` in a repo you control | Treating local config as attacker-controlled when any untrusted process can write it | 2022 fsmonitor advisories; still unfixed upstream by policy | This is the shift that Pitfall 5 rests on. |
| Daemon calls `setuid()` on itself | Service manager assigns the identity (systemd `User=`/`DynamicUser=`) | systemd v232+ | Relevant framing, but does not apply to ADL's manager→worker fork: CLAUDE.md fixes the manager as the worker supervisor, so the launcher (`sudo -u` / `setpriv`) is the mechanism, not systemd. |

**Deprecated/outdated:**
- `no-restricted-modules` — removed from ESLint core; do not reach for it as the `require()` answer. `no-restricted-syntax` selectors are the current mechanism [VERIFIED: selectors reproduced working on eslint 10.8.1].
- `isomorphic-git` for worktree-bearing repos — prohibited by CLAUDE.md, and the mechanism is confirmed (`.git` is a file).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `sudo -u` with a NOPASSWD sudoers entry is the right v1 privilege-drop mechanism | Pitfall 8, Open Question 2 | The install story gains a sudoers file the maintainer must accept. If wrong, the alternative (`setpriv`, manager-as-root) changes WORK-05's deployment shape and D-06's premise. **Needs user confirmation.** |
| A2 | `packages/workspace` is the right package name and boundary for the exec module | § Recommended Project Structure | Cosmetic if wrong, but the lint glob and the `@adl/*` sibling rule both key off it, so changing it later touches `eslint.config.js` and every import. |
| A3 | The `Workspace` interface can live in `@adl/core/stage` without violating core's purity ban | § Architectural Responsibility Map | If a runtime value (not just a type) is needed — e.g. a `NETWORK_POLICIES` frozen array in the Phase 1 style — it is still pure data and fine. Only an actual `node:` import would break it. Low risk. |
| A4 | GC lives on the manager side rather than inside `packages/workspace` | § Supporting stack, Open Question 3 | If wrong, `packages/workspace` gains an `@adl/db` dependency it may not want, coupling the swappable backend package to the database. |
| A5 | `git worktree` semantics verified on git 2.49.0.windows.1 hold identically on the Linux deployment target | Pitfalls 3, 4, 9; Patterns 1, 2 | Low — these are core git behaviours, not platform-specific. Worth one Linux CI run to confirm. |
| A6 | An `ExecSpec.maxOutputBytes` cap is out of scope (belongs to WORK-09 / Phase 15) | Pitfall 13 | If wrong, a runaway agent's output is unbounded until Phase 15. Mitigated by the two-loop backpressure pattern. |
| A7 | The `execa` `[SUS]` verdict is a recency false positive requiring no human checkpoint | § Package Legitimacy Audit | Very low — 135M weekly downloads, canonical repo, explicitly named in CLAUDE.md's stack. |
| A8 | Setting `HOME` alone is sufficient for git's config lookup on Linux (the deployment target) | Pattern 6 | Low — POSIX git reads `$HOME/.gitconfig`. The Windows fallback chain is dev-only under D-05. |

## Open Questions

1. **Does ADL's manager-owned git client (D-12) count as "a code path that launches a process" for success criterion 2?**
   - What we know: D-12 locks that ADL's credentialed git operations run through a separate manager-owned client, *"outside `Workspace.exec()` entirely."* Success criterion 2 says *"No code path anywhere launches a process except through the workspace exec path."* `simple-git` spawns `git` internally.
   - What's unclear: whether the lint rule gets a second exemption (`simple-git` allowed in the manager git module), or whether the manager git client should itself route through a *second* `Workspace` instance — a host-rooted backend with the manager's own env and forge credentials — which would keep criterion 2 literally true with one exemption and still honour D-12's separation of the *worker's* Workspace from forge credentials.
   - Recommendation: **route the manager git client through a distinct `Workspace` instance.** It preserves both the letter of criterion 2 and the substance of D-12 (the worker's workspace still never carries a forge token), it means Pattern 7's config neutralisation is applied by construction, and it costs one extra registry entry. Flag this to the user before planning, since it touches a `costly`-reversibility decision.

2. **Which privilege-drop launcher, and does the manager run as root?**
   - What we know: `spawn({uid,gid})` requires root and does not drop supplementary groups (Pitfall 8). D-06 wants the manager to never need root-capable permissions. These two facts together mean the launcher must be an external setuid helper (`sudo`) rather than a Node capability.
   - What's unclear: whether the maintainer accepts a NOPASSWD sudoers entry as part of installation. That is a real adoption-friction question for an OSS tool installed into someone else's infrastructure, and it is exactly the kind of thing DIST-01 ("reach a first PR without reading past the top of the README") is sensitive to.
   - Recommendation: `sudo -u` as the default with `setpriv` as a documented alternative; both behind `os.platform() === 'linux'`; absence of the launcher degrades to D-05's warning banner rather than a hard failure. Confirm with the user (A1).

3. **Does GC live in `packages/workspace` or in the manager?**
   - What we know: D-16 makes the DB the source of truth, which means GC needs `@adl/db`. D-04 makes the workspace backend swappable, which argues for keeping it free of database coupling.
   - What's unclear: whether the orphan *policy* (which features are collectable) and the orphan *mechanism* (list worktrees, remove them) should be one module.
   - Recommendation: split them. `packages/workspace` exposes `listManagedWorktrees()` and `destroy()`; the manager owns the sweep that joins that inventory against `featuresRepository`. That keeps the backend swappable and puts the DB dependency where EXEC-01 already puts it ("Manager process owns detection, queue, state, config, credentials, and accounting").

4. **What is the `snapshot()` restore handle, concretely?**
   - What we know: D-03 requires a real signature now, and CONTEXT.md leaves the exact shape to discretion. Its consumer is v2's `group:` parallel stages plus the `mutates` flag already on `Stage` (`packages/core/src/stage/stage.ts` line 134: `readonly mutates: boolean;`).
   - Recommendation: `snapshot(): Promise<RestoreHandle>` where `RestoreHandle` is `{ readonly id: string; restore(): Promise<void>; release(): Promise<void> }`. For the worktree backend, `id` can be a stash ref or a temporary commit sha; for the stub backend, an in-memory copy. `release()` matters — a snapshot that can only be restored, never discarded, leaks refs. Keep the implementation minimal (a v1 worktree backend may legitimately return a handle whose `restore()` throws `not supported`, provided the *type* is honest about it — prefer a documented `UnsupportedOperation` StageError-shaped failure over a silent no-op).

5. **How does the stub backend prove "zero call-site edits" (criterion 3)?**
   - Recommendation: a parameterised contract test (`describeWorkspaceContract(name, factory)`) run over both `'worktree'` and `'stub'`, plus an assertion that the registry resolution is the only place either backend's constructor is named. This is the same shape BACK-03 will need in Phase 11, so building it here is not speculative.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `git` binary | WORK-01, WORK-04, all worktree operations | ✓ | 2.49.0.windows.1 | none needed — `GIT_CONFIG_GLOBAL` requires ≥2.32, satisfied |
| Node.js | everything | ✓ | v22.23.2 (satisfies `engines >=22.12.0`) | — |
| pnpm | workspace install | ✓ | 11.22.0 (per `packageManager`) | not on the bash `PATH` in this shell; use `corepack`/PowerShell |
| ESLint | success criterion 2 | ✓ | 10.8.1 (root devDependency) | — |
| Vitest | all tests | ✓ | 4.1.10 (`catalog:`) | — |
| `execa` | the exec path | ✗ not yet installed | 10.0.1 on registry, verified installable | none — required |
| `simple-git` | worktree operations | ✗ not yet installed | 3.36.0 on registry | hand-rolled `execa` git calls (see Alternatives) |
| Linux + `sudo` or `setpriv` | WORK-05 privilege drop | ✗ (this machine is Windows 11) | — | **D-05 already covers this**: privilege drop is Linux-only in v1; Windows runs unsandboxed with a warning banner |
| Docker | — | not required by this phase | — | — |

**Missing dependencies with no fallback:**
- `execa@10.0.1` — must be installed into `packages/workspace`. Not a blocker; it is a routine `pnpm add`.

**Missing dependencies with fallback:**
- `simple-git@3.36.0` — could be replaced by direct `execa` git invocations (which would also resolve Open Question 1 more cleanly). Planner's call.
- Linux privilege-drop tooling — D-05's warning-banner path is the designed fallback, not a gap. **Consequence for planning:** the WORK-05 acceptance test cannot run on this machine. It must be written so it *skips with a visible reason* on non-Linux rather than passing vacuously, and it must run in Linux CI before the phase can be called done.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.10 (`catalog:`) |
| Config file | `packages/workspace/vitest.config.ts` — **Wave 0**, does not exist yet. Auto-enrolled by the root `projects: ['packages/*/vitest.config.ts']` glob, so **no root config edit is required** |
| Quick run command | `pnpm vitest run --project workspace` |
| Full suite command | `pnpm test` (`pnpm -r test && vitest run --project root`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WORK-01 | `create()` produces a worktree at `<scratch>/<id>` on branch `adl/<id>` | integration (real git, temp repo) | `pnpm vitest run --project workspace -t "creates a worktree"` | ❌ Wave 0 |
| WORK-02 | Direct `import`, `require`, and dynamic `import` of `child_process`/`execa` outside `packages/workspace` are lint errors at severity 2 | lint-as-test (extends `test/lint/no-restricted-imports.test.ts`) | `pnpm vitest run --project root -t "no-direct-spawn"` | ⚠️ file exists, 3 new fixtures + cases needed |
| WORK-02 | **Regression guard:** `@adl/core`'s existing purity bans survive the new rules | lint-as-test | `pnpm vitest run --project root -t "core purity survives"` | ❌ Wave 0 — see Pitfall 1 |
| WORK-03 | Both `'worktree'` and `'stub'` satisfy the same contract suite; the registry is the only site naming either constructor | contract (parameterised) | `pnpm vitest run --project workspace -t "workspace contract"` | ❌ Wave 0 |
| WORK-04 | After `destroy()`, `git worktree list` and `git branch --list 'adl/*'` are both empty | integration | `pnpm vitest run --project workspace -t "reclaims worktree and branch"` | ❌ Wave 0 |
| WORK-04 | `destroy()` succeeds on a **dirty** worktree | integration | same file | ❌ Wave 0 |
| WORK-04 | GC removes a worktree whose feature is `merged`/`abandoned` or absent from the DB; **leaves** an `escalated` one | integration (temp DB + temp repo) | `pnpm vitest run --project workspace -t "gc"` | ❌ Wave 0 |
| WORK-05 | Scratch `HOME` exists during the run and is gone after teardown | integration | `pnpm vitest run --project workspace -t "scratch home"` | ❌ Wave 0 |
| WORK-05 | Child runs as the configured uid | integration, **Linux-only, skips visibly elsewhere** | `pnpm vitest run --project workspace -t "privilege drop"` | ❌ Wave 0 — cannot run on this machine |
| WORK-06 | A real child process dumping its env contains no forge-token or model-key pattern (D-11) | integration | `pnpm vitest run --project workspace -t "credentials absent"` | ❌ Wave 0 |
| WORK-06 | A model key passed to *one* `exec()` is present there and absent from a sibling `exec()` | integration | same file | ❌ Wave 0 |
| WORK-07 | A `.gitconfig`/`.npmrc` written by a child into the scratch HOME does not exist after teardown | integration | `pnpm vitest run --project workspace -t "config does not survive"` | ❌ Wave 0 |
| WORK-07 | `core.hooksPath` poisoned from inside a worktree does **not** fire during a manager-side git operation | integration | `pnpm vitest run --project workspace -t "poisoned hooksPath"` | ❌ Wave 0 — **the Pitfall 5 test; do not omit** |
| D-02 | `read`/`write` reject `../`, absolute paths, and a sibling-prefix path (`/scratch/feat-1-evil` vs root `/scratch/feat-1`) | unit | `pnpm vitest run --project workspace -t "containment"` | ❌ Wave 0 |
| D-01 | `exec()` emits `LogChunk`s tagged `stdout`/`stderr` in order | integration | `pnpm vitest run --project workspace -t "streams log chunks"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm vitest run --project workspace` (target < 30s; the git-integration tests dominate — reuse one temp repo per file via a `beforeAll` fixture rather than per test)
- **Per wave merge:** `pnpm test && pnpm lint && pnpm typecheck`
- **Phase gate:** full suite green **on Linux CI**, because the WORK-05 privilege-drop test cannot execute on the development machine

### Wave 0 Gaps

- [ ] `packages/workspace/package.json`, `tsconfig.json`, `vitest.config.ts` (`name: 'workspace'`) — new package scaffolding
- [ ] `packages/workspace/test/helpers/temp-repo.ts` — creates a temp git repo + scratch root, mirroring `packages/db/test/helpers/temp-db.ts`
- [ ] `packages/workspace/test/helpers/env-dump-child.cjs` — the child script D-11's test spawns
- [ ] `test/lint/fixtures/spawn-direct-import.ts`, `spawn-require.ts`, `spawn-dynamic-import.ts` — deliberate-violation fixtures; the existing test asserts registered rule ids exactly equal exercised ones (lines 192-204), so these are mandatory, not optional
- [ ] Linux CI job — nothing currently runs the suite on the deployment target, and two acceptance criteria are unverifiable without it

## Security Domain

### Applicable ASVS Categories

Level 1, per `.planning/config.json` (`security_asvs_level: 1`).

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No user authentication surface in this phase |
| V3 Session Management | no | — |
| V4 Access Control | **yes** | OS-level: dedicated unprivileged worker user (WORK-05); `.git/config` owned by the ADL user, not writable by the worker (Pitfall 5, layer 2) |
| V5 Input Validation | **yes** | `RepoRelativePathSchema` (already in `@adl/core/config`) for repo-supplied paths; `path.resolve` + separator-guarded containment for D-02; `argv` arrays only, never shell strings |
| V6 Cryptography | no | No crypto in this phase |
| V7 Error Handling & Logging | **yes** | `LogChunk` streams agent output that may contain secrets the agent itself printed. Phase 15 (WORK-09) owns scanning; this phase must not *add* leakage — notably, never log the constructed child `env` |
| V8 Data Protection | **yes** | D-09/D-10: credentials confined to a single `exec()` call's env; never in the worker's process env, never persisted |
| V12 Files & Resources | **yes** | Scratch HOME via `mkdtemp` (unpredictable, per-run); worktree containment; `--force` teardown |
| V14 Configuration | **yes** | Git and npm config neutralisers; the `GIT_CONFIG_COUNT` injection vector |

### Known Threat Patterns for a self-hosted agent runner on git worktrees

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent writes `core.hooksPath`/`core.fsmonitor` into the shared `.git/config`, executing code during ADL's own `git status`/`push` | Elevation of Privilege | Per-invocation `-c key=` neutralisation on the manager git client (Pattern 7) + `.git/config` not writable by the worker user (D-05 Linux path) + the poisoned-hooksPath test |
| Agent reads a forge token or model key out of its own environment and exfiltrates it in output | Information Disclosure | D-10 zero-inherit env; D-09 per-call allowlist; D-11's real-child-process assertion |
| Agent writes `~/.npmrc` pointing at a hostile registry, poisoning later installs on the host | Tampering | `npm_config_userconfig` into the scratch HOME (verified neutraliser) + D-07's per-run fresh directory |
| Agent path-traverses out of its worktree via `Workspace.write('../../etc/…')` | Tampering | D-02 rejection at the interface; `RepoRelativePathSchema` + resolved-prefix check |
| Agent leaks a detached background process that outlives the run and keeps spending | Denial of Service | `killDescendants: true` + `cancelSignal` + `forceKillAfterDelay` |
| A future contributor adds `spawn()` in a new module, bypassing every control above | Elevation of Privilege | Success criterion 2's lint rule — **which is only real if Pitfalls 1 and 2 are both handled** |
| `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` reaching a child through a widened env allowlist | Elevation of Privilege | Zero-inherit default; explicit comment at the env-builder site forbidding prefix pass-through |
| Symlink inside the worktree pointing outside it, defeating a lexical containment check | Tampering | `fs.realpath` on the resolved parent before the containment test |

## Sources

### Primary (HIGH confidence)

- **Local reproduction on this machine** (git 2.49.0.windows.1, Node v22.23.2, execa 10.0.1, eslint 10.8.1) — worktree add/remove/prune/list semantics; branch survival after remove and prune; `branch -D` refusal while checked out; dirty-removal refusal; `.git`-as-file; shared local config leakage from a linked worktree; `-c` and `GIT_CONFIG_COUNT` override precedence; `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` effect; `npm_config_userconfig` neutralisation; `env: {}` contents on Windows; execa `extendEnv:false` behaviour; execa `iterable()` stream tagging; ESLint flat-config rule replacement across overlapping globs; `no-restricted-imports` blindness to `require()`/dynamic `import()`; `no-restricted-syntax` selector coverage; entry-level `ignores` exemption
- **Repository source read this session** — `packages/core/src/stage/stage.ts`, `packages/core/src/state/feature-state.ts`, `packages/core/src/config/adl-yml.ts`, `packages/core/src/config/path-guard.ts`, `packages/db/src/schema.ts`, `packages/db/src/repository/features.ts`, `packages/plugin-sdk/src/index.ts`, `eslint.config.js`, `test/lint/no-restricted-imports.test.ts`, `vitest.config.ts`, `pnpm-workspace.yaml`, `package.json`
- **npm registry** — `execa` 10.0.1, `simple-git` 3.36.0, `ulid` 3.0.2; `postinstall: null` for all three, via `gsd-tools query package-legitimacy check`
- [Node.js child_process documentation](https://nodejs.org/api/child_process.html) — `uid`/`gid`/`env` option semantics; Windows env case-insensitivity; `undefined` values ignored
- [execa docs/api.md](https://github.com/sindresorhus/execa/blob/main/docs/api.md) and [docs/termination.md](https://github.com/sindresorhus/execa/blob/main/docs/termination.md) — option types and defaults; process-group kill mechanism
- `./.claude/CLAUDE.md` § Technology Stack — the blessed stack and prohibitions

### Secondary (MEDIUM confidence)

- [git-worktree documentation](https://git-scm.com/docs/git-worktree) — porcelain format stability guarantee, `-z` recommendation, `locked`/`prunable` attributes (cross-checked against local reproduction)
- [GHSA-9ccr-r5hg-74gf — Nested Bare Repository Can Execute Arbitrary Commands via core.fsmonitor](https://github.com/github/copilot-cli/security/advisories/GHSA-9ccr-r5hg-74gf) and [justinsteven/advisories — git buried bare repos and fsmonitor abuses](https://github.com/justinsteven/advisories/blob/main/2022_git_buried_bare_repos_and_fsmonitor_various_abuses.md) — the executable-config-key set and git upstream's stated non-fix position
- [sindresorhus/execa issue #366](https://github.com/sindresorhus/execa/issues/366) — `extendEnv: false` binary-resolution divergence from Node's `spawn` (could not be falsified locally because Windows injects PATH)
- [Dynamic Users with systemd](https://0pointer.net/blog/dynamic-users-with-systemd.html) and [systemd.io UIDS-GIDS](https://systemd.io/UIDS-GIDS/) — privilege-assignment framing; informative but not directly applicable given CLAUDE.md's manager-as-supervisor constraint

### Tertiary (LOW confidence)

- CERT C Secure Coding guidance on relinquishing supplementary groups when dropping privileges — surfaced via search summary rather than read directly. The *conclusion* (do not treat `spawn({uid,gid})` as a privilege boundary) is corroborated by Node's own documentation being silent on `setgroups`, so the recommendation stands on two legs.
- [Sonar — Securing Developer Tools: Git Integrations](https://www.sonarsource.com/blog/securing-developer-tools-git-integrations/) — corroborating context for the git-config threat model

## Metadata

**Confidence breakdown:**

- Standard stack: **HIGH** — both new dependencies are named in CLAUDE.md, versions confirmed against the registry, and execa's API was exercised against the installed package rather than read about
- Architecture: **HIGH** on the worktree/exec/registry shape (grounded in Phase 1's actual source, read this session); **MEDIUM** on where GC and the manager git client live (Open Questions 1 and 3)
- Pitfalls: **HIGH** — nine of thirteen were reproduced locally; the remainder are cited to first-party documentation or vendor advisories
- Privilege drop: **MEDIUM** — the negative claim (do not use `spawn({uid,gid})`) is solid; the positive recommendation (`sudo -u`) is an unconfirmed assumption (A1) with an adoption-friction cost the user should weigh
- Validation architecture: **HIGH** on the framework and enrolment mechanics (read from `vitest.config.ts` and the existing per-package configs); **MEDIUM** on the completeness of the test map

**Research date:** 2026-08-18
**Valid until:** 2026-09-17 (30 days — git semantics and the lint mechanics are stable; the execa version is the only fast-moving element, and it is pinned)
