# M07 — Code Reviewer on the Gate Plugin Interface

**Status:** 🟡 **Code complete** — steps 7.1–7.6, 7.8 and 7.9 shipped; four of five acceptance criteria ticked. Step 7.7's known-bad-diff corpus is deferred into `DEBT.md` § 1 (item 1.8) by the 2026-09-03 maintainer decision, so criterion 4 stays unticked until it runs — the same shape M02, M04, M05 and M06 each carry
**Depends on:** M06
**Requirements:** HARN-01…04, ROLE-02, ROLE-04, LOOP-09 (7)

**Goal:** the reviewer is the first real plugin gate — judging implementation against spec
and code quality from fresh context, on exactly the interface a third party would use.

> **What a pre-implementation audit found before writing a single step** (2026-09-02,
> the same discipline M06 opened with; it contradicts the original sketch in two places,
> corrected below).
>
> **1. There are two gate context types, not one, and that is the real work of 7.1.**
> `@adl/core/stage`'s `StageContext` is the _published_ third-party contract — it is
> already re-exported by `@adl/plugin-sdk` and is what `Stage.run` takes. But **four of its
> nine members are forward declarations nothing supplies** (`FeatureView`, `StageConfig`,
> `ArtifactSink`, `RoundSummary`), and **no production code implements `Stage` at all** —
> the built-in gates are plain functions. Meanwhile `GateContext` (M05 step 5.17) is what
> gates actually take, carries ROLE-03's fresh-context guarantee as a machine-checked
> member list, and is **deliberately not** exported from `@adl/plugin-sdk`. HARN-04 asks
> that the reviewer run on "the same interface third parties use", which cannot be true of
> both. Deciding which one survives is 7.1, and it is the milestone's one genuinely
> one-way decision.
>
> **2. `GateContext` has no way to call a model.** It has `workspace`, `spec`, `diff`,
> `stageId`, `onEvent` and `signal` — and no `agents`. The command gate needs none, so
> nothing noticed. The reviewer is the first agent-backed gate and cannot run without one.
> `StageContext` declares `agents: AgentRunner` for exactly this, which is evidence for
> keeping its shape even if its identity changes. This is also where `DEBT.md`'s
> **D-5-18-1** lands: a gate-invoked agent currently has no channel to report spend
> through, so an agent gate would burn tokens invisibly — which after M06 means silently
> outside 6.4's per-feature budget and 6.5's global cap.
>
> **3. More of HARN-01/03 is already real than the sketch assumes.** `resolvePipeline` has
> been a _production_ caller since 5.13 — `dispatcher.ts` resolves the snapshotted pipeline
> on every dispatch, refuses an unresolvable harness id before forking, and passes
> `stage.id` on the assign message. `ResolvedStage` already carries `with` and
> `onSendBack`. Position in the `adl.yml` array is already the stage's position. So
> configuration-driven positioning is not greenfield: what is missing is (a) a gate that is
> not one of the three built-ins, and (b) anything that _reads_ `onSendBack`.
>
> **4. `on_send_back` is a documented, deliberate half-implementation.**
> `loop/round-step.ts` states it outright: `ResolvedStage.onSendBack` "is read by nothing
> here", v1 stops on the first `send_back`, and the cost-class default was left unbuilt
> because "half a policy is worse than none" while `Stage.costClass` had no implementations
> to carry it. This milestone creates the second gate, which is the condition that
> statement was waiting on.
>
> **5. ROLE-04's mechanism exists; its _evidence_ does not.** `PassVerdictSchema.checked`
> is already non-empty by schema, and the command gate already cites
> `{ kind: 'global', category: 'build' }` rather than fabricating criterion coverage. What
> 7.6 adds is a reviewer that cites **real criterion ids from the spec it was given**, and
> the rejection of a citation naming a criterion that does not exist — which the schema
> cannot check, because it does not have the spec.
>
> **6. 6.10 left the reviewer's seat wired and empty.** `stage-runner.ts`'s
> `AGENT_ROLE_PRODUCERS` has `reviewer: null`, and `AGENT_GATE_ROLES` is derived from it,
> so giving the reviewer a producer is one entry — the model read, the role mapping and the
> dispatch classification all follow. That was built in M06 precisely so this milestone
> would not have to touch them.
>
> **7. Two debts are owed answers by this milestone, and neither is a hole in v1 today**
> — `D-6-09-1` (nothing makes the reviewer run on a different model from the developer;
> cross-model review is now expressible and still not recommended anywhere) and
> `D-5-18-1` (above). See the Notes section.

