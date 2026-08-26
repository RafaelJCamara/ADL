# Decisions

Settled calls, with the reasoning that settled them. **Read this before proposing an
architecture change** — the point is that these stay settled unless something new is known.

Each entry says what was decided and _why_. Where a decision was taken against contrary
advice, that's noted — because the counter-argument is the thing you'd need to defeat to
reopen it.

---

## Product shape

**The unit of work is a _feature_ — a described behaviour — not a ticket or a diff.**
This is why the tester agent is deliberately blind to code: it judges only whether the
described behaviour is real. Code quality is the reviewer's job, and the two must not blur.

**Human approves and merges the PR. ADL never merges.**
An unattended loop with write access to the target branch is unacceptable for real team
repos in v1. This is a v1 constraint, not a limitation to engineer around.

**The PR comment _is_ the product.**
Rather than requiring anyone to watch the daemon, every agent writes its own summary
comment onto the PR. A reviewer arriving cold reconstructs what was built, what was
challenged, what was re-done, and how behaviour was verified. The value proposition is
measured in _review time saved_ — but the delivered artefact is more code to review, so if
ADL doesn't demonstrably reduce review effort it's negative value regardless of how well
the loop works.

**Dogfooding is the v1 success bar.**
A demo repo can be tuned to pass; ADL's own repo cannot.

**Dogfooding is a hard gate _partway through_, not the finish line.**
Every unit of breadth multiplies the cost of a contract change (~8× once it must propagate
through three forge adapters, four backend adapters and a dashboard). The gate keeps that
multiplier low until the loop is proven.

**v1 is the first public release, so breadth stays in scope.**
⚠️ _Taken against research advice._ All four research passes independently recommended
deferring breadth past dogfooding. The maintainer's call, made with that flag in hand: a
tool advertised as model-agnostic and multi-forge that ships with one of each is not
credible publicly. The compromise is the hard gate above.

**The second agent backend is the sole exception permitted before the gate.**
An adapter interface with one implementation is unfalsifiable. The pair must span the layer
gap — a delegated-loop CLI _and_ an owned-loop raw API. Claude plus an OpenAI CLI proves
much less; GitHub plus GitLab proves less still.

**Tester's tests are committed to the repository.**
Converts throwaway verification into permanent regression coverage the team owns. The
guardrails (assertion floor, spec-clause link, stability runs, mandatory failure against
the pre-feature commit) are what keep that an asset rather than pollution.

---

## Architecture

**Long-running self-hosted daemon, not CI-triggered runs.**
The loop spans many rounds and hours; CI job semantics fit poorly. Teams also keep code and
credentials in-house.

**Manager (control plane) + separate-process workers (execution plane).**
Crash isolation from runaway agents, and it creates the seam where the future sandbox
backend slots in — it becomes "what a worker runs inside", invisible to the manager. The
manager owns everything that must be singular: webhook endpoint, database, queue, per-repo
config, credentials, round and budget accounting. **Forge _reads_ belong to the manager too.**

**Worktree per feature, with the backend behind an interface.**
Cheap and fast at concurrency 1, without foreclosing container isolation.
`networkPolicy` and `resources` are present in the workspace spec from day one with
`'full'` as the v1 value, so a future container backend is a drop-in rather than a
call-site sweep. **This is the one mistake that is expensive to retrofit.**

**All execution routes through `workspace.exec()`.**
The other leak that's expensive to retrofit — a direct `spawn` anywhere means the container
backend can never work. Enforced by lint, with the exemption count _measured_ by a test.

**Concurrency configurable, default 1.**
Matches intended v1 behaviour while making scale-up a config change rather than a redesign.

**Daemon-side database as the state source of truth.**
Rich history, transcripts, and retry/spend accounting without polluting the repo with
status commits.

**The git commit is the checkpoint.**
Agent output is nondeterministic, so replay-style durable execution is impossible.
At-least-once activities with idempotency keys is the only honest semantics.

**The adapter layer is _two_ ports, not one.**
`AgentBackend` for agentic CLIs that own their own loop and tools; `ModelBackend` for raw
model APIs where ADL owns the loop. Agentic CLIs return a diff plus transcript plus cost;
raw APIs return one assistant turn. One interface over both means either a
lowest-common-denominator adapter or rebuilding Claude Code. **Conflating them would cost
the project.**

**Session resume is an optimisation, never a correctness requirement.**
That single rule is what stops the core quietly becoming Claude-shaped — Gemini's CLI has
no resume and emits one JSON object at completion rather than an event stream.

---

## Loop and safety semantics

**Six-outcome verdict schema, defined before any agent role existed.**
`pass` / `send_back` / `fail` / `inconclusive` / `warn` / `skip`. `pass/fail/send_back`
alone cannot express "I could not verify", which becomes a false green. And without an
honest "this gate is wrong" exit, the agent is effectively forced to cheat.

> **The dominant risk class is silently-wrong-but-green, and it's measured, not
> theoretical.** ImpossibleBench found frontier models exploit conflicting tests up to 76%
> of the time, with Claude-family models specifically preferring to _modify the tests_ —
> exactly what committing agent-authored tests exposes. The same work found the mitigation:
> an honest escalation exit cut cheating from 92% to 1%. That is why the verdict schema and
> protected paths are M01 contracts rather than later hardening.

**Acceptance-criterion IDs are the join key.**
Without them the product cannot answer "was every criterion actually verified" — and
retrofitting means re-running every agent prompt.

**Gate pipeline is data, not lifecycle states.**
If adding a harness requires a state-machine change and a migration, "pluggable harness" is
decorative.

