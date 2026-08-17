# Feature Research

**Domain:** Self-hosted autonomous agentic software-delivery pipelines (multi-agent develop → review → test → PR loops installed into a team's own repositories)
**Researched:** 2026-08-17
**Confidence:** MEDIUM (see Confidence & Method at the end — every claim is web-sourced and cross-checked across at least two independent results; no vendor claim is treated as verified behaviour)

---

## Executive Orientation: Where ADL Sits

The market has converged hard on one shape: **issue in → sandboxed cloud worker → draft PR out**. Copilot coding agent, Jules, Codex cloud, Cursor background agents, Devin, Sweep, Factory Droids and OpenHands Resolver are all instances of that shape. It is now table stakes, not a differentiator.

Two things are conspicuously *missing* from that convergence, and both are ADL's stated core:

1. **Nobody ships an opinionated, multi-role, verdict-driven gate loop.** The mainstream products are one agent that self-checks and then hands to a human. Adversarial review (a second agent that can *reject and send back*) exists in research (`Adversarial Review`, `critic/defender/judge` debate protocols) and in product-adjacent form (CodeRabbit, Greptile as separate review tools), but there is no widely-used OSS orchestrator that runs develop → review → gates → behaviour test → send-back as a closed loop with a formal verdict type.
2. **Nobody treats gates as a first-class plugin surface.** The closest precedent is `Danger.js` — a JS plugin ecosystem for PR-time gates with a `fail`/`warn`/`message` vocabulary, but it runs once in CI and cannot send work back to an agent.

That gap is real and it is ADL's differentiator. The risk is not that the idea is taken; it's that the surface area needed to *reach* the differentiator (forge abstraction × 3, model adapters × 4, CLI + API + dashboard) is large enough to consume a solo maintainer before the loop ever closes. PROJECT.md already flags this. This research strongly seconds it, and adds a concrete correction: **build the reviewer and the behaviour tester as the first two implementations of the harness interface, not as special cases.** If the built-in gates are special-cased, the plugin interface will be under-specified and the differentiator ships broken.

One more strategic finding worth stating up front: **ADL should not try to out-review CodeRabbit or Greptile.** Greptile catches ~82% of seeded bugs vs CodeRabbit's ~44%, but at the cost of the most false positives; CodeRabbit deliberately trades recall for low noise. Both have years of investment in code-graph indexing. ADL's harness interface means it can *consume* them as gates rather than compete with them. That reframes "ship at least one real harness" from a checkbox into a positioning move.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these and a team will not install ADL, or will uninstall it after the first bad run.

#### 1. Work intake

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Declarative spec-as-file in the repo | Spec-driven development is the 2026 default; GitHub Spec Kit supports 15+ agents, and specs-in-repo are diffable, reviewable, versioned | LOW | ADL's `/features` folder **is** this. It is the correct choice and is ahead of issue-only competitors. |
| Structured acceptance criteria that map 1:1 to tests | EARS-style / Gherkin criteria are the de facto standard for unambiguous, testable requirements; this is the input the behaviour tester needs | LOW–MED | Already in Active. Prefer EARS-shaped bullets in the structured template — reported to map almost 1:1 onto test cases. |
| Gherkin / BDD scenario files | BDD teams already own this format; forcing them to re-author is an adoption tax | MED | Already in Active. Note: a `gherkin-guidelines-for-ai` guidance repo exists precisely because agents write bad Gherkin — ADL should *consume* Gherkin, and should not generate it. |
| Explicit "this feature is not built yet" signal | Detection by heuristic will re-run features and spam PRs. 17.3% of rejected agentic PRs died of *inactivity* and 5.9% were *superseded* — duplicates are a top-3 rejection cause | LOW | **Gap in Active requirements.** "Detect undeveloped feature folders" is under-specified. Needs an explicit marker (status field in the spec, or a manifest) plus reconciliation against already-open ADL PRs. |
| A `.gitignore`-style opt-out / per-feature skip | Teams need to park a spec without deleting it | LOW | Trivial once the status marker exists. |

#### 2. The loop itself

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Bounded iteration (max rounds) | Unbounded agent loops are the canonical production failure. Every cloud agent has a wall-clock or step cap | LOW | Already in Active. |
| Cost/token budget per unit of work | Devin's ACU model exists because "poorly-defined tasks requiring extended debugging" escalate cost fast. Budget-only or rounds-only each miss half the failure modes | MED | Already in Active, and the dual-limit reasoning in PROJECT.md matches what the field learned. Depends on the model adapter reporting usage — see Dependencies. |
| **No-progress detection**, not just a round cap | Strongest, most repeated finding in the loop-engineering literature: *raising the max iteration count does not solve a retry loop, it only makes it more expensive*. The exit must be based on whether state improved (fewer failing tests, smaller error surface) | MED | **Genuinely missing from Active requirements.** A feature that burns 6 rounds making zero progress should escalate at round 3. Cheap to implement (hash the failing-verdict set; if unchanged N rounds, escalate) and it is the single highest-leverage addition in this document. |
| Escalation to a human with full context | Production agent guidance is unanimous: on repeated non-progress, stop and hand back with the blocker stated clearly | LOW–MED | Already in Active. Make the escalation artifact the PR itself, not a log file. |
| Send-back carries the failing verdict as context | Without it the developer agent re-derives the failure and often re-makes it | LOW | Already in Active — this is the mechanically important part of the whole design. |
| Graceful handling of provider failure | 8.5% of agentic-PR rejections were *provider issues* (7.5% agent failure/unreachable, 1.0% rate limits) — a bigger cause than breaking changes | MED | **Gap.** Retries with backoff on 429/5xx, and a distinct "infrastructure failed" state that does not consume a round or the budget. Users will not forgive burning their budget on the vendor's outage. |

#### 3. Code review by AI

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Findings anchored to file + line | Both CodeRabbit and Greptile are line-anchored; the adversarial-review research is explicit that *"every criticism is tied to a quotation, so a disagreement has to point at text rather than at a hunch"* | MED | **Make this a hard schema constraint**, not a prompt suggestion. An un-anchored finding must be rejected by the loop, not passed to the developer. This is what stops reviewer↔developer disagreement loops. |
| Severity levels on findings | CodeRabbit ranks severity; a reviewer with only pass/fail forces every nit into a full round | LOW | Feeds directly into the `warn` verdict gap below. |
| Review scoped against the spec **and** code quality | ADL's reviewer role is defined this way and it is correct — the spec is the only ground truth for "did it build the right thing" | LOW | Already in Active. |
| Structured, machine-readable verdict | The loop consumes it; free-text review is unroutable | MED | This is the schema everything else hangs off. Define it first. |

#### 4. Autonomous testing

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Declared build / start / test / teardown commands | The industry answer to "how does a tool learn to run an arbitrary repo" is **declare it, don't sniff it**. Copilot uses `.github/workflows/copilot-setup-steps.yml`; GitHub docs explicitly tell you to teach it "how to run any build steps, automated tests, or linters" | LOW | `adl.yml` is exactly right and is validated by the market. |
| Tests committed to the repo | Qodo's guidance is to "review the generated tests… and commit the tests alongside your code" so new code ships with baseline coverage | LOW | Already in Active. Correct, and one of ADL's better calls — throwaway verification is wasted work. |
| Enumerate behaviours before writing test code | Qodo's flagship feature is a "test behaviors" panel that lists identified behaviours *before* generating a line of code. Playwright Test Agents split planner (markdown test plan) → generator (code) → healer | MED | **Strong recommendation to adopt.** A behaviour list is (a) reviewable, (b) diffable against the spec's acceptance criteria, (c) the natural PR comment for the tester agent. It converts "did the tester test the right thing?" from unanswerable to a 10-second read. |
| Test failures reported as behaviour failures, not stack traces | The tester is spec'd as behaviour-only; a raw pytest dump forces the developer agent to infer intent | LOW | Cheap. Big quality gain on send-back. |
| CI must actually pass | 6.9% of rejections were straight CI pipeline failures — the largest single *technical* rejection cause | MED | ADL runs its own tests but should also honour the repo's existing test command from `adl.yml` before opening the PR. Opening a red PR is a trust-killer. |

#### 5. Extensibility / harness stages

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Gate = plugin returning a verdict | Danger.js proved the demand: a plugin ecosystem purely for PR-time gates, GitHub + GitLab | MED | Already in Active. The differentiator is that ADL gates can *send back*, which Danger cannot. |
| Gate can be a plain command (exit code) | Most real gates already exist as CLIs (semgrep, trivy, licence scanners, axe, lighthouse). Requiring an AI wrapper kills adoption | LOW | Already in Active. Define the command contract precisely: exit code + a JSON verdict on stdout or at a known path. |
| A non-blocking `warn` / advisory verdict | Danger's vocabulary is `fail` / `warn` / `message` for a reason. `pass`/`fail`/`send-back` alone forces every advisory finding to either vanish or cost a full developer round | LOW | **Genuinely missing from Active requirements and the cheapest high-value fix in this document.** Add `warn` (surfaces on the PR, does not block) and `skip`/`not-applicable` (gate had nothing to say). |
| Gate ordering / positioning | Already in Active — correct, and necessary (a licence scan should run before an expensive behaviour test) | MED | Also needs: what happens when gate 3 fails — restart from the developer, or resume at gate 1? Define once. |

#### 6. Forge integration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Branch + PR creation with a readable title/body | Universal | LOW | Already in Active. |
| **Draft PR opened early, promoted when green** | Copilot's actual behaviour is to push commits to a *draft* PR as it works, trackable live. ADL's current design (open PR only when all gates pass) means hours of zero visibility on the surface the team actually watches | LOW | **Concrete correction to an Active requirement.** Open the draft at round 1; mark ready-for-review when every gate passes. Costs almost nothing, converts "the PR is the audit trail" from an end-state into a live one, and gives humans a natural place to intervene mid-loop. |
| Clear bot attribution | GitHub added maintainer kill switches (disable PRs entirely, or restrict to collaborators) in response to ~17M agent PRs/month by Mar 2026. Ambiguous agent identity is now actively hostile | LOW | Distinct bot identity, labelled PRs, `ADL` prefix. |
| Human approval before merge | Copilot requires human approval before CI/CD workflows even run on agent PRs | LOW | Already in Active and correctly hard-constrained. Do not soften this. |
| One forge, done properly | Copilot is GitHub-only. GitLab Duo is GitLab-only. Greptile is GitHub + GitLab. Only CodeRabbit spans four forges — and it is a funded company | MED per forge | Multi-forge is a **differentiator, not table stakes**. See Anti-Features. |

#### 7. Observability & control

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Live session log / transcript | Copilot ships session logs showing "reasoning and validation steps"; Cursor returns screenshots and logs. Universal expectation | MED | Already in Active via CLI logs. |
| Kill switch / pause | GitHub shipped a literal kill switch after agent-PR-driven incidents. A daemon with no stop button will not be installed twice | LOW | Already in Active. Make it work at three scopes: one feature, one repo, everything. |
| Cost + token accounting per feature | Standard across LLM observability (Langfuse/LangSmith aggregate cost per trace, with spend-threshold alerts). Also required to enforce ADL's own budget | MED | Already in Active. **Hard dependency on the model adapter surfacing usage** — see Dependencies. |
| Loop-iteration visibility | Agent observability guidance: "which subagents, handoffs, or loop iterations ran, in what order, and how often the agent looped" | LOW | Falls out of the DB schema if rounds are modelled explicitly. |
| State survives restart | A multi-hour loop that loses everything on a daemon restart is unusable | MED | Already in Active. Must also define: what happens to a worker that was mid-round. |

#### 8. Safety & trust

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Human approval gate before merge | Only ~3% of developers highly trust AI-generated code; 38% say reviewing it is *more* effort than reviewing human code | LOW | Already in Active. This is the single most important trust feature ADL has. |
| Documented secret handling | Environment-variable leakage is repeatedly named the biggest blind spot in agent sandboxing — even isolated sandboxes exfiltrate secrets passed as env vars unless scrubbed or egress-restricted | MED | **Gap.** ADL holds forge tokens *and* model API keys and runs untrusted-ish generated code on the daemon host. Minimum v1: worker env is explicitly constructed (allowlist, not inherit), forge token scoped to the working repo, model keys never entering the worktree environment. |
| Published threat model | Self-hosted OSS asking for repo write access and model credentials will be security-reviewed before install | LOW | Docs work, not code. Non-negotiable for a tool "installed into someone else's repository". |
| No autonomous merge | Already out of scope. Correct | — | Keep it out of scope loudly, in the README's first screen. |
| Least-privilege forge token | Standard enterprise ask: least-privilege access, ephemeral credentials | LOW–MED | Document the exact minimum scopes per forge. |

#### 9. Configuration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| A repo-level config for commands | `copilot-setup-steps.yml` is the direct precedent | LOW | `adl.yml` — already in Active, validated. |
| **Read AGENTS.md by default** | AGENTS.md was formalised as an open spec in Aug 2025 (OpenAI with Google, Cursor, Factory), donated to the Linux Foundation's Agentic AI Foundation in Dec 2025, is in 60,000+ OSS repos, and is supported by 20+ tools including Copilot coding agent (which also reads `CLAUDE.md` and `GEMINI.md`) | LOW | **Concrete correction to an Active requirement.** The Active list says context "defaults to README when unspecified". The default should be a cascade: `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`. Inventing an ADL-specific context file, or defaulting past the ecosystem standard, is unnecessary friction. |
| Config validation with good errors | A daemon that silently misreads `adl.yml` and then burns budget is worse than one that refuses to start | LOW | Schema-validate on load and on `adl doctor`. |

---

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Closed adversarial loop with formal send-back** | Nobody in the mainstream ships this. Copilot/Jules/Codex/Cursor are single-agent + human. Research (`Adversarial Review`, critic/defender/judge debate) says evidence-grounded structured disagreement measurably improves agentic coding | HIGH | This is the product. Everything else is scaffolding for it. |
| **Behaviour tester that cannot read code** | Directly attacks the "agent writes tests that assert what the code does, not what the spec says" failure — the well-known degenerate case of AI test generation | MED | Enforce structurally (the tester's workspace/tooling excludes the diff), not by prompt instruction. A prompt-only rule will be violated. |
| **Gates as pluggable verdict-returning stages that can send back** | Danger.js proved plugin gates have an ecosystem; none of them can return work to an agent. This is the extension point that lets ADL absorb the whole security/perf/a11y/licence category without ADL implementing any of it | MED–HIGH | Ship the interface + one reference gate. Do not ship five. |
| **Consume CodeRabbit / Greptile / semgrep as harnesses** | Reframes best-funded competitors as plugins. "ADL runs your existing review tooling as a blocking gate and sends failures back to the developer agent" is a stronger pitch than "ADL has its own reviewer" | LOW (once the command-gate contract exists) | Highest marketing-to-effort ratio in this document. Requires only the plain-command gate contract. |
| **Spec-folder as the unit of work** | Every competitor is issue-driven or prompt-driven. A versioned, reviewable, diffable spec directory is auditable and survives ticket churn. The rejection study's #1 recommendation is "embed project-specific guidance clarifying preferred approaches and forbidden strategies" — a spec folder is that, structurally | LOW | Already the design. Lean into it in positioning. |
| **The PR as a complete, self-contained audit trail** | Directly counters the top complaint of 2026: reviewers drowning in agent PRs with no visible reasoning. A PR that shows what was challenged, what was re-done, and how behaviour was verified is *cheaper* to review than a human PR | MED | See the comment-spam warning below — this differentiator is easy to turn into an anti-feature. |
| **Vendor-neutral model adapters** | Devin, Copilot, Jules, Cursor all lock to one vendor. Tembo's stated differentiator is exactly "no lock-in to a single agent" (Claude Code, Codex, Cursor, OpenCode, Amp) — so the market values this | MED per backend | Real, but see Anti-Features on doing four at once. |
| **Self-hosted, credentials never leave your infrastructure** | Greptile self-hosts; CodeRabbit self-hosts only at 500+ seats. Self-hosting is a paid enterprise tier elsewhere — free and default in ADL | LOW | Already the architecture. Say it on the README's first line. |
| No-progress detection with early escalation | Nobody ships this well; the literature says everyone needs it | MED | Cheap, and it is what makes the budget feel intelligent rather than arbitrary. |
| Behaviour list published before test code | Adopted from Qodo's best-received feature; makes tester output human-auditable in seconds | LOW–MED | High trust return for low effort. |

---

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Three forges before the loop closes** | "Teams use GitLab too" | Each forge is a distinct PR/review/comment/status API with different draft-PR and bot-identity semantics. Copilot ships GitHub-only; GitLab Duo ships GitLab-only. Three forges is ~3× the integration surface spent before a single validated loop exists | GitHub-only v1, behind the forge interface. Add GitLab when a real user asks. PROJECT.md already flags this; this research confirms it. |
| **Four model backends before the loop closes** | Vendor neutrality is a stated constraint | Four backends means four usage-reporting formats, four failure modes, four tool-permission models — and budget enforcement *depends* on usage reporting. Debugging the loop across four backends multiplies every bug | One backend (Claude Code headless) v1, behind the adapter. Add the second only after the loop closes — the second backend is what actually validates the interface; the third and fourth validate nothing new. |
| **Web dashboard in v1** | Dashboards demo well | Requires HTTP API + auth + a frontend build + its own release cadence. It is the classic solo-maintainer sink, and CLI already answers every v1 question | CLI + structured JSON output. Build the dashboard when someone other than the maintainer is running the daemon. |
| **One PR comment per agent per round** | "Every agent posts its own comment" is an Active requirement, and full transparency sounds right | With 4 gate stages × 5 rounds this is 20 comments. CodeRabbit's explicitly-marketed advantage over Greptile is producing *fewer* comments to "cut review noise". A 20-comment PR is not an audit trail, it is the AI-slop complaint that maintainers are revolting against | **Reinterpret the requirement:** one comment *per agent role*, edited in place across rounds, with prior rounds in a collapsed `<details>` history. Same information, one screen. This preserves the intent of the requirement and fixes its failure mode. |
| **Auto-detecting build / run / test commands** | "Zero-config would be magic" | Heuristic detection is right ~70% of the time and silently wrong the rest, burning full budgets on a bad start command. The whole industry declares instead (`copilot-setup-steps.yml`, `adl.yml`) | Keep `adl.yml` mandatory. Optionally scaffold a *draft* `adl.yml` via `adl init` that a human confirms. Never infer at runtime. |
| **ADL building its own code-graph / repo index** | Greptile's semantic code graph is visibly effective | Years of investment; also duplicates what Claude Code / Codex already do internally. A solo maintainer cannot win here and does not need to | Rely on the backend agent's own retrieval. Point at context via `adl.yml` + AGENTS.md. If deeper indexing is wanted, that's a *harness* (run Greptile as a gate). |
| **Multi-agent debate / voting to resolve reviewer↔developer disagreement** | Debate literature shows quality gains; feels like the natural fix for stalemates | Multiplies token spend on exactly the features that are already over-budget, and the outcome is usually the same as escalating. Debate protocols need a judge agent, which needs its own prompt, budget and failure mode | Escalate to the human. That *is* the answer, and it is already in the design. No-progress detection makes the escalation timely. |
| **Self-healing flaky tests** | Playwright's healer agent is compelling; flakiness will bite | A healer that rewrites a failing assertion is a machine for silently deleting coverage. Extremely dangerous in a system that also *commits* the tests | Detect flakiness (re-run failing tests N times; if non-deterministic, mark the verdict `warn` and escalate) but never auto-heal. Quarantine, don't repair. |
| **Container-per-feature sandbox in v1** | Every competitor sandboxes (OpenHands: Docker per task; Codex: network disabled per task; Copilot: egress allowlist to package registries) | Already correctly deferred behind the workspace interface. Building it in v1 doubles the setup surface for early adopters | Ship the interface + a documented threat model + an **egress allowlist option**, and be explicit in the README that v1 assumes a trusted host. Honesty here buys more trust than a half-built sandbox. |
| **Cost prediction before a run** | Devin's ACU model makes people want an estimate | Genuinely unpredictable — Devin's own reputational problem is cost escalating on poorly-defined tasks. A wrong estimate is worse than no estimate | Show spend live, enforce a hard budget, report actuals per feature. Historical per-feature averages become a real estimator later, for free. |
| **Full LLM observability stack (traces, evals, dashboards)** | Langfuse/LangSmith set the expectation | Rebuilding Langfuse is a product, not a feature | Emit OpenTelemetry/OTLP spans with token+cost attributes. Users point Langfuse (MIT, self-hostable) at it. ~One day of work, full observability story. |
| **RBAC / SSO / multi-tenant / per-repo quotas** | Enterprise checklist | Multi-repo fleet management is already out of scope for v1. Auth systems are unbounded | Single-tenant daemon, one shared admin token on the API. Defer. |
| **ADL authoring or refining specs** | "The agent could just write the feature folder" | Already out of scope — and the rejection data supports it: 23.5% of agentic PRs were rejected for *relevance* (wrong thing, wrong time, superseded). Agents choosing their own work amplifies exactly that failure | Humans write the folder. Keep this out of scope permanently, not just for v1. |
| **Auto-merge on all-green** | The loop is unattended everywhere else — why stop at the PR? | Already out of scope, correctly. 96% of developers don't fully trust AI code; auto-merge makes ADL uninstallable at most companies regardless of pass rates | Human approves. Non-negotiable. |

---

## Feature Dependencies

```
[Verdict schema: pass | fail | send-back | warn | skip, with anchored findings]
    ├──required by──> [Code reviewer agent]
    ├──required by──> [Behaviour tester agent]
    ├──required by──> [Harness plugin interface]
    ├──required by──> [Send-back routing with failing verdict as context]
    └──required by──> [PR comment rendering]

[Harness plugin interface]
    └──should be implemented by──> [Reviewer] and [Behaviour tester]
        (build the built-ins ON the interface, or the interface ships under-specified)

[Model adapter layer]
    └──must report token usage──> [Per-feature cost budget]
                                      └──required by──> [Dual limit enforcement]
                                                            └──required by──> [Escalation]

[No-progress detection] ──enhances──> [Escalation]
    └──requires──> [Verdict history persisted per round]
                       └──requires──> [Daemon DB]

[Daemon DB] ──required by──> [State survives restart]
            ──required by──> [HTTP API] ──required by──> [Web dashboard]
            ──required by──> [CLI status/logs]

[Forge abstraction: branch, PR, comment]
    ├──required by──> [Draft PR opened at round 1]
    ├──required by──> [Per-role PR comment, edited in place]
    └──required by──> [Human approval gate]

[Feature-folder detection] ──requires──> [Explicit not-built marker]
                           ──requires──> [Reconciliation against open ADL PRs]
                           ──requires──> [Feature claim/lock in DB]

[Polling detection] ──must exist before──> [Webhook detection]
    (webhooks need public reachability; polling is the universal fallback)

[Git worktree per feature] ──behind──> [Workspace backend interface]
                                           └──enables later──> [Container backend]

[Secret scrubbing / explicit worker env] ──required by──> [Any credible self-hosted install]

[Adaptive/prompt-only tester code-blindness] ──conflicts with──> [Tester judges behaviour only]
    (must be enforced structurally, not by instruction)

[One comment per agent per round] ──conflicts with──> [PR as readable audit trail]
```

### Dependency Notes

- **Verdict schema is the keystone.** Reviewer, tester, every harness, send-back routing and PR rendering all consume it. Design it once, in the first phase, before any agent role exists. Getting `warn` and `skip` into it at day zero costs nothing; retrofitting them means touching every consumer.
- **Reviewer and tester should be harnesses.** If they are special-cased, the plugin interface will be shaped around a hypothesis instead of two real users, and third-party gates will hit missing capabilities immediately. This also makes "positionable at any point in the pipeline" fall out for free.
- **Budget enforcement depends on the adapter reporting usage.** This is the sharpest hidden dependency. If the v1 backend is Claude Code headless (a shelled-out CLI), token/cost usage must be reliably parseable from its output. **Verify this before committing to the dual-limit requirement**, or the budget half of the limit silently does nothing. This is a spike-worthy unknown.
- **No-progress detection requires per-round verdict history**, which the DB already needs for transcripts — so it is nearly free once state persistence exists. Sequence it right after the loop closes.
- **Polling before webhooks.** Webhooks need a publicly reachable endpoint, which a self-hosted daemon behind a firewall often is not. Polling is the fallback *and* the simpler first implementation; build it first and treat webhooks as an optimisation.
- **Detection needs a claim/lock.** Without one, a daemon restart mid-feature, or concurrency > 1, will double-run a feature and open duplicate PRs — the single most reputation-damaging bug this system can have, given maintainers are already installing kill switches against duplicate agent PRs.
- **Draft PR early depends only on the forge abstraction**, not on gates passing. It can ship in the very first vertical slice and it substantially de-risks everything after it, because the loop becomes observable on the surface users already watch.

---

## MVP Definition

### Launch With (v1 vertical slice — one forge, one backend, CLI only)

This is the smallest set that proves the loop closes. It matches PROJECT.md's own flagged narrowing.

- [ ] **Verdict schema** (`pass` / `fail` / `send-back` / `warn` / `skip`, findings anchored to file+line) — keystone; everything consumes it
- [ ] **Harness plugin interface** (AI agent or plain command; positionable) — must exist before the built-ins, or it will be retrofitted badly
- [ ] **Developer agent** — the loop has no output without it
- [ ] **Code reviewer agent, implemented as a harness** — first real consumer of the interface; validates spec-conformance + quality
- [ ] **Behaviour tester agent, implemented as a harness, structurally code-blind** — the differentiator; commits its tests
- [ ] **Send-back routing carrying the failing verdict** — the mechanically essential part of the loop
- [ ] **Max-round limit + no-progress detection** — bounded loop; ship budget enforcement only if adapter usage reporting is verified
- [ ] **Escalation to human with full transcript on any limit** — the loop must have an exit that isn't a bad PR
- [ ] **Feature-folder detection with an explicit not-built marker + DB claim/lock** — no duplicate PRs, ever
- [ ] **Structured ADL feature-spec template** (EARS-shaped acceptance criteria) — one format only in v1; Gherkin follows
- [ ] **`adl.yml`** with build/start/test/teardown + context pointers defaulting to `AGENTS.md` → `CLAUDE.md` → `README.md`
- [ ] **GitHub forge adapter** behind the forge interface — branch, draft PR at round 1, comment, promote-to-ready when green
- [ ] **One summary comment per agent role, edited in place**, with collapsed round history
- [ ] **Claude Code headless backend** behind the model adapter interface
- [ ] **Git worktree workspace** behind the workspace backend interface
- [ ] **Daemon DB** (feature state, rounds, verdicts, transcripts, spend) surviving restart
- [ ] **Polling detection** — webhooks deferred
- [ ] **CLI**: `status`, `logs`, `pause`, `kill` (per-feature and global)
- [ ] **Explicit worker environment construction** (allowlist env vars; forge token scoped; model keys excluded from the worktree env) + a published threat model
- [ ] **Human approves and merges — ADL never merges**
- [ ] **Dogfood: ADL ships a real feature into its own repo unattended**

### Add After Validation (v1.x)

- [ ] **Second model backend** (OpenAI/Codex) — *trigger:* loop closes on backend #1. The second backend is what actually validates the adapter interface.
- [ ] **Gherkin / BDD scenario support** — *trigger:* first user who runs BDD asks. Consumes existing scenarios; never generates them.
- [ ] **Security harness as a reference plugin** (wrap semgrep/trivy as a plain command) — *trigger:* harness interface has survived two built-in consumers.
- [ ] **"Run CodeRabbit / Greptile as a gate" documented recipe** — *trigger:* plain-command gate contract is stable. Near-zero code, large positioning return.
- [ ] **Per-feature cost budget** — *trigger:* adapter usage reporting verified across two backends.
- [ ] **Webhook detection** — *trigger:* polling latency is a real complaint from a real user.
- [ ] **Behaviour-list-before-test-code published as the tester's PR comment** — *trigger:* tester output is being questioned by reviewers.
- [ ] **HTTP API** — *trigger:* someone wants to script ADL or the dashboard is next.
- [ ] **GitLab forge adapter** — *trigger:* a real user on GitLab. Second forge validates the forge interface.
- [ ] **OTLP span emission** (token + cost attributes) — *trigger:* anyone asks about observability. One day of work; outsources the entire dashboard story to Langfuse.
- [ ] **Flakiness detection** (re-run N times, `warn` + quarantine on non-determinism) — *trigger:* first flaky-test false send-back.
- [ ] **Egress allowlist for worker processes** — *trigger:* first security review from a prospective adopter.

### Future Consideration (v2+)

- [ ] **Web dashboard** — defer; CLI answers every v1 question and the dashboard is the classic solo-maintainer sink.
- [ ] **Gitea forge adapter** — defer; smallest user population of the three, and the forge interface is already proven by forge #2.
- [ ] **Gemini backend** — defer; backends #3 and #4 validate nothing that #2 didn't.
- [ ] **Container/sandbox workspace backend** — defer per PROJECT.md; the interface is what matters in v1.
- [ ] **Concurrency > 1 in anger** (base-branch staleness, worktree contention, per-repo fairness) — defer; default 1 is honest.
- [ ] **Multi-repo fleet management** — already out of scope for v1; revisit only with real multi-repo users.
- [ ] **Issue → feature-folder bridge** (open an issue, ADL scaffolds a spec folder for a human to complete) — defer, and design carefully: it must never let ADL author the spec itself.
- [ ] **Historical cost estimation from past features** — defer; falls out of accounting data for free once there is history.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Verdict schema (incl. `warn`, `skip`, anchored findings) | HIGH | LOW | P1 |
| Send-back routing with failing verdict as context | HIGH | MEDIUM | P1 |
| Harness plugin interface (built-ins implemented on it) | HIGH | MEDIUM | P1 |
| Developer / reviewer / behaviour-tester agents | HIGH | HIGH | P1 |
| Structurally code-blind tester | HIGH | MEDIUM | P1 |
| Max rounds + no-progress detection | HIGH | MEDIUM | P1 |
| Escalation with full transcript | HIGH | LOW | P1 |
| Feature detection + not-built marker + claim/lock | HIGH | MEDIUM | P1 |
| `adl.yml` with AGENTS.md-first context cascade | HIGH | LOW | P1 |
| GitHub adapter + draft PR at round 1 | HIGH | MEDIUM | P1 |
| One comment per role, edited in place | HIGH | LOW | P1 |
| Daemon DB + restart survival | HIGH | MEDIUM | P1 |
| CLI status / logs / pause / kill | HIGH | LOW | P1 |
| Explicit worker env + threat model doc | HIGH | LOW | P1 |
| Human approval, never merge | HIGH | LOW | P1 |
| Tests committed to the repo | HIGH | LOW | P1 |
| Claude Code headless backend | HIGH | MEDIUM | P1 |
| Worktree workspace behind an interface | MEDIUM | LOW | P1 |
| Polling detection | MEDIUM | LOW | P1 |
| Provider-failure retry (doesn't consume round/budget) | HIGH | MEDIUM | P2 |
| Per-feature cost budget | HIGH | MEDIUM | P2 |
| Second model backend | MEDIUM | MEDIUM | P2 |
| Security harness reference plugin | MEDIUM | LOW | P2 |
| "Third-party reviewer as a gate" recipe | HIGH | LOW | P2 |
| Gherkin support | MEDIUM | MEDIUM | P2 |
| Behaviour list before test code | MEDIUM | MEDIUM | P2 |
| OTLP span emission | MEDIUM | LOW | P2 |
| Flakiness detect + quarantine | MEDIUM | MEDIUM | P2 |
| Webhook detection | LOW | MEDIUM | P2 |
| HTTP API | MEDIUM | MEDIUM | P2 |
| GitLab adapter | MEDIUM | HIGH | P3 |
| Egress allowlist | MEDIUM | MEDIUM | P3 |
| Web dashboard | LOW | HIGH | P3 |
| Gitea adapter | LOW | HIGH | P3 |
| Gemini backend | LOW | MEDIUM | P3 |
| Container workspace backend | MEDIUM | HIGH | P3 |
| Concurrency > 1 hardening | LOW | HIGH | P3 |

**Priority key:** P1 = must have for the v1 vertical slice · P2 = should have, add after the loop closes · P3 = future

---

## Competitor Feature Analysis

| Feature | Copilot coding agent | OpenHands (OSS) | Devin | CodeRabbit / Greptile | ADL's approach |
|---------|---------------------|-----------------|-------|----------------------|----------------|
| Work intake | Assign a GitHub issue, or chat from VS Code | Label an issue `fix-me` (Resolver); prompt; schedules; webhooks | Prompt, Slack, Jira, Linear + 20 tools | PR event only | **Spec folder under `/features`** — versioned, diffable, reviewable |
| Spec format | Free-text issue + AGENTS.md/instructions | Free-text issue + `.openhands/microagents/repo.md` | Prompt + playbooks + knowledge docs | n/a | **Structured template (EARS-shaped) + Gherkin** |
| Loop shape | One agent, self-checks, human reviews | Observe-think-act; optional subagents | Multi-agent, parallel managed Devins | Single review pass, no loop | **Develop → review → gates → behaviour test → send-back** |
| Send-back to the agent | Human comments on the PR | Human replies in the conversation | Human comments | None (advisory only) | **Automatic, verdict-carried, no human in the cycle** |
| Iteration limit | Wall-clock / session | Max iterations config | ACU spend | n/a | **Max rounds + budget + no-progress detection** |
| Gate extensibility | None (checks are just CI) | Microagents/Skills = context, not gates | Playbooks = procedure, not gates | Custom rules (Greptile); 40+ linters bundled (CodeRabbit) | **Pluggable verdict-returning gates that can send work back** |
| Testing | Runs repo tests; no dedicated tester role | Runs tests inside the loop | Runs tests | None | **Dedicated behaviour tester, code-blind, tests committed** |
| Build/run discovery | `copilot-setup-steps.yml` (declared) | Docker sandbox + repo config | Learns over sessions | n/a | **`adl.yml` (declared)** — same industry answer |
| Repo config | AGENTS.md, copilot-instructions.md, `.instructions.md`, CLAUDE.md, GEMINI.md | `.openhands/microagents/*.md` | Playbooks + knowledge base | `.coderabbit.yaml` / custom rules | **`adl.yml` + AGENTS.md-first cascade** (read the standard, don't reinvent it) |
| PR mechanics | Draft PR, commits pushed live, session logs | Opens PR on completion | Opens PR | Comments on existing PRs | **Draft PR at round 1, promoted when green** |
| Forges | GitHub only | GitHub (GitLab requested) | GitHub-centric | CodeRabbit: GH/GL/ADO/Bitbucket · Greptile: GH/GL | **Interface + GitHub in v1**; GitLab, Gitea later |
| Models | Locked to Copilot models | Any LLM provider | Cognition's own | Vendor's own | **Adapter layer; Claude Code headless in v1** |
| Sandboxing | Egress allowlist to package registries | Docker container per task | Managed cloud VMs | n/a | **Worktree on a trusted host in v1**, interface for containers later — the honest weak spot |
| Self-hosting | No | Yes | No | Greptile yes · CodeRabbit at 500+ seats | **Yes, default, free** |
| Merge | Human approves; CI needs approval to run | Human | Human | n/a | **Human — hard constraint** |
| Observability | Session logs | Logs + REST API | Session analysis, ACU accounting | PR comments | **CLI + DB transcripts + per-feature spend**; API/dashboard later |

---

## Validation of PROJECT.md's Active Requirements

**Validated by the market — keep as-is:** spec-as-file intake; `adl.yml` declaring commands; committed tester tests; dual limits; escalation with transcript; harness = pluggable verdict gate (agent or command); manager/worker split; human approves and never auto-merges; adapter/forge/workspace interfaces; worktree-first; polling + webhooks; DB as source of truth; CLI.

**Amend (four concrete corrections):**
1. **Context default should be `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`**, not README alone. AGENTS.md is a Linux Foundation spec in 60k+ repos supported by 20+ tools; skipping it is gratuitous friction.
2. **Open the PR as a draft at round 1**, promote to ready when all gates pass — rather than opening only on success. Matches Copilot's shipped behaviour and makes the audit trail live.
3. **"Every agent posts its own PR comment" → one comment per agent *role*, edited in place, prior rounds collapsed.** Per-round appending produces the comment spam that maintainers are currently revolting against.
4. **Add `warn` and `skip` to the verdict vocabulary.** `pass`/`fail`/`send-back` forces every advisory finding to either vanish or cost a full round. Danger.js's `fail`/`warn`/`message` exists for exactly this reason.

**Add (four genuine gaps):**
1. **No-progress detection** — the field's clearest lesson is that a higher iteration cap does not fix a stuck loop; only a progress-based exit does.
2. **Provider-failure handling that does not consume a round or budget** — provider issues caused 8.5% of agentic-PR rejections, more than breaking changes.
3. **Explicit worker environment construction + a published threat model** — env-var leakage is the named #1 sandboxing blind spot, and ADL runs generated code on the daemon host holding forge and model credentials.
4. **A feature claim/lock and reconciliation against open ADL PRs** — duplicate/superseded PRs are a top rejection category and the fastest way to get ADL uninstalled.

**Confirm the narrowing PROJECT.md already flagged:** one forge, one backend, CLI only, polling only for v1. Everything found here supports it.

---

## Sources

Competitor products and evidence analysed (all accessed 2026-08-17):

- OpenHands / OpenDevin — https://github.com/OpenHands/openhands · https://www.openhands.dev/blog/open-source-coding-agents-in-your-github-fixing-your-issues · https://pypi.org/project/openhands-resolver/ · https://ai-infrastructure.net/openhands-platform/
- GitHub Copilot coding agent — https://github.blog/ai-and-ml/github-copilot/github-copilot-coding-agent-101-getting-started-with-agentic-workflows-on-github/ · https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment · https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/ · https://docs.github.com/en/copilot/responsible-use/copilot-cloud-agent
- Reviewing agent PRs / trust data — https://arxiv.org/html/2606.13468 (AIDev rejection study) · https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/ · https://www.builder.io/blog/developers-drowning-in-ai-prs · https://www.danilchenko.dev/posts/2026-04-11-github-ai-agents-pull-requests/ · https://arxiv.org/html/2607.26819v1
- Devin / Cognition — https://www.lindy.ai/blog/devin-pricing · https://aiagentsquare.com/agents/devin · https://cursor-alternatives.com/blog/devin-faq/
- CodeRabbit / Greptile — https://www.greptile.com/greptile-vs-coderabbit · https://levelop.dev/blog/best-ai-code-review-tools-2026-coderabbit-greptile-qodo-compared · https://www.getpanto.ai/blog/coderabbit-vs-greptile-ai-code-review-tools-compared
- Qodo / CodiumAI testing — https://www.qodo.ai/solutions/testing/ · https://dev.to/rahulxsingh/qodo-ai-test-generation-how-it-works-with-examples-4abk
- Playwright AI test agents / flakiness — https://www.checklyhq.com/blog/generate-end-to-end-tests-with-ai-and-playwright/ · https://www.browserstack.com/guide/playwright-ai-test-generator
- Cursor / Jules / Codex cloud agents — https://www.aitidbits.ai/p/cloud-coding-agents · https://www.morphllm.com/comparisons/jules-google-coding-agent · https://techsy.io/en/blog/background-coding-agents-compared
- Factory AI / Tembo — https://www.lowcode.agency/blog/claude-code-vs-factory-ai · https://www.tembo.io/blog/top-coding-agent-tools
- SWE-agent / Aider / Sweep — https://github.com/SWE-agent/SWE-agent · https://arxiv.org/pdf/2512.22256 (agentic issue-resolution survey)
- GitLab Duo Agent Platform — https://about.gitlab.com/press/releases/2025-07-17-gitlab-announces-the-public-beta-of-gitlab-duo-agent-platform/ · https://cloudfresh.com/en/news/gitlab-duo-agent-platform-is-now-generally-available/
- AGENTS.md standard — https://agents.md/ · https://asdlc.io/practices/agents-md-spec/ · https://arxiv.org/pdf/2511.12884 (context-file empirical study) · https://arxiv.org/pdf/2606.15828 (configuration smells)
- Spec-driven development / Gherkin for agents — https://github.com/AutomationPanda/gherkin-guidelines-for-ai · https://learn.microsoft.com/en-us/training/modules/spec-driven-development-github-spec-kit-enterprise-developers/3-examine-github-spec-kit · https://dev.to/krlz/spec-driven-development-in-2026-what-it-is-the-tooling-and-how-teams-actually-use-it-2fk2
- Agent loop / retry / escalation design — https://www.explainx.ai/blog/ai-agent-loop-architecture-triggers-retries-checkpoints-2026 · https://opendatascience.com/the-3-loops-that-break-ai-agents-in-production/ · https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026
- Adversarial / critic-reviewer patterns — https://openreview.net/forum?id=fOHvpLs6zp · https://arxiv.org/html/2607.26212v1
- Pluggable PR gates — https://danger.systems/js/ · https://github.com/danger/danger-js
- Sandboxing / secrets — https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/ · https://northflank.com/blog/how-to-sandbox-ai-agents
- Observability / cost accounting — https://langfuse.com/docs/observability/features/token-and-cost-tracking · https://docs.langchain.com/langsmith/cost-tracking

## Confidence & Method

- **MEDIUM overall.** Every finding came from web search or fetch (base tier: LOW) and was promoted to MEDIUM only where it was corroborated by at least two independent results, or by a primary source (GitHub Docs, GitHub Changelog, arXiv, vendor docs).
- **HIGH-confidence subset** (primary sources, directly checked): Copilot coding agent's config surface and `copilot-setup-steps.yml`; AGENTS.md adoption and governance; the AIDev rejection-cause breakdown; Danger.js's plugin/verdict model; OpenHands' architecture and Resolver flow.
- **LOWER-confidence subset** (single-source or vendor-marketing-derived; treat as directional): the Greptile 82% / CodeRabbit 44% bug-catch comparison (published by one of the vendors); the "70% flaky-test reduction" figure (single practitioner blog); Devin's ACU-to-minutes ratio; the "3–10× first-pass success" claim for spec-driven development.
- **Known gaps:** no primary source found for Gitea AI-agent integration maturity (assume immature — deprioritise accordingly); no independent benchmark of any multi-agent send-back loop, because no widely-used product ships one, which is both the confidence gap and the opportunity.

---
*Feature research for: self-hosted autonomous agentic software-delivery pipelines*
*Researched: 2026-08-17*
