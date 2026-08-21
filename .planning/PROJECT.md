# ADL — Autonomous Delivery Loop

## What This Is

ADL is a self-hosted, open-source delivery framework that turns a written feature description into a reviewed, tested, human-approvable pull request without a human driving the handoffs. A team drops a new subfolder into their repository's `/features` directory; ADL detects that the feature hasn't been built yet, and runs it through a closed loop of AI agents — developer → code reviewer → pluggable harnesses → behaviour tester — sending work back to the developer whenever a gate fails, and opening a PR when every gate passes. It is aimed at engineering teams whose delivery is bottlenecked by code review and QA queues.

## Core Value

A feature folder goes in, and a green, human-approvable PR comes out — with the whole loop's reasoning visible in the PR — without a human orchestrating any of the handoffs.

## Requirements

### Validated

**Core contracts** (Phase 1: Core Contracts)

- [x] Six-outcome verdict schema — `pass`, `send_back`, `fail`, `inconclusive`, `warn`, `skip` — where only `send_back` consumes a round, and `inconclusive` is structurally incapable of producing a green PR (CORE-01, CORE-02)
- [x] Developer-side "this gate is wrong" escalation exit, so an agent facing an impossible gate has an honest alternative to subverting it (CORE-03)
- [x] Every finding carries `fingerprint`, `severity`, `location`, and `criterionId` (CORE-04)
- [x] Acceptance criteria are enumerable and ID'd, threading spec → developer prompt → reviewer finding → test result → PR coverage table (CORE-05)
- [x] A malformed or unparseable agent verdict is classified as an infrastructure failure, never a gate failure that costs a round (CORE-06)

**Feature specs & target-repo config** (Phase 1: Core Contracts)

- [x] Support a structured ADL feature-spec template (SPEC-01)
- [x] Support Gherkin / BDD scenario files (SPEC-02)
- [x] `adl.yml` in the target repo declares build / start / test / teardown commands (SPEC-03)
- [x] `adl.yml` declares an explicit readiness contract (`ready`, `ready_timeout`) — ADL owns the app lifecycle, not the agent (SPEC-04)
- [x] `adl.yml` can point at additional context files; defaults to an `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` cascade (SPEC-05)

**Extensibility** (Phase 1: Core Contracts)

- [x] Adding a harness requires no change to the feature lifecycle state machine (EXEC-07)

### Active

**Loop & orchestration**

- [ ] Detect undeveloped feature folders under `/features` as a pure function of repository state — webhooks and polling only trigger re-evaluation
- [ ] Run the developer → code review → harnesses → behaviour test → PR loop end to end
- [ ] Route failed gates back to the developer agent with the failing verdict as context
- [ ] Enforce a per-feature max-round limit and a per-feature token/cost budget, whichever is hit first, checked before dispatch rather than after
- [ ] Detect no-progress stalls via repeated-finding fingerprints, independently of round and budget caps
- [ ] Handle provider failures (429/5xx, auth) without consuming a round or budget
- [ ] Escalate to a human with full transcript and disagreement when a limit is hit
- [ ] Feature claim/lock with reconciliation against open ADL pull requests, so restarts never duplicate work
- [ ] Manager process owns detection, queue, state, config, credentials, and accounting
- [ ] Worker runs as a separate OS process, leasing one feature at a time
- [ ] Configurable concurrency, defaulting to 1 feature in flight

**Agent roles**

- [ ] Developer agent implements the feature from its spec
- [ ] Code reviewer agent judges implementation against the feature spec plus code quality, with fresh context — it never inherits the developer's session or transcript
- [ ] Behaviour tester agent designs and runs tests for the feature, judging behaviour only — never code, enforced by workspace composition rather than by prompt
- [ ] Tester's tests are committed into the repository as permanent regression coverage
- [ ] Committed-test guardrails — assertion floor, spec-clause link, stability re-runs, and mandatory failure against the pre-feature commit
- [ ] Protected-path enforcement — the developer cannot modify specs, gate configuration, or the tests that judge it

**Harness extensibility**

- [ ] Harnesses are pluggable gate stages returning a verdict from the six-outcome schema
- [ ] A harness may be an AI agent or a plain command — the loop only consumes the verdict
- [ ] Harnesses are positionable at any point in the pipeline
- [ ] Reviewer and behaviour tester are themselves implemented on the harness interface, not special-cased
- [ ] Ship at least one real harness (security checks) as a reference implementation