**Reviewer and tester are built on the harness interface, not special-cased.**
Two real consumers shape the plugin interface; special-casing ships it shaped around a
hypothesis.

**Dual limits: max rounds _and_ cost budget.**
Developer/reviewer disagreement can loop indefinitely. Rounds alone miss expensive stalls;
budget alone misses cheap ones.

**Check the budget _before_ dispatching the next agent turn, never after.**
A check-after design overshoots by one full agent run. At Opus rates on a long turn that is
real money, and it will be the first bug a user reports.

**Sticky per-role PR comments, draft PR from round 1.**
Four gates over five rounds is twenty comments — the AI-slop pattern maintainers are
revolting against, and the exact shape GitHub's secondary rate limiter penalises.

**Escalate to a human rather than arbitrate.**
No multi-agent debate to resolve stalemates: cheaper, more honest, and doesn't risk two
agents agreeing on something wrong.

**Core vocabulary is forge-neutral.** `ChangeRequest`, never `PullRequest`.

**GitLab is the second forge; the interface is designed around Gitea.**
GitLab is genuinely different, so it forces the abstraction honest. Gitea has the narrowest
API, so it sets the interface floor — top-level comments only, no line-level diff comments,
no review updates.

**The installed `adl` binary is published by `@adl/manager`, not `@adl/cli` (5.7).**
M03 fixed "two packages, one binary" (the historical `D-21`) but left _which_ package
carries the executable open — `@adl/cli`'s own package.json states it "structurally cannot
resolve `@adl/db` or `@adl/manager`" (pnpm strict `node_modules`), and the repo-wide
`adl/no-direct-spawn` lint rule has no carve-out for it either, so `@adl/cli` alone can
neither import the manager nor shell out to it. `@adl/manager` now depends on `@adl/cli` as
a library (never the reverse) and ships `packages/manager/src/bin.ts` as the real `adl`
executable: every verb except `daemon start` is `@adl/cli`'s own unmodified, HTTP-only
`buildProgram`; `daemon start` alone gets `@adl/manager`'s `createProductionDaemonStartRunner`
injected into it as `BuildProgramDeps.startDaemon`, the same dependency-injection seam
`loadConfig`/`createClient` already use for tests. `@adl/cli` itself is unchanged and
untouched by this — still zero dependency on `@adl/manager`/`@adl/db`, still publishable and
importable on its own as a library. The alternative (a third, thin dispatcher package
depending on both) was rejected as unnecessary machinery for a solo project: it would only
buy back the ability to install `@adl/cli` alone as a binary, which is not a documented v1
requirement anywhere in the plan. **Reversibility: costly** — the package that owns the
published executable's name is a distribution-facing choice.

---

## Stack

Full detail and version pins live in `.claude/CLAUDE.md`. The load-bearing ones:

**TypeScript 6.0.3 — exact pin. Do not move to TypeScript 7 yet.**
`typescript-eslint@8.x` declares a peer of `>=4.8.4 <6.1.0`. TS 7 breaks it, and ESLint
core, ts-jest and ts-morph are all blocked on the missing programmatic API until 7.1.
**This is the single hardest constraint in the stack**, and a root test asserts it.

**Kysely with hand-written SQL migrations — _not_ Drizzle.**
Drizzle's stable release is still pre-1.0 with an RC pending; choosing it would schedule a
known breaking migration into a nights-and-weekends project. ⚠️ _Note: `.claude/CLAUDE.md`'s
research section still recommends Drizzle. It is stale on this point — **Kysely is settled,
and no Drizzle migration phase exists or should be added.**_

**SQLite plus a hand-rolled lease table. No Redis, no queue library.**
Concurrency defaults to 1 and jobs run for hours, so throughput is irrelevant. Redis would
be a hard install prerequisite for a tool pitched as "drop a daemon on your box".

**Hono over Express/Fastify.**
Web-standard `Request`/`Response` makes raw-body access for webhook HMAC verification
trivial (`await c.req.arrayBuffer()`) — the #1 webhook security footgun, solved by the
framework choice. `streamSSE` is built in.

**SSE, not WebSocket.**
Server→client only; survives corporate proxies; reconnects per spec via `Last-Event-ID`;
`curl`-able.

**`child_process.fork()` for the manager→worker seam — not `worker_threads`.**
A shared process means a runaway agent OOM takes the manager down, defeating the stated
crash-isolation rationale.

**`simple-git` + the real git binary — not isomorphic-git.**
isomorphic-git fails on git worktrees (`.git` as a file → "could not resolve reference"),
and worktree-per-feature is a core requirement.

**No bundler.** Node ESM + `"module": "nodenext"` means `tsc` output runs directly. The
dashboard's Vite build is the only bundling in the project.

**Never use `tiktoken` / `gpt-tokenizer` to estimate Anthropic tokens.**
Wrong tokenizer — undercounts by ~15–20% on prose and far more on code. The budget gate
would be systematically wrong. Use backend-reported usage or `messages.countTokens()`.

**Model prices live in a versioned table with `effective_from`, never in code.**
A price change in code silently rewrites historical spend and breaks budget audits.

**Model IDs are bare aliases with no date suffixes.** Date-suffixed IDs will 404.

---

## Explicitly out of scope for v1

Deploying or releasing code · authoring feature specs · provisioning infrastructure for the
app under test · hosting or fine-tuning models · ADL merging to the target branch ·
container-per-feature isolation · multi-repo fleet management · competing with dedicated AI
review products (consume them as harnesses) · building a code-graph index · multi-agent
debate · self-healing flaky tests · auto-detecting build and run commands · rebuilding LLM
observability · harness registry / discovery / versioning / marketplace · issue-to-spec
bridging · cost prediction.
