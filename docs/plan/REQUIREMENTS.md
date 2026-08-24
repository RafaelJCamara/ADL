# Requirements

92 v1 requirements. All mapped to a milestone. No orphans, no duplicates.

Phrased from the perspective of the two people ADL serves: the **maintainer** who installs
and operates the daemon, and the **reviewer** who receives its pull requests.

**Status** — ✅ done · 🟡 code complete, one deferred check · ⬜ pending

---

## Core Contracts — M01 ✅

- ✅ **CORE-01** A gate returns exactly one of six outcomes — `pass`, `send_back`, `fail`, `inconclusive`, `warn`, `skip` — and only `send_back` consumes a round
- ✅ **CORE-02** An `inconclusive` verdict is structurally incapable of producing a green PR
- ✅ **CORE-03** A developer agent that believes a gate is wrong can escalate rather than comply
- ✅ **CORE-04** Every finding carries a fingerprint, severity, source location, and criterion ID
- ✅ **CORE-05** Acceptance criteria are enumerable and individually addressable; the original spec text is retained verbatim alongside the normalized form
- ✅ **CORE-06** A malformed agent verdict is an infrastructure failure, never a gate failure that costs a round

## Feature Intake — M01 ✅ · M05

- ✅ **SPEC-01** Describe a feature using ADL's structured spec template
- ✅ **SPEC-02** Describe a feature as Gherkin/BDD scenarios
- ✅ **SPEC-03** Declare build / start / test / teardown commands in `adl.yml`
- ✅ **SPEC-04** Declare an explicit readiness signal and timeout in `adl.yml`
- ✅ **SPEC-05** Point `adl.yml` at extra context files; else cascade `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md`
- ⬜ **SPEC-06** *(M05)* Act only on specs from a trusted path — default branch, write-permission authors; ignore fork-PR specs unless opted in

## Detection & Scheduling — M05 · M10

- ⬜ **DETECT-01** *(M05)* Identify undeveloped feature folders by evaluating repository state, not by remembering events
- ⬜ **DETECT-02** *(M10)* Immediate pickup via forge webhooks where reachable
- ⬜ **DETECT-03** *(M05)* Still detect new features via polling when webhooks are unavailable
- ⬜ **DETECT-04** *(M10)* Webhook and polling detecting the same feature simultaneously results in one run, not two
- ⬜ **DETECT-05** *(M05)* A feature is claimed exclusively while in flight, reconciled against open ADL PRs so a restart never duplicates work

## The Loop — M05 · M06 · M07

- ⬜ **LOOP-01** *(M05)* developer → code review → harness gates → behaviour test → PR, without human orchestration
- ⬜ **LOOP-02** *(M05)* A failed gate returns work to the developer carrying the failing verdict as context
- ⬜ **LOOP-03** *(M06)* Maximum round count per feature
- ⬜ **LOOP-04** *(M06)* Token/cost budget per feature, enforced **before** dispatching the next turn
- ⬜ **LOOP-05** *(M06)* Global spend cap above the per-feature caps
- ⬜ **LOOP-06** *(M06)* Stalemate detected by repeated findings, independently of round and budget limits
- ⬜ **LOOP-07** *(M06)* Provider outage / rate limit / auth failure consumes neither a round nor budget
- ⬜ **LOOP-08** *(M06)* Hitting any limit escalates to a human with full transcript and the disagreement, where they will see it
- ⬜ **LOOP-09** *(M07)* Findings raised after round 1 become follow-ups, not new send-backs

## Agent Roles — M05 · M07 · M08

- ⬜ **ROLE-01** *(M05)* Developer agent implements a feature from its spec and commits
- ⬜ **ROLE-02** *(M07)* Code reviewer judges implementation against spec and code quality
- ⬜ **ROLE-03** *(M05)* Reviewer works from fresh context — never inherits the developer's session or transcript
- ⬜ **ROLE-04** *(M07)* Reviewer cites the spec clauses it checked; an approval citing none is malformed
- ⬜ **ROLE-05** *(M08)* Behaviour tester designs and runs tests, judging behaviour only
- ⬜ **ROLE-06** *(M08)* Tester structurally cannot read implementation source — enforced by workspace composition, not instruction
- ⬜ **ROLE-07** *(M08)* ADL starts, probes and tears down the app itself, allocating a port and reaping the process group
- ⬜ **ROLE-08** *(M08)* Results read from structured runner output; zero tests executed reports `inconclusive`
- ⬜ **ROLE-09** *(M08)* Tester's tests are committed as permanent regression coverage
- ⬜ **ROLE-10** *(M08)* Committed tests meet an assertion floor, link a spec clause, pass stability runs, and fail against the pre-feature commit
- ⬜ **ROLE-11** *(M05)* The developer cannot modify specs, gate config, or the tests that judge it — enforced by diffing, not by asking

## Harness Extensibility — M07 · M13

- ⬜ **HARN-01** *(M07)* Add a gate stage returning a verdict, without modifying ADL's lifecycle
- ⬜ **HARN-02** *(M07)* A gate may be an AI agent or a plain command — the loop consumes only the verdict
- ⬜ **HARN-03** *(M07)* Position a gate anywhere in the pipeline
- ⬜ **HARN-04** *(M07)* Reviewer and tester are implemented on the same interface third parties use
- ⬜ **HARN-05** *(M13)* A security-checking harness ships as a working reference implementation
- ⬜ **HARN-06** *(M13)* Run an existing tool (semgrep, CodeRabbit, Greptile) as a gate with configuration rather than code

