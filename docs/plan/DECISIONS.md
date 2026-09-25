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

**`GateContext` is the published gate contract; `StageContext` is retired.**
There were two candidate gate interfaces, and HARN-04 — _"reviewer and tester are implemented
on the same interface third parties use"_ — cannot be true of both. `StageContext` was the
published one, re-exported by `@adl/plugin-sdk` and taken by `Stage.run`, but four of its nine
members were forward declarations nothing ever supplied and **no production code implemented
`Stage` at all**. `GateContext` was what gates actually took, and the only one carrying
ROLE-03's fresh-context guarantee as a machine-checked member list — a guarantee
`StageContext` structurally could not make while `FeatureView` was opaque, because an
`Exclude<>` assertion over placeholder members proves nothing. So `GateContext` won: it
absorbed the one forward declaration with a real consumer (`StageConfig` → `config`, the
gate's own `with:` block), gained the one capability a published contract cannot do without
(`agents`), and the rest were dropped rather than carried as vocabulary nothing supplies.
**Spend reporting is on the runner, not on the context**: a `reportUsage` member would be a
call a gate could forget, and after M06 a forgotten call is spend that never reaches the
per-feature budget or the global cap — so the manager hands a gate a runner that already
reports, and there is nothing to forget (`DEBT.md`'s D-5-18-1, closed by construction).
(M07 step 7.1, HARN-01/04.)

**A gate declares the view it gets; ADL composes it. Code-blindness is a property of the
workspace on disk, never an instruction to the gate.**
ROLE-06 asks that the behaviour tester _structurally cannot read the implementation_, and the
published contract said the opposite: `GateContext.workspace` is documented as the repository
"already carrying the developer's work", and one workspace per dispatch was handed to
developer and gate alike. Resolving that is M08's one-way decision. A pipeline entry gains
`visible_paths`, a key **ADL itself reads** — `on_send_back`'s precedent, not opaque `with:`
data — and a gate that declares one is handed a composed workspace containing the matches and
nothing else. Omitting the key means what it always meant: attach to the workspace the
previous stage left. The tester is the first declarer and a third party's gate declares the
identical key, which is what keeps HARN-04 true with no branch anywhere on the tester's name.
**ADL does not detect which files are implementation source, and will not**, for the reason
`protected_paths` already records about tests: auto-detecting it is exactly the
non-deterministic guess the schema's `commands` refuse to make.
**The mechanism is a materialised copy with no `.git`, placed outside every repository** —
not a second worktree, and specifically not a sparse checkout, which step 8.0 measured and
found code-blind in appearance only: the working tree is clean of the source and `git
cat-file`, `git show` and a one-command `git sparse-checkout disable` all read it back out of
the main repository's object store. Location is part of the mechanism rather than a
deployment detail, because git resolves a repository by walking _up_ — so a `.git`-less copy
under the default `scratchRoot` (`<repo>/.adl/scratch`) leaks anyway, and `.adl/` being
gitignored changes nothing, because ignore rules are not access control. ADL therefore
**asks git rather than assuming**, before the copy and again after it, and refuses with a
`VisibilityError` rather than handing over a workspace that only looks blind.
**What the gate can reach and where ADL reads facts from are two questions, not one.** The
spec and the diff are gathered from the attached worktree and handed over as data; only
`workspace` narrows. Conflating them made the first composed gate fail before it ran — the
spec was not in the copy and there was no git to diff — and would have made "the tester may
read its own acceptance criteria" the same knob as "the tester's directory contains the spec
file".
(M08 steps 8.0–8.1, ROLE-06, HARN-04.)

**ADL owns the app's lifecycle, and it needs no new port method and no new launcher — an
un-awaited `Workspace.exec` plus an `AbortController` _is_ the handle.**
`ROLE-07` needs `commands.build` → `commands.start` → a readiness probe → `commands.teardown`,
and M08's audit concluded that `Workspace.exec` could not express a long-lived child: `run()`
awaits the child and returns an `ExecResult`, with no handle, no detach and no "running"
state. That left two uncomfortable options — a new `Workspace` method, one-way because
`@adl/plugin-sdk` republishes the port (D-01) and obliging a future container backend to model
a running process; or a third sanctioned launcher inside `@adl/workspace`, which the contract
suite pins at exactly two. **A throwaway probe against the installed execa showed neither is
needed** (convention 15): a server started through the published `exec` is reachable while the
promise is pending, its log chunks arrive live — which is what makes the `log` probe kind
possible at all — and `abort()` reaps the whole tree including a grandchild. So the lifecycle
is composition over the interface that already exists, the port is untouched, and the
launcher count stays at two.
**The probe also found a platform split worth carrying:** on win32 a cancelled child reports
`exitCode: 1` with no signal, which is byte-for-byte what a crashed app returns — so
`command-gate.ts`'s "`exitCode === null` means killed" reading is false there. The lifecycle
never infers it: it holds the controller, so whether it reaped is a fact it knows.
**A gate DECLARES that it needs an app**, `needs_app: true` on the pipeline entry, on
`visible_paths`' precedent — a key ADL itself reads, not opaque `with:` data. Absent is every
pre-M08 pipeline byte-for-byte, which is what keeps the existing fixtures' `start: {argv:
['true']}` inert instead of reading as an app that died instantly; and a third party's gate
declares the identical key, so there is no branch anywhere on the tester's name (HARN-04).
**How a gate learns the port is the same mechanism the app learns it by** — `${ADL_PORT}`
interpolated into its own command's `env` — rather than a new `GateContext` member. Vocabulary
nothing supplies does not get carried; step 8.4's tester agent is the first consumer that
would need one.
**ADL reaps before `commands.teardown`, not after**, and the watched-failing pass is what
settled the order: with teardown first, deleting the abort changed nothing observable, because
the worker exits at the end of a dispatch and execa's own `cleanup` kills the subprocess then.
Reaping first is also the right semantics — ADL reclaims the tree it started, then hands a
repository-supplied teardown command a world that is already stopped — and it lets that
command _witness_ the reap from outside ADL's bookkeeping.
(M08 step 8.2, ROLE-07.)

**Every way the app can fail to be judgeable has one answer, and neither `pass` nor
`inconclusive` is ever it.**
M08's step sketch said an app that never becomes ready yields `inconclusive`. That is wrong in
a way the requirement's own wording hides: `aggregate` maps an `inconclusive` with no
`send_back` anywhere to `unverified`, and `round-step.ts` turns `unverified` into `complete`
plus an `unrecoverable` event — so it wakes a human **immediately and irrecoverably**, for a
lost port race as readily as for a genuinely wedged app. The requirement's load-bearing half
is _"never `pass`"_, and `@adl/core/stage`'s `answerForAppFailure` makes that **structurally
impossible** rather than merely true: `AppFailureAnswer` has three channels — `send_back`,
`stage_error`, `report_only` — and no member through which any `Outcome` can travel.
**Exactly two failures are the developer's round**, and they are the two that are evidence
about the _work_: a build that will not build, and an app that boots and dies. Everything else
is evidence about the machine, the configuration or the operator, and rides a `StageError`,
which `stageErrorPolicy` already promises costs neither a round nor budget. Neither send-back
is certain of its attribution — a `build` command that is itself wrong produces the same
failure — and the asymmetry is deliberate: a wrong send-back costs one round and produces a
finding a human reads on the pull request, while a wrong `StageError` escalates to a human
instead of to the agent that could have fixed it. Prefer the cheap mistake.
**A never-ready app rides `timeout`, which is retryable**, so `planTransientRetry` spends a
real backoff budget before anybody is woken and then escalates _naming what was tried_ — which
is strictly more than a bare `inconclusive` verdict carries. That is why the `inconclusive`
column is empty too.
**A failed `commands.teardown` changes no verdict.** The gate had already judged by the time it
ran, so converting it into a failure would let a cleanup command overturn a correct approval.
It is `report_only`: recorded on the transcript and on the daemon log, and acting on nothing.
(M08 step 8.3, ROLE-07.)

**The behaviour tester is a built-in gate with no privileged path, and the one thing it needs
that no existing mechanism could give it is a port.**
`AGENT_ROLE_PRODUCERS.tester` went from `null` to `'behaviour'` and
`AGENT_GATE_IMPLEMENTATIONS` gained one entry — the same one-line change M06 step 6.10 built
the derivation for and M07 step 7.4 spent. The stage id is `behaviour` and not `test`, because
`test` is the built-in command gate's and `resolvePipeline` refuses a duplicate id: that id is
what verdicts, `stage_attempts` and coverage rows join on.
**Being a fourth built-in made the build refuse to compile until two policies were declared**,
which is finding 8 observed rather than asserted — six errors across
`BUILT_IN_COST_CLASSES` and `BUILT_IN_JUDGEMENT_KINDS`. It is `expensive`, so `on_send_back`
defaults to `stop` and an earlier gate's send-back does not pay to build and boot an app to
judge code already known to need changes. It is **`deterministic`**, which is the sharp one:
`opinion` would let LOOP-09 demote a genuine round-2 regression — caught by a test that ran
and failed — to a follow-up, and ship a broken feature. `deterministic` is only honest because
step 8.6 commits the surviving tests, so a later round **re-runs** them and a re-run failure
has a stable fingerprint. That is why 8.6 is a correctness requirement of the loop rather than
the product nicety the sketch called it.
**`GateContext` gained its first member since M07 step 7.1: `app`, carrying a port.** 8.1 and
8.2 each deliberately added none — code-blindness is a property of what is on disk, and a
_command_ gate learns its port from `${ADL_PORT}` in its own interpolated `env`. An **agent**
gate has no command and therefore no `env`, so it is the first consumer the existing mechanism
genuinely cannot serve. A port and not a base URL, because a URL would make ADL own an
`http://` convention that is wrong for the app with no HTTP surface `ExecReadyProbeSchema`
exists for. `APP_UNDER_TEST_PORT_MEMBERS` governs the nested type for `GATE_DIFF_MEMBERS`'
reason — door 2 reads member _names_, so a `sourceRoot` reaching a gate through `ctx.app`
would be a hole in it, and for this gate a path back to the implementation is the one thing
ROLE-06 withholds.
**ADL does not infer `needs_app` from a stage's name, so the tester refuses without one.** A
pipeline naming `behaviour` with no `needs_app: true` gets a `StageError` naming the key rather
than a tester that verifies nothing and reports a pass. Inferring it would be exactly the
branch on the tester's identity HARN-04 forbids; refusing is the same
be-strict-about-your-own-requirements move the reviewer makes about citing a criterion.
**The tester receives `diff.changedPaths` and its prompt does not use them.** 8.1 flagged the
disclosure to be decided here. Withholding the member _for the tester_ would be a special
case; using it would produce tests about modules instead of tests about behaviour. So the
member stays, the prompt omits it, and a test asserts the absence.
**It does NOT borrow the reviewer's must-cite-a-criterion rule**, deliberately: "the suite ran
and passed" and "AC-3 was verified" are different claims, and enforcing citation before step
8.5 gives a tester's coverage claim any evidence would reward it for asserting coverage it
cannot support.
(M08 step 8.4, ROLE-05, HARN-04.)

**Session resume is an optimisation, never a correctness requirement.**
That single rule is what stops the core quietly becoming Claude-shaped — Gemini's CLI has
no resume and emits one JSON object at completion rather than an event stream.

**Model selection is repo-requestable behind a daemon allowlist; backend selection is not.**
D-22 made both daemon-only. Its rationale — _“a backend the watched repository can choose is
a credential-selection primitive”_ — is about **credentials**, and credentials are `backend`.
A model _within_ an already-chosen backend is a **cost** concern, and cost already has a
clamp mechanism (`limits`). So `agents.<role>.backend` stays in `DAEMON_ONLY_FIELDS` and is
discarded unconditionally, while `agents.<role>.model` is accepted only when the daemon
publishes a `repo_model_allowlist` naming it. **Absent an allowlist nothing changes** — the
field ships closed, and opening it is a deliberate daemon act. D-22 explicitly permits this
direction: _“Loosening it later is trivial; tightening it later breaks adopters’ working
configs.”_ (M06 step 6.11, BACK-10.)

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
