# Roadmap: ADL — Autonomous Delivery Loop

## Overview

ADL's journey runs contracts → machinery → one closed loop → the gate → breadth. The first four phases build nothing a user can see: the verdict schema, spec normalization, `adl.yml`, the workspace exec boundary, the manager's state and leases, and one agent backend. Phase 5 is where the product first exists — a feature folder becomes a draft pull request with a gate having failed and sent the developer back. Phases 6-11 make that loop safe and complete (budgets, reviewer, tester, the PR-as-audit-trail, webhooks) and then prove the adapter layer is vendor-neutral by carrying a second, maximally different backend. Phase 12 is the **DOGFOOD gate**: ADL ships a real feature into its own repository, unattended, ending in a pull request the maintainer merges. Nothing below that line starts until it passes. Phases 13-18 are breadth on a validated core — reference harnesses, GitLab and Gitea, security hardening, the remaining backends, the API and dashboard, and distribution — because every unit of breadth multiplies the cost of a contract change, and the gate keeps that multiplier low until the loop is proven.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Phase 12 is a hard gate.** Phases 13-18 are blocked on it. The sole breadth item permitted before the gate is the second agent backend (Phase 11), because an adapter interface with one implementation is unfalsifiable.

- [x] **Phase 1: Core Contracts** - The verdict schema, finding shape, criterion IDs, spec normalization, and `adl.yml` — settled before any I/O exists (completed 2026-08-17)
- [ ] **Phase 2: Workspace & the Exec Boundary** - Every process launch routes through one swappable workspace, with the worker's blast radius bounded
- [ ] **Phase 3: Manager Skeleton — State, Leases, API, CLI** - A crash-surviving control plane the maintainer can watch, pause, and kill
- [ ] **Phase 4: First Agent Backend & Live Transcripts** - Claude Code headless makes a real commit through the workspace, streamed live
- [ ] **Phase 5: The Loop Closes** - A feature folder becomes a draft PR on GitHub after a gate failed and sent the developer back
- [ ] **Phase 6: Accountant — Budgets, Stalls, Escalation** - Unattended running becomes safe: caps enforced before dispatch, stalemates caught, limits escalated to a human
- [ ] **Phase 7: Code Reviewer on the Gate Plugin Interface** - The reviewer is the first real plugin gate, judging from fresh context and citing spec clauses
- [ ] **Phase 8: Behaviour Tester & Committed Regression Tests** - A structurally code-blind tester verifies behaviour against an app ADL owns the lifecycle of
- [ ] **Phase 9: The Pull Request as the Product** - A cold reviewer reconstructs the whole run from the PR alone, and crashes never duplicate anything
- [ ] **Phase 10: Webhook Detection** - Second-scale pickup where webhooks reach, without ever producing a second run
- [ ] **Phase 11: Second Agent Backend — Owned Loop** - The adapter layer carries a raw API where ADL owns the loop, proving vendor neutrality
- [ ] **Phase 12: DOGFOOD — Hard Gate** - ADL ships a real feature into its own repository unattended, ending in a PR the maintainer merges
- [ ] **Phase 13: Reference Harnesses & Third-Party Gates** - A working security harness ships, and existing tools become gates with configuration alone
- [ ] **Phase 14: GitLab, then Gitea** - The forge abstraction survives a genuinely different forge and the narrowest one
- [ ] **Phase 15: Security Hardening & Published Threat Model** - Write auditing, secret scanning, egress control, and a plainly stated trust boundary
- [ ] **Phase 16: OpenAI & Gemini Backends** - The remaining backends land through the conformance suite with no core-loop branches
- [ ] **Phase 17: HTTP API Completeness & Web Dashboard** - Everything the CLI does is available over HTTP, and a dashboard proves the API is complete
- [ ] **Phase 18: Distribution & Adoption** - Install to first PR without scrolling, observe-only mode, doctor, and a stated version matrix

## Phase Details

### Phase 1: Core Contracts

