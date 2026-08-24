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

- **Not blocking** — it needs an agent actively racing ADL's own `read`/`write` on the same
  path, and nothing schedules those concurrently in v1. **M05 changes that**, so re-read
  this then.
- **Proposed fix:** `open()` then `fstat` the handle and compare `dev`/`ino` against the
  blessed path — one extra syscall, converts "attacker wins silently" into "attacker is
  detected". Add `O_NOFOLLOW` on the leaf where the platform supports it (Windows has no
  equivalent, so it can't be the only measure).
- If the residual is **accepted** instead of closed, updating that docblock *is* the entire
  deliverable and is worth more than a partial fix.

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

- **Not yet exploitable in shipped code** — nothing today constructs a real credentialed
  URL; the M05 tracer's own push is against an unauthenticated local bare remote, and no
  production call site exists yet.
- **Becomes live** the moment a real GitHub App installation token is formatted into a
  `push()` call — expected around 5.10 (draft-CR-at-round-1 wiring) or whenever the
  round-loop runner first performs a real publish.
- **Candidate mitigations, not evaluated yet:** a custom `credential.helper` appended via
  `-c` *after* `NEUTRALISE_ARGS` reading the token from a caller-supplied env var outside
  the `GIT_*` execution-vector ban (`packages/workspace/src/exec/env.ts`'s
  `GIT_EXECUTION_ENV_PREFIXES` blocks `GIT_CONFIG_*`/`GIT_ASKPASS` outright, so this needs a
  non-`GIT_`-prefixed variable name and a helper script written into ADL's own git home);
  or simply accepting the argv-visibility window as bounded by the token's own short TTL
  (GitHub installation tokens expire in ~1 hour) and the same-host trust boundary the
  manager already operates inside.
- **Owner:** whichever M05 step first constructs a real, credentialed push URL.

---

## 3 · Open code-review findings

None exploitable, none blocking a success criterion — per the reviews' own severity
classification.

| ID | Where | What | Sev |
|----|-------|------|-----|
| **WR-01** (M04) | stage runner | The 10-minute wall-clock timeout is a hardcoded placeholder, not wired to `effectiveConfig` — risks misclassifying a legitimate long agent run as a timeout | 🟡 |
| **WR-02** (M04) | `loadSpecFromWorktree` | Builds a path with plain `join()` and **no `resolveWithinRoot` containment check** — unreachable with untrusted input today, but inconsistent with the containment discipline used at every other path site in the milestone | 🟡 |
| **WR-03** (M04) | `agent-claude-code/src/backend.ts` | The rendered prompt is a trailing positional argument with **no `--` end-of-options separator** — safe today only because the template can never start with `-` | 🟡 |
| **IN-01/02/03** (M04) | various | A same-name/different-type placeholder field on `stage_result`, an unused `AgentTask.contextFiles`, an ENOENT fallback branch untested on any platform | 🟡 |
| — | `stage-runner.ts` | The retry attempt ordinal is **hardcoded to `1`** for both the transcript address and the prompt-artifact address; the real ordinal from `openAttempt` never reaches the wire | 🟡 |
| — | `POST /dev-run/:featureId` | Assumes a single configured repository (`reposRepo.list()[0]`) and refuses (409) a feature no longer `queued` — **re-running one feature is impossible until M05's loop runner requeues it** | 🟡 |
| **IN-01/02** (M03) | `meta.ts`, `daemon.ts` | Duplicated discriminated get/set pattern; an incomplete boot-order comment | 🟡 |

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
| **`ADL_TEST_STAGE_DELAY_MS` never reaches a forked child** | No `env` override is passed through `createSupervisor.spawn`, which invalidates timing-based worker doubles | 🟡 |
| **`@adl/forge-github`'s `upsertComment` does not paginate `issues.listComments`** | Finds its own sticky comment by scanning one page (30, GitHub's default) of comments. A change request with more than 30 comments — plausible once humans and other bots are commenting alongside ADL's own roles — could push ADL's prior marker off the first page, producing a duplicate comment instead of an edit-in-place. Not yet reachable: nothing calls `upsertComment` in production. **Owner: M05 step 5.11**, which wires this in for real | 🟡 |

---

## 5 · Deliberate non-goals ⚪

**Do not "fix" these.** Each is a decision with reasoning; changing one is a decision, not
a cleanup.

- **`adl daemon start` prints a gap message and exits 1.** It cannot boot the daemon until
  M05 supplies a production `resolveAdlYml`. Shipping it half-working would have been
  undefended by any test. → **M05 step 5.7.**
- **No single-instance guard** for two managers against one database. Accepted for v1,
  documented in `packages/manager/README.md`.
- **Repo-scoped pause does not survive a restart** (only the global flag does). The
  asymmetry is deliberate and documented.
- **The backend preflight gate is opt-in.** Defaulting it on would make 200+ green tests
  depend on an exactly-pinned `claude` on PATH.
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
