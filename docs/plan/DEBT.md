# Known Debt, Deferred Items & Accepted Risks

Everything discovered and not fixed. **Deferred is not done** — nothing here has been
silently absorbed into a completed milestone.

Full reasoning, reproductions and the original acceptance decisions are preserved in
[`.planning/`](../../.planning/ARCHIVED.md); the identifiers below (`D-2-R-1`, `WR-03`, …)
are greppable there.

**Legend** — 🔴 must be resolved before v1 ships · 🟠 real risk, accepted for v1 with
revisit triggers · 🟡 rough edge, no correctness impact · ⚪ deliberate non-goal that looks
like debt

---

## 1 · The end-of-project verification pass 🔴

**A maintainer decision from 2026-08-21.** A live API key plus an unshadowed pinned CLI is
an *environment precondition*, not project work. Gating each milestone on it stalls the
roadmap on setup while finished code sits on `main`. So every credential-bound test batches
into **one** end-of-project pass — which also buys a single honest reconciliation against
real billed usage instead of many partial ones.

**This list is that pass.** It must run before v1 ships.

| # | Item | Needs | Surfaced in |
|---|------|-------|-------------|
| 1.1 | One real `adl dev-run` + `adl logs -f` end to end: transcript scrolls live (not all at once), `logs -f` exits on its own, the commit is authored `ADL (claude-code) <…>` and never the operator's identity | `ANTHROPIC_API_KEY` + `@anthropic-ai/claude-code@2.1.237` unshadowed on PATH | M04 |
| 1.2 | Reconcile the recorded `usage_events` row against the Anthropic Console's billed usage for the same window — `cost_source: 'reported'`, plausible cost | same | M04 |
| 1.3 | Capture real CLI transcript fixtures into `packages/agent-claude-code/test/fixtures/` (does not exist on disk) | same | M04 |
| 1.4 | Exercise `claudeVersionCheckRunner` against the real pinned binary | same, plus fixing PATH shadowing | M04 |
| 1.5 | Run the D-2-08-1 privilege-drop reproduction (positive + negative control) | **a Linux host** — independent of the credential gap | M02 → M04 |
| 1.6 | Run the D-2-R-1 cross-feature isolation reproduction | **a Linux host** | M02 |
| 1.7 | One real draft change request opened on a real GitHub repo through a real installed GitHub App: `adl+forge-github`'s `openChangeRequest` exercised against `api.github.com`, not the local mock server the automated tracer uses | a GitHub App created and installed by the maintainer, its App ID + private key + installation id | M05 |

**Why 1.1–1.4 are all one run.** No session across the whole of M04 ever invoked the real,
pinned CLI against a real credential. The dev machine is Windows, has no key configured,
and its `claude` on PATH resolves to a WinGet-installed `2.1.227` that shadows the
correctly npm-installed `2.1.237`. Every gap traces to that one missing precondition — each
was hit, recorded honestly, and left open rather than faked, across five separate plans.

**Consequences while it stays open:** `translateLine` is built against *documented* shapes
only; the auth-failure classifier is a best-effort keyword match with no fixture; and
`usage.ts`'s field names and nesting rest on an unverified assumption. Those are the three
most likely failure points when 1.1 finally runs.

> **M06 is blocked on 1.2.** Cross-backend usage reporting reliability is unverified, and
> budget enforcement is a hard gate built on it. Best moment to close it: **during M05**,
> when a real agent turn happens in anger for the first time.

---

## 2 · Accepted security residuals 🟠

Real risks, knowingly accepted for v1, each with named revisit triggers. **An accepted
residual whose justification is absent is an *un*accepted residual** — that is why these
carry their reasoning rather than a one-line status.

### D-2-R-1 — features are not isolated from each other 🟠 **highest severity open item**

ADL runs **one trust domain per daemon.** Every concurrent feature's agent runs as the same
uid in the same group, so feature A's agent can rewrite feature B's source *after B's
reviewer stage passed and before its PR opens* — a supply-chain path from an untrusted
feature spec into a human-approved PR.

Group and mode bits cannot fix this: **they cannot separate two processes sharing a uid.**
The real fix is a pool of distinct uids leased per feature, with lease state owned by the
manager and one sudoers entry per pool member — which changes the install story an adopting
team has to sign off on.

- **Accepted** at the M02 UAT gate, 2026-08-19, so v1 can ship. Not closed, not withdrawn.
- **Bounded by:** human approval is mandatory before merge, so a cross-feature tamper still
  faces a human reading the PR. The README says plainly that concurrent features share one
  identity.