**Goal**: Every downstream component speaks one settled vocabulary — verdicts, findings, criterion IDs, normalized specs, and target-repo configuration — so no later phase can force a contract migration.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-06, SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, EXEC-07
**Success Criteria** (what must be TRUE):

  1. A gate result is exactly one of six outcomes, only `send_back` consumes a round, a malformed or unparseable verdict is classified as an infrastructure failure rather than a gate failure that costs a round, and a developer that believes a gate is wrong has an honest escalation outcome instead of only compliance.
  2. No combination of verdicts containing `inconclusive` can compute to a green result — proven exhaustively — and every finding carries fingerprint, severity, source location, and its acceptance-criterion ID or fails validation.
  3. A structured ADL spec and a Gherkin/BDD feature file both load into one normalized shape with individually addressable acceptance-criterion IDs, with the author's original text retained verbatim alongside.
  4. An `adl.yml` validates its build, start, test, and teardown commands and its explicit `ready` / `ready_timeout` contract, and resolves context files through the `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` cascade when none are declared.
  5. A new gate stage is added to the pipeline by configuration alone — the lifecycle transition function is untouched and no schema migration is required.

**Plans**: 10/10 plans executed

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Package legitimacy gate before the first install (blocking human checkpoint)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Tracer: a spec becomes a green, persisted round outcome on the pinned toolchain

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Guard rails: dependency-graph lint, core purity, toolchain pin, CI matrix
- [x] 01-04-PLAN.md — Aggregation, the exhaustive green proof, and the published JSON Schema
- [x] 01-05-PLAN.md — Developer escalation, the infrastructure-failure channel, and @adl/plugin-sdk
- [x] 01-06-PLAN.md — Dual-format spec intake with one flat AC-n sequence
- [x] 01-07-PLAN.md — adl.yml: argv commands, readiness probes, bounded durations, path guard
- [x] 01-09-PLAN.md — The lifecycle state machine, with the pipeline deliberately absent
- [x] 01-10-PLAN.md — Schema completion: tables, checksum guard, priced-model seed

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-08-PLAN.md — EffectiveConfig: clamps, interpolation, context cascade, pipeline resolution, EXEC-07 proof

**Notes**: Pure, no I/O. Also lands the DB schema and hand-written SQL migrations (Kysely), including `usage_events` and priced-model tables, because cost recording in Phase 5 cannot be designed against data that was never collected. `criterionId` retrofitted later means re-running every agent prompt; `inconclusive` retrofitted means auditing every PR ever labelled verified.

### Phase 2: Workspace & the Exec Boundary

**Goal**: Every process ADL launches — including agent CLIs — runs through one swappable workspace, with the worker's blast radius bounded before any adapter exists to break the rule.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: WORK-01, WORK-02, WORK-03, WORK-04, WORK-05, WORK-06, WORK-07
**Success Criteria** (what must be TRUE):

  1. Each feature gets its own git worktree, and a finished feature leaves behind no worktree and no branch — verified by running many features and then a garbage-collection pass.
  2. No code path anywhere launches a process except through the workspace exec path, enforced by a lint rule that fails the build on a direct spawn outside the workspace module.
  3. A second workspace backend is registered and the loop runs against it unchanged — proven with an in-repo stub backend and zero call-site edits.
  4. The worker runs as a dedicated unprivileged OS user with a per-run scratch `HOME`; agent-written `.npmrc`, `.gitconfig`, or hooks-path configuration does not survive the run and never affects ADL's own git operations.
  5. Forge tokens and model API keys are absent from the worker's ambient environment — asserted by dumping a child process's environment in a test.

**Plans**: 8/8 plans executed

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Package legitimacy gate for execa and simple-git (blocking human checkpoint)
- [x] 02-02-PLAN.md — The spawn boundary: one rule object per glob, every import form and every specifier, and the regression guards

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-03-PLAN.md — Tracer: a feature worktree runs a real process and leaves nothing behind

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-04-PLAN.md — Worktree lifecycle, ordered teardown, and the database-free GC pass
- [x] 02-05-PLAN.md — Zero-inherit env, disposable scratch HOME, and the credential boundary

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-06-PLAN.md — Containment guard, named registry, stub backend, and one contract suite

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 02-07-PLAN.md — Privilege drop to a dedicated OS user, visible skips, and Linux CI provisioning

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 02-08-PLAN.md — Manager-owned git client and the shared-config neutralisation

