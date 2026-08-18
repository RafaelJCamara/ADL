# Phase 2: Workspace & the Exec Boundary - Context

**Gathered:** 2026-08-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 delivers the **one swappable path every process launch goes through**, including agent CLIs, and bounds the worker's blast radius before any adapter exists to break the rule: the real `Workspace` interface (replacing Phase 1's forward declaration in `@adl/plugin-sdk`), a git-worktree-backed implementation with lifecycle and GC, a second in-repo stub backend proving swappability, the `no-restricted-imports` lint rule banning direct process spawns outside the workspace module, and the OS-user/scratch-HOME/credential isolation that makes the worker's ambient environment safe by construction rather than by convention.

Requirements in scope: **WORK-01 … WORK-07** (7 of 92).

Explicitly *not* in this phase: the manager, the worker's lease/queue logic (Phase 3), the agent backends that will call `Workspace.exec()` (Phase 4), writes-outside-expected-paths detection and secret scanning (Phase 15), and any container/sandbox backend (v2 SCALE-02) — Phase 2 only guarantees the swap is possible.

**Constraint carried in, not re-decided (from ROADMAP.md Notes):** `networkPolicy` and `resources` must be present in the workspace spec from day one with `'full'` as the v1 value, so the future container backend is a drop-in rather than a call-site sweep. This was not discussed as a gray area — it is already locked by the roadmap.

</domain>

<decisions>
## Implementation Decisions

### Workspace Interface Surface

- **D-01:** `Workspace.exec()` streams output via a `log(chunk: LogChunk) => void` sink, reusing the `LogChunk`/`StageContext.log` shape already defined in Phase 1's `Stage` interface — one shape, real-time transcripts for free, and it's what OBS-02 (follow a running agent live) needs. — **Reversibility:** one-way — once `@adl/plugin-sdk` republishes `Workspace` with a real (non-forward-declared) shape, every third-party harness and both built-in backends depend on this signature.

- **D-02:** `Workspace.read()`/`write()` are scoped to the feature's worktree root only — paths outside it are rejected at the interface, not by convention (mirrors D-27's "make the wrong thing unrepresentable" philosophy from Phase 1). The scratch HOME is a separate concern, handled through process env at `exec()` time, not through `Workspace.read/write`. — **Reversibility:** reversible — widening the addressable root later is additive.

