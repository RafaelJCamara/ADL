# M07 — Code Reviewer on the Gate Plugin Interface

**Status:** ◀ **IN PROGRESS**
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

- [ ] A gate stage — an AI agent or a plain command — can be added and positioned anywhere
      in the pipeline **through configuration**, with no change to ADL's lifecycle and no
      code written.
- [ ] The reviewer runs on that same interface with **no special-casing**: removing it from
      configuration removes it from the pipeline exactly like a third-party gate would be.
- [ ] The reviewer's verdicts cite the specific spec clauses checked, and a `pass` citing
      none is rejected as _malformed_ rather than accepted as an approval.
- [ ] A known-bad-diff fixture set runs in ADL's own CI and turns the build red if the
      reviewer approves it — so rubber-stamping is **measured**, not assumed.
- [ ] Findings raised after the first review round arrive as PR follow-ups rather than
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
- [ ] **7.4** — **The reviewer agent gate** (ROLE-02), on 7.1's context with zero
      special-casing. One entry in `stage-runner.ts`'s `AGENT_ROLE_PRODUCERS`
      (`reviewer: 'review'`, finding 6) plus the gate module itself under
      `worker-entry/gates/`, so it inherits `adl/gate-fresh-context` on the day it is
      created. It judges implementation against spec and code quality, and reports spend
      through 7.1's channel — the first invocation that proves `D-5-18-1` closed.
- [ ] **7.5** — **Fresh context, proven for the reviewer specifically** (ROLE-03). The
      structural guarantee already exists as a type and a lint rule; what does not exist is
      a run in which a real reviewer had a real developer transcript sitting on disk beside
      it and demonstrably could not name it. A real-daemon scenario, on
      `detect-restart-reconciliation.test.ts`'s precedent.
- [ ] **7.6** — **Spec-clause citation, checked against the spec** (ROLE-04, finding 5).
      `PassVerdictSchema.checked` is already non-empty by schema, so the missing half is
      semantic: a reviewer `pass` citing a criterion id **that the spec does not contain**
      is `unparseable`, not an approval. That check needs the spec, which the schema does
      not have and this gate does. A `pass` citing only `{ kind: 'global' }` from an
      _agent_ gate is likewise refused — that is the command gate's honest answer, and
      borrowing it would let the reviewer approve without claiming coverage of anything.
- [ ] **7.7** — **The known-bad-diff fixture corpus, red-build in ADL's own CI.** Diffs
      that a competent reviewer must send back — a criterion silently unimplemented, a test
      weakened to pass, a protected path touched. The build goes red if the reviewer
      approves one. This is the milestone's only _continuous_ measurement, and criterion 4
      exists because an approving reviewer is worse than no reviewer.
- [ ] **7.8** — **Follow-ups instead of fresh send-backs after round 1** (LOOP-09). A
      finding first raised in round 2+ becomes a PR follow-up rather than a new send-back,
      so the goalposts cannot move mid-feature. `fingerprintFinding` and
      `verdictsRepository().fingerprintCountsForFeature()` already exist (CORE-04, 6.6) and
      are what "first raised in" is decided by — this is a policy over data that is already
      recorded, not new bookkeeping.
- [ ] **7.9** — **Removal proof.** Delete the reviewer from `adl.yml`'s pipeline, watch the
      feature run to a PR without it, with **no code change** — the negative half of
      HARN-04, and the one assertion that would catch a reviewer that had quietly become
      special-cased.

## Notes

- **Two real consumers shape the interface** — the reviewer here, the tester in M08.
  Special-casing the built-ins ships an interface shaped around a hypothesis rather than
  around use.
- **Default `onFail` differs by gate cost:** cheap gates default to `continue` (merge all
  findings, one send-back); expensive agent gates default to `stop`.
- The rubber-stamp fixture set is the point of criterion 4 — an approving reviewer is
  worse than no reviewer, and the only way to know is to measure it continuously.
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