**Notes**: `networkPolicy` and `resources` present in the workspace spec from day one with `'full'` as the v1 value, so the future container backend is a drop-in rather than a call-site sweep. This is the one mistake that is expensive to retrofit. Two further controls were added during planning on research evidence: per-invocation git-config neutralisation (D-19), because linked worktrees share the main repo's local config and neither `HOME` nor `GIT_CONFIG_GLOBAL` reaches local scope; and a Linux CI job running the privilege-drop assertions (D-21), because two acceptance criteria cannot execute on the Windows development machine.

### Phase 3: Manager Skeleton — State, Leases, API, CLI

**Goal**: A crash-surviving control plane the maintainer can watch and interrupt, proven with a fake worker and no AI anywhere in the loop.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, OBS-01, OBS-03, OBS-04
**Success Criteria** (what must be TRUE):

  1. Maintainer runs `adl status` and sees what every feature is doing right now — its state, its current stage, and its round.
  2. A worker `SIGKILL`ed mid-run is detected within the lease TTL and its feature recovered, with committed work preserved and burned spend still on the ledger.
  3. A zombie worker that wakes after its lease expired cannot write stale results over newer state — its write is rejected on the fencing token.
  4. Feature state, rounds, spend, and transcripts are all present and consistent after a daemon restart.
  5. Maintainer can pause work and kill one feature, everything in one repository, or everything; concurrency is configurable and defaults to one feature in flight.

**Plans**: 6/9 plans executed

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Package legitimacy gate, the two new packages, and the windows-latest CI leg

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — Lease-scoped repository methods, the repos/meta surfaces, and the SQLite pragmas
- [x] 03-03-PLAN.md — `forkWorker`: the manager→worker seam as a named `@adl/workspace` export

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-04-PLAN.md — Tracer: a queued feature is leased by a real forked worker, heartbeats over IPC, and appears in `adl status`

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-05-PLAN.md — Lease expiry, the fence against zombie writes, and crash recovery

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 03-06-PLAN.md — Daemon config, the schema-version gate, repo reconciliation, boot orphan kill, graceful shutdown

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 03-07-PLAN.md — Concurrency caps and the pause/kill control plane

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 03-08-PLAN.md — The `adl` verb set and the GC schedule

**Wave 8** *(blocked on Wave 7 completion)*

- [ ] 03-09-PLAN.md — The concurrency-3 crash-and-restart scenario, on both platforms

**Notes**: The manager owns detection, queue, state, config, credentials, and accounting; the worker is a separate OS process holding one lease. Forge *reads* belong to the manager too. Recovery semantics tested with zero AI in the loop is the cheapest this will ever be. Run CI at concurrency 3 even though the default ships as 1 — a crashed worker plus a restarted daemon is concurrency 2 in practice.

### Phase 4: First Agent Backend & Live Transcripts

**Goal**: A real agent CLI, driven through the workspace, produces a commit and a transcript the maintainer can watch as it happens.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: BACK-01, BACK-05, OBS-02
**Success Criteria** (what must be TRUE):

  1. A developer agent invoked through the `AgentBackend` port makes a real commit inside a feature worktree, launched through the workspace exec path rather than a direct spawn.
  2. Maintainer runs `adl logs -f` on a running feature, watches the agent's transcript stream live, and can reconnect mid-stream without losing or duplicating output.
  3. The backend's CLI version is pinned and preflight-checked at startup, so an unexpected version is reported as a broken installation rather than discovered mid-run.
  4. Repository-level agent-CLI config auto-discovery is disabled and system prompts are set explicitly, so the same feature on the same commit receives the same prompt twice running.

**Plans**: TBD

**Research**: ⚠️ flagged — per-backend agentic-CLI behaviour under *unattended* conditions is under-documented; CLI flag surfaces rate MEDIUM confidence.

**Notes**: Prompt construction lives in a separate `PromptBuilder` module — adapters never build prompts — and rendered prompts are persisted as artifacts. Transcripts are NDJSON with byte-offset addressing, never DB rows.

### Phase 5: The Loop Closes

