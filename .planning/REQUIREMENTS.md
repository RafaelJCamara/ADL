# Requirements: ADL — Autonomous Delivery Loop

**Defined:** 2026-08-17
**Core Value:** A feature folder goes in, and a green, human-approvable PR comes out — with the whole loop's reasoning visible in the PR — without a human orchestrating any of the handoffs.

## v1 Requirements

v1 is the **first public release**. Breadth (three forges, four backends, dashboard) is in scope, with dogfooding as a hard gate partway through the roadmap rather than the finish line.

Requirements are phrased from the perspective of the two users ADL serves: the **maintainer** who installs and operates the daemon, and the **reviewer** who receives its pull requests.

### Core Contracts

- [ ] **CORE-01**: A gate returns exactly one of six outcomes — `pass`, `send_back`, `fail`, `inconclusive`, `warn`, `skip` — and only `send_back` consumes a round
- [ ] **CORE-02**: An `inconclusive` verdict is structurally incapable of producing a green PR, so an unverified feature can never be presented as verified
- [ ] **CORE-03**: A developer agent that believes a gate is wrong can escalate rather than comply, giving it an honest alternative to subverting the gate
- [ ] **CORE-04**: Every finding carries a fingerprint, severity, source location, and the acceptance-criterion ID it relates to
- [ ] **CORE-05**: A feature spec's acceptance criteria are enumerable and individually addressable, and the original spec text is retained verbatim alongside the normalized form
- [ ] **CORE-06**: A malformed or unparseable agent verdict is classified as an infrastructure failure, never as a gate failure that costs the developer a round

### Feature Intake

- [ ] **SPEC-01**: Maintainer can describe a feature using ADL's structured spec template and have it accepted
- [ ] **SPEC-02**: Maintainer can describe a feature as Gherkin/BDD scenarios and have it accepted
- [ ] **SPEC-03**: Maintainer declares build, start, test, and teardown commands for their repo in `adl.yml`
- [ ] **SPEC-04**: Maintainer declares an explicit readiness signal and timeout in `adl.yml`, so ADL knows when the app is actually up
- [ ] **SPEC-05**: Maintainer can point `adl.yml` at additional context files; absent that, ADL falls back through `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`
- [ ] **SPEC-06**: ADL only acts on specs reaching it through a trusted path — default branch, authors with write permission — and ignores fork-PR specs unless explicitly opted in

### Detection & Scheduling

- [ ] **DETECT-01**: ADL identifies which feature folders are undeveloped by evaluating repository state, not by remembering events
- [ ] **DETECT-02**: Maintainer gets immediate pickup via forge webhooks where reachable
- [ ] **DETECT-03**: ADL still detects new features when webhooks are unavailable, via polling
- [ ] **DETECT-04**: Webhook and polling detecting the same feature simultaneously results in one run, not two
- [ ] **DETECT-05**: A feature is claimed exclusively while in flight, reconciled against open ADL pull requests so a restart never duplicates or supersedes its own work

### The Loop

- [ ] **LOOP-01**: A feature runs developer → code review → harness gates → behaviour test → pull request without human orchestration
- [ ] **LOOP-02**: A failed gate returns work to the developer agent carrying the failing verdict as context
- [ ] **LOOP-03**: Maintainer sets a maximum round count per feature
- [ ] **LOOP-04**: Maintainer sets a token/cost budget per feature, enforced before dispatching the next agent turn rather than after
- [ ] **LOOP-05**: Maintainer sets a global spend cap above per-feature caps
- [ ] **LOOP-06**: A developer/reviewer stalemate is detected by repeated findings, independently of round and budget limits
- [ ] **LOOP-07**: A provider outage, rate limit, or auth failure consumes neither a round nor budget
- [ ] **LOOP-08**: Hitting any limit escalates to a human with the full transcript and the disagreement, posted where the human will see it
- [ ] **LOOP-09**: Findings raised after the first review round become follow-ups rather than new send-backs, so the goalposts cannot move mid-feature

### Agent Roles