- **Revisit when *any* of these is true:** (1) concurrency > 1 on a shared or multi-tenant
  host; (2) the human approval gate before merge is relaxed or automated; (3) before any
  public or multi-tenant deployment is advertised; (4) manager-owned lease state makes a
  uid pool buildable — which it now is.
- **Still outstanding:** the reproduction is **argued from the code, never run** (item 1.6
  above). Until it runs, the acceptance rests on a *reasoned* rather than a *demonstrated*
  severity — a lower standard than M02 applied to everything else, and precisely the gap
  that produced three separate CI surprises during that milestone.

### D-2-R-4 — an attacker-named git filter still executes during ADL's own `snapshot()` 🟠

`NEUTRALISED_CONFIG` neutralises eight executable keys by name. `filter.<driver>.clean` /
`.smudge` and `diff.<driver>.textconv` / `.command` **cannot** be neutralised that way,
because `<driver>` is chosen by whoever writes the `.gitattributes`. A committed
`.gitattributes` selects the driver and git invokes it.

**This one is demonstrated, not argued.** `packages/workspace/test/git/neutralisation-residual-risk.test.ts`
executes a chosen program during ADL's own `snapshot()` **with full neutralisation in
force**, with a `git check-attr` control so it cannot pass vacuously.

- **Accepted** at the M02 UAT gate, 2026-08-19. **Owner: M15.**
- **Bounded by:** `git status` doesn't reach the filter; `git stash create` does, and that
  is what `snapshot()` runs. Exploiting it requires a committed `.gitattributes` — the same
  trust boundary the feature spec already sits on. The six other fixed-name keys
  (`core.askPass`, `gpg.program`, `sequence.editor`, `core.alternateRefsCommand`,
  `gpg.ssh.program`, `uploadpack.packObjectsHook`) are unreachable through any operation
  ADL ships today.
- ⚠️ **M15 must gain an explicit criterion for this** — its stated criteria cover write
  auditing, secret scanning and egress and say *nothing* about config neutralisation.
  Without that criterion this residual lands in a milestone with no acceptance point and
  becomes invisible. **Already added as criterion 5 of
  [`m15`](./milestones/m15-security-hardening.md).**
- **If that test ever goes green,** the hole closed by accident — update this entry rather
  than deleting the test. If the test is ever weakened or deleted, this acceptance silently
  stops being observable.
- **Revisit earlier than M15 if:** `ManagerGitClient` gains an operation reaching one of
  the six fixed-name keys; ADL runs `snapshot()` against a repository it does not control;
  or the `.gitattributes` path becomes reachable without a commit.

### D-2-R-3 — `assertWithinRoot` is check-then-use (TOCTOU) 🟠

The guard realpaths and returns a path; the caller then opens it. Two syscalls with a gap.
An agent running inside its own worktree can replace a path component with a symlink in
that gap. `paths.ts`'s docblock presents the realpath walk as *the* answer to this and does
not say it cannot cover a symlink planted **after** the check — which is the misleading
part: a reader budgeting trust from that paragraph over-trusts it.

- **Live as of M05 step 5.17, and this is the instance the entry was waiting for.** 5.16
  looked and reported *not this one* — its diff reads git's object database through
  `ManagerGitClient`, never a worktree path through `assertWithinRoot`. 5.17 is different:
  gate-context assembly (`packages/manager/src/worker-entry/spec-from-worktree.ts`, called
  by `worker-entry/gate-context.ts`) reads a feature's spec **out of a worktree the
  developer's agent has already written to**. That is the first read in this project to
  happen after an agent has had write access to the directory being walked, which is the
  precondition this entry names.
- **Accepted, not closed**, and the entry's own stated deliverable for that case is done:
  `packages/workspace/src/paths.ts`'s module docblock now carries a *"what rejection 4 does
  NOT cover"* section saying in as many words that the realpath walk is check-then-use and
  cannot see a symlink planted after the check. The misleading paragraph was the actual
  harm — a reader budgeting trust from the four-rejection list over-trusted it.
- **What bounds it now.** The attack needs an *uncommitted* working-tree swap: ROLE-11's
  protected-path check (5.16) hard-fails any round whose commit touches the spec folder, and
  it fires in the manager before the gate is ever dispatched. The payoff is also small —
  the reader is a spec loader, and a substituted spec buys a gate judging against the wrong
  acceptance criteria rather than code execution or a path escape.