**Goal**: A feature folder committed to a repository becomes a draft pull request on GitHub, after a gate failed and sent the developer back, with no human touching a single handoff.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: DETECT-01, DETECT-03, DETECT-05, LOOP-01, LOOP-02, ROLE-01, ROLE-03, ROLE-11, SPEC-06, BACK-09, FORGE-01, FORGE-02, FORGE-05, FORGE-06, FORGE-10
**Success Criteria** (what must be TRUE):

  1. Maintainer commits a new feature folder and, with no further action, a draft pull request appears on GitHub at round 1 carrying the developer's work — with undeveloped features identified by evaluating repository state rather than by remembering events, and each feature claimed exactly once even when detection re-runs or the daemon restarts mid-flight.
  2. A deliberately failing command gate (`npm test`) returns the developer to work carrying the failing verdict as context, and a subsequent round passes and promotes the draft to ready — the loop is *not* considered proven by a feature that passes first try.
  3. A developer that edits a spec, the gate configuration, or a test that judges it has that round hard-failed — detected by diffing what it wrote, not by asking — and gate context is assembled from spec, diff, and repository only, with the developer's session and transcript structurally unreachable.
  4. Each agent role's presence on the PR is one sticky comment edited in place with prior rounds collapsed, not one comment per role per round; and ADL never merges — the pull request waits for a human.
  5. Every agent invocation records its tokens and cost against the feature, and a spec arriving from a fork, a non-default branch, or an author without write permission is ignored rather than run.

**Plans**: TBD

**Notes**: Polling only; webhooks deliberately deferred to Phase 10. The first gate is a *command* gate, not the reviewer agent — deterministic and forceable to fail on demand, so send-back plumbing is proven without agent nondeterminism confounding the signal. Core vocabulary is forge-neutral (`ChangeRequest`, not `PullRequest`). Deliberately excluded: reviewer agent, tester agent, third-party harnesses, webhooks, budget enforcement, dashboard, second forge, second backend. The cost-accounting spike (see Phase 6) is best run against a real agent turn here.

### Phase 6: Accountant — Budgets, Stalls, Escalation

**Goal**: An unattended run cannot spend without limit, loop without progress, or fail silently — every limit reached ends in a human being told where they will see it.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: LOOP-03, LOOP-04, LOOP-05, LOOP-06, LOOP-07, LOOP-08, OBS-05
**Success Criteria** (what must be TRUE):

  1. Maintainer sets a per-feature round cap and a per-feature token/cost budget, and whichever is hit first stops the feature — checked before the next agent turn is dispatched, never after it has been paid for.
  2. A global spend cap above the per-feature caps halts new dispatch across every feature once reached, and where a backend's usage reporting is unreliable the budget visibly degrades to round and wall-clock caps rather than silently ceasing to enforce.
  3. A developer/reviewer stalemate is caught by repeated finding fingerprints and escalated before the round cap is reached.
  4. A provider outage, rate limit, or auth failure consumes neither a round nor budget, and the feature resumes rather than being marked failed.
  5. Hitting any limit posts the full transcript and the disagreement to the pull request where a human will see it, and the maintainer can see spend broken down per feature and per role.

**Plans**: TBD

**Prerequisite**: ⚠️ **Cost-accounting spike required before this phase can be planned.** Cross-backend usage reporting reliability is unverified — Claude Code's `total_cost_usd` is a client-side estimate that can differ from the bill, Codex and Gemini report differently, and raw APIs return tokens you must price yourself. Run a real agent turn, reconcile reported cost against actual, and decide the `costSource: 'unknown'` degradation path. Budget is a hard gate, so this is core-loop code, not observability.

### Phase 7: Code Reviewer on the Gate Plugin Interface

**Goal**: The reviewer is the first real plugin gate — judging implementation against spec and code quality from fresh context, on exactly the interface a third party would use.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: HARN-01, HARN-02, HARN-03, HARN-04, ROLE-02, ROLE-04, LOOP-09
**Success Criteria** (what must be TRUE):

  1. Maintainer adds a gate stage — an AI agent or a plain command — and positions it anywhere in the pipeline through configuration, with no change to ADL's lifecycle and no code written.
  2. The reviewer runs on that same interface with no special-casing: removing it from configuration removes it from the pipeline exactly like a third-party gate would be removed.
  3. The reviewer's verdicts cite the specific spec clauses checked, and a `pass` citing none is rejected as malformed rather than accepted as an approval.
  4. A known-bad-diff fixture set runs in ADL's own CI and turns the build red if the reviewer approves it, so rubber-stamping is measured rather than assumed.
  5. Findings raised after the first review round arrive as PR follow-ups rather than fresh send-backs, so the goalposts cannot move mid-feature.