## Model Backends — M04 🟡 · M05 · M11 · M16

- ✅ **BACK-01** Drive agentic CLIs through an `AgentBackend` port
- ⬜ **BACK-02** *(M11)* Drive raw model APIs, owning the loop, through a `ModelBackend` port
- ⬜ **BACK-03** *(M11)* One conformance suite passed by every adapter in both families, in CI
- ⬜ **BACK-04** *(M11)* Backend-specific behaviour confined to adapters — the core loop never branches on backend identity
- ✅ **BACK-05** Claude Code headless works as a backend
- ⬜ **BACK-06** *(M11)* Anthropic API direct works as a backend
- ⬜ **BACK-07** *(M16)* OpenAI works, via API and Codex CLI
- ⬜ **BACK-08** *(M16)* Gemini works, via API and CLI
- ⬜ **BACK-09** *(M05)* Per-invocation token and cost recorded for every backend, degrading visibly where reporting is unreliable

## Forge Integration — M05 · M09 · M14

- ⬜ **FORGE-01** *(M05)* Branches, change requests and comments through one interface, designed to the narrowest forge's capabilities
- ⬜ **FORGE-02** *(M05)* GitHub works end to end
- ⬜ **FORGE-03** *(M14)* GitLab works end to end
- ⬜ **FORGE-04** *(M14)* Gitea works end to end
- ⬜ **FORGE-05** *(M05)* Draft PR opens at round 1, promoted to ready only when every gate is green
- ⬜ **FORGE-06** *(M05)* Each role maintains one sticky comment, edited in place, prior rounds collapsed
- ⬜ **FORGE-07** *(M09)* A single rollup: what was built, challenged, redone, and how behaviour was verified
- ⬜ **FORGE-08** *(M09)* A coverage table mapping every criterion to the test that verified it
- ⬜ **FORGE-09** *(M09)* The reviewer sees what the feature cost
- ⬜ **FORGE-10** *(M05)* A human approves and merges — ADL never merges
- ⬜ **FORGE-11** *(M09)* Forge side effects survive crashes without duplicating comments or PRs
- ⬜ **FORGE-12** *(M09)* Back off correctly under forge rate limiting rather than being throttled into failure

## Execution & State — M01 ✅ · M03 ✅

- ✅ **EXEC-01** Manager owns detection, queue, state, config, credentials, accounting
- ✅ **EXEC-02** Worker is a separate OS process holding a lease on one feature
- ✅ **EXEC-03** A worker killed mid-loop is detected and recovered, work preserved, burned spend retained
- ✅ **EXEC-04** A resumed zombie worker cannot write stale results over newer state
- ✅ **EXEC-05** Concurrency is configurable; defaults to one feature in flight
- ✅ **EXEC-06** State, rounds, spend and transcripts survive daemon restart
- ✅ **EXEC-07** Adding a harness requires no change to the lifecycle state machine

## Workspace & Trust Boundary — M02 🟡 · M15

- 🟡 **WORK-01** Each feature gets its own git worktree
- 🟡 **WORK-02** Every process launch — including agent CLIs — goes through the workspace exec path
- 🟡 **WORK-03** The workspace backend is swappable for a container/sandbox implementation
- 🟡 **WORK-04** Worktrees and branches are reclaimed after a feature finishes
- 🟡 **WORK-05** Worker runs as a dedicated unprivileged OS user with a per-run scratch home
- 🟡 **WORK-06** Credentials never enter the worker's ambient environment
- 🟡 **WORK-07** Agent-written configuration cannot persist to the host or affect ADL's own git operations
- ⬜ **WORK-08** *(M15)* Writes outside expected paths are detected and surfaced after each round
- ⬜ **WORK-09** *(M15)* Agent output is secret-scanned and size-capped before it reaches a forge
- ⬜ **WORK-10** *(M15)* A published threat model states the trust boundary plainly

> M02's 🟡 is the *milestone's* deferred Linux reproduction, not a per-requirement gap —
> every implementation is merged, tested and CI-green. See [`DEBT.md`](./DEBT.md) § 1.

## Observability & Control — M03 ✅ · M04 ✅ · M06 · M17 · M18

- ✅ **OBS-01** See what every feature is doing right now
- ✅ **OBS-02** Follow a running agent's transcript live
- ✅ **OBS-03** Pause work
- ✅ **OBS-04** Kill a single feature, one repo, or everything
- ⬜ **OBS-05** *(M06)* See spend per feature and per role
- ⬜ **OBS-06** *(M17)* An HTTP API exposes everything the CLI can do
- ⬜ **OBS-07** *(M17)* A web dashboard presents the same information over that API
- ⬜ **OBS-08** *(M18)* Diagnose a broken installation before running a feature through it

## Distribution & Adoption — M18

- ⬜ **DIST-01** Install and reach a first PR without reading past the top of the README
- ⬜ **DIST-02** Observe-only mode — see what ADL would do without it touching anything
- ⬜ **DIST-03** State which forge, backend and runtime versions ADL is tested against

---

## v2 — tracked, not planned

**SCALE-01** one manager, many repositories, with per-repo fairness/quotas/credential
isolation · **SCALE-02** container-per-feature workspace backend · **SCALE-03** concurrency
above 1 as a supported, load-tested configuration · **SCALE-04** remote workers on separate
machines · **ECO-01** issue-to-spec bridge · **ECO-02** harness registry with discovery and
versioning · **ECO-03** cost prediction before a feature runs · **ECO-04** autonomous merge
to an integration branch under an opt-in policy.