- **Proposed fix, unchanged:** `open()` then `fstat` the handle and compare `dev`/`ino`
  against the blessed path — one extra syscall, converts "attacker wins silently" into
  "attacker is detected". Add `O_NOFOLLOW` on the leaf where the platform supports it
  (Windows has no equivalent, so it can't be the only measure). **Owner: M15** — the real
  fix changes `Workspace.read`'s implementation across both backends and is security
  hardening, not gate work.

### D-2-07-1 — cancellation under the privilege drop signals a process ADL doesn't own 🟠

With the drop active, execa's direct child is `sudo` — a setuid-root process. So
`cancelSignal`'s `SIGTERM`, `forceKillAfterDelay`'s `SIGKILL`, and `killDescendants` all
address a process the daemon user cannot signal. On the undropped path (every platform the
maintainer can test on) cancellation works as verified. On the Linux deployment target,
where the drop is the whole point, it may not.

- **Measure before fixing:** run a long child under the drop, abort, observe whether the
  descendant survives. The answer may already be "no" via POSIX process-group behaviour, in
  which case this closes with a test rather than a change.
- The candidate fixes (a dedicated process group, a second `sudo` to deliver the kill, or
  `setpriv`) each change the sudoers entry the README documents — the thing an adopting
  team signs off on. Not a flag.
- **Owner:** whichever milestone owns cancellation end to end. Budget interrupt is **M06**.

### D-2-R-2 — the two privilege decisions are never reconciled 🟡

Privilege mode is decided twice against two different PATHs, deliberately and correctly.
What's missing is what happens when the answers **differ**: creation says `dropped` so the
worktree is widened to the shared group, but a later `exec` runs as the daemon, leaving
those directories group-writable with no beneficiary.

`privilegeModeMismatch(creation, runtime)` **is shipped and tested — nothing calls it.**
Two call sites need two lines. Belongs with whichever plan next touches `run()`'s signature.

### D-5-R-1 — `ManagerGitClient.push`'s remote URL is an argv element, visible via `ps` 🟠

`push(remoteUrl, refspec)` (`packages/workspace/src/git/manager-git.ts`, M05) has no
credential parameter by design — `credential.helper` is neutralised to empty on every
invocation, so the one git-native mechanism left for an authenticated HTTPS push is a
`remoteUrl` carrying its own `https://<user>:<token>@host/...`. That URL is a plain argv
element passed to the real `git` child, which means the short-lived forge token is visible
to another process on the same host reading `/proc/<pid>/cmdline` (or `ps`) for the
(typically sub-second) duration of the push.

- **Live as of M05 step 5.10.** `worker-entry/stage-runner.ts` calls `ManagerGitClient.push`
  with `assign.pushUrl` — a real, credentialed URL the manager mints per dispatch
  (`scheduler/dispatcher.ts`'s `DispatcherDeps.forge.pushCredential`, wired from
  `boot/cli-entry.ts`'s `buildForgeOption` whenever `repos[0].github_app` is configured) —
  whenever a real developer stage commits. Proven live end to end by
  `test/tracer/draft-cr-wiring.test.ts`. Not yet exploitable *in this project's own CI or the
  maintainer's own install*, since no live GitHub App credentials are configured
  (`DEBT.md` item 1.7) — but the code path itself is real, shipped, and unconditional
  whenever an operator does configure one.
- **No mitigation attempted this step** — 5.10's own scope, confirmed with the maintainer
  before implementation, was the draft-CR-at-round-1 wiring itself; the residual below is
  accepted exactly as already documented, not re-litigated.
- **Candidate mitigations, still not evaluated:** a custom `credential.helper` appended via
  `-c` *after* `NEUTRALISE_ARGS` reading the token from a caller-supplied env var outside
  the `GIT_*` execution-vector ban (`packages/workspace/src/exec/env.ts`'s
  `GIT_EXECUTION_ENV_PREFIXES` blocks `GIT_CONFIG_*`/`GIT_ASKPASS` outright, so this needs a
  non-`GIT_`-prefixed variable name and a helper script written into ADL's own git home);
  or simply accepting the argv-visibility window as bounded by the token's own short TTL
  (GitHub installation tokens expire in ~1 hour) and the same-host trust boundary the
  manager already operates inside.
- **Owner:** unassigned — a real mitigation, if one is wanted, is a fresh milestone decision
  now that the residual is live rather than hypothetical.

---

## 3 · Open code-review findings

None exploitable, none blocking a success criterion — per the reviews' own severity
classification.

| ID | Where | What | Sev |
|----|-------|------|-----|
| **WR-01** (M04) | stage runner | The 10-minute wall-clock timeout is a hardcoded placeholder, not wired to `effectiveConfig` — risks misclassifying a legitimate long agent run as a timeout | 🟡 |
| ~~**WR-02**~~ (M04) | `loadSpecFromWorktree` | **Closed by M05 step 5.17.** The item was: the spec load built a path with plain `join()` and **no containment check**, which M04 filed as "unreachable with untrusted input today, but inconsistent with the containment discipline used at every other path site". 5.17 is where it stopped being unreachable — gate-context assembly reads the spec *after* the developer's agent has written to that worktree, where M04's caller read it before. Now one shared module (`packages/manager/src/worker-entry/spec-from-worktree.ts`, used by both the developer stage and the gate) resolves the feature directory through `resolveWithinRoot` and reads the entry file through **`Workspace.read`**, which applies `assertWithinRoot` — so the content read goes through the port's own guard rather than around it. What that does *not* close is the check-then-use race inside that guard: see **D-2-R-3** above, which 5.17 makes live and accepts | ✅ |
| **WR-03** (M04) | `agent-claude-code/src/backend.ts` | The rendered prompt is a trailing positional argument with **no `--` end-of-options separator** — safe today only because the template can never start with `-` | 🟡 |
| **IN-01/02/03** (M04) | various | A same-name/different-type placeholder field on `stage_result`, an unused `AgentTask.contextFiles`, an ENOENT fallback branch untested on any platform | 🟡 |
| — | `stage-runner.ts` | The retry attempt ordinal is **hardcoded to `1`** for both the transcript address and the prompt-artifact address; the real ordinal from `openAttempt` never reaches the wire | 🟡 |
| — | `POST /dev-run/:featureId` | Assumes a single configured repository (`reposRepo.list()[0]`) and refuses (409) a feature no longer `queued` — **re-running one feature is impossible until M05's loop runner requeues it** | 🟡 |
| **IN-01/02** (M03) | `meta.ts`, `daemon.ts` | Duplicated discriminated get/set pattern; an incomplete boot-order comment | 🟡 |
| ~~**D-5-13-1**~~ (M05) | `worker-entry/stage-runner.ts`, `workspace/worktree/lifecycle.ts` | **Closed by M05 step 5.14.** The item was: a workspace did not survive the stage that created it, so a gate would have judged a tree with none of the developer's work in it — `createProductionStageRunner` called `workspace.destroy()` in its `finally` (reclaiming the worktree *and* deleting the `adl/*` branch) while `createWorktree` deliberately **refuses** to attach to an existing one (WORK-04). **Fixed as the two symmetric pairs the port was missing:** `WorkspaceBackend.attach(spec) → Workspace \| undefined` (the method `.planning/research/ARCHITECTURE.md` §1 has named since before M01 and that was never built) and `Workspace.detach()`. A stage now `attach(spec) ?? create(spec)` and ends with `detach()` — reclaiming the scratch `HOME`, keeping the worktree — and no stage calls `destroy()` at all; reclaiming the workspace is the GC sweep's decision, made from feature state (D-16). **One correction to this entry's own text:** it said the fix widens a one-way port because "`WorkspaceBackend` is republished through `@adl/plugin-sdk`". It is not — `packages/plugin-sdk/src/index.ts` exports `Workspace`, `ExecSpec`, `ExecResult`, `RestoreHandle`, `NetworkPolicy` and `ResourceLimits`, and no `WorkspaceBackend`/`WorkspaceSpec`/`ManagedWorkspace`. So `attach` was free and **`detach` is the one-way half**; it was added before `@adl/plugin-sdk` ships (M18) for D-27's reason, with the maintainer's decision recorded in the milestone file. Watched failing against the exact defect first, twice: reverting `detach()` to `destroy()` turned the gate's own case red with `expected 'send_back' to be 'pass'` (a gate judging a `baseRef` tree), and making `detach()` destroy the worktree turned three workspace-contract cases red on both backends | ✅ |
| **D-5-14-1** (M05) | `workspace/worktree/gc.ts`, `@adl/core/state` | **A finished feature's worktree is never collected in v1.** `sweepOrphans` reclaims a worktree when its feature's state is in `TERMINAL_STATES` — which is `['merged', 'abandoned']` — or unknown. Nothing in v1 ever produces `merged`: **ADL never merges** (FORGE-10, and 5.12 made that a build property), and no webhook watches for a human doing it until M10. `abandoned` needs an explicit `adl kill`. So a feature that runs to `publishing`/`pr_open` keeps its worktree, its `adl/*` branch, and its share of the object store **forever**. This was invisible before 5.14 because the stage runner destroyed the worktree at the end of every stage — the behaviour that was itself D-5-13-1. **Reproduced:** `test/scenario/command-gate-loop.test.ts` runs a feature to `publishing` and its worktree is still on disk at the end (the test's own temp-repo cleanup is what removes it, which is also why `withTempRepo` needed `rm`'s `maxRetries` for Windows `EBUSY` in this step). **Proposed shape:** either a merge-detection path that moves a feature to `merged` (M10's webhook is the natural source, `listOpenChangeRequests` a polling fallback), or an explicit "the loop is done with this workspace" reclamation at `pr_open` — noting that a human retry out of `escalated` legitimately needs the worktree, so `escalated` must keep surviving. **Not urgent for a single-feature install; it is `.planning/research/ARCHITECTURE.md`'s own Leak #7** ("256 worktrees, 28 GB, 700+ stale branches") arriving by a different route. **Owner: M09**, which owns the pull request as a product and therefore its end of life | 🟠 |
| **D-5-14-2** (M05) | `worker-supervisor/supervisor.ts` | **A worker that reported a fence-matched `stage_result` is still logged as "exited without an accepted result".** Every round-loop run emits `forked worker exited without an accepted result — applying the fast-path lease_expired recovery` at `warn`, *immediately after* the round loop has logged `round loop: stage completed` for that same worker. The loop reaches the correct state regardless, so this is noise rather than a correctness defect today — but it is noise on the exact log line an operator would use to spot a real lost worker, and it fires the fast-path recovery against a feature the round loop has already advanced and unleased. **Reproduced** in both `test/scenario/round-loop.test.ts` (5.13's, which this step did not modify) and `test/scenario/command-gate-loop.test.ts`; **it predates 5.14** — 5.13's scenario uses a worker double that builds no workspace at all, so nothing in the attach/detach change can reach it. **Unreproduced detail:** it fires for some workers and not others within one run, which has not been characterised. **Proposed shape:** work out why `expectingExit` is not observed on this path (it is marked synchronously when the result is accepted) and either fix the marking or stop routing an expected exit through recovery. **Owner: M06**, where the crash counter this path increments becomes load-bearing for budget escalation | 🟡 |
| **D-5-13-2** (M05) | `bookkeeping/attempt.ts`, `scheduler/dispatcher.ts` | **`features.round` and `rounds.number` count the same thing from different starting points.** `openAttempt` numbers rounds 1-based; `features.round` starts at 0 and is only ever moved by `transition()`'s `send_back` edge, so a feature in its first round has `features.round = 0` and `rounds.number = 1`. Nothing is wrong today — `transition()`'s ceiling check (`round + 1 > maxRounds`) is self-consistent, and the sticky comment renders `rounds.number` — but the two are silently one apart and a future reader joining them will get it wrong. **Reproduced** in `test/scenario/round-loop.test.ts` (the send-back case asserts `rounds.number` 1 and 2 alongside `features.round` 1). **Proposed shape:** derive one from the other, or rename `features.round` to `features.rounds_consumed`, which is what it actually counts. **Owner: M06**, which is where the round ceiling becomes load-bearing | 🟡 |
| **D-5-18-1** (M05) | `worker-entry/stage-runner.ts`, `worker-entry/gates/` | **A second agent-invoking role would have to remember to report its spend.** BACK-09 is satisfied for every role that exists today — the developer reports, and the command gate honestly reports nothing because it runs no agent — but the reporting is *one call to `sendUsage` on the developer branch*, not a property of the code path. M07's reviewer is an agent-backed **gate**, and the gate branch returns its verdict without passing anything that could carry a usage record: `GateContext` has no member to report through (5.17's `GATE_CONTEXT_MEMBERS` locks that, correctly — it is a fresh-context guarantee, not an oversight), so the reviewer's spend has to be observed by the stage runner, one level above the role. That is buildable today and was deliberately not built: it needs a producer to shape it against, and inventing one now is the speculative generality D-01 exists to avoid. **Not a hole in v1** — nothing in this build invokes an agent from a gate, and `test/scenario/command-gate-loop.test.ts` asserts zero usage rows against gate attempts, so the day that changes the assertion goes red rather than the ledger going quiet. **Proposed shape:** the stage runner already pipes every gate `AgentEvent` through `GateContext.onEvent` to the transcript; observing a terminal `result` event there and calling the same `sendUsage` — reusing `@adl/agent-claude-code`'s `usageFromResult`, which operates on neutral `AgentEvent`s — makes reporting a property of the *stage runner* rather than of each role. **Owner: M07**, the milestone that first invokes an agent from a gate | 🟡 |
| ~~**D-5-11-1**~~ (M05) | `publish/role-rounds.ts` | **Closed by M05 step 5.14.** Partly closed by 5.13 first, whose finding was that this item's own premise was wrong: it said writing a real `RoundOutcome` into `rounds.outcome_json` would stop a prior round losing its commit sha, and `RoundOutcome` has no field for a commit, so it never could have. 5.13 gave a finished round its real result (`send_back — 3 findings` rather than a bare kind); 5.14 gave it the sha, as `rounds.head_sha` (`0005_rounds_head_sha.ts`). Written by the round loop when a developer stage reports `committed` — **not** at round close, because a developer stage in any pipeline with a gate in it `advance`s rather than completing — and read by `readRoleRounds` for every round the publishing event does not address. `RoundNote` now carries the raw sha rather than pre-rendered text so the event and the column go through one formatter. The `not.toContain('Committed \`1111111\`.')` assertion 5.11 left in `test/publish/sticky-comment.test.ts` to force this is **inverted, not deleted**, and the fix was watched failing first: dropping the column read reproduced `expected '- Attempt 1 — completed' to contain 'Committed \`1111111\`.'`. **The second consumer named here — "a gate needs the diff between the base and exactly that commit" — is not yet a caller:** the command gate runs *inside* the attached worktree, where `HEAD` already is that commit, so it needs no diff. ROLE-11's protected-path diffing (M05 step 5.16) is the first real reader | ✅ |

---

## 4 · Coverage and tooling gaps

| Item | Detail | Sev |
|------|--------|-----|
| **The spawn ban covers TypeScript spellings only** | `adl/no-direct-spawn` derives its globs from `['ts','tsx','mts','cts']`. **A `.mjs` or `.js` file outside `packages/workspace` importing `execa` lints clean** — demonstrated at commit `84d1d16`. The repo is all-TypeScript today, so nothing exploits it; it is a hole in a load-bearing guard | 🟠 |
| **`packages/workspace`'s test suite is never typechecked** | ~2,900 lines. `tsc --noEmit --listFiles \| grep -c test/` → 0. Type-level regressions in that suite are invisible | 🟡 |
| **Windows branches of M02's security code are unverified** | The privilege-drop CI provisioning is Linux-only, so every platform-conditional branch in that code is untested on Windows | 🟡 |
| **`D-2-03-1`** | `run()` cannot distinguish a missing binary from a non-zero exit — on Windows both surface as `exitCode: 1, code: undefined` via `cross-spawn`/`cmd.exe` | 🟡 |
| **`D-2-06-1`** | A leaked `refs/adl-snapshots/*` ref is invisible to `sweepOrphans` (no worktree inventory entry remains) and keeps the stash commit **reachable**, so `git gc` never collects the objects either. Reproduced | 🟡 |
| **Fingerprint normalisation strength is unproven** | The pair corpus pins today's behaviour, but *whether two differently-worded findings are the same finding* is an open question. **M06's stalemate detection is the first place this gets real evidence** — and the first place getting it wrong is expensive | 🟡 |
| **`version: 1` "additive keys only"** | A promise about future releases. No test can confirm it | 🟡 |
| **`simple-git@3.36.0` is still a runtime dependency** | `packages/workspace/src` no longer uses it | 🟡 |
| **`.pre-*` database copies accumulate without bound** | Pre-migration backups beside the database file; no pruning tool. Documented as an operator responsibility | 🟡 |
| **`adl status` prints a raw stack trace** | When `.adl/daemon.json` has *never* been created. ("Daemon down, config exists" is handled correctly.) Found during M03 UAT, ruled out of scope | 🟡 |
| **Two `pnpm format` failures were logged to a file that doesn't exist** | M03 plan 10 recorded them in a phase-03 `deferred-items.md` that was never written. Re-check `packages/cli/src/render/status-table.ts` and `packages/manager/src/scheduler/dispatcher.ts` | 🟡 |
| **`pnpm format` is red on `main`, so CI's Format step is failing** | Found during M05 step 5.12. **Reproduction:** on a clean tree at `f9f0816`, `npx prettier --check docs/plan/milestones/m06-accountant.md` — a file no recent commit touched — reports `[warn]`. `pnpm format` reports **23 files, every one of them under `docs/`**: all 18 milestone files plus `DEBT.md`, `DECISIONS.md`, `README.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATUS.md`. `.github/workflows/ci.yml:92` runs `pnpm format` as a CI step, so this leg is red for reasons unrelated to any code change. **Cause:** `.prettierignore` excludes `.planning/`, `.claude/` and `.gsd/` with the stated reasoning *"Prose owned by the GSD workflow, not project source — Prettier would reflow tables and wrap lines that are laid out deliberately"* — and `docs/plan/` is exactly that same kind of prose (hard-wrapped at ~95 columns, hand-laid-out tables) but was never added to the list when it was created. **Two defensible shapes, and it is a maintainer call rather than a cleanup:** (a) add `docs/plan/` to `.prettierignore`, one line, the reasoning already written in that file applying verbatim — but `docs/plan/` is the *live* plan rather than an archived corpus, so the analogy is not airtight; or (b) let Prettier reformat all 23, accepting one large whitespace-only commit that reflows deliberate wrapping and every table. **Not chosen here:** 5.12 formatted only the one file it touched (`test/lint/no-restricted-imports.test.ts`), and a formatting-only change belongs in its own `style` commit anyway (house convention 20). **Owner: unassigned — needs the maintainer to pick (a) or (b)** | 🟠 |
| **`daemon.ts`'s two "never throws" supervisor callbacks have no automated regression test** | `recordUsage` (hardened in M05 step 5.18) and `closeAttempt` (hardened in 5.16) both fire from the supervisor's floating `void (async () => …)()` message task, so a rejection from either is an **unhandled rejection that takes the manager down**. Both are wrapped in `try`/`catch` + `logger.error`; neither has a test that would notice the wrapper being deleted. **Both were watched failing by hand** — 5.18's by injecting `await Promise.reject(...)` above the `try` and running `test/usage/recording.test.ts`, which reported `Unhandled Rejection: simulated ledger write failure` verbatim, then moving the same line inside the `try` and observing `recordUsage: failed to write the spend event — this invocation is missing from the ledger` at `error` with the daemon still running. **Why no permanent test:** `startDaemon` has no seam for making a single repository write fail — the database is constructed from `dbFilePath` internally — and the only naturally-occurring failure (the connection closing during shutdown) is a race a test cannot schedule. **Proposed shape:** a `StartDaemonOptions` seam that wraps the `Kysely` instance, or extracting the shared "log and swallow" wrapper into a named module with its own unit test and using it at both call sites | 🟡 |
| **`ADL_TEST_STAGE_DELAY_MS` never reaches a forked child** | No `env` override is passed through `createSupervisor.spawn`, which invalidates timing-based worker doubles | 🟡 |
| **Wall-clock scenario tests flake under heavy parallelism** | Observed during M05 step 5.11: `pnpm vitest run --project core --project forge-github --project manager` (three projects at once — *not* how CI runs them) failed once on `test/prompt/determinism.test.ts` and once on `test/scenario/detect-restart-reconciliation.test.ts`, a **different** test each run, both passing in isolation immediately after. Both fork real worker processes and wait on `waitUntil` deadlines, so contention, not logic, is the plausible cause. **Escalated during step 5.12 (2026-08-25): `pnpm test` itself — the CI-equivalent, per-package command this entry previously recorded as green on both runs — failed twice in three runs**, on a *different* test each time and neither one reproducible afterwards. Run 1: `test/prompt/determinism.test.ts > a distinctive environment variable set only for the second run does not change the artifact` (15.8s for that file). Run 2 (after an intervening fully-green `pnpm test`): `test/boot/poll-schedule-wiring.test.ts`, 6.0s in the failing run against 3.7s in isolation. Both then passed in isolation, and the whole `--project manager` suite passed standalone (46 files, 346 tests) between them. So the "not an invocation CI uses" mitigation this row used to rest on **no longer holds** — the entry is now about the exact command CI runs, and the observed rate on one developer machine is roughly 1 in 2. Still not root-caused; 5.12 touched nothing either test exercises (its changes are `@adl/core/forge` declarations, `eslint.config.js`, and two new test files, none of which are in the manager's dependency path at runtime). The common shape across all four recorded instances is unchanged: every one forks real worker processes and waits on `waitUntil` deadlines, and every one passes alone. **Proposed shape:** lift the `waitUntil` deadlines off a single machine-tuned constant into something proportional to observed startup cost, or run the real-fork tests with `fileParallelism: false` inside the manager project only. **Risk if wrong:** these deadlines are tuned to one developer machine, so a slower CI runner turns this into a real intermittent red — and it has now been seen twice on the exact command CI runs. **This should be fixed before it costs a debugging session on an unrelated change.** **Seen again during step 5.13 (2026-08-25), on `test/boot/poll-schedule-wiring.test.ts` — the same file as 5.12's run 2** — once in four full `pnpm test` runs; it passed in isolation immediately after and the next full run was green. 5.13 makes the pressure worse rather than better: it adds `test/scenario/round-loop.test.ts`, which forks **four** real worker processes across its two cases (one per stage, per round) where every earlier scenario forked one or two. The fifth recorded instance, the same shape as the first four | 🟠 |
| ~~**`@adl/forge-github`'s `upsertComment` does not paginate `issues.listComments`**~~ | **Closed by M05 step 5.11.** Both `upsertComment` and `listOpenChangeRequests` now go through `octokit.paginate` with `per_page: 100`. The mock GitHub server gained real `per_page`/`page` + `Link: rel="next"` pagination so the fix is *proven* rather than asserted, and both cases were watched failing against the un-paginated code first. `listOpenChangeRequests` was the same defect and worse — 5.10's draft-CR idempotency check and 5.2's restart reconciliation both ask it "is one already open for this branch?", so a repository with more than one page of open pull requests would have opened a duplicate draft on every round | ✅ |

---

## 5 · Deliberate non-goals ⚪

**Do not "fix" these.** Each is a decision with reasoning; changing one is a decision, not
a cleanup.

- **No single-instance guard** for two managers against one database. Accepted for v1,
  documented in `packages/manager/README.md`.
- **Repo-scoped pause does not survive a restart** (only the global flag does). The
  asymmetry is deliberate and documented.
- **The backend preflight gate is opt-in in `StartDaemonOptions`** — but `bin.ts` (5.7), the
  real, installed `adl daemon start` entry point, wires it unconditionally. The option stays
  opt-in only so the 300+ tests that call `startDaemon()` directly don't all need an
  exactly-pinned `claude` on PATH.
- **The poll schedule (5.5) requires an explicit `ForgeAdapter` (`StartDaemonOptions.forge`)
  and does not start without one**, the same "absent means skip" shape as the backend
  preflight gate above. `packages/manager/src/boot/cli-entry.ts` **now builds one (5.10)**
  whenever `repos[0].github_app` is configured — the real entry point has a credential
  source as of this step. It still supplies none *by default*: no live GitHub App exists yet
  (item 1.7 above), so the maintainer's own `.adl/daemon.json` leaves `github_app` unset and
  the poll schedule (and the publish side, D-5-R-1) stays off until that's populated.
- **The context-file cascade is not wired into `mergeConfig`'s output.**
  `effectiveConfig.context.files` stays exactly what `adl.yml` declared.
- **No capability-reconciliation error event.** Implemented per its plan's literal wording,
  found to convert *successful* runs into false `stage_error`s, and removed.
  `cost_source: 'unknown'` is the honest signal instead.
- **`restore()` does not delete post-capture files.** `git clean` is a data-loss primitive
  this backend does not hold.
- **The M04 reconnect proof uses a lighter harness** (`createApi()` + ephemeral port, real
  HTTP, real on-disk transcripts) rather than a full daemon + forked worker + agent
  pipeline. The byte-precise adversarial cases need deterministic timing a real agent
  subprocess cannot guarantee; the full pipeline is proven separately by the tracer.
- **Gherkin Scenario Outlines are not expanded per Examples row.** One criterion, table
  retained verbatim. A one-way contract decision.
- **`resetCrashCountOnSuccess` has no caller.** There is no gate pipeline to complete a
  round from yet. → **M05 step 5.13.**