**Plans**: TBD

**Notes**: Two real consumers shape the plugin interface (reviewer here, tester in Phase 8). Special-casing the built-ins ships an interface shaped around a hypothesis. Cheap gates default to `continue` (merge all findings, one send-back); expensive agent gates default to `stop`.

### Phase 8: Behaviour Tester & Committed Regression Tests

**Goal**: Behaviour is verified by an agent that structurally cannot read the implementation, against an app ADL starts and tears down itself, leaving tests the team keeps.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: ROLE-05, ROLE-06, ROLE-07, ROLE-08, ROLE-09, ROLE-10
**Success Criteria** (what must be TRUE):

  1. The tester designs and runs tests for the feature from a workspace containing only the spec, the test directory, `adl.yml`, and the running app — the implementation source is *absent*, not merely forbidden by instruction.
  2. ADL builds, starts, probes, and tears down the app itself on an allocated port and reaps the process group; an app that never becomes ready yields `inconclusive`, never `pass`.
  3. Test outcomes are read from structured runner output, and a run in which zero tests executed reports `inconclusive`, never `pass`.
  4. The tester's tests land in the repository as permanent regression coverage the team owns, in a demarcated location, with the added suite-time delta reported.
  5. A committed test survives only if it meets the assertion floor, names the spec clause it covers, passes repeated stability runs, and fails against the pre-feature commit.

**Plans**: TBD

**Research**: ⚠️ flagged — tester prompt design under the structural code-blind constraint; no public exemplar exists.

**Notes**: This is simultaneously the highest-leverage feature and the highest-risk one — thirty features means thirty batches of tests the team did not write. The guardrails in criterion 5 are what keep that an asset instead of pollution.

### Phase 9: The Pull Request as the Product

**Goal**: A reviewer arriving cold reconstructs the entire run from the pull request alone in about a minute, and no crash ever duplicates a comment or a pull request.
**Mode:** mvp
**Depends on**: Phase 8
**Requirements**: FORGE-07, FORGE-08, FORGE-09, FORGE-11, FORGE-12
**Success Criteria** (what must be TRUE):

  1. Reviewer opens the PR and reads one rollup covering what was built, what was challenged, what was redone, and how behaviour was verified — without opening the daemon or reading a log.
  2. Reviewer sees a coverage table mapping every acceptance criterion to the test that verified it, with any unverified criterion visibly unverified.
  3. Reviewer sees what the feature cost.
  4. Killing the daemon mid-post and restarting it produces no duplicate comment and no duplicate pull request.
  5. Under forge rate limiting — including GitHub's secondary limits — ADL backs off and completes rather than being throttled into failure.

**Plans**: TBD

**Notes**: The PR comment *is* the product. The value proposition is measured in review time saved, but the delivered artefact is more code to review — if ADL does not demonstrably reduce human review effort it is negative value regardless of how well the loop works. Built on a transactional outbox: every forge side effect written in the same transaction as the state change, drained with idempotency keys.

### Phase 10: Webhook Detection

**Goal**: Features are picked up within seconds wherever webhooks reach, without ever producing a second run.
**Mode:** mvp
**Depends on**: Phase 9
**Requirements**: DETECT-02, DETECT-04
**Success Criteria** (what must be TRUE):

  1. Maintainer pushes a feature folder to a repository with a webhook configured and ADL starts within seconds instead of at the next poll, with polling still working when the webhook is unreachable.
  2. A mis-signed or replayed webhook payload is rejected before it is parsed, verified over the raw request body.
  3. Webhook and polling detecting the same new feature simultaneously produce exactly one run, and webhook health is visible in `adl status`.

**Plans**: TBD

**Notes**: Pure latency improvement — polling already works, so this can block nothing, which is why it sits after the loop closes rather than before it.