---

## Done when

- [x] A gate stage — an AI agent or a plain command — can be added and positioned anywhere
      in the pipeline **through configuration**, with no change to ADL's lifecycle and no
      code written.
- [x] The reviewer runs on that same interface with **no special-casing**: removing it from
      configuration removes it from the pipeline exactly like a third-party gate would be.
- [x] The reviewer's verdicts cite the specific spec clauses checked, and a `pass` citing
      none is rejected as _malformed_ rather than accepted as an approval.
- [ ] A known-bad-diff fixture set runs in ADL's own CI and turns the build red if the
      reviewer approves it — so rubber-stamping is **measured**, not assumed.
      **Unticked, and deferred by the 2026-09-03 maintainer decision** — `DEBT.md` § 1
      item 1.8. Measuring rubber-stamping against a replay double measures the double.
      See step 7.7.
- [x] Findings raised after the first review round arrive as PR follow-ups rather than
      fresh send-backs, so the goalposts cannot move mid-feature (LOOP-09).

---

## Steps

Refined from the sketch by the audit above (2026-09-02). Ordered so the interface decision
lands **first** — every later step consumes it — and so the reviewer is built only after
the thing it plugs into is real. The original sketch's numbering is preserved; what changed
is that each step now says what exists, what is greenfield, and what it must prove.

