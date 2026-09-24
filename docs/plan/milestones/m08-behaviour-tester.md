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
- [ ] Test outcomes are read from structured runner output, and a run in which zero tests
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

- [ ] **8.0** — **The code-blind tester spike** (the milestone's own research flag;
      `docs(08-00)`). Tester prompt design under a _structural_ code-blind constraint has no
      public exemplar, and finding 10 says this is a decision to reach rather than a
      criterion to tick. Its output is written into this file's Notes: what the tester is
      told, what it is given, what it does when the spec is ambiguous and it cannot peek,
      and — the question that decides 8.1's allowlist — **what a test runner actually needs
      on disk to execute one test against a running app.** Answer that last one empirically
      against real `git worktree` and real `npm`, per convention 15; the research prose in
      this repository has been wrong before and is not taken on faith.
- [ ] **8.1** — **A gate declares the view it gets, and ADL composes it** (ROLE-06,
      findings 1–3). The one-way decision: a pipeline entry gains a key ADL itself reads —
      `on_send_back`'s precedent, not opaque `with:` data — declaring the repo-relative
      allowlist its gate's workspace contains. The tester declares one; every other gate
      declares nothing and gets today's behaviour byte-for-byte. Greenfield underneath:
      a **second, concurrently-live workspace per feature**, with its own spec identity,
      visible to the GC sweep, composed by path allowlist (`matchesGlob`, not a second
      matcher). `GateContext` gains **no** new member and `GATE_CONTEXT_MEMBERS` does not
      move — code-blindness is a property of what is on disk under `Workspace.root`, never
      something the gate is asked to honour. **Must prove:** the implementation source is
      absent from the tester's root while the spec, `adl.yml` and the suite's own
      prerequisites are present; and GC reclaims both workspaces. Prove the absence
      **from outside ADL** — 7.5 and 7.9's pattern, a double that walks its own root and
      writes what it found to a report file, so the evidence does not come from ADL's own
      bookkeeping.
- [ ] **8.2** — **The app lifecycle ADL owns** (ROLE-07, findings 4–5). **The tracer.**
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
- [ ] **8.3** — **Every way the app can fail to be judgeable, mapped once** (finding 6).
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
- [ ] **8.4** — **The tester agent** (ROLE-05, finding 8). One entry in
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
- [ ] **8.5** — **Outcomes from structured runner output; zero tests is not a pass**
      (ROLE-08). Declared, never sniffed — 7.3's principle, and its reason applies verbatim:
      sniffing would read a runner that crashed before printing as a green exit code. Decide
      whether this is a third `emits:` mode (a runner-report parser) or the existing
      `verdict` mode plus a declared adapter, and say which in the step; a parser that lands
      in `@adl/core` must stay I/O-free. **Must prove:** a runner that executed zero tests
      reports `inconclusive`, and is distinguishable from a suite that ran and passed.
- [ ] **8.6** — **The tester's tests are committed** (ROLE-09, finding 7). Two structural
      facts first: a gate has no commit channel, and a gate commit made after
      `recordRoundHeadSha` is attributed to the **developer** by the next round's
      protected-path check (`DEBT.md`'s **D-8-A-1**, unreproduced because the fixture it
      needs is this step's own first task). So this step decides who commits and when, and it makes the
      demarcated location a **third always-on protection** alongside the feature folder and
      `adl.yml` — because `protected_paths` defaults to `[]`, and committed tests the
      developer may rewrite next round are precisely the ImpossibleBench surface the Notes
      below name. The location is declared in `adl.yml`, must be outside `features_dir`, and
      needs the new-key precedent `protected_paths` set (unknown-key strictness, the
      published JSON Schema and its CI diff). **Must prove:** the tests are on the branch
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

## Notes

- ⚠️ **Research flagged.** Tester prompt design under the _structural_ code-blind
  constraint has no public exemplar. Budget a spike — **8.0**, and finding 10 says what it
  has to answer.
- **The code-blindness must be structural.** A tester that can read the implementation
  starts approving intent instead of outcomes — which is exactly the failure the
  behaviour-first framing exists to prevent. Finding 1 is why this is a workspace
  composition and not a `GateContext` member.
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