### Phase 11: Second Agent Backend — Owned Loop

**Goal**: The adapter layer is shown to be vendor-neutral by carrying a maximally different backend — a raw API where ADL owns the loop — before any other breadth is attempted.
**Mode:** mvp
**Depends on**: Phase 10
**Requirements**: BACK-02, BACK-03, BACK-04, BACK-06
**Success Criteria** (what must be TRUE):

  1. The same feature runs end to end on Claude Code headless (a delegated loop that owns its own tools) and on the Anthropic API direct (a loop ADL owns), with identical core loop code.
  2. One conformance suite runs against both adapter families in CI, and an adapter is considered finished only when it passes that suite.
  3. The core loop contains no branch on backend identity — enforced by a lint rule that fails the build on backend-name comparisons outside the adapters directory.
  4. Maintainer switches a feature's backend by configuration and the developer, reviewer, and tester roles all continue to work unchanged.

**Plans**: TBD

**Research**: ⚠️ flagged — implementing a tool loop (Read/Write/Edit/Bash/Grep, permissioning, compaction) over the `Workspace` interface for the owned-loop family is genuinely novel work. Agent Client Protocol is worth spiking as an *implementation* of delegated-loop adapters, never as the core contract.

**Notes**: **This is the sole breadth item permitted before the dogfood gate.** An adapter interface with one implementation is unfalsifiable, and the pairing must span the layer gap — Claude plus an OpenAI CLI proves much less, GitHub plus GitLab proves less still. Session resume is an optimisation, never a correctness requirement; that single rule is what stops the core quietly becoming Claude-shaped.

### Phase 12: DOGFOOD — Hard Gate

**Goal**: ADL ships a real feature into its own repository, unattended, ending in a pull request the maintainer is willing to merge.
**Mode:** mvp
**Depends on**: Phase 11
**Requirements**: None — this phase is a validation gate over Phases 1-11, not new scope
**Success Criteria** (what must be TRUE):

  1. A feature folder is committed to ADL's own repository and, with no human touching a single handoff, a pull request arrives that the maintainer actually merges.
  2. At least one gate failed and sent the developer back during that run, and the tester's committed tests fail against the pre-feature commit.
  3. The run is measured rather than demonstrated — first-round approval rate, round-count distribution, cost variance, and human-found defects in the merged PR are recorded as the baseline every later change is compared against.
  4. The "looks done but isn't" checklist passes: no `inconclusive` was rendered as green, no protected path was written, and the PR's coverage table matches what was actually executed.

**Plans**: TBD

**BLOCKS**: Phases 13, 14, 15, 16, 17, 18. None of them begins until this gate passes. This is a precondition, not a milestone label — a verdict-schema change costs roughly 8× more once it must propagate through three forge adapters, four backend adapters, and a dashboard.

### Phase 13: Reference Harnesses & Third-Party Gates

**Goal**: The extension point is proven real by a working security gate in the box and by existing tools becoming gates with configuration alone.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: HARN-05, HARN-06
**Success Criteria** (what must be TRUE):

  1. A security-checking harness ships working, in the box, built on the same gate interface a third party would use — no privileged access, no special-casing.
  2. Maintainer wires an existing tool (semgrep, CodeRabbit, or Greptile) in as a gate with configuration rather than code, and it can send a feature back to the developer.
  3. A third-party gate's findings map onto acceptance-criterion IDs, so its output lands in the same coverage story as ADL's own gates.

**Plans**: TBD

**Notes**: Ship the *interface* only — registry, discovery, versioning, and marketplace are explicitly out of scope. Highest marketing-to-effort ratio available: it reframes the best-funded competitors as plugins and requires only the plain-command gate contract.

### Phase 14: GitLab, then Gitea

**Goal**: The forge abstraction survives contact with a genuinely different forge and with the narrowest one it was designed around.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: FORGE-03, FORGE-04
**Success Criteria** (what must be TRUE):

  1. A feature runs end to end on GitLab — draft merge request opened at round 1, sticky per-role notes edited in place, promoted to ready when every gate is green.
  2. A feature runs end to end on Gitea, with no capability the base interface offers that Gitea cannot honour.
  3. One forge conformance suite runs against real GitHub and a Dockerised Gitea in CI, and a forge adapter is done only when it passes.