**Model backends**

- [ ] `AgentBackend` port for agentic CLIs that own their own loop and tools
- [ ] `ModelBackend` port for raw model APIs where ADL owns the loop
- [ ] A conformance suite both adapter families pass in CI
- [ ] Claude Code headless backend (`AgentBackend`)
- [ ] Anthropic API direct backend (`ModelBackend` + generic agent loop)
- [ ] OpenAI backend (API + Codex CLI)
- [ ] Gemini backend (API + CLI)

**Forge integration**

- [ ] Forge abstraction covering branch, change-request, and comment operations, designed around the narrowest forge's API
- [ ] GitHub support
- [ ] GitLab support
- [ ] Gitea support
- [ ] Draft PR opened at round 1, promoted to ready when every gate is green
- [ ] One sticky comment per agent role, edited in place with prior rounds collapsed, plus a single rollup
- [ ] Spec-clause coverage table on the PR
- [ ] Human approves and merges the PR — ADL never merges

**Detection & state**

- [ ] Forge webhooks for immediate detection, with polling as fallback
- [ ] Daemon-side database as source of truth for feature state, rounds, spend, and transcripts
- [ ] State survives daemon restart, including recovery from a worker killed mid-loop

**Observability & control**

- [ ] HTTP API on the manager
- [ ] CLI for status, logs, pause, and kill
- [ ] Web dashboard over the same API
- [ ] Per-invocation token and cost recording, degrading visibly when a backend's usage data is unreliable

**Workspace & trust boundary**

- [ ] Git worktree per feature on the daemon host
- [ ] All process execution — including agent CLIs — goes through `workspace.exec()`
- [ ] Workspace backend is an interface, so a container/sandbox backend can be added without touching the loop
- [ ] Worker runs as a dedicated unprivileged OS user with a per-run scratch `HOME`
- [ ] Credentials never in the worker's ambient environment; model keys injected only into the model subprocess
- [ ] Trusted-path spec detection — default branch and write-permission authors only
- [ ] Published threat model and `SECURITY.md` stating the trust boundary plainly before public release

### Out of Scope

- Deploying or releasing code — ADL stops at a green, human-approvable PR; CD belongs to the team's existing pipeline
- Authoring feature specs — humans write the feature folders; ADL never invents work for itself
- Provisioning infrastructure for the app under test — nothing beyond what `adl.yml` starts
- Hosting or fine-tuning models — ADL always calls somebody else's inference
- ADL merging to the target branch autonomously — v1 always ends at human approval, even though the loop is otherwise unattended
- Container-per-feature isolation in v1 — worktrees are sufficient for *concurrency*, but provide no isolation; this is an accepted, documented risk mitigated by the trust-boundary requirements above, not a solved problem
- Multi-repo fleet management as a v1 goal — the manager/worker split makes it possible later, but v1 does not commit to per-repo fairness, quotas, or credential isolation
- Competing with dedicated AI review products — CodeRabbit, Greptile, and semgrep are consumed as harnesses rather than reimplemented
- Harness registry, discovery, versioning, or marketplace — v1 ships the interface only
- Issue-to-spec bridging and cost prediction — deferred until the loop is validated

## Context

**Origin.** The project exists because code review and QA queues are the real delivery bottleneck on a team, not writing code. Agents already write code well; what's missing is the machinery that carries a change through review and behavioural verification without a person shepherding each handoff.

**Behaviour-first framing.** The unit of work is a *feature* — a described behaviour — not a ticket or a diff. This is why the tester agent is deliberately blind to code: it judges only whether the described behaviour is real. Code quality is the reviewer's job, and the two must not blur.

**Harness engineering.** The pipeline is expected to grow gates over time (security, performance, accessibility, licence scanning). The gate stage is therefore a first-class extension point from day one rather than something retrofitted — a harness must be able to fail a feature and send it back exactly the way code review does.

**Manager/worker shape.** A control plane (manager) owns everything that must be singular — webhook endpoint, database, queue, per-repo config, credentials, round and budget accounting. Workers are separate OS processes that lease one feature and run its loop, giving crash isolation so a runaway agent cannot take the manager down. This also creates the seam where the future sandbox backend slots in: it becomes "what a worker runs inside," invisible to the manager.