- [x] **7.1** — **One gate context, published.** Resolve finding 1: `StageContext` (a
      hypothesis with four unsupplied members and no implementation) and `GateContext`
      (what gates take, carrying ROLE-03's machine-checked member list) both claim to be
      the gate interface, and HARN-04 cannot be true of both. **Decision to record in
      `DECISIONS.md`:** `GateContext` survives and is published; `StageContext`'s
      forward-declared members are folded into it or dropped, and `Stage` is retired or
      re-declared over `GateContext`. The reasoning is the milestone's own note — an
      interface shaped around a hypothesis rather than around use — plus the fact that
      `GateContext` is the one carrying the fresh-context guarantee that ROLE-03 needs and
      `StageContext` structurally cannot make while `FeatureView` is opaque. **Also in this
      step, because the interface cannot be finalised without it (finding 2):**
      `GateContext` gains `agents: AgentRunner` and a spend-reporting channel, closing
      `D-5-18-1`. The command gate ignores both exactly as it already ignores `spec` and
      `diff` — that a gate may ignore its context is the point; what it may not do is reach
      for context it was not given. `GATE_CONTEXT_MEMBERS` and its `Exclude` assertion
      extend to cover the new members, and `packages/core/test/stage/gate-context.test.ts`'s
      forbidden-name check must still pass: an `AgentRunner` is a capability, not a
      transcript.
      **Shipped as decided, and the spend channel landed in a better shape than the debt
      proposed.** D-5-18-1 suggested observing a terminal `result` event on the gate's
      transcript stream and calling `sendUsage` from there. That works, but it makes
      reporting a _consequence of a gate choosing to emit events_ — a gate that ran a model
      without piping its events through `onEvent` would still spend silently. What shipped
      instead puts the obligation on the runner: `stage-runner.ts`'s `reportingAgentRunner`
      wraps the backend, and the wrapped instance is the only thing a gate ever receives.
      There is no call any gate can forget to make, which is rule 9 rather than a stricter
      convention. `GateContext` therefore has **no** `reportUsage` member, and its absence
      is the design.
      `StageContext`, `FeatureView`, `ArtifactSink` and `RoundSummary` are gone from
      `@adl/core` and from `@adl/plugin-sdk`. `StageConfig` survives as
      `GateContext.config`, resolved by the caller from the same snapshotted pipeline
      `dispatcher.ts` named the stage from — resolving it twice per dispatch would be two
      chances to disagree about what the pipeline is, which is what
      `resolveSnapshotPipeline`'s "exactly one caller" note exists to prevent.
      **Two things worth knowing about what this step does _not_ prove.** No gate calls a
      model until 7.4, so `reportingAgentRunner` is proven by its own unit test rather than
      by a real invocation — the mechanism, not the end-to-end path, and `DEBT.md`'s entry
      says so rather than claiming more. And the published `GateContext` has exactly **one**
      real consumer today, not the two the sketch asked for; M08's tester is the second, and
      the interface may still need widening for it (`priorFindings` is the likeliest).
      **Watched failing** (convention 13): deleting the `sendUsage` call inside
      `reportingAgentRunner` turned two of its four cases red; the pre-existing
      `Object.keys(built.gate)` assertion in `gate-context.test.ts` went red on the two new
      members before it was updated, which is the fresh-context guard doing exactly its job
      — a new member is a decision, not an accident.
      9 new cases across four files, plus `DECISIONS.md`.
- [x] **7.2** — **`on_send_back` becomes real** (HARN-03, finding 4). `round-step.ts`
      currently stops on the first `send_back` and says in its own docblock that this is
      the conservative half of a policy left unbuilt because `Stage.costClass` had no
      implementations. This milestone supplies the second gate, so build the other half:
      cost-class defaults (`free`/`cheap` → `continue` and merge findings into one
      send-back; `expensive` → `stop`) with `ResolvedStage.onSendBack` overriding. The
      round's `gate_passed` event must stay honest — it is emitted only when the stage did
      not stop the pipeline, and `continue` changes what that means.
      **Shipped, and `gate_passed`'s honesty cost a new event kind.** With `continue`, a
      gate that raised blockers advances the pipeline — the same lifecycle move a pass
      makes. Reusing `gate_passed` for it would make the audit trail and the pull request
      read "this gate was satisfied" about a gate that raised two blockers, so
      **`gate_deferred`** is its own `FeatureEvent` kind, carrying `stageId` and
      `findingCount`. `transition()` gives it the identical `gating → gating` edge and says
      why in a comment: the two differ in what they _mean to a reader_, not in what they do
      to the state machine. Deliberately not one kind with a boolean — a flag would make
      the honest reading depend on remembering to check it.
      The cost-class table lives in `@adl/core/loop`'s new `send-back-policy.ts`:
      `test` → `cheap` → `continue`, `review` → `expensive` → `stop`, and **anything this
      build did not supply → `expensive` → `stop`**, which is byte-identical to pre-7.2
      behaviour. `costClassOf` keys on `source` as well as `id`, so a repo-path harness
      that names itself `test` does not inherit the built-in command gate's price.
      `onSendBackFor` is written as "only `expensive` stops" rather than "`cheap`
      continues", so a fourth cost class lands on the conservative side by construction.
      An explicit `adl.yml` value wins in **both** directions — unlike `limits`, this is
      not a ceiling: the pipeline is already the repository's to write.
      `RoundStepInput.onSendBack` is optional and defaults to `stop`, so every pre-7.2
      caller and fixture keeps v1's behaviour with no edit.
      **The end-to-end proof is deferred to 7.3, and that is a real gap rather than an
      oversight.** `continue` only changes anything when a gate that is _not last_ sends
      back, and this build has exactly one gate implementation — `resolvePipeline` rejects
      a duplicate stage id, so a two-gate pipeline is unbuildable until 7.3 makes a gate
      out of an arbitrary program. Every existing scenario has `test` as its last stage,
      where `isLastStage` short-circuits and behaviour is provably unchanged (they pass).
      **Watched failing** (convention 13): emitting `gate_passed` unconditionally on the
      advance path turned the `gate_deferred` case red; flipping `DEFAULT_COST_CLASS` to
      `cheap` turned three cases red, including the "byte-identical to pre-7.2" one. The
      pre-existing cross-product guard in `transition.test.ts` also went red the moment the
      event kind was added and before the sample was written — 11 cases, exactly as
      designed.
      12 new cases across three files.
- [x] **7.3** — **The plain-command gate contract** (HARN-02). Generalise 5.14's command
      gate, which today runs exactly `adl.yml`'s `commands.test` and maps an exit code.
      A third-party gate is _any_ program: it receives the gate context as data, and its
      **stdout is validated against the published verdict JSON Schema**
      (`packages/core/schema/verdict.schema.json`, already emitted and diffed in CI) rather
      than inferred from an exit code. Malformed stdout is `unparseable` — a `StageError`,
      never a gate failure that costs a round (CORE-06). The exit-code mapping stays as the
      degenerate case for a program that emits no verdict, so 5.18's existing
      `command-gate-loop.test.ts` assertions hold unchanged.
      **Shipped, and the resolution tier turned out to be the interesting part.**
      D-23's three tiers — built-in, npm, repo-path — all answer the same question:
      _where is the module?_ A plain-command gate has no module, so it needs no tier.
      `HarnessSource` gains a fourth member, `command`, and an entry whose `with:` block
      declares a `command` object resolves to it **without consulting the registry at
      all** — which is what makes this the extension point available today, before M13's
      loader exists. It still runs the path guard and the duplicate-id check: the id
      becomes a stage id that verdicts, `stage_attempts` and coverage rows join on, and one
      that could be read as a filesystem path is exactly as dangerous here as anywhere.
      Recognition is deliberately structural and narrow (a `command` key whose value is an
      object) and never validation — `CommandGateWithSchema` validates where the gate runs,
      so a `with: { command: "npm run lint" }` typo falls through to the registry and is
      refused **by name** instead of resolving to a gate with no program.
      **The mode is declared, never sniffed**, and that is a correctness decision rather
      than a stylistic one. Parsing stdout as a verdict "when it happens to look like one"
      would silently promote an `npm test` JSON blob to a verdict, and — worse — read a
      verdict-emitting gate that crashed before printing as "not a verdict, fall back to
      the exit code", producing a `send_back` that nothing judged. `emits: exit_code` is
      the default, so 5.14's built-in `test` gate and every ordinary linter need no mode
      line. In `verdict` mode the exit code is not consulted **in either direction**: a
      linter that exits 1 to mean "I found things" and prints an accurate `send_back` is
      reporting correctly, and mixing the signals would make the contract two contracts.
      **A real finding, mid-write:** `resolvedStageFor` looked a stage up by index alone.
      A message whose index and id disagree is a message about a pipeline this worker is
      not looking at, and reading a _different_ entry's `with:` block would hand a gate
      someone else's program or someone else's `emits` mode with nothing reporting a
      mismatch. It now checks both and returns `undefined` when they disagree — which
      every caller already had an honest answer for.
      **7.2's deferred end-to-end proof landed here**, because this is the step that makes
      a two-gate pipeline buildable at all:
      `test/scenario/two-gate-continue.test.ts` drives a real daemon through two
      plain-command gates, the first `on_send_back: continue`, and asserts the second gate
      _ran_, that both ran inside **one** round (attempts at index 0, 1 and 2), that both
      verdicts survived, and that the audit trail records `gate_deferred` and never
      `gate_passed`. Watched failing by flipping that one policy word to `stop`: the second
      gate's marker file never appears.
      **A wrong assumption, caught by the test:** its first draft asserted the feature
      closes exactly one round. It does not, and should not — a `send_back` sends the
      developer back, so a second round opening is the loop working. The assertion moved to
      where the property actually lives (both gates inside round **1**), and the file now
      says outright what it deliberately does not assert.
      **Also watched failing:** an invalid `GlobalCategory` in a hand-written verdict
      fixture was rejected as `unparseable` before the assertion could read it — the schema
      validation proving itself on the first run rather than on a contrived one.
      13 new cases across four files.
- [x] **7.4** — **The reviewer agent gate** (ROLE-02), on 7.1's context with zero
      special-casing. One entry in `stage-runner.ts`'s `AGENT_ROLE_PRODUCERS`
      (`reviewer: 'review'`, finding 6) plus the gate module itself under
      `worker-entry/gates/`, so it inherits `adl/gate-fresh-context` on the day it is
      created. It judges implementation against spec and code quality, and reports spend
      through 7.1's channel — the first invocation that proves `D-5-18-1` closed.
- [x] **7.5** — **Fresh context, proven for the reviewer specifically** (ROLE-03). The
      structural guarantee already exists as a type and a lint rule; what does not exist is
      a run in which a real reviewer had a real developer transcript sitting on disk beside
      it and demonstrably could not name it. A real-daemon scenario, on
      `detect-restart-reconciliation.test.ts`'s precedent.
      **Shipped as one scenario and one new double, and the double is the interesting
      part.** `ADL_TRACER_CLAUDE_BINARY_JSON` names ONE binary for the whole daemon, so a
      `['develop', 'review']` pipeline cannot be driven by two separate doubles.
      `fake-claude-role-switch.mjs` therefore decides which role it is playing by reading
      its own `--append-system-prompt` argument — which is also the honest stand-in for what
      actually distinguishes the two invocations in production: the argv, and nothing else.
      A flag the test passed would have let the double be "the reviewer" on a run where ADL
      never told it it was one.
      As the reviewer it **hunts**: it walks every directory ADL gave it a root for and
      writes what it found — every file, plus its complete argv and environment — to a
      report outside the worktree. The test then asserts the developer's transcript really
      exists at its real path carrying its real session id and real reasoning; that the walk
      found the developer's committed output and was not truncated; that it found no
      `*.ndjson`, no `*.prompt` and no `logs/` anywhere; and that the reviewer's **full
      command line** — which carries the entire rendered prompt, read back out of the
      process that received it rather than out of ADL's belief about what it sent —
      contains no transcript path, no logs root, no session ref and none of the developer's
      words. A negative control keeps that meaningful: the same command line does carry the
      spec, the criteria and the changed paths.
      **What it deliberately does NOT claim, stated in the file rather than left to be
      discovered:** that the reviewer is _sandboxed_ from the transcript. It is not — v1 is
      one trust domain per daemon (`DEBT.md` D-2-R-1), and in a real installation
      `logsRootFor(dbFilePath)` is a sibling of the scratch root the worktree lives under.
      ROLE-03's claim is the narrower one under test: ADL does not hand the reviewer the
      developer's context and gives it nothing from which to derive it.
      **Watched failing** (convention 13), four separate injections, each restored:
      (1) a stray `notes.ndjson` written into the worktree by the developer half →
      `transcripts` is `['notes.ndjson']`, so the detector detects; (2) the walk stubbed to
      return nothing → the "hunt worked" assertion goes red, so "found nothing" cannot be a
      broken search; (3) `logsRoot` threaded onto the built gate context and appended to the
      reviewer's instructions — the real ROLE-03 defect — → the needle assertion names it
      exactly (`the reviewer was handed the logs root (…)`), **and `adl/gate-fresh-context`
      independently went red on the same line**, which is the two guards catching one defect
      from opposite directions; (4) the spec and criteria withheld from the prompt → the
      negative control goes red.
      **Found and not fixed:** `D-7-05-1` — `upsertComment` is check-then-act, so a sticky
      comment can be posted twice. Reproduced on `main` with no local changes; recorded in
      `DEBT.md` § 3 with an owner rather than folded into § 4's flake row, because it is an
      assertion about product state and not a timeout.
      1 new case, 1 new double.
- [x] **7.6** — **Spec-clause citation, checked against the spec** (ROLE-04, finding 5).
      `PassVerdictSchema.checked` is already non-empty by schema, so the missing half is
      semantic: a reviewer `pass` citing a criterion id **that the spec does not contain**
      is `unparseable`, not an approval. That check needs the spec, which the schema does
      not have and this gate does. A `pass` citing only `{ kind: 'global' }` from an
      _agent_ gate is likewise refused — that is the command gate's honest answer, and
      borrowing it would let the reviewer approve without claiming coverage of anything.
      **Shipped as two rules at two levels, and the split is the finding.** The sketch
      above puts both inside the reviewer, on the sound-looking grounds that the reviewer
      is what holds the spec. Writing it turned up the reason the first rule belongs one
      level out: **any gate may cite a criterion.** A plain-command gate in
      `emits: verdict` mode (7.3) can print `{"kind":"criterion","id":"AC-99"}` exactly as
      easily as a model can, and the `verdict_checked_criteria` row it would write — the
      table the pull request's coverage section is drawn from — is exactly as false. So:
      **Rule 1, "a cited criterion must exist", is enforced once in `stage-runner.ts` for
      every gate of every kind.** That is both stricter than the sketch and _less_
      special-casing, which is what HARN-04 asks for. It covers every citation a verdict
      can carry, not only a `pass`'s: a `send_back` finding pointing at `AC-99` renders in
      the PR against a criterion that is not there and `fingerprintFinding` would make it
      stable across every round that follows, and a `skip`'s waiver target is checked
      because a waiver is a **human's** recorded decision — a gate emitting one that names
      a non-existent criterion is fabricating a human's answer, not miscounting.
      **Rule 2, "an approval must cite at least one criterion", lives in the reviewer.**
      This is the one genuinely about what this gate's job is, and it is deliberately not
      applied to every gate: a `pass` citing only `{ kind: 'global', category: 'build' }`
      is the command gate's _honest_ answer, because a build that went green really did
      check no criterion. A gate being stricter about its own output is the opposite of
      being special-cased — it is what any third party's gate is equally free to do. The
      reviewer's instructions were updated in the same commit, because a gate that refuses
      an output it never asked for fails for a reason the model could not have known.
      The pure half is `@adl/core/verdict`'s new `citations.ts` —
      `citedCriterionIds(verdict)` and `unknownCitedCriteria({verdict, knownCriterionIds})`,
      order- and duplicate-preserving on `violatedProtectedPaths`' precedent, with a `never`
      arm so a seventh outcome would fail the build rather than silently read as "cites
      nothing". Rule 2 is **derived** from `citedCriterionIds` rather than restated as
      "every entry is global" (convention 8): the two would be one edit apart from
      disagreeing, and that disagreement would resolve in favour of the approval.
      Both failures are `unparseable` and non-retryable: a gate whose verdict cites a
      criterion that does not exist did not judge _this_ spec, so the round escalates to a
      human rather than costing the developer one (CORE-06, D-12).
      **Watched failing** (convention 13), three injections, each restored: neutering the
      stage-runner check turned both plain-command-gate cases red — each reporting a verdict where a stage error was expected — while the negative control stayed green; short-circuiting the
      reviewer's rule turned the global-only approval red and left the other ten cases
      untouched; and making `criterionIdsOf` treat a global's `category` as a criterion id
      turned three core cases red, including the one asserting a global is never flagged.
      **Proven end to end without a new scenario:** 7.5's
      `reviewer-fresh-context.test.ts` already drives a real daemon whose reviewer emits
      `checked: [{ criterion, AC-1 }]`, and that verdict now passes through both rules on a
      real dispatch. The negative paths are proven at the stage-runner level against a
      **real** worktree and a **real** child process, which is where a wrong verdict is
      actually produced.
      19 new cases across three files, plus one new module.

- [~] **7.7** — **The known-bad-diff fixture corpus, red-build in ADL's own CI.** Diffs
  that a competent reviewer must send back — a criterion silently unimplemented, a test
  weakened to pass, a protected path touched. The build goes red if the reviewer
  approves one. This is the milestone's only _continuous_ measurement, and criterion 4
  exists because an approving reviewer is worse than no reviewer.
  **DEFERRED by maintainer decision, 2026-09-03**, into `DEBT.md` § 1's end-of-project
  credential batch as item **1.8** — the same shape M06's step 6.1 was deferred in on
  2026-08-27, and for the same reason: a live `ANTHROPIC_API_KEY` plus an unshadowed
  pinned CLI is an environment precondition, not project work.
  **The reasoning is specific to this step and is why it was raised rather than
  quietly faked.** This corpus's whole purpose is to measure whether a real reviewer
  rubber-stamps. Run against a replay double — which is what every gate test in this
  build uses, correctly — it measures the double: the double sends back because the
  fixture told it to, and a green build would be evidence of nothing. That is worse
  than no corpus, because criterion 4 would read as satisfied.
  **One of the three named bad diffs is already covered, credential-free, and is
  therefore NOT in the deferred batch.** "A protected path touched" is not the
  reviewer's job at all: 5.16's protected-paths check catches it by diffing the round's
  real commit, **before** stage 1 is ever dispatched, and
  `test/scenario/protected-paths-loop.test.ts` already proves it end to end against a
  real daemon and a real commit. What is deferred is the half that genuinely needs a
  judging model — a criterion silently unimplemented, and a test weakened to pass.
  **Criterion 4 in "Done when" therefore stays unticked**, and M07 closes as
  code-complete-with-one-deferred-check rather than as fully proven — the same status
  M02, M04, M05 and M06 each carry.

- [x] **7.8** — **Follow-ups instead of fresh send-backs after round 1** (LOOP-09). A
      finding first raised in round 2+ becomes a PR follow-up rather than a new send-back,
      so the goalposts cannot move mid-feature. `fingerprintFinding` and
      `verdictsRepository().fingerprintCountsForFeature()` already exist (CORE-04, 6.6) and
      are what "first raised in" is decided by — this is a policy over data that is already
      recorded, not new bookkeeping.
      **Shipped, and the step's sketch was wrong in one place that mattered.** "A finding
      first raised in round 2+" cannot be the rule, for two reasons the writing turned up.
      **First, the round number is the wrong clock.** `review` defaults to
      `on_send_back: stop` (7.2's cost-class table), so in a `['develop', 'test', 'review']`
      pipeline whose tests fail in round 1 the reviewer never runs until round 2 — and a
      literal "after round 1" rule would make its very first opinion non-blocking, i.e.
      decorative. The contract is therefore **per stage**: the findings a gate raised the
      first time _it_ judged this feature. M07's own "Done when" says "after the first
      **review** round", which is the careful wording; the step sketch's "round 2+" is not.
      **Second, the rule must not apply to every gate.** The built-in command gate's finding
      title carries the exit code (`command-gate.ts` puts it there so the fingerprint is
      stable across runs), so `exit 1` in round 1 and `exit 2` in round 2 are two different
      fingerprints. Demoting the second would turn **a broken build into a green round** —
      reachable, not theoretical. `.planning/research/PITFALLS.md`'s original rule anticipates
      this and answers it with "a regression introduced by the fix, _marked as such_", which
      would mean a new `Finding` field, a migration and a schema republish. What shipped
      instead is a classification of the **gate**, not of the finding: `judgementKindOf`
      answers `deterministic` or `opinion`, keyed on `(id, source)` exactly as `costClassOf`
      is, with `DEFAULT_JUDGEMENT_KIND = 'deterministic'` so every npm-, repo-path- and
      command-sourced gate keeps pre-7.8 behaviour and an unknown gate can never let a broken
      build through. That is `onSendBackFor`'s "conservative side by construction" again.
      Deliberately **not** configurable from `adl.yml`: `on_send_back` is a pipeline-shape
      decision a maintainer owns, while this is a claim about whether a program is
      reproducible, which a maintainer declaring `judgement: opinion` on their own test suite
      could only get wrong.
      **A demoted `send_back` becomes a `warn`, which required no new concept and no change
      to `aggregate`.** `WarnVerdictSchema` already means "non-blocking observations", and
      CORE-02's single enforcement point — proven exhaustively over 3,002 multisets — already
      knows that a `warn` never produces a `send_back` and that its findings still ride along
      into the brief when some _other_ gate sent the developer back. So the policy changes one
      field of one verdict. **Nothing is discarded**: the findings stay on the verdict, are
      persisted with it, and reach the pull request. What changes is that they no longer cost
      a round.
      **The verdict that is persisted is the one ADL acted on**, not the one the gate
      returned. Storing round 2's as a `send_back` would leave `verdicts.outcome` disagreeing
      with the round it produced, and the pull request is rendered from those rows.
      **`gate_passed`'s honesty cost a third event kind, exactly as 7.2's did.** A gate whose
      findings were all raised after its own first look advanced without blocking _and_
      without being satisfied. `gate_passed` reads as "satisfied" and `gate_deferred` reads as
      "still blocking, later"; neither is true, so **`gate_follow_ups`** is its own kind on the
      identical `gating → gating` edge. Three kinds, one edge — they differ in what they mean
      to a reader, never in what they do to the state machine.
      **The one inverted ordering in `round-runner.ts`, and why.** Every other check there is
      "evidence first, state second" — `checkStalemate` asks "how many rounds has this
      recurred in, including now?" and wants the write to have happened. `checkFollowUps` asks
      the opposite question, "what did this gate say _before_ this round?", so a history that
      already contained this round's findings would report every one of them as part of the
      contract: the policy never firing at all. The round is identified **by id** rather than
      by ordinal, because `rounds.number` is derived from the previous round's number while
      `features.round` is moved by `transition()` — two answers to one question, and an
      ordinal read from the wrong one would exclude the wrong round.
      **Watched failing** (convention 13), six injections, each restored: (1) flipping
      `DEFAULT_JUDGEMENT_KIND` to `opinion` turned two core cases red; (2) deleting the
      first-judging-round guard turned the "decorative reviewer" case red; (3) reclassifying
      `review` as `deterministic` made the end-to-end scenario **time out at 60 s** — the
      feature loops on send-backs to `max_rounds` and never reaches `publishing`, which is
      precisely the goalpost-moving failure LOOP-09 exists to prevent; (4) dropping the
      `gate_follow_ups` event turned the audit-trail assertion red; (5) persisting the gate's
      original verdict rather than the acted-on one turned the `[2, 'warn']` assertion red;
      (6) turning the repository's LEFT JOIN into an INNER JOIN turned the "a gate that
      passed still counts as having judged" case red. **And a seventh, unplanned:** the
      pre-existing cross-product guard in `transition.test.ts` went red the moment the event
      kind was added and before the sample was written — 11 cases, the same way 7.2's did.
      **A trap worth recording:** `@adl/manager` resolves `@adl/core` through its built
      `dist`, so a core-only edit is invisible to a manager test until `tsc -b` runs.
      Injection 3 passed green on its first attempt for exactly this reason before being
      re-run against a rebuilt `dist`. Any future watched-failing pass that edits `@adl/core`
      and observes `@adl/manager` must rebuild in between or it is observing the old code.
      22 new cases across three files, plus two new modules and one new repository method.

- [x] **7.9** — **Removal proof.** Delete the reviewer from `adl.yml`'s pipeline, watch the
      feature run to a PR without it, with **no code change** — the negative half of
      HARN-04, and the one assertion that would catch a reviewer that had quietly become
      special-cased.
      **Shipped as two runs in one file, sharing one builder.** Everything is identical —
      the same daemon options, the same `claude` double, the same spec, the same four
      lifecycle commands — except the argument naming the pipeline:
      `['develop', 'review', 'test']` against `['develop', 'test']`. The diff between the
      two runs is one array element in the test's source and nothing else, which is the
      literal content of "with no code written".
      **The reviewer's absence is observed from outside ADL, not asked of it.** The double
      writes its report file only when it is launched as the reviewer, so the file's
      existence is a direct observation of whether ADL ever started one — no assertion has
      to trust ADL's own bookkeeping. It is there in the control and absent in the removal
      run, and the removal run still reaches `publishing`.
      **A real finding, caught by the control failing on its first run.** The control's
      first draft put `review` last, and its "an event named the reviewer" assertion went
      red — correctly. `completeWith` emits `all_gates_passed`, which carries no stage id,
      so a green **last** gate leaves no stage-named event behind at all. That would have
      made the removal run's "no `review` event" assertion true of a build that ran the
      reviewer perfectly. The control now puts `review` at index 1, which is also the more
      faithful removal: a repository deletes one entry from a pipeline that has others.
      **Why `test` stays in both pipelines:** a `['develop']` pipeline reaches
      `aggregate([])`, which escalates — "the pipeline ran zero gates, so nothing was
      verified" — so a removal run with no gate at all would prove the reviewer's absence by
      breaking the feature.
      **Watched failing** (convention 13), two injections, each restored: (1) special-casing
      the reviewer into every gate slot — `AGENT_GATE_ROLES.get(id) ?? 'reviewer'`, which is
      exactly the shape a quietly-privileged reviewer would take — turned the removal case
      red on `reviewerRan`; (2) making the double write its report regardless of role turned
      **both** cases red, which is the proof the evidence is role-specific rather than
      "a process ran".
      2 new cases.

## Notes

- **Two real consumers shape the interface** — the reviewer here, the tester in M08.
  Special-casing the built-ins ships an interface shaped around a hypothesis rather than
  around use.
- **Default `onFail` differs by gate cost:** cheap gates default to `continue` (merge all
  findings, one send-back); expensive agent gates default to `stop`.
- The rubber-stamp fixture set is the point of criterion 4 — an approving reviewer is
  worse than no reviewer, and the only way to know is to measure it continuously.
- **Cross-model review: ANSWERED (maintainer decision, 2026-09-03).** ADL warns, once, at
  boot, when the reviewer would run on the developer's model —
  `manager/src/boot/reviewer-model-warning.ts` — and **including the backend-default case**,
  which is where an untouched install sits and therefore where the risk actually bites. It is
  deliberately unlike its sibling `boot/model-pricing-warning.ts`, which skips the
  `BACKEND_DEFAULT_MODEL` sentinel: the two differ in whether the default case is
  _actionable_. For pricing it is not — the price belongs to whatever the backend picked and
  arrives on the `started` event — so warning there would only train the operator to ignore
  the line. Here the default case is the dangerous one and its remedy is one line of
  configuration, so a warning that fired only on a deliberate same-model collision would be
  silent for every operator actually at risk. **A warning, never a refusal:** ADL does not
  pick models on an operator's behalf. One narrowing stays open and is recorded in `DEBT.md`
  rather than guessed at — the warning cannot see whether any pipeline actually contains a
  `review` stage, because a pipeline is a property of each repository's own `adl.yml` and is
  read per feature at admission. **Watched failing:** re-adding the sentinel skip — the most
  likely "make it consistent with its sibling" refactor — turns both default-case assertions
  red.
  The original note is kept below, because it is the argument the decision answers.
- **Cross-model review is now expressible, and still not required — decide which here.**
  M06 steps 6.9–6.11 (BACK-10) made per-role model selection actually work; before them
  `agents.<role>.model` validated and did nothing. This milestone is the first moment a
  second role exists, so it is the first moment `agents.reviewer.model` can differ from
  `agents.developer.model` in practice. The archived research asked for cross-model review
  as _the recommended default_, on the grounds that a reviewer sharing the developer's
  model makes the gate decorative — a risk it ranks #5. That request did not survive into
  the live plan. **`DEBT.md`'s `D-6-09-1` owns the decision and is owed an answer by this
  milestone**, alongside its sibling `D-5-18-1` (a gate-invoked agent has no member of
  `GateContext` to report spend through). Both are about the reviewer being the first
  agent-backed gate; neither is a hole in v1 today.
