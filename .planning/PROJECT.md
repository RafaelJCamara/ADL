# ADL — Autonomous Delivery Loop

## What This Is

ADL is a self-hosted, open-source delivery framework that turns a written feature description into a reviewed, tested, human-approvable pull request without a human driving the handoffs. A team drops a new subfolder into their repository's `/features` directory; ADL detects that the feature hasn't been built yet, and runs it through a closed loop of AI agents — developer → code reviewer → pluggable harnesses → behaviour tester — sending work back to the developer whenever a gate fails, and opening a PR when every gate passes. It is aimed at engineering teams whose delivery is bottlenecked by code review and QA queues.

## Core Value

A feature folder goes in, and a green, human-approvable PR comes out — with the whole loop's reasoning visible in the PR — without a human orchestrating any of the handoffs.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Loop & orchestration**

- [ ] Detect undeveloped feature folders under `/features` in a target repository
- [ ] Run the developer → code review → harnesses → behaviour test → PR loop end to end
- [ ] Route failed gates back to the developer agent with the failing verdict as context
- [ ] Enforce a per-feature max-round limit and a per-feature token/cost budget, whichever is hit first
- [ ] Escalate to a human with full transcript and disagreement when a limit is hit
- [ ] Manager process owns detection, queue, state, config, credentials, and accounting
- [ ] Worker runs as a separate OS process, leasing one feature at a time
- [ ] Configurable concurrency, defaulting to 1 feature in flight

**Agent roles**

- [ ] Developer agent implements the feature from its spec
- [ ] Code reviewer agent judges implementation against the feature spec plus code quality
- [ ] Behaviour tester agent designs and runs tests for the feature, judging behaviour only — never code
- [ ] Tester's tests are committed into the repository as permanent regression coverage

**Harness extensibility**

- [ ] Harnesses are pluggable gate stages returning a verdict (pass / fail / send-back)
- [ ] A harness may be an AI agent or a plain command — the loop only consumes the verdict
- [ ] Harnesses are positionable at any point in the pipeline
- [ ] Ship at least one real harness (security checks) as a reference implementation

**Model backends**

- [ ] Model-agnostic adapter layer for agent execution
- [ ] Claude Code headless backend
- [ ] Anthropic API direct backend
- [ ] OpenAI backend (API + Codex CLI)
- [ ] Gemini backend (API + CLI)

**Forge integration**

- [ ] Forge abstraction covering branch, PR, and comment operations
- [ ] GitHub support
- [ ] GitLab support
- [ ] Gitea support
- [ ] Every agent posts its own PR comment summarizing its work and outcome
- [ ] Human approves and merges the PR — ADL never merges

**Feature specs & target-repo config**

- [ ] Support a structured ADL feature-spec template
- [ ] Support Gherkin / BDD scenario files
- [ ] `adl.yml` in the target repo declares build / start / test / teardown commands
- [ ] `adl.yml` can point at additional context files; defaults to README when unspecified

**Detection & state**

- [ ] Forge webhooks for immediate detection, with polling as fallback
- [ ] Daemon-side database as source of truth for feature state, rounds, spend, and transcripts
- [ ] State survives daemon restart

**Observability & control**

- [ ] HTTP API on the manager
- [ ] CLI for status, logs, pause, and kill
- [ ] Web dashboard over the same API

**Workspace**

- [ ] Git worktree per feature on the daemon host
- [ ] Workspace backend is an interface, so a container/sandbox backend can be added without touching the loop

### Out of Scope

- Deploying or releasing code — ADL stops at a green, human-approvable PR; CD belongs to the team's existing pipeline
- Authoring feature specs — humans write the feature folders; ADL never invents work for itself
- Provisioning infrastructure for the app under test — nothing beyond what `adl.yml` starts
- Hosting or fine-tuning models — ADL always calls somebody else's inference
- ADL merging to the target branch autonomously — v1 always ends at human approval, even though the loop is otherwise unattended
- Container-per-feature isolation in v1 — deferred behind the workspace-backend interface; worktrees are sufficient at concurrency 1
- Multi-repo fleet management as a v1 goal — the manager/worker split makes it possible later, but v1 does not commit to per-repo fairness, quotas, or credential isolation

## Context

**Origin.** The project exists because code review and QA queues are the real delivery bottleneck on a team, not writing code. Agents already write code well; what's missing is the machinery that carries a change through review and behavioural verification without a person shepherding each handoff.

**Behaviour-first framing.** The unit of work is a *feature* — a described behaviour — not a ticket or a diff. This is why the tester agent is deliberately blind to code: it judges only whether the described behaviour is real. Code quality is the reviewer's job, and the two must not blur.

**Harness engineering.** The pipeline is expected to grow gates over time (security, performance, accessibility, licence scanning). The gate stage is therefore a first-class extension point from day one rather than something retrofitted — a harness must be able to fail a feature and send it back exactly the way code review does.

**Manager/worker shape.** A control plane (manager) owns everything that must be singular — webhook endpoint, database, queue, per-repo config, credentials, round and budget accounting. Workers are separate OS processes that lease one feature and run its loop, giving crash isolation so a runaway agent cannot take the manager down. This also creates the seam where the future sandbox backend slots in: it becomes "what a worker runs inside," invisible to the manager.

**The PR is the audit trail.** Rather than requiring anyone to watch the daemon, every agent writes its own summary comment onto the PR. A reviewer arriving cold can reconstruct what was built, what was challenged, what was re-done, and how behaviour was verified.

**Dogfooding as the bar.** v1 is not considered proven by a demo project. ADL must ship a real feature into its own repository, unattended, ending in a PR the author is willing to merge.

**Scope tension (flagged during initialization).** Three forges, four model backends, and CLI + API + dashboard is a wide v1. Nothing has been cut, but the roadmap should establish a single vertical slice — one forge, one backend, CLI only — that proves the loop closes, before breadth is added. Breadth added before the loop closes is breadth built on an unvalidated assumption.

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
*Last updated: 2026-08-17 after initialization*
