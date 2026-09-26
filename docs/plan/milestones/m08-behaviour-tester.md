# M08 — Behaviour Tester & Committed Regression Tests

**Status:** ◀ **IN PROGRESS**
**Depends on:** M07
**Requirements:** ROLE-05…10 (6)

**Goal:** behaviour is verified by an agent that _structurally cannot read the
implementation_, against an app ADL starts and tears down itself, leaving tests the team
keeps.

> Simultaneously the highest-leverage feature and the highest-risk one. Thirty features
> means thirty batches of tests the team did not write — the guardrails below are what
> keep that an asset instead of pollution.

> **What a pre-implementation audit found before writing a single step** (2026-09-24, the
> same discipline M06 and M07 opened with). It **contradicts the original sketch in three
> places**, re-scopes two more, and finds one step the sketch does not have at all — each
> corrected below.
>
> **1. The published gate contract says the workspace carries the developer's work.
> ROLE-06 says the tester's must not. That contradiction is this milestone's one genuinely
> one-way decision, and it is 8.1.** `GateContext.workspace` is documented as _"the
> repository, at the commit under judgement — **already carrying the developer's work**,
> because a stage attaches to the workspace the previous stage left rather than branching
> afresh (M05 step 5.14)"_, and `worker-entry/stage-runner.ts` implements exactly that:
> `(await backend.attach(spec)) ?? (await backend.create(spec))`, **one** workspace per
> dispatch, handed to developer and gate alike. So a tester whose workspace lacks the
> implementation is either a second workspace — which nothing in this system can currently
> hold — or a special case, which HARN-04 forbids. **The decision to record in
> `DECISIONS.md`:** a pipeline entry _declares the view its gate gets_ and ADL composes it,
> the same way `on_send_back` is a pipeline-entry key ADL itself reads rather than opaque
> `with:` data. The tester is the first gate to declare one; a third party's gate declares
> the identical thing. The alternative — a `GateContext` member the tester reads and
> honours — puts code-blindness in the gate's own hands, which is _"merely forbidden by
> instruction"_ and is the one thing criterion 1 rules out.
>
> **2. ADL cannot know which files are "implementation source", and has already decided
> never to guess.** `protected_paths`' own schema text settles it: _"Auto-detecting which
> files 'are tests' is exactly the non-deterministic guess this schema's `commands` already
> refuse to make, so this list is explicit by design too."_ The same reasoning forbids
> auto-detecting source, so 8.1 is an **allowlist**, never a subtraction. And the allowlist
> is bigger than the sketch's four items: a workspace holding only the spec, the test
> directory and `adl.yml` **cannot run a test runner** — no `package.json`, no lockfile, no
> runner config, no installed dependencies. What the sketch calls "the test directory" is
> really "everything the suite needs and nothing the suite is judging", and that set is the
> repository's to declare. `@adl/core/loop`'s `matchesGlob` already exists and is what
> matches it (convention 8 — it is not re-implemented).
>
> **3. One worktree per feature is baked into the branch name, the GC sweep and DETECT-05's
> reconciliation.** `createWorktree` runs
> `git worktree add -b <branch> --end-of-options <path> <baseRef>` at
> `<scratchRoot>/<featureId>`, one branch per worktree, and 5.6's
> `composeBranchFeatureId` (`adl/<folderName>--<ulid>`) is what GC's
> `createFeatureStateLookup` and `undevelopedFeatures` read identity back out of. A
> **second concurrent workspace per feature** is what 8.1 needs for the code-blind view and
> what 8.8 needs for the pre-feature commit — and it is a change to that convention, not a
> new call site. If GC cannot see it, ADL leaks a worktree and a branch per feature per
> round. `create()` also refuses a path that already exists, deliberately, so the second
> workspace needs its own spec identity rather than a reused one.
>
> **4. Three of `adl.yml`'s four required commands have no consumer at all, and neither
> does the interpolation contract 8.2 runs on.** `CommandsSchema` requires all four of
> `build` / `start` / `test` / `teardown`; only `commands.test` is ever read
> (`stage-runner.ts`, for the built-in `test` gate). `commands.build`, `commands.start` and
> `commands.teardown`: **zero production readers.** `@adl/core/config`'s `interpolate()` and
> `ADL_VARIABLES` — which is where `ADL_PORT` is _defined_ — likewise have zero production
> callers. The readiness contract is also richer than the sketch implies: **four** probe
> kinds (`http`, `tcp`, `log`, `exec`), `ready`/`ready_timeout` both-or-neither,
> `${ADL_PORT}` documented in the schema as _"the one place this schema documents
> ADL-provided interpolation"_. So 8.2 needs **no schema work** and every existing fixture
> already declares the commands — but it is also the first time ADL has ever installed
> dependencies or started a server, and it does both **per worktree**.
>
> **5. `Workspace.exec` cannot start a server, and the launcher is _counted_.** `run()`
> awaits the child and returns an `ExecResult` carrying a `durationMs`; there is no handle,
> no detach, no "running" state. `commands.start` is therefore inexpressible through the
> published port as it stands, and `Workspace` is republished by `@adl/plugin-sdk`, so
> adding a method is a one-way signature change (D-01). The exemption is measured, not
> argued: `packages/workspace/test/contract/workspace-contract.test.ts` pins the exact list
> of modules importing `exec/run.js` to four, so a new launcher is a deliberate red-test
> diff line and an argument, exactly as designed.
>
> **6. `inconclusive` is not a soft outcome in this codebase — it ends the feature.**
> `aggregate` maps an `inconclusive` with no `send_back` anywhere to `unverified`, and
> `loop/round-step.ts` turns `unverified` into `{ kind: 'complete' }` plus an
> `unrecoverable` event. So the sketch's _"never-ready → `inconclusive`"_ escalates to a
> human **immediately and irrecoverably, with no retry**. Meanwhile `timeout` is a
> `StageError` that is `retryable: true`, `consumesRound: false`. The requirement's
> load-bearing half is _"never `pass`"_, and both satisfy it — but an app that never boots
> **because the developer's code crashes** wants a `send_back`, one that never boots because
> `commands.start` is wrong wants the operator, and one that lost a port race wants a retry.
> A single mapping cannot serve three causes, and the sketch picks one silently.
>
> **7. A gate cannot commit — and if it could, the protected-path check would attribute its
> commit to the developer in the next round.** `GateContext` has no commit member and
> `DeveloperOutcome`'s `committed` is the only commit channel in the system. Worse:
> `round-runner.ts` calls `recordRoundHeadSha` with the **developer's** sha, before any gate
> runs, and `checkProtectedPaths` then diffs `latestClosedRound.head_sha ... committedSha`.
> A gate's commit lands _after_ round N's recorded head sha, so it appears in round N+1's
> diff **as the developer's work**. With `protected_paths: ['tests/**']` — the schema's own
> worked example, and the ROLE-11 configuration this milestone is what makes necessary —
> the tester's own committed tests hard-fail the following round. And
> `violatedProtectedPaths` flags **anything** inside the feature folder unconditionally, so
> the demarcated location structurally cannot live under `features/<id>/`. Two constraints
> on 8.6 the sketch does not mention, and the first is a defect waiting for the natural
> configuration — reachable on `main` today through 7.3's plain-command gate, and
> recorded as `DEBT.md`'s **D-8-A-1**, owner 8.6.
>
> **8. The tester is a fourth built-in, and the build will refuse to compile until it
> declares two policies. The sketch has no step for that.** `BUILT_IN_STAGE_IDS` is
> `['develop', 'review', 'test']`, and `BUILT_IN_COST_CLASSES` and
> `BUILT_IN_JUDGEMENT_KINDS` each carry an `Exclude<>` assertion whose docblock says a
> fourth built-in **fails the build** rather than silently inheriting a default. The wiring
> itself is the one-entry change 6.10 was built for and 7.4 spent:
> `AGENT_ROLE_PRODUCERS.tester` is `null` and `AGENT_GATE_IMPLEMENTATIONS` is
> `{ reviewer: runReviewerGate }`, whose docblock already names _"the honest state of
> `tester` until M08"_. But the stage id **`test` is taken** —
> `GATE_IMPLEMENTATIONS = { test: 'command' }` — and `resolvePipeline` rejects a
> duplicate id, so the tester needs
> its own — and `judgementKindOf` is the interesting half. `review` is `opinion`, `test` is
> `deterministic`, and the tester is an agent whose verdict comes from **executed tests**.
> Classify it `opinion` and LOOP-09 demotes a genuine round-2 regression to a follow-up —
> a broken feature ships. Classify it `deterministic` while the tester re-invents its tests
> every round, and every round produces a new fingerprint, so the feature loops to
> `max_rounds`. **The resolution is that 8.6 is not a product nicety — it is what makes
> `deterministic` honest:** a committed test is _re-run_, so its fingerprint is stable, and
> the tester stops being a fresh opinion every round.
>
> **9. 8.9's reporting surface is M09's, and the number is not the one already recorded.**
> `stage_attempts` already carries `started_at` / `ended_at`, so a gate's wall-clock is
> recorded — but that includes model time and is not suite time, and a _delta_ needs the
> suite timed with and without the new tests. Meanwhile M09's own criteria own the rollup,
> the criterion coverage table and cost-on-the-PR. So this step **records and exposes** the
> delta on the `usage_events` precedent (per-feature accumulation, `adl status`, the HTTP
> API) and deliberately leaves PR rendering to M09 steps 9.3–9.5; 8.7's spec-clause link is
> what populates M09's coverage table for tests.
>
> **10. No acceptance criterion here is credential-bound — the first milestone since M03
> where that is true — and the reflex to assume one is would be wrong.** All five criteria
> are structurally provable against the replay doubles M01–M07 already use: an absence is
> observable, a port is observable, a guardrail is deterministic, and a test that must fail
> against the pre-feature commit either does or does not. **What is not provable against a
> double is whether a _real_ code-blind tester writes behaviour-relevant tests at a useful
> rate** — the double writes what the fixture says, so a green corpus would measure the
> fixture. That is the research the milestone's own notes flag, and it is a **spike whose
> output is a decision**, not a sixth acceptance criterion. M08 can therefore close fully
> code-complete, and 8.0 exists so the spike happens before 8.4 rather than instead of it.

---

## Done when

- [ ] The tester designs and runs tests from a workspace containing only the spec, the
      test directory, `adl.yml`, and the running app. **The implementation source is
      _absent_, not merely forbidden by instruction.**
- [ ] ADL builds, starts, probes and tears down the app itself on an allocated port and
      reaps the process group. An app that never becomes ready yields `inconclusive`,
      never `pass`.
- [x] Test outcomes are read from structured runner output, and a run in which zero tests
      executed reports `inconclusive`, never `pass`.
- [ ] The tester's tests land in the repository as permanent regression coverage the team
      owns, in a demarcated location, with the added suite-time delta reported.
- [ ] A committed test survives only if it meets the assertion floor, names the spec
      clause it covers, passes repeated stability runs, **and fails against the pre-feature
      commit.**

---

## Steps

Refined from the sketch by the audit above (2026-09-24). Ordered so the one-way decision
lands **first** — 8.2 through 8.9 all consume it — and so the tester is built only after
the app it judges can actually be started. The sketch's numbering is preserved through 8.6;
8.7 is split because its fourth guardrail needs 8.1's mechanism and is worth its own
watched-failing proof, which pushes the suite-time delta to 8.9.

**8.2 is the tracer slice** (convention 14). It is the first cross-process path through
every layer this milestone touches — a real daemon, a real allocated port, a real app built
and started and probed and reaped — and it is deliberately proven _before_ any agent, any
code-blindness and any commit exist.

- [x] **8.0** — **The code-blind tester spike** — done, 2026-09-24. Its output is
      [The 8.0 spike record](#the-80-spike-record-2026-09-24) below rather than this file's
      Notes, because it is longer than a note and 8.1 consumes it directly. It answered the
      empirical question it was written for and **the answer revised finding 3**: a second
      worktree with a sparse checkout is _not_ code-blind, so 8.1's mechanism changed before
      a line of it was written. Probes were throwaway, run against real git 2.49 and real
      node 24 per convention 15, and deleted.
- [x] **8.1** — **A gate declares the view it gets, and ADL composes it** (ROLE-06,
      findings 1–3). The one-way decision: a pipeline entry gains a key ADL itself reads —
      `on_send_back`'s precedent, not opaque `with:` data — declaring the repo-relative
      allowlist its gate's workspace contains. The tester declares one; every other gate
      declares nothing and gets today's behaviour byte-for-byte. Greenfield underneath, and
      **8.0 settled what it is**: a second, concurrently-live workspace per feature that is
      a **materialised copy of the allowlist with no `.git`**, placed **outside any git
      repository's working tree** — not a second worktree, and not a sparse checkout, both
      of which the spike proved are code-blind in appearance only. It needs its own spec
      identity and must be visible to the GC sweep, and it is composed by path allowlist
      (`matchesGlob`, not a second matcher). `GateContext` gains **no** new member and
      `GATE_CONTEXT_MEMBERS` does not move — code-blindness is a property of what is on disk
      under `Workspace.root`, never something the gate is asked to honour. **Must prove:**
      the implementation source is absent from the tester's root while the spec and the
      suite's own prerequisites are present; that `git cat-file`, `git show` and
      `git sparse-checkout disable` all fail from inside it; and that GC reclaims both
      workspaces. Prove the absence **from outside ADL** — 7.5 and 7.9's pattern, a double
      that walks its own root and writes what it found to a report file, so the evidence
      does not come from ADL's own bookkeeping.
      **Done, 2026-09-24.** `visible_paths` on the pipeline entry,
      `selectVisiblePaths` in `@adl/core/stage` (pure, and reusing `matchesGlob` rather
      than growing a second matcher), `composeVisibleWorkspace` in `@adl/workspace`, and
      the wiring in `stage-runner.ts`. `GateContext` gained no member, as promised.
      Proven twice: `packages/workspace/test/visible/compose.test.ts` runs the real
      `cat-file`, `show`, `log` and `sparse-checkout disable` against a composed workspace
      and requires every one of them to fail, and
      `packages/manager/test/scenario/gate-visible-paths.test.ts` drives a real daemon
      whose gate is a plain program that walks its own cwd and reports what it found to a
      file outside every workspace. **Watched failing five ways**, listed below. > **8.1's finding, and the end-to-end proof is what found it.** `buildGateContext` > read the spec **and the diff** out of the gate's own workspace, so pointing > `workspace` at a blind copy pointed the spec load and `managerGitClient` at it > too: the first composed gate died `unparseable` before it ran, because the spec > was not in the copy and there was no `.git` to diff. The workspace-level tests > were all green at the time — this is only visible end to end. The fix is the > distinction the design was missing: **what a gate can reach and where ADL reads > facts from are two questions.** `buildGateContext` gained a `repository` input, > defaulting to `workspace` so every pre-M08 caller is untouched; `spec` and `diff` > come from the attached worktree and are handed over as data, and only `workspace` > narrows. Worth keeping for 8.4: the tester still receives `diff.changedPaths`, > which **names** the implementation files without containing them — a deliberate, > bounded disclosure that 8.4 should decide about explicitly rather than inherit. > > **Watched failing five ways.** Copying `.git` along with the allowlist (caught by > a case that had to be _added_ — the first injection changed nothing, because the > allowlist filtered `.git` out anyway, which is how the greedy-glob case came to > exist). Dropping the pre-copy location check (the rejection still happened; what > went red is "nothing was copied first"). Dropping the cwd guard. Defaulting an > absent `visible_paths` to `[]`. And handing the gate the sighted worktree, which > is the wiring defect the whole scenario exists for. > > **Found and not fixed:** `D-8-01-1`. The contract suite's comment stripper runs > its block-comment regex first, so a `//` line containing `/**` silently deletes > the rest of the file before the cwd-guard rule reads it — which is how a guard > that was present got reported as missing here, and how a guard that is genuinely > missing could be reported as present. Owner 8.2.

- [x] **8.2** — **The app lifecycle ADL owns** (ROLE-07, findings 4–5). **The tracer.**
      `commands.build` → `commands.start` → the readiness probe → `commands.teardown`, on
      an ADL-allocated port reaching the app through `${ADL_PORT}` and `interpolate()` —
      all of which are built, required by the schema, and have never had a caller. All four
      probe kinds, not three. The lifecycle belongs to **the gate that needs it**, on
      `commands.test`'s own precedent (_"`commands.test` is none of its business"_ for every
      other gate) — which is also what keeps it inert for the existing fixtures whose
      `start` is `{ argv: ['true'] }` and would otherwise read as an app that died
      instantly. Decide and record whether starting a long-lived child is a new `Workspace`
      method (one-way, D-01) or a launcher internal to `@adl/workspace`; either way the
      contract test's four-importer pin is a deliberate line in the diff. **Must prove:**
      the process group is reaped — no orphan survives the round — against a real daemon,
      with the platform gate visible (`test/helpers/platform.ts`), and with D-2-07-1's
      privilege-drop limitation stated rather than quietly inherited.
      **Done, 2026-09-25.** `appVariables` / `interpolateCommandEnv` / `interpolateReadyProbe` in `@adl/core/config` (pure, and the first production caller `interpolate()` and `ADL_VARIABLES` have ever had); `needs_app` on the pipeline entry and `ResolvedStage.needsApp`; `worker-entry/app/port.ts`, `probe.ts` (all four kinds) and `lifecycle.ts` in `@adl/manager`; and the wiring in `stage-runner.ts`, which now runs the gate through one `runGate` callback so the `needs_app` path cannot grow a second copy of the agent/command branch. Proven by `packages/manager/test/scenario/gate-app-lifecycle.test.ts` — a real daemon builds a real app, starts it on an allocated port, waits for a real `http` probe to answer 200, runs a gate that fetches it over the loopback, then reaps the tree — plus unit suites for the pure module, the four probe kinds and the allocator. **Every assertion reads a file written by a program that is not ADL**, 7.5/7.9/8.1's pattern. **The decision, and the probe that overturned the step's own premise.** Finding 5 said `Workspace.exec` cannot start a server, so the step was written to choose between a new `Workspace` method (one-way, D-01) and a third sanctioned launcher (which convention 1 says turns the contract guard red). **Neither was needed.** A throwaway probe against the installed execa measured that an un-awaited `exec` promise plus an `AbortController` already IS the handle: the server is reachable while the promise is pending, log chunks arrive live — which is what makes the `log` probe kind possible — and `abort()` reaps a grandchild. The port is untouched, the launcher count is still two, and **the contract suite's importer pin did not move at all**, which the step expected to be a deliberate diff line. **A platform split worth carrying to 8.3.** On win32 a cancelled child reports `exitCode: 1` with **no signal** — byte-for-byte what a crashed app returns — so `command-gate.ts`'s "`exitCode === null` means killed" reading is false there. The lifecycle never infers it: it holds the controller, so `AppTeardown.reaped` is a fact rather than a reading. **How a gate learns the port is the same mechanism the app does** — `${ADL_PORT}` in its own command's `env` — and **not** a new `GateContext` member. `gate-context.ts`'s own discipline is that vocabulary nothing supplies is not carried; 8.4's tester agent is the first consumer that would need one, and it is 8.4's to add. **The watched-failing pass changed the design.** Five injections were run. Skipping `commands.build` and skipping `commands.teardown` each turn the phase- order assertion red; not interpolating the gate command's env turns it red with the literal unsubstituted variable in the failure message; ignoring the declared `needs_app` turns it red because no app was ever started. The fifth — **deleting `controller.abort()` — left the test GREEN**, and that is the finding: the worker exits at the end of a dispatch and execa's own `cleanup` kills the subprocess then, so the assertion was measuring execa rather than ADL. The fix is an ordering change with an argument behind it: **ADL reaps the tree it started FIRST, then runs `commands.teardown`**, which is both the right semantics (a repository's teardown should not remove the database out from under a still-running app) and what lets that repository- supplied command _witness_ the reap while the worker is still alive. With the witness in place the injection goes red. **Found and not fixed: three items.** `D-8-02-1` — a `tcp` probe's `port` is an `int`, so an app on an allocated port cannot be tcp-probed at all. `D-8-02-2` — a declared `start.timeout` is a ceiling on the app's whole lifetime, and the schema's own worked example sets `start: 2m` beside `test: 15m`. Both owner 8.3. `D-8-02-3` — `killDescendants: true` cannot be watched failing on win32: setting it to `false` and rebuilding left the tracer green, measured twice, because the platform reaps the subtree without it; it is the section-1 deferred batch's new check 1.9, to run on Linux CI. **And `D-8-01-1` is closed**, which this step owned. The contract suite's two inline comment strippers became one left-to-right scanner in `workspace/test/helpers/source-scan.ts`, and the cwd-guard predicate moved there as `callsCwdGuard` so it can run over a synthetic module — the only way to write the fixture the debt asked for. Watched failing four ways against the restored block-first pair, including the inverse direction the debt named. That pass also **corrected the fixtures**: the first version was green against the defect, because the lazy block regex closed immediately on a line comment containing the four-character opener-plus- closer run, so every fixture now ends its line on the opener — the shape 8.1's real comment had.

- [x] **8.3** — **Every way the app can fail to be judgeable, mapped once** (finding 6).
      Not _"never-ready → `inconclusive`"_: `inconclusive` completes the feature as
      `unrecoverable`, so that mapping escalates on a port race. The step's content is the
      table — app never ready, probe timed out, build failed, runner binary missing,
      teardown failed — each to a `send_back`, an `inconclusive`, or one of the five
      `StageErrorKind`s, with `retryable` / `consumesRound` / `consumesBudget` following
      from the existing policy rather than being restated. `timeout` is retryable and costs
      no round, which is the honest first answer for a transient never-ready;
      `inconclusive` is where the retry budget runs out. **Must prove:** the `pass` column
      of that table is empty — no failure mode reaches `pass` — and that a never-ready app
      is retried before a human is woken.
      **Done, 2026-09-25.** `answerForAppFailure` in `@adl/core/stage` (`app-failure.ts`) is the table, with the seven-row matrix in its own docblock; `worker-entry/app/failure-outcome.ts` dresses one row in the failure's own words; and `stage-runner.ts` replaced 8.2's single conservative `provider_error` — whose own comment named this step as its replacement. **The `pass` column is empty structurally, not by assertion**: `AppFailureAnswer` has three channels and no member through which any `Outcome` can travel, so convention 9 does the work a mapping test would otherwise be trusted with. The `inconclusive` column is empty too, and that took an argument rather than a type — the escalation the sketch wanted `inconclusive` for already exists and is better, because `planTransientRetry` escalates _naming what was tried_. **Exactly two rows are `send_back`** and they are the two that are evidence about the work: a build that will not build, and an app that boots and dies. Everything else is the machine, the configuration or the operator. Proven by `core/test/stage/app-failure.test.ts` (the table, 10 cases), `manager/test/worker-entry/app/lifecycle.test.ts` (6 cases against a stub workspace, because a string comparison should not cost a worktree and a fork), and `manager/test/scenario/app-failure-modes.test.ts` — three real-daemon cases, one per channel. **A test caught a real bug in this step's own code**: the `send_back` path serialised the bare `Verdict` instead of the `kind: 'verdict'` envelope, and the round came out `escalate` rather than `send_back` because the supervisor could not recognise it. **Watched failing seven ways.** In `@adl/core` (each with a `tsc -b` rebuild in between, per trap 1): `build-failed` mapped back to `provider_error` — two pure cases red and the scenario red with `escalate` where `send_back` belonged; `never-ready` mapped to a non-transient kind — the pure case red and the scenario red after waiting out its whole 90s budget for a second attempt that never came; and a fourth channel added that CAN carry `pass`, which **fails the build** at the consumer and turns two pure cases red as well — two layers, as intended. In `@adl/manager`: a failed teardown converted into a `StageError`, which turns a correct `green` round into a failure and is exactly what `report_only` exists to prevent; the D-8-02-2 comparison disabled; and the warning-emitting loop deleted — **that last one initially passed**, which is how it was found that the loop had no end-to-end coverage at all, so the build-failure scenario now declares a short `start.timeout` and asserts the warning reaches the transcript. **Two debts closed, one opened.** `D-8-02-1`: a `tcp` probe's port accepts a bare `${ADL_PORT}` reference, and `interpolateReadyProbe` answers with a `ResolvedReadyProbe` — a real type distinction, since a declared probe may carry a variable and a resolved one cannot. `D-8-02-2`: closed, but not in the shape proposed — the semantics were kept, the schema's worked example fixed, and the warning put in the lifecycle rather than at boot, because at boot there is no gate yet and so no number to compare against. `D-8-03-1` opened: `gracefulShutdown` destroys the database without awaiting an in-flight dispatch, which the never-ready case surfaced as an intermittent unhandled rejection; mitigated in the test with a settle window and owned by M09.

- [x] **8.4** — **The tester agent** (ROLE-05, finding 8). One entry in
      `AGENT_ROLE_PRODUCERS` (`tester: null` → its stage id) and one in
      `AGENT_GATE_IMPLEMENTATIONS`, on `runReviewerGate`'s shape: compose a prompt, run
      through `GateContext.agents` (already spend-reporting, D-5-18-1), read a verdict from
      `.adl/<stage>-verdict.json`, every way of not producing one a `StageError`. The stage
      id cannot be `test`; `behaviour` is the recommendation — the milestone's own name, and
      it does not collide with the verdict vocabulary the way `verify` would. The fourth
      built-in **fails the build** until it declares a cost class (`expensive` → `stop`, as
      an agent stage) and a judgement kind (`deterministic`, per finding 8, with 8.6 as what
      makes that honest). **Must prove:** no branch gives the tester anything a third
      party's gate would not also get — HARN-04 as code — and that `adl/gate-fresh-context`
      lints the new module clean.
      **Done, 2026-09-25.** `worker-entry/gates/tester-gate.ts` on `runReviewerGate`'s shape, plus the one-entry wiring 6.10 was built for: `AGENT_ROLE_PRODUCERS.tester` from `null` to `'behaviour'` and one row in `AGENT_GATE_IMPLEMENTATIONS`. **Finding 8's build-failure claim was observed, not assumed** — adding `behaviour` to `BUILT_IN_STAGE_IDS` before declaring anything produced six compile errors across `BUILT_IN_COST_CLASSES` and `BUILT_IN_JUDGEMENT_KINDS`. It declares `expensive` (so `on_send_back` defaults to `stop`) and `deterministic`, with 8.6 as what makes the second honest. **`GateContext` gained `app`, its first new member since 7.1**, and the reason it lands here rather than in 8.1 or 8.2 is that a command gate reads its port from `${ADL_PORT}` in its own interpolated `env` and an agent gate has no command — it is the first consumer the existing mechanism cannot serve. A port and not a base URL, because a URL would make ADL own an `http://` convention that is wrong for the app with no HTTP surface `ExecReadyProbeSchema` exists for; `APP_UNDER_TEST_PORT_MEMBERS` governs the nested type for `GATE_DIFF_MEMBERS`' reason. **The tester refuses to run without an app**, naming `needs_app: true`, because ADL does not infer it from a stage's name — that would be the branch on the tester's identity HARN-04 forbids. **8.1's carried disclosure is decided:** `diff.changedPaths` stays on the contract (withholding it for the tester alone would be a special case) and the **prompt does not use it**, because a tester told which module changed writes tests about a module. A test asserts the absence. **It deliberately does not borrow the reviewer's must-cite-a-criterion rule** — "the suite ran and passed" and "AC-3 was verified" are different claims, and 8.5 is where a tester's coverage claim gets evidence. **Proven three ways.** `manager/test/worker-entry/tester-gate.test.ts` (10 cases, including the two prompt properties a scenario can only see indirectly); `manager/test/worker-entry/harn-04-no-privileged-gate.test.ts` — **HARN-04 as code**, a source-level guard over `stage-runner.ts` catching the exact harmless-looking edit that would give the built-in tester a richer context than a third party's gate (7.9's removal proof cannot see that, because the gate it removes is the one that would notice); and `manager/test/scenario/behaviour-tester.test.ts`, where a real daemon builds and starts a real app, composes a blind workspace, and dispatches the agent into it — the first time 8.1, 8.2 and 8.4 all run together. The replay double reads the base URL out of its own instructions, **really fetches it**, walks its own root, and only emits a `pass` if the app answered; so reachability and blindness are measured from opposite ends at once. **Watched failing three ways**, plus the build-failure observation above: a banned import added to the new module (`adl/gate-fresh-context` red, naming the prompt builder); the command gate handed `built.gate` instead of the composed context (the HARN-04 guard red twice); and the no-app refusal disabled (the unit case red **and** the compiler red on `gate.app` possibly undefined — two layers). **And one real regression, which is the most useful thing this step produced.** Adding
      `behaviour → tester` to `AGENT_GATE_ROLES` made two lookups in `resolveStageRole`
      collide for the first time, and the pre-existing order resolved it the wrong way
      round: the agent-role lookup ran before the `source: 'command'` check, so four
      existing scenario tests whose third-party gate is _named_ `behaviour` — an arbitrary
      name, which is exactly what HARN-02 promises is allowed — were suddenly dispatched
      into the built-in tester instead of running their own program. The function's own
      docblock had predicted the collision and picked the wrong winner. The entry's
      declaration of what it runs beats ADL's name for one of its built-ins, which is the
      order `resolvePipeline`'s `declaresCommand` already uses. Fixed, and guarded by a
      source-order assertion watched failing by swapping the two lookups back — the four
      scenarios catch it only by accident, and would stop the day somebody renamed a
      fixture gate. **One finding worth carrying:** a case-sensitive regex in the replay double cost a full 90-second scenario run to diagnose, because a double that exits 9 is reported as `cancelled` and looks exactly like a killed CLI. The prompt now puts the base URL on its own line with no trailing punctuation, so neither a model nor a parser can take the full stop with it.

- [x] **8.5** — **Outcomes from structured runner output; zero tests is not a pass**
      (ROLE-08). Declared, never sniffed — 7.3's principle, and its reason applies verbatim:
      sniffing would read a runner that crashed before printing as a green exit code. Decide
      whether this is a third `emits:` mode (a runner-report parser) or the existing
      `verdict` mode plus a declared adapter, and say which in the step; a parser that lands
      in `@adl/core` must stay I/O-free. **Must prove:** a runner that executed zero tests
      reports `inconclusive`, and is distinguishable from a suite that ran and passed.
      **Done, 2026-09-26.** **The decision: a third `emits:` mode, `tap` — not `verdict` plus a declared adapter.** An adapter either launches the runner itself (a third launcher outside `packages/workspace`, convention 1) or sits in a shell pipe `argv` does not have; it puts ROLE-08's rule in code ADL cannot see; and it does nothing for the tester, which has no `emits`. So the rule is ADL's own, pure and I/O-free: `readTapReport` (`core/src/stage/tap.ts`) and `readRunnerReport` / `judgeRunnerReport` (`core/src/stage/runner-report.ts`), whose `RunnerEvidence` answer type cannot carry `fail`, `warn`, `skip` or any `StageError` but `unparseable`, and whose `passed` member carries a **non-empty tuple** of executed tests — a pass from nothing does not typecheck. **Set against real output, not the specification** (convention 15): 27 fixtures captured from node 24.19 and vitest 4.1, and they overturned four assumptions — node exits 0 on an empty run and vitest exits 1, so the exit code cannot decide; node prints `# fail 0` beside a failed hook, so summaries are never read; node repeats point numbers, so they are never validated; and vitest prints a fully green report and exits 1 when a test leaks a rejection, so the exit code keeps exactly one power, to **veto** a pass. An empty `describe` prints no block and is only a group through node's YAML `type: 'suite'` — the one diagnostic key read, and one that can only make a judgement stricter. **The tester's outcome now comes from a run, not from its word.** Its entry declares `with.suite` (`TestSuiteSchema`: `emits` required, `tap` only; the key is never `command`, which would make the entry a program), and after the agent finishes the gate runs that suite itself — `workspace.exec` on the blind copy, the app still up — through `captured-exec.ts`, judged by the same function a command gate's `emits: tap` is. The run decides; the claim can only turn a green run `inconclusive` or attach `warn` notes, its fingerprints recomputed; ROLE-04 runs on the claim before the suite is paid for; a tester's pass cites `{ global: build }` and its claimed criteria wait for 8.7's link. The prompt finally carries "the command that runs the suite" its docblock had claimed since 8.4. Agent gates gained an `AgentGateHost` second parameter (`path` plus the single `appVariables` record), on `CommandGateConfig`'s precedent; `DECISIONS.md` records why that over a `GateContext` member. The built-in `test` gate can read `commands.test` as a report (`with: { emits: tap }`, `BuiltInCommandGateWithSchema`) and stays the built-in. And `Workspace.exec` delivering **one line per chunk, newline stripped** is now documented on the port and pinned by the contract suite — the command gate had been concatenating lines, harmless for a JSON verdict and fatal for TAP. **Proven:** `core/test/stage/{tap,runner-report}.test.ts` over the corpus (every fixture judged; `passed ⇒ exit 0 ∧ executed ≥ 1` at both exit codes; no proper prefix of a passing report passes; fingerprints stable across workspace roots, timings and point numbers); `runner-report.test-d.ts`; real `node --test` through the real launcher in `stage-runner.test.ts`, where **the same zero-test program is `inconclusive` under `tap` and `pass` under `exit_code`**; and `scenario/runner-outcomes.test.ts`, a real daemon where two testers BOTH claim `pass` and only the runner's report separates them — the one whose suite executed nothing is `inconclusive`, recorded `gate_inconclusive` mid-pipeline, escalated, with no coverage row, while the other passes; the evidence is a witness file only ADL's suite env can reach, the double's own report, and node's TAP on each transcript. **Watched failing 33 ways.** Before the manager half existed, `'tap'` in the mode list alone typechecked green and a real zero-test run declared `emits: tap` came back `pass` — 7.3's sniff by omission, and why the command gate now dispatches through an exhaustive table. Core, 17 injections, all red (the zero-executed branch, skipped/todo/groups counted as executed, leaf-only failures, the exit veto, missing plan, short count, escaped `#`, first-document-only, YAML at exactly +2, `# time=` in names, cap in report order, `not ok # SKIP`, `type: 'suite'` ignored, `\r` kept, bail not recorded, `executed` widened). Manager, 16, and **one stayed green, which was the finding**: a stale `junit` row in the mode table compiled, because an annotated table's `keyof` is the annotation's, so the `Exclude` pairing asserted nothing — and the precedent it was copied from, 8.3's `app-failure.ts`, had the identical defect (`fix(08-03)`, `satisfies`, watched both ways). With `satisfies` all three table injections go red. **Found and not fixed:** `D-8-05-2` to `D-8-05-14` in `DEBT.md` — the synthetic node pass (8.8), pre-existing visible tests credited to the tester (8.6, reproduced by `behaviour-tester.test.ts`), gates never handed an abort signal (8.7) and the rest with owners. **And an incident:** three `agent: implement the feature` commits a replay double made in the real checkout on 2026-09-25, source unidentified; left on `main` for the maintainer, and every committing double now refuses to write inside its own checkout (`test(manager)`, `D-8-05-13`). **Then an adversarial review of the whole diff verified ten more findings, and each was acted on:** three were fixed in the reader and judge — a vitest failure whose `annotate()` notes sit between its point and its YAML was read as `malformed` (a real failure escalated instead of sent back); a node test named with a trailing ` {` was read as a block opener (a whole real run `unparseable`); and node's `before`-hook failure produced findings blaming the tests it cancelled with the hook's own error nowhere, now carried as the failed group's diagnostic — each watched failing when undone. One is a residual now stated rather than missed: vitest under `passWithNoTests` reports an empty `describe` and a test-less file as passing tests, which no reader can tell apart (D-8-05-2, pinned in `runner-report.test.ts`). And five were claims or tests that overstated: four comments corrected, and one test that could not fail rewritten and watched failing with the schema loosened.
- [ ] **8.6** — **The tester's tests are committed** (ROLE-09, finding 7). Two structural
      facts first: a gate has no commit channel, and a gate commit made after
      `recordRoundHeadSha` is attributed to the **developer** by the next round's
      protected-path check (`DEBT.md`'s **D-8-A-1**, unreproduced because the fixture it
      needs is this step's own first task). So this step decides who commits and when, and it makes the
      demarcated location a **third always-on protection** alongside the feature folder and
      `adl.yml` — because `protected_paths` defaults to `[]`, and committed tests the
      developer may rewrite next round are precisely the ImpossibleBench surface the Notes
      below name. The location is declared in `adl.yml`, must be outside `features_dir`, and
      follows the new-key precedent `visible_paths` set in 8.1 — `z.strictObject` means an
      unknown key is a boot-time refusal, and there is **no** published `adl.yml` JSON
      Schema to diff, unlike the verdict schema (`packages/core/schema/` holds that one
      alone). This sentence previously claimed otherwise; 8.1 is what established the
      real precedent. **Must prove:** the tests are on the branch
      that becomes the change request — pushed from **inside** the worker, before teardown
      reclaims the branch, 5.10's constraint — and that the developer editing them in a
      later round is refused.
- [ ] **8.7** — **Three of the four guardrails: assertion floor, spec-clause link,
      stability runs** (ROLE-10, first half). The spec-clause link is _not_ free from 7.6:
      `citations.ts` already refuses a verdict citing a criterion the spec lacks, for every
      gate, but linking a **committed test file** to a criterion is a different artefact and
      is what M09's coverage table joins on. Stability runs cost real wall-clock against
      `limits` and the budget gate — checked before, never after (convention 10).
      **Must prove:** each guardrail rejects a test that fails it and admits one that
      passes, with the rejection watched failing against the exact defect.
- [ ] **8.8** — **The fourth guardrail: a test that does not fail against the pre-feature
      commit is rejected** (ROLE-10, the load-bearing half). Its own step because it needs
      8.1's second-workspace mechanism at `GateDiff.base` — the base ref is already on the
      wire — and because the milestone's own notes are right that without it committed
      coverage is a machine for generating green noise. **Must prove:** a test that passes
      at the base commit is rejected even though it also passes at head; watched failing by
      disabling the check and confirming a vacuous test survives.
- [ ] **8.9** — **The added suite-time delta, recorded and exposed** (criterion 4's last
      clause, finding 9). Measured where the suite runs, accumulated per feature on the
      `usage_events` precedent, surfaced in `adl status` and the HTTP API. **Deliberately
      not rendered on the pull request** — that is M09 steps 9.3–9.5, and building it twice
      is the sequencing mistake this step exists to avoid.

## The 8.0 spike record (2026-09-24)

The milestone's own notes flagged this as research: tester prompt design under a
_structural_ code-blind constraint has no public exemplar. What follows is the decision the
spike reached, and the measurements it reached them from. **It revises audit finding 3.**

Probes were throwaway, run against **git 2.49.0.windows.1** and **node v24.19.0** — a real
repository, two real worktrees, a real server on a real allocated port, a real test run —
and deleted afterwards, per convention 15. The research prose in this project has been wrong
before; none of the below is taken from documentation.

### What was measured

| #   | Question                                                                      | Answer                                                             |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| P1  | Two worktrees of one repo, same commit, different branches, at once?          | **Yes**                                                            |
| P2  | Does `sparse-checkout` remove the implementation from disk?                   | **Yes** — `src/` is absent from the working tree                   |
| P3  | Does the sparse worktree report **clean**, or look like a deletion?           | **Clean** — a commit from it would not remove the source           |
| P4  | Can a port be allocated by binding `:0` and closing?                          | **Yes**                                                            |
| P5  | Does the app become ready on it?                                              | **Yes**                                                            |
| P6  | Can the code-blind tree run a behaviour test with **no `node_modules`**?      | **Yes** — 1 pass, 0 fail                                           |
| P7  | Is the implementation marker in any **file** under the tester root?           | **No** — the working tree is genuinely code-blind                  |
| P8a | Can `git cat-file -p HEAD:src/server.mjs` print it from inside that tree?     | **YES — the source comes straight back**                           |
| P8b | Can `git show <rev>:<path>`?                                                  | **Yes** — a second spelling of the same door                       |
| P8c | Can the tester run `git sparse-checkout disable`?                             | **YES — one command restores the whole tree**                      |
| P9  | Is a plain copy of the allowlist with **no `.git`** blind, and can it run?    | **Blind: yes · git door: closed · test: passed**                   |
| P10 | With `node:test`, is `package.json` needed, or is the test file alone enough? | **The test file alone is enough**                                  |
| P11 | A plain `.git`-less copy at ADL's **default** scratch root (`<repo>/.adl/…`)? | **LEAKS** — git walks up and finds the watched repository          |
| P12 | The same copy **outside any repository**?                                     | **Refused** — `fatal: not a git repository`                        |
| P13 | `GIT_CEILING_DIRECTORIES` instead of moving the directory?                    | Blocks the walk-up — but a child can unset it: a fence, not a wall |

### The four decisions

**1. The tester's workspace is a materialised copy with no `.git`, outside any repository.**
Not a second worktree, and not a sparse checkout. P2 and P7 make sparse-checkout _look_
right — the source really is off the disk — and P8a/P8b/P8c are why it is not: a linked
worktree's `.git` file points at the **main repository's object store**, which holds every
blob of the excluded source. `git cat-file` and `git show` read it back, and
`git sparse-checkout disable` restores the entire tree in one command, because
sparse-checkout is a _checkout preference, not a permission_. A tester that must be asked not
to run that command is code-blind by instruction wearing a structural costume, which is the
one thing criterion 1 rules out.

**2. Where it lives is part of the mechanism, not a deployment detail.** P11 is the finding
that would have been missed by reasoning alone: git resolves a repository by walking **up**
the directory tree, and ADL's `scratchRoot` today is `join(dirname(dbFilePath), 'scratch')`
— `<repo>/.adl/scratch`, **inside the watched repository's working tree**. A perfectly
`.git`-less copy placed there leaks the source anyway, and `.adl/` being gitignored makes no
difference: ignore rules are not access control. So 8.1 must place the tester's workspace
outside any repository, and must **assert** that rather than assume it —
`git rev-parse --show-toplevel` failing from inside the tester root is the check, and it is
cheap. `GIT_CEILING_DIRECTORIES` (P13) works but is an environment variable the child can
unset, so it is defence in depth, never the guarantee.

**3. The allowlist is small, and it is the repository's to declare rather than ADL's to
guess.** P10 is the useful surprise: with node's built-in runner, `node --test
tests/x.test.mjs` passed against the running app with **no `package.json`, no
`node_modules`, and nothing else on disk** — `node:test`, `node:assert` and `fetch` are all
built in, and the `.mjs` extension carries the module type. So the floor for a behaviour test
is _the test directory_. Everything above that floor — a lockfile, an install, a
`vitest.config.ts` — is a property of **which runner the repository chose**, which is
exactly why audit finding 2's conclusion holds and its wording does not: the allowlist is not
inherently big, it is inherently _repository-specific_. This also means the tracer in 8.2 can
use a node-native fixture app and a node-native test with no install step at all, which keeps
the first cross-process proof fast and free of npm.

**4. A tester that cannot see the source also cannot commit — and that is the right shape.**
It follows from decision 1 rather than being chosen: a directory with no `.git` has nothing
to commit _to_. That agrees with audit finding 7, where `GateContext` has no commit channel
and a gate commit would be attributed to the developer by the next round's protected-path
check (`DEBT.md` D-8-A-1). So 8.6 is **ADL carrying the surviving tests back into the
developer's worktree and committing them itself**, at a point it controls relative to
`recordRoundHeadSha` — not the tester committing. One decision removes a capability, a
defect and a design question together.

### What the tester is told, and what it does when it cannot peek

- **It is given:** the acceptance criteria with their ids, the base URL of the running app
  (`${ADL_PORT}`), the declared test directory, and the command that runs the suite.
- **It is told the blindness is deliberate**, and that the implementation is not merely
  off-limits but absent. A tester that does not know this spends turns hunting for source
  that is not there, and 7.5's reviewer report is the precedent for how much walking an agent
  will do before it concludes anything.
- **Ambiguity is reported, not guessed.** When a criterion admits more than one reading and
  the tester cannot resolve it by looking at the implementation — which is the whole point —
  it writes the test against the **most literal reading** and raises a `warn` finding naming
  the criterion and the reading it took. This needs no new machinery: `aggregate` already
  knows a `warn` never produces a `send_back` and that its findings still ride into the brief
  and the pull request. Guessing silently would produce a false failure the developer cannot
  act on; reporting `inconclusive` would let one ambiguous criterion sink an otherwise
  verified feature.
- **Not the prompt's job:** stopping the tester from writing a test that cannot fail. That is
  8.7's assertion floor and 8.8's must-fail-at-base guardrail, and a prompt is the wrong
  place to enforce it — the same reason ROLE-06 is a workspace composition and not an
  instruction.

### What the spike did not settle

Whether a **real** code-blind tester writes behaviour-relevant tests at a useful rate. The
probes ran a hand-written test, not a model-authored one, so what is established is that the
_mechanism_ works end to end and what the tester must be given — not the quality of what it
produces. Audit finding 10 already says why that cannot be measured against a replay double,
and it stays a known limit of this milestone rather than a sixth acceptance criterion.

## Notes

- ✅ **The research flag is discharged.** Tester prompt design under the _structural_
  code-blind constraint had no public exemplar; 8.0 is the spike, and
  [its record](#the-80-spike-record-2026-09-24) carries the four decisions it reached. What
  it deliberately did **not** settle is the quality of a real tester's output — finding 10
  says why a replay double cannot measure it.
- **The code-blindness must be structural.** A tester that can read the implementation
  starts approving intent instead of outcomes — which is exactly the failure the
  behaviour-first framing exists to prevent. Finding 1 is why this is a workspace
  composition and not a `GateContext` member; the spike is why it is a `.git`-less copy
  outside any repository rather than the sparse worktree finding 3 assumed. **A mechanism
  that only looks structural is the trap here** — sparse-checkout passes every test you
  would think to run on the working tree and fails to `git show`.
- **Guardrail 4 is the load-bearing one.** A test that passes against the pre-feature
  commit tested nothing. Without it, committed coverage is a machine for generating
  green noise. It is 8.8, on its own, for that reason.
- This is where ImpossibleBench's finding bites hardest: frontier models exploit
  conflicting tests up to 76% of the time, and Claude-family models specifically prefer
  to _modify the tests_. Committing agent-authored tests is exactly the surface that
  exposes. M01's protected paths and the honest "this gate is wrong" exit are the
  mitigations already in place — but finding 7 is that `protected_paths` **defaults to
  `[]`**, so the mitigation is opt-in for exactly the files this milestone creates. 8.6
  closes that.
- **Two debts this milestone should expect to touch.** `D-2-07-1` (cancellation under the
  privilege drop signals a process ADL does not own) is directly in 8.2's path — reaping
  an app's process group is the same problem seen from the product side. `D-7-05-1`
  (`upsertComment` is check-then-act) is owner M09 and stays there.