- **D-03:** `Workspace.snapshot()` is defined on the interface now (real signature, e.g. returning a restore handle) even though no Phase 2 backend needs concurrent access yet — v2's `group:` parallel syntax and `mutates` (Phase 1, D-27's sibling decision) will need it, and adding a method to a published interface later is the expensive direction. — **Reversibility:** reversible now (it's additive to define it), but *not* defining it would have been a one-way-door omission per D-27's philosophy.

- **D-04:** A second workspace backend registers through a named registry (e.g. `'worktree'`, `'stub'`) resolved once at manager startup from daemon config — mirrors Phase 1's D-23 harness registry (`harness:` ids resolve the same way), so contributors reuse one mental model for pluggability. — **Reversibility:** reversible.

### OS User & Scratch HOME Isolation

- **D-05:** Privilege drop to a dedicated unprivileged OS user is **Linux-only in v1**; on Windows/macOS dev environments the worktree backend runs unsandboxed with a warning banner. Satisfies WORK-05 literally on the daemon's actual deployment target without blocking local development on this Windows machine. — **Reversibility:** reversible — additive per-OS support later.

- **D-06:** The dedicated unprivileged user is **pre-provisioned by install docs** (or a one-time documented `sudo` step in an install script), not created by the daemon at runtime — keeps the long-running manager process from ever needing root-capable permissions itself. — **Reversibility:** reversible.

- **D-07:** The per-run scratch `HOME` is a **fresh temp directory created before each run and deleted on teardown** — no reused/wiped directory, so WORK-07's "does not survive the run" is true because the directory stops existing, not because a wipe step ran correctly. — **Reversibility:** reversible.

- **D-08:** WORK-07's "never affects ADL's own git operations" is enforced **structurally**: ADL's own git operations (branch creation, any commits ADL itself makes) run with their own explicit `GIT_CONFIG_GLOBAL`/`HOME` pointing outside the scratch directory entirely. A leftover `.gitconfig` or hooks-path in the scratch HOME has nothing to reach, rather than relying on cleanup happening before ADL's next git call. — **Reversibility:** costly — this is a security property multiple later phases (5, 9) will build git operations against; loosening it later needs an audit of every manager-side git call site.

### Credential Boundary Mechanism

- **D-09:** Model API keys reach the model subprocess via an **explicit env allowlist passed into that one `exec()` call** — the manager passes `ANTHROPIC_API_KEY` etc. only into the specific spawn that is the agent CLI invocation, never into the worker process's own environment or any other child. — **Reversibility:** reversible.

- **D-10:** `Workspace.exec()` defaults to **zero inherited environment** — every child starts with an explicit, minimal env (the caller supplies `PATH` and whatever else it needs), rather than inheriting the worker process's environment with sensitive vars stripped. Makes WORK-06 ("credentials never enter the worker's ambient environment") true by construction. — **Reversibility:** costly — an allowlist model requires every future caller to remember to pass what it needs; loosening the default later (e.g. to "inherit minus denylist") is a security regression that needs re-auditing every exec() call site added since.

- **D-11:** The success-criterion-5 test **spawns a real child process that dumps its environment** and asserts no forge token or model key pattern appears in the captured output — tests the actual boundary the child process sees, not just the code path that builds the env object. — **Reversibility:** reversible.

- **D-12:** ADL's own git operations that need forge credentials (push, remote calls) run through a **separate manager-owned git client, outside `Workspace.exec()` entirely** — the worker's `Workspace` never has forge-token-bearing exec calls to begin with, so there is no second credential-passing mechanism layered onto the general env-allowlist. — **Reversibility:** costly — Phase 5 (forge push) and Phase 9 (sticky comments, PR operations) build directly on this boundary; merging the two paths later means re-plumbing every manager-side git call.

### Worktree Lifecycle & GC

- **D-13:** Branch naming is **`adl/<feature-id>`**, with the worktree checked out to a dedicated scratch root sibling to the main repo — consistent with Phase 1's D-16 (folder name is the feature id and the branch suffix), predictable, greppable, collision-safe since feature ids are already unique. — **Reversibility:** one-way — public convention once features start running; changing it breaks reconciliation logic (DETECT-05) that matches open PRs back to feature ids.

- **D-14:** Worktree/branch teardown happens **immediately on terminal state** (merged, closed, abandoned) — the worker removes its own worktree and branch as soon as the feature reaches a terminal state, not only during a periodic sweep. Keeps success criterion 1 continuously true rather than only true right after a GC pass. — **Reversibility:** reversible.

- **D-15:** A **periodic backstop sweep plus an explicit manual CLI trigger** both run the GC pass named in success criterion 1 — the sweep catches worktrees orphaned by a crash before immediate teardown could run; the CLI trigger gives the success-criterion test (and the maintainer) a deterministic way to invoke it. — **Reversibility:** reversible.

- **D-16:** GC decides a worktree is a safe-to-remove orphan by **cross-checking it against the DB's feature state** (Phase 1's schema) — list worktrees on disk, look up each by feature id, remove any whose feature is terminal or whose id doesn't exist in the DB at all. Reuses the DB as the single source of truth (EXEC-06) rather than inventing a second signal like filesystem age, which can't distinguish a slow-running feature from an abandoned one. — **Reversibility:** reversible.

### Resolved During Planning (research follow-up, 2026-08-18)

These four resolve the open questions raised by `02-RESEARCH.md`. The user selected the researcher's recommendation in all four.