- [ ] **ROLE-01**: Developer agent implements a feature from its spec and commits the work
- [ ] **ROLE-02**: Code reviewer judges the implementation against the spec and against code quality
- [ ] **ROLE-03**: Reviewer works from fresh context — it never inherits the developer's session, transcript, or reasoning
- [ ] **ROLE-04**: Reviewer must cite the spec clauses it checked; an approval citing none is malformed rather than an approval
- [ ] **ROLE-05**: Behaviour tester designs and runs tests for the feature, judging behaviour only
- [ ] **ROLE-06**: Tester structurally cannot read the implementation source — enforced by what its workspace contains, not by instruction
- [ ] **ROLE-07**: ADL starts, probes, and tears down the app under test itself, allocating a port and reaping the process group — the agent never owns the lifecycle
- [ ] **ROLE-08**: Test results are read from structured runner output; zero tests executed reports `inconclusive`, never `pass`
- [ ] **ROLE-09**: Tester's tests are committed to the repository as permanent regression coverage
- [ ] **ROLE-10**: Committed tests must meet an assertion floor, link to the spec clause they cover, pass repeated stability runs, and fail against the pre-feature commit
- [ ] **ROLE-11**: The developer cannot modify specs, gate configuration, or the tests that judge it — enforced by diffing what it wrote, not by asking

### Harness Extensibility

- [ ] **HARN-01**: Maintainer can add a gate stage that returns a verdict, without modifying ADL's lifecycle
- [ ] **HARN-02**: A gate may be an AI agent or a plain command — the loop consumes only the verdict
- [ ] **HARN-03**: Maintainer can position a gate anywhere in the pipeline
- [ ] **HARN-04**: Reviewer and behaviour tester are implemented on the same interface third-party gates use
- [ ] **HARN-05**: A security-checking harness ships as a working reference implementation
- [ ] **HARN-06**: Maintainer can run an existing tool (semgrep, CodeRabbit, Greptile) as a gate with configuration rather than code

### Model Backends

- [ ] **BACK-01**: ADL drives agentic CLIs that own their own loop and tools, through an `AgentBackend` port
- [ ] **BACK-02**: ADL drives raw model APIs, owning the loop itself, through a `ModelBackend` port
- [ ] **BACK-03**: A single conformance suite is passed by every adapter in both families, in CI
- [ ] **BACK-04**: Backend-specific behaviour is confined to adapters — the core loop never branches on backend identity
- [ ] **BACK-05**: Claude Code headless works as a backend
- [ ] **BACK-06**: Anthropic API direct works as a backend
- [ ] **BACK-07**: OpenAI works as a backend, via API and Codex CLI
- [ ] **BACK-08**: Gemini works as a backend, via API and CLI
- [ ] **BACK-09**: Per-invocation token and cost are recorded for every backend, degrading visibly when a backend's usage reporting is unreliable rather than silently ceasing to enforce budgets

### Forge Integration

- [ ] **FORGE-01**: ADL creates branches, change requests, and comments through one interface, designed to the narrowest forge's capabilities
- [ ] **FORGE-02**: GitHub works end to end
- [ ] **FORGE-03**: GitLab works end to end
- [ ] **FORGE-04**: Gitea works end to end
- [ ] **FORGE-05**: A draft PR opens at round 1 and is promoted to ready only when every gate is green
- [ ] **FORGE-06**: Each agent role maintains one sticky comment, edited in place, with prior rounds collapsed
- [ ] **FORGE-07**: Reviewer sees a single rollup of what was built, what was challenged, what was redone, and how behaviour was verified
- [ ] **FORGE-08**: Reviewer sees a coverage table mapping every acceptance criterion to the test that verified it
- [ ] **FORGE-09**: Reviewer sees what the feature cost
- [ ] **FORGE-10**: A human approves and merges — ADL never merges
- [ ] **FORGE-11**: Forge side effects survive crashes without duplicating comments or pull requests
- [ ] **FORGE-12**: ADL backs off correctly under forge rate limiting rather than being throttled into failure

### Execution & State

- [ ] **EXEC-01**: Manager process owns detection, queue, state, config, credentials, and accounting
- [ ] **EXEC-02**: Worker runs as a separate OS process holding a lease on one feature
- [ ] **EXEC-03**: A worker killed mid-loop is detected and its feature recovered, with committed work preserved and burned spend retained on the ledger
- [ ] **EXEC-04**: A resumed zombie worker cannot write stale results over newer state
- [ ] **EXEC-05**: Maintainer sets concurrency; it defaults to one feature in flight
- [ ] **EXEC-06**: Feature state, rounds, spend, and transcripts survive daemon restart
- [ ] **EXEC-07**: Adding a harness requires no change to the feature lifecycle state machine