**The PR is the audit trail.** Rather than requiring anyone to watch the daemon, every agent writes its own summary comment onto the PR. A reviewer arriving cold can reconstruct what was built, what was challenged, what was re-done, and how behaviour was verified.

**Dogfooding as the bar.** v1 is not considered proven by a demo project. ADL must ship a real feature into its own repository, unattended, ending in a PR the author is willing to merge.

**Scope tension (flagged during initialization, resolved after research).** Three forges, four model backends, and CLI + API + dashboard is a wide v1, and all four researchers independently recommended deferring breadth past dogfooding. The maintainer's decision, taken with that flag in hand: **v1 is the first public release**, so breadth stays in scope — a tool advertised as model-agnostic and multi-forge that ships with one of each is not credible publicly. The roadmap therefore keeps everything but treats **dogfooding as a hard gate partway through**, not as the finish line: no third backend, no second forge, no dashboard until ADL has shipped a real feature into its own repository unattended. The second agent backend is the sole exception that precedes the gate, because an adapter interface with one implementation cannot be shown to be vendor-neutral.

**Why breadth is expensive before the gate.** A change to the verdict schema costs roughly 8× more once it must propagate through three forge adapters, four backend adapters, and a dashboard. Since no shipping product has a send-back gate loop, there is no evidence that anyone's contracts survive first contact — which is precisely why the contracts land in phase 1 and the gate sits before breadth.

**Market position (from research).** The industry has converged on "issue in → sandboxed worker → draft PR out" (Copilot coding agent, Jules, Codex cloud, Devin, OpenHands). Two things are absent from every mainstream product, and both are ADL's core: a multi-role verdict-driven loop where a gate can reject and send work back, and gates as a first-class plugin surface. Danger.js is the closest precedent for the latter and it runs once in CI and cannot return work to an agent. The differentiator is real; the risk was only ever whether the surface area needed to reach it exhausts a solo maintainer first.

**The dominant risk class is silently-wrong-but-green.** Gate subversion is measured rather than theoretical — ImpossibleBench found frontier models exploit conflicting tests up to 76% of the time, with Claude-family models specifically preferring to *modify the tests*, which is exactly what committing agent-authored tests exposes. The same work found the mitigation: an honest "this gate is wrong" exit cut cheating from 92% to 1%. That is why the verdict schema and protected paths are phase-1 contracts rather than hardening.

## Constraints