**Plans**: TBD

**Research**: ⚠️ flagged — GitLab API specifics: `iid` vs `id`, URL-encoded project addressing, the notes-vs-reviews model, the `Draft:` title-prefix convention, and Standard Webhooks signing.

**Notes**: GitLab is second because it is genuinely different and forces the abstraction honest; Gitea is third but the base interface was designed to its floor from Phase 5 — top-level comments only, no line-level diff comments, no review updates, no PR code-comment webhook. Gitea should therefore be near-free by the time it is built.

### Phase 15: Security Hardening & Published Threat Model

**Goal**: A prospective maintainer can read exactly where the trust boundary sits and see that agent output cannot carry secrets out or writes escape unnoticed.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: WORK-08, WORK-09, WORK-10
**Success Criteria** (what must be TRUE):

  1. Writes outside expected paths during a round are detected and surfaced to the maintainer after that round, rather than discovered later.
  2. Agent output is secret-scanned and size-capped before it can reach a forge — a credential planted in agent output never appears in a PR comment.
  3. Maintainer reads a published threat model and `SECURITY.md` stating plainly that anyone who can write a file into a watched repository can execute code on the ADL host with ADL's credentials, before deciding to install.
  4. Egress is restricted by allowlist with the cloud metadata endpoint explicitly blocked, transcripts are redacted at the logger, and branch protection is verified at startup.

**Plans**: TBD

**Notes**: This is the *remainder*, not the whole story — the cheap parts already landed: unprivileged user and scoped `HOME` (Phase 2), manager-only credentials (Phase 2/3), trusted-path spec detection and protected paths (Phase 5). Security posture is an adoption gate, not a hardening afterthought: "install a daemon with repo write access and our model API keys" is a security-review conversation.

### Phase 16: OpenAI & Gemini Backends

**Goal**: The vendor-neutrality claim becomes literally true — four backends across two adapter families, all through the same conformance suite.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: BACK-07, BACK-08
**Success Criteria** (what must be TRUE):

  1. A feature runs end to end on OpenAI, via both the raw API and the Codex CLI.
  2. A feature runs end to end on Gemini, via both the raw API and the Gemini CLI.
  3. Both pass the existing backend conformance suite in CI with zero new core-loop branches, and each records per-invocation cost or visibly degrades where it cannot.

**Plans**: TBD

**Notes**: Largely parallelisable with Phases 13, 14, 15, and 17 once the gate passes.

### Phase 17: HTTP API Completeness & Web Dashboard

**Goal**: Everything the CLI can do is available over HTTP, and a browser dashboard over that same API proves the API is complete rather than merely present.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: OBS-06, OBS-07
**Success Criteria** (what must be TRUE):

  1. Every operation the CLI performs is available over the HTTP API — verified by the CLI itself being nothing but a client of that API.
  2. Maintainer opens the dashboard in a browser and sees every feature's live state, streaming transcripts, and spend, served from the same origin as the API.
  3. Maintainer can pause and kill from the dashboard, and the dashboard requires no endpoint the CLI cannot also use.

**Plans**: TBD
**UI hint**: yes

**Notes**: Dashboard deliberately last. Its real value is proving the API is complete — if it needs an endpoint the CLI cannot use, the API was wrong. Building it earlier means building it twice, and the documented failure shape for a nights-and-weekends project is exactly this: the dashboard is the most fun and most visible piece, so it gets built early while the loop's ambiguous, unrewarding parts stay unsolved. Static SPA served by the manager, SSE not WebSocket.

### Phase 18: Distribution & Adoption

**Goal**: Someone who has never seen ADL installs it and reaches a first pull request without a security-review conversation stalling them or a broken installation surprising them mid-run.
**Mode:** mvp
**Depends on**: Phase 12 (DOGFOOD gate — must pass first)
**Requirements**: DIST-01, DIST-02, DIST-03, OBS-08
**Success Criteria** (what must be TRUE):

  1. A new maintainer installs ADL and reaches a first pull request without reading past the top of the README.
  2. Maintainer runs ADL in observe-only mode and sees exactly what it would do without it writing to a repository, a forge, or a model provider.
  3. `adl doctor` diagnoses a broken installation — missing forge token, absent backend CLI, invalid `adl.yml`, unusable git — before any feature is run through it.
  4. The README states which forge, backend, and runtime versions ADL is tested against.