### Workspace & Trust Boundary

- [ ] **WORK-01**: Each feature gets its own git worktree
- [ ] **WORK-02**: Every process launch — including agent CLIs — goes through the workspace's exec path
- [ ] **WORK-03**: The workspace backend is swappable for a container/sandbox implementation without changes to the loop
- [ ] **WORK-04**: Worktrees and branches are reclaimed after a feature finishes
- [ ] **WORK-05**: Worker runs as a dedicated unprivileged OS user with a per-run scratch home directory
- [ ] **WORK-06**: Credentials never enter the worker's ambient environment; model keys reach only the model subprocess
- [ ] **WORK-07**: Agent-written configuration cannot persist to the host or affect ADL's own git operations
- [ ] **WORK-08**: Writes outside expected paths are detected and surfaced after each round
- [ ] **WORK-09**: Agent output is scanned for secrets and size-capped before it reaches a forge
- [ ] **WORK-10**: Maintainer can read a published threat model stating the trust boundary plainly before deciding to install

### Observability & Control

- [ ] **OBS-01**: Maintainer can see what every feature is doing right now
- [ ] **OBS-02**: Maintainer can follow a running agent's transcript live
- [ ] **OBS-03**: Maintainer can pause work
- [ ] **OBS-04**: Maintainer can kill a single feature, everything in one repo, or everything
- [ ] **OBS-05**: Maintainer can see spend per feature and per role
- [ ] **OBS-06**: An HTTP API exposes everything the CLI can do
- [ ] **OBS-07**: A web dashboard presents the same information over that API
- [ ] **OBS-08**: Maintainer can diagnose a broken installation before running a feature through it

### Distribution & Adoption

- [ ] **DIST-01**: Maintainer can install ADL and reach a first PR without reading past the top of the README
- [ ] **DIST-02**: Maintainer can run ADL in observe-only mode, seeing what it would do without it touching anything
- [ ] **DIST-03**: ADL states which forge, backend, and runtime versions it is tested against

## v2 Requirements

Deferred. Tracked but not in the current roadmap.

### Scale

- **SCALE-01**: One manager serves many repositories with per-repo fairness, quotas, and credential isolation
- **SCALE-02**: Container-per-feature workspace backend, replacing worktree-on-host isolation
- **SCALE-03**: Concurrency above 1 as a supported, load-tested configuration
- **SCALE-04**: Remote workers on separate machines

### Intake & Ecosystem

- **ECO-01**: Issue-to-spec bridge, turning forge issues into feature folders
- **ECO-02**: Harness registry with discovery and versioning
- **ECO-03**: Cost prediction before a feature runs
- **ECO-04**: Autonomous merge to an integration branch under an opt-in policy

## Out of Scope

| Feature | Reason |
|---------|--------|
| Deploying or releasing code | ADL stops at a human-approvable PR; CD belongs to the team's existing pipeline |
| Authoring feature specs | Humans write the feature folders; ADL never invents work for itself |
| Provisioning infrastructure for the app under test | Nothing beyond what `adl.yml` starts — no databases, no clusters, no environments |
| Hosting or fine-tuning models | ADL always calls somebody else's inference |
| ADL merging to the target branch | An unattended loop with write access to the target branch is unacceptable in v1 |
| Competing with dedicated AI review products | CodeRabbit and Greptile rest on years of code-graph investment; consume them as harnesses instead |
| Building a code-graph index | Same reason — enormous investment, and it is not what makes ADL different |
| Multi-agent debate to resolve reviewer/developer stalemates | Escalating to a human is cheaper, more honest, and does not risk two agents agreeing on something wrong |
| Self-healing flaky tests | A machine for silently deleting committed coverage |
| Auto-detecting build and run commands | Non-deterministic where it matters most; `adl.yml` is explicit by design |
| Rebuilding LLM observability | Emit standard traces and let existing tools consume them |
| Advisory-only harnesses as the default model | A gate that cannot block or re-route is a linter, not a gate — advisory is available via the `warn` verdict |

## Traceability

Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| _(to be filled by roadmapper)_ | | |

**Coverage:**
- v1 requirements: 92 total
- Mapped to phases: 0
- Unmapped: 92 ⚠️

---
*Requirements defined: 2026-08-17*
*Last updated: 2026-08-17 after initial definition*