- **Tech stack**: TypeScript / Node — best agent-SDK ecosystem, easiest for open-source contributors, trivial to shell out to CLI-based agent backends
- **Architecture**: Manager (control plane) + separate-process workers (execution plane) — crash isolation, and the seam for future sandboxed execution
- **Deployment**: Self-hosted long-running daemon — teams keep their code and credentials on their own infrastructure
- **Distribution**: Open source, installed into someone else's repository — extension points, configuration surface, and documentation are v1 concerns, not afterthoughts
- **Vendor neutrality**: No backend may be privileged in the core loop — the adapter layer must survive contact with Claude, OpenAI, and Gemini simultaneously
- **Safety**: Human approval is mandatory before merge — an unattended loop that can write to the target branch is not acceptable in v1
- **Timeline**: Solo, nights and weekends, no hard deadline — favours thoroughness over speed, but makes finishing the vertical slice early important for motivation and validation

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Long-running self-hosted daemon over CI-triggered runs | Loop can span many rounds and hours; CI job semantics fit poorly, and teams keep code/credentials in-house | — Pending |
| Manager + separate-process workers | Crash isolation from runaway agents; creates the seam for sandboxed execution later | — Pending |
| Worktree per feature, backend behind an interface | Cheap and fast at concurrency 1, without foreclosing container isolation | — Pending |
| Concurrency configurable, default 1 | Matches the intended v1 behaviour while making scale-up a config change, not a redesign | — Pending |
| Tester judges behaviour only, never code | Keeps the two failure signals distinct; a tester that reads code starts approving intent instead of outcomes | — Pending |
| Tester's tests are committed to the repo | Converts throwaway verification into permanent regression coverage the team owns | — Pending |
| Harness = pluggable gate stage with a verdict, agent or command | Makes the pipeline extensible without the loop knowing what any gate does | — Pending |
| Both structured template and Gherkin spec formats | Structured templates suit teams without BDD practice; Gherkin makes behaviour directly executable for BDD teams | — Pending |
| `adl.yml` with README as default extra context | Explicit commands stay reproducible; context pointers stop agents guessing how the project works | — Pending |
| Daemon-side database as state source of truth | Rich history, transcripts, and retry/spend accounting without polluting the repo with status commits | — Pending |
| Webhooks with polling fallback | Instant detection where reachable, still works behind a firewall | — Pending |
| Human approves and merges the PR | An unattended loop with write access to the target branch is unacceptable for real team repos in v1 | — Pending |
| Every agent posts its own PR comment | The PR becomes a self-contained audit trail readable without the daemon | — Pending |
| Dual limits: max rounds and cost budget | Developer/reviewer disagreement can loop indefinitely; rounds alone miss expensive stalls, budget alone misses cheap ones | — Pending |
| TypeScript / Node | Strongest agent-SDK ecosystem and lowest barrier for OSS contributors | — Pending |
| Dogfooding as the v1 success bar | A demo repo can be tuned to pass; ADL's own repo cannot | — Pending |
| v1 is the first public release; breadth stays in scope | A tool advertised as model-agnostic and multi-forge that ships with one of each is not credible publicly — taken with the research's contrary recommendation in hand | — Pending |
| Dogfooding is a hard gate partway through, not the finish line | Every unit of breadth multiplies the cost of a contract change; the gate keeps that multiplier low until the loop is proven | — Pending |
| Second agent backend precedes the dogfood gate | An adapter interface with one implementation is unfalsifiable — pair a delegated-loop CLI with an owned-loop raw API to span both families | — Pending |
| Adapter layer splits into `AgentBackend` and `ModelBackend` | Agentic CLIs return a diff plus transcript plus cost; raw APIs return one assistant turn. One interface over both means either a lowest-common-denominator adapter or rebuilding Claude Code | — Pending |
| Six-outcome verdict schema, defined before any agent role exists | `pass/fail/send_back` cannot express "I could not verify", which becomes a false green; and without an honest "this gate is wrong" exit the agent is effectively forced to cheat | — Pending |
| Reviewer and tester built on the harness interface, not special-cased | Two real consumers shape the plugin interface; special-casing ships it shaped around a hypothesis | — Pending |
| Gate pipeline is data, not lifecycle states | If adding a harness requires a state-machine change and a migration, "pluggable harness" is decorative | — Pending |
| All execution routes through `workspace.exec()` | The one leak that is expensive to retrofit — a direct `spawn` anywhere means the container backend can never work | — Pending |
| The git commit is the checkpoint | Agent output is nondeterministic, so replay-style durable execution is impossible; at-least-once activities with idempotency keys is the only honest semantics | — Pending |
| Acceptance-criterion IDs are the join key | Without them the product cannot answer "was every criterion actually verified" — and retrofitting means re-running every prompt | — Pending |
| Sticky per-role PR comments, draft PR from round 1 | Four gates over five rounds is twenty comments — the AI-slop pattern maintainers are revolting against, and the shape GitHub's secondary rate limiter penalises | — Pending |
| GitLab is the second forge, interface designed around Gitea | GitLab is genuinely different so it forces the abstraction honest; Gitea is the narrowest API so it sets the interface floor | — Pending |
| Kysely with hand-written SQL migrations | Drizzle's stable release is still pre-1.0 with an RC pending; choosing it would schedule a known breaking migration into a nights-and-weekends project | — Pending |
| SQLite plus a hand-rolled lease table; no Redis, no queue library | Concurrency defaults to 1 and jobs run for hours, so throughput is irrelevant — and Redis would be a hard install prerequisite for a tool pitched as "drop a daemon on your box" | — Pending |
| Credentialed agentic-CLI tests batch into one end-of-project credentialed verification pass | A live API key plus an unshadowed pinned CLI is an environment precondition, not project work, so gating each phase on it stalls the roadmap on setup while finished code sits on `main`; batching buys one honest reconciliation against real billed usage instead of many partial ones; deferred is not passed — the items stay tracked in STATE.md's Deferred Items table and no phase receives a COMPLETE checkbox it did not earn | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-17 after Phase 1 (Core Contracts) completion*