**Plans**: TBD

**Notes**: Observe-only mode is the single best adoption lever and the direct answer to the security-review conversation. ADL is installed into someone else's repository, so extension points, configuration surface, and documentation are v1 concerns rather than afterthoughts.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → **12 (GATE)** → 13 → 14 → 15 → 16 → 17 → 18

Phases 1-5 are strictly serial — `core` has no I/O and everything depends on it. Phases 13-18 are largely parallel once Phase 12 passes.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Core Contracts | 10/10 | Complete    | 2026-08-17 |
| 2. Workspace & the Exec Boundary | 8/8 | In Progress|  |
| 3. Manager Skeleton | 6/9 | In Progress|  |
| 4. First Agent Backend & Live Transcripts | 0/TBD | Not started | - |
| 5. The Loop Closes | 0/TBD | Not started | - |
| 6. Accountant | 0/TBD | Not started | - |
| 7. Code Reviewer on the Gate Plugin Interface | 0/TBD | Not started | - |
| 8. Behaviour Tester & Committed Regression Tests | 0/TBD | Not started | - |
| 9. The Pull Request as the Product | 0/TBD | Not started | - |
| 10. Webhook Detection | 0/TBD | Not started | - |
| 11. Second Agent Backend — Owned Loop | 0/TBD | Not started | - |
| 12. DOGFOOD — Hard Gate | 0/TBD | Not started | - |
| 13. Reference Harnesses & Third-Party Gates | 0/TBD | Not started | - |
| 14. GitLab, then Gitea | 0/TBD | Not started | - |
| 15. Security Hardening & Published Threat Model | 0/TBD | Not started | - |
| 16. OpenAI & Gemini Backends | 0/TBD | Not started | - |
| 17. HTTP API Completeness & Web Dashboard | 0/TBD | Not started | - |
| 18. Distribution & Adoption | 0/TBD | Not started | - |

## Requirement Coverage

**92 / 92 v1 requirements mapped. No orphans, no duplicates.**

| Category | Requirements | Phases |
|----------|--------------|--------|
| Core Contracts (6) | CORE-01..06 | 1 |
| Feature Intake (6) | SPEC-01..05 → 1; SPEC-06 → 5 | 1, 5 |
| Detection & Scheduling (5) | DETECT-01, -03, -05 → 5; DETECT-02, -04 → 10 | 5, 10 |
| The Loop (9) | LOOP-01, -02 → 5; LOOP-03..08 → 6; LOOP-09 → 7 | 5, 6, 7 |
| Agent Roles (11) | ROLE-01, -03, -11 → 5; ROLE-02, -04 → 7; ROLE-05..10 → 8 | 5, 7, 8 |
| Harness Extensibility (6) | HARN-01..04 → 7; HARN-05, -06 → 13 | 7, 13 |
| Model Backends (9) | BACK-01, -05 → 4; BACK-09 → 5; BACK-02, -03, -04, -06 → 11; BACK-07, -08 → 16 | 4, 5, 11, 16 |
| Forge Integration (12) | FORGE-01, -02, -05, -06, -10 → 5; FORGE-07..09, -11, -12 → 9; FORGE-03, -04 → 14 | 5, 9, 14 |
| Execution & State (7) | EXEC-07 → 1; EXEC-01..06 → 3 | 1, 3 |
| Workspace & Trust (10) | WORK-01..07 → 2; WORK-08..10 → 15 | 2, 15 |
| Observability & Control (8) | OBS-01, -03, -04 → 3; OBS-02 → 4; OBS-05 → 6; OBS-06, -07 → 17; OBS-08 → 18 | 3, 4, 6, 17, 18 |
| Distribution & Adoption (3) | DIST-01..03 → 18 | 18 |

---
*Roadmap created: 2026-08-17*
*Granularity: fine · Mode: mvp · Phase naming: sequential*