- **D-17:** The manager-owned git client of D-12 **runs through its own distinct `Workspace` instance** — a host-rooted backend carrying ADL's own env and forge credentials — rather than earning a second lint exemption. Keeps success criterion 2 literally true with exactly one exemption (`packages/workspace`), preserves D-12's substance (the *worker's* Workspace still never carries a forge token), and applies the config-poisoning neutralisation of D-19 by construction. Costs one extra registry entry. — **Reversibility:** costly — this is the shape Phase 5 (forge push) and Phase 9 (PR operations) build their git call sites against.

- **D-18:** Linux privilege drop uses **`sudo -u` as the default launcher, with `setpriv --init-groups` documented as an alternative**; both gated on `os.platform() === 'linux'`, and absence of the launcher degrades to D-05's warning banner rather than a hard failure. Node's `spawn({uid, gid})` is *not* usable — it requires the caller to already be root (contradicting D-06) and does not drop supplementary groups. The install story therefore gains a NOPASSWD sudoers entry the adopting team must accept; this must be documented, not silent. — **Reversibility:** reversible — the launcher is behind one seam.

- **D-19:** WORK-07's config-poisoning defence needs a **third control beyond D-08's `HOME`/`GIT_CONFIG_GLOBAL`**: per-invocation `-c key=value` neutralisation on the manager git client. Linked worktrees share the main repo's `.git/config`, so `git config core.hooksPath …` run from inside a worktree writes the *main* repo's local config, which `HOME`/`GIT_CONFIG_GLOBAL` do not cover (verified locally; git upstream will not make local-config directives safe). Both `-c` and `GIT_CONFIG_COUNT` were verified to override a poisoned value. — **Reversibility:** costly — same audit surface as D-08.

- **D-20:** GC **splits mechanism from policy**. `packages/workspace` exposes `listManagedWorktrees()` and `destroy()` and takes no `@adl/db` dependency; the manager owns the sweep that joins that inventory against `featuresRepository` to apply D-16's terminal-state policy. Keeps the swappable backend database-free (D-04) and puts the DB dependency where EXEC-01 already puts it. — **Reversibility:** reversible.

- **D-21:** A **Linux CI job is Wave 0 scaffolding for this phase**, not a follow-up. Two acceptance criteria (WORK-05 privilege drop, and the OS-user half of success criterion 4) cannot execute on the Windows development machine. Linux-only tests must **skip with a visible reason** on other platforms rather than passing vacuously, and the phase cannot be called done until they have run green on Linux. — **Reversibility:** reversible.

### Claude's Discretion

The user selected the recommended option in all sixteen questions; nothing was explicitly delegated beyond what's noted above. Left to the researcher and planner:

- Exact `LogChunk` buffering/backpressure behavior when a consumer is slow to read the stream.
- ~~The precise mechanism for Linux privilege drop (setuid-root helper binary vs `sudo -u` vs `su`)~~ — **now decided by D-18** (`sudo -u` default, `setpriv` documented alternative).
- Scratch root directory location/naming convention (e.g. under a configured temp root vs alongside worktrees).
- Exact shape of the `snapshot()` restore handle from D-03, beyond "it exists on the interface."
- Registry key naming conventions beyond `'worktree'`/`'stub'` examples from D-04.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition and requirements
- `.planning/ROADMAP.md` § "Phase 2: Workspace & the Exec Boundary" — goal, the five success criteria, and the Notes paragraph mandating `networkPolicy`/`resources` in the workspace spec from day one with `'full'` as the v1 value
- `.planning/REQUIREMENTS.md` § Workspace & Trust Boundary — WORK-01…WORK-07 (WORK-08…WORK-10 belong to Phase 15, not this phase)
- `.planning/PROJECT.md` § Constraints — self-hosted deployment, human-approval-mandatory framing that underlies why the worker's blast radius must be bounded before any adapter exists

### Phase 1 contracts this phase must satisfy
- `packages/plugin-sdk/src/index.ts` — the `Workspace` forward declaration re-exported from `@adl/core/stage`; Phase 2 replaces it wholesale, and the replacement becomes what every third-party harness and Phase 4's agent backends depend on
- `packages/core/src/stage/stage.ts` — `StageContext.workspace`, `LogChunk`, and the `mutates` flag on `Stage` (the `Workspace.snapshot()` hook per D-03 exists to eventually support this)
- `.planning/phases/01-core-contracts/01-CONTEXT.md` § D-20…D-23 — `ready` probes and `ADL_PORT` interpolation already route through `workspace.exec` per WORK-02; `EffectiveConfig` clamps and the untrusted-`adl.yml` trust boundary this phase's isolation work protects
- `.planning/phases/01-core-contracts/01-CONTEXT.md` § D-27 — the `no-restricted-imports` dependency-graph lint mechanism already exists in `eslint.config.js`; Phase 2's no-direct-spawn rule slots into it
- `.planning/phases/01-core-contracts/01-CONTEXT.md` § Deferred — "the `mutates` flag and `Workspace.snapshot()` that unlock [`group:` parallel stages] belong to Phase 2"
- `eslint.config.js` lines ~17-18, ~64-152 — the existing `no-restricted-imports` config block and its rationale table, the mechanism Phase 2's spawn-boundary rule extends

### Failure modes this phase is designed against
- `.planning/REQUIREMENTS.md` § Out of Scope — container/sandbox backend is v2 (SCALE-02); this phase only guarantees the *swap* is possible via D-04's registry, not that a container backend ships now

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/core/src/stage/stage.ts` — `LogChunk` type and the `StageContext.log` sink pattern (D-01 reuses this exact shape for `Workspace.exec()`)
- `eslint.config.js` — the `no-restricted-imports` rule block (D-27, Phase 1) is the mechanism the no-direct-spawn rule extends rather than a new lint mechanism
- `packages/db/src/repository/*.ts` — the repository-layer pattern already established for `@adl/db`; GC's DB cross-check (D-16) should follow the same read pattern rather than raw queries

### Established Patterns
- Config-driven registry resolution: `adl.yml`'s `harness:` id resolves through a registry (built-in id → npm package → repo-relative path, Phase 1 D-23). D-04's workspace-backend registry follows the same shape.
- Forward-declared types replaced wholesale by the phase that owns them (`packages/plugin-sdk/src/index.ts` comments name Phase 2 explicitly for `Workspace`).

### Integration Points
- `packages/plugin-sdk/src/index.ts` re-exports `Workspace`, `StageContext`, etc. from `@adl/core/stage` — the real `Workspace` interface replaces the forward declaration there; no new export path needed.
- Phase 3 (`@adl/db` gets its first real writer) will read GC's orphan-detection queries against the same feature-state schema.
- Phase 4 (agent backends) is the first real consumer of `Workspace.exec()`'s env-allowlist and streaming behavior (D-01, D-09, D-10).
- Phase 5 and Phase 9 build forge-credentialed git operations on top of D-12's manager-side-git-client boundary.

</code_context>

<specifics>
## Specific Ideas

A consistent thread across all four areas: **the security-relevant defaults are structural, not procedural.** Zero-inherited-env by default (D-10), read/write rejected outside the worktree at the interface (D-02), ADL's own git ops never reading the worker's scratch HOME (D-08), and manager-side git calls kept entirely off the worker's exec path (D-12) — every one of these makes the unsafe thing impossible to reach rather than something to remember not to do, continuing the Phase 1 pattern of pushing enforcement into the type/interface layer.

The other recurring theme: **reuse Phase 1's mechanisms instead of inventing parallel ones.** The backend registry mirrors the harness registry (D-04/D-23), the lint rule extends the existing `no-restricted-imports` block rather than adding a second lint mechanism (D-27), and GC's source of truth is the DB schema Phase 1 already defined (D-16/EXEC-06) rather than a filesystem heuristic.

</specifics>

<deferred>
## Deferred Ideas

No scope creep occurred — discussion stayed inside the phase boundary throughout.

- **Container/sandbox workspace backend** — explicitly v2 (SCALE-02, REQUIREMENTS.md). Phase 2 only guarantees the swap is possible via the registry (D-04) and the `networkPolicy`/`resources` placeholder fields carried in from the roadmap notes.
- **Windows/macOS OS-user isolation** — D-05 defers real privilege-drop support on non-Linux dev environments; only a warning banner ships in v1.
- **Credential broker / short-lived tokens** — considered and passed over in favor of the simpler env-allowlist (D-09) for v1; would be the next step up if the env-allowlist model proves insufficient.
- **`group:` parallel pipeline stages** — still v2 per Phase 1's deferred list; D-03 only defines `snapshot()`'s signature now so the interface doesn't need to break later.

</deferred>

---

*Phase: 2-Workspace & the Exec Boundary*
*Context gathered: 2026-08-17*
