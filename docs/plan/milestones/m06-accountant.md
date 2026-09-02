# M06 — Accountant: Budgets, Stalls, Escalation

**Status:** ◀ **IN PROGRESS**
**Depends on:** M05
**Requirements:** LOOP-03…08, OBS-05, BACK-10 (8)

**Goal:** an unattended run cannot spend without limit, loop without progress, or fail
silently — every limit reached ends in a human being told where they will see it.

> ⚠️ **The cost-accounting spike (step 6.1) is planned provisionally, not closed.**
> **Maintainer decision, 2026-08-27:** rather than block this milestone on a live
> `ANTHROPIC_API_KEY` that is not available in this environment, M06 proceeds with 6.1
> deferred into `DEBT.md` §1's existing end-of-project batch (items 1.1–1.4, the same
> precondition M04 already deferred). A pre-implementation audit (below) found that
> nothing else in this milestone actually needs the live reconciliation to be _built_ or
> _tested_ — every requirement's mechanism can be designed and proven against the same
> mocks and replay doubles M01–M05 already used throughout. What the live run would add is
> _confidence that `cost_source: 'reported'` numbers are accurate_, not new code paths; the
> `cost_source: 'unknown'` degradation path 6.5 asks for is a policy decision over an enum
> 5.18 already ships, not an empirical one. Revisit 6.1 for real once credentials exist.
>
> **What a pre-implementation audit found already exists, before writing a single step
> below** (contradicts the original step sketch in places — corrected here):
> LOOP-03's round ceiling is **already fully implemented and production-wired** —
> `packages/core/src/state/transition.ts`'s `gating`/`send_back` edge already checks
> `round + 1 > maxRounds` **before** handing out the round (convention #10, verbatim in its
> own comment), fed by `packages/manager/src/loop/round-runner.ts`'s `maxRoundsOf`, and
> already unit-tested at the pure boundary in
> `packages/core/test/state/transition.test.ts`. What's missing is a real or integration
> proof through the manager, not the mechanism. LOOP-04's data (`spendByCategory`) and
> LOOP-06's primitive (`fingerprintFinding`, `repeat_finding_threshold`) already exist too,
> built ahead of need by 5.18 and CORE-04 — only the gates/detectors that read them are
> missing. See each step below for what's real vs. greenfield.

---

## Done when

- [x] A per-feature round cap and a per-feature token/cost budget both exist, and whichever
      is hit first stops the feature — **checked before the next agent turn is dispatched,
      never after it has been paid for.** (6.2, 6.4)
- [x] A global spend cap above the per-feature caps halts new dispatch across every
      feature once reached, and where a backend's usage reporting is unreliable the budget
      **visibly degrades** to round and wall-clock caps rather than silently ceasing to
      enforce. (6.5)
- [x] A developer/reviewer stalemate is caught by repeated finding fingerprints and
      escalated _before_ the round cap is reached. (6.6)
- [ ] A provider outage, rate limit, or auth failure consumes neither a round nor budget,
      and the feature resumes rather than being marked failed.
- [ ] Hitting any limit posts the full transcript and the disagreement to the pull request
      where a human will see it, and spend is visible broken down per feature and per role.
- [ ] A daemon operator can choose a different model per agent role, that choice reaches the
      agent CLI, and the ledger prices what actually ran. A repository may request a model
      only from a daemon-declared allowlist. (6.9, 6.10, 6.11)

> **The sixth criterion was added after the milestone opened** (maintainer request,
> 2026-09-01) rather than derived from the original planning work. `README.md` asks that
> acceptance criteria not be edited casually, so this is the record of why. Per-role model
> selection turned out to be a **dead config shape rather than a missing feature**:
> `agents.<role>.model` has existed and validated since M01, `mergeConfig` resolves it, and
> `worker-entry/stage-runner.ts` already reads it into `AgentTask.model` — but no adapter
> ever turns it into a CLI flag, so setting it does nothing at all. It lands in **this**
> milestone rather than M07 because the sentinel it defaults to (`'default'`) matches no
> `model_prices` row: per D-31 an unpriced row is never folded into the compared total, so
> the dead field silently removes its own spend from 6.4's per-feature budget and 6.5's
> global cap. That makes it an accounting defect, which is what M06 is for.
>
> A second motivation is recorded as debt rather than built here. The archived research
> (`.planning/research/PITFALLS.md`) ranks _“reviewer rubber-stamping via self-preference”_
> **#5** in its own risk table and prescribes two mitigations. The first, fresh context,
> survived into the live plan as **ROLE-03** ✅. The second — _“make cross-model review a
> first-class config, and the recommended default”_ — **did not survive the transfer into
> `docs/plan/`** and appears in no requirement, decision or criterion. 6.9–6.11 make it
> _configurable_; nothing yet makes it _true_. Owner **M07**, filed in `DEBT.md`.

---

## Steps

Reordered from the original sketch by the pre-implementation audit above — cheapest and
lowest-risk first, and grouped so a design decision (the `cost_source: 'unknown'`
degradation policy) lands once, in the step that actually needs it, rather than twice.

- [ ] **6.1** — **Deferred provisionally** (maintainer decision, 2026-08-27). Close the
      cost-accounting spike: one real agent turn, reported cost reconciled against the
      provider's billed usage. Needs a live `ANTHROPIC_API_KEY` + the unshadowed pinned
      CLI — folded into [`DEBT.md`](../DEBT.md) §1 items 1.1–1.4 rather than tracked here
      separately. Not required by any step below.
- [x] **6.2** — Round-ceiling proof (LOOP-03). The mechanism already exists
      (`transition.ts`'s `gating`/`send_back` edge, fed by `round-runner.ts`'s
      `maxRoundsOf`) and is already unit-tested at the pure boundary. This step is a real
      or integration proof through the manager — repeated real send-backs to a low
      `max_rounds` ceiling, asserting the manager escalates on the round the ceiling
      forbids rather than dispatching it. Matches the shape of 5.6/5.19: wire an existing
      seam, prove it, fix whatever the proof surfaces.
      **Shipped:** a third case in `packages/manager/test/scenario/round-loop.test.ts` — a
      real `startDaemon()`, real forked workers, `limits.max_rounds: 1` — drives two
      real send-backs and asserts `features.state` reaches `escalated` on the second, never
      dispatching a third round. **A real finding, mid-write:** the round the ceiling trips
      still closes with `outcome: 'send_back'`, not `'escalate'` — `round-runner.ts`'s
      `closeRound` records `planRoundStep`'s decision (the gate's real verdict) before
      `transition()` separately refuses to open the next round; `'escalate'` as a round
      outcome is 5.16's own synthetic-`CompleteStep` mechanism (`checkProtectedPaths`), a
      different code path entirely, not something the round ceiling produces. The first
      draft of this test asserted `'escalate'` and failed against the real daemon
      immediately — corrected in place, and the comments explain why rather than only
      asserting the corrected value. No production code changed; the mechanism was already
      correct.
- [x] **6.3** — Spend visible per feature in `adl status` (OBS-05). `usageRepository`'s
      `spendByCategory`/`listForFeature` (5.18) already have everything needed; this is a
      `FeatureView` field plus CLI rendering, not new accounting. Cheap, demoable
      immediately, and no dependency on 6.4–6.8 — a deliberately early, low-risk step.
      **Shipped:** a new `usageRepository().spendByFeature()` (`packages/db/src/repository/usage.ts`)
      reads every feature's spend, broken down by role (`stage_attempts.stage_id`), in
      **one** query — `daemon.ts`'s `listFeatureViews` calls it once per `GET /features`
      request, the same "single read for the whole response" discipline `ageMs`'s clock
      read already holds itself to, never once per row. `FeatureView` gains a `spend`
      field (`{totalUsd, unpricedEvents, byRole}`), always present with a zeroed default
      for a feature with no usage rows yet, mirroring `staleRejections`'s own
      never-absent convention. `adl status`'s table gains a `SPEND` column
      (`formatSpend`, `packages/cli/src/render/status-table.ts`): sub-cent amounts render
      to four decimal places so a real but tiny cost is still distinguishable from zero,
      a cent and above renders to two, and a total that includes an unpriced row (D-31)
      carries a trailing `?` rather than folding it in silently.
      **A real bug found while adding the column, before it shipped:** the table's
      dimming logic for an idle `WORKER` cell (`row.worker === null`) located that column
      by `header.length - 1` — correct only because `WORKER` happened to be the last
      column. Appending `SPEND` after it would have silently moved the dim styling onto
      the new column instead, with no test failure (the assertions check content, not
      color codes). Fixed to `header.indexOf('WORKER')` before it ever shipped wrong.
      **`GET /features`'s own negative guard inverted, not deleted:** M03's
      `features-view.test.ts` had asserted `not.toMatch(/cost|spend/)` since Phase 3 —
      deliberately, per `FeatureView`'s own docblock at the time ("OBS-05 is mapped to
      Phase 6"). That assertion is now the positive case it was always waiting to become,
      renamed rather than silently dropped. **Proof the real wiring works, not only the
      hand-fed route tests:** `test/usage/recording.test.ts`'s existing real-daemon,
      real-usage-row scenario (5.18's own tracer) now also asserts `GET /features` reports
      that exact recorded spend back — `totalUsd: 0.001`, `byRole: {develop: 0.001}` —
      through the real production `listFeatureViews`, not a double.
      New `packages/db/test/repos-usage.test.ts` covers `spendByFeature` directly: grouping
      by feature and role, an unresolvable `stage_attempt_id` folding into `'unknown'`
      rather than being dropped, an unpriced row counted separately per D-31, and the
      zero-rows case. **Empirically verified before writing it** (convention 15): foreign
      keys are enforced on this connection (`stage_attempts.round_id`,
      `usage_events.feature_id`) — a first, minimal-fixture draft of the test failed with
      a real `FOREIGN KEY constraint failed`, corrected to seed a full
      repo → feature → round → stage_attempt chain.
- [x] **6.4** — Per-feature token/cost budget, checked before dispatch (LOOP-04), and the
      `cost_source: 'unknown'` degradation policy (6.5's original ask) decided here rather
      than later, since the budget check has to have an answer for an unreliable
      `cost_source` the first time it runs, not as a follow-up. **Extend `dispatchOnce`'s
      existing pre-lease candidate predicate — do not restructure it**, mirroring the
      concurrency cap already checked there before a lease is acquired (M03's template for
      this milestone). A continuation candidate's spend is read via `spendByCategory`
      against its own snapshotted `effective_config_json.limits.budget_usd`; an over-budget
      candidate is filtered out of dispatch and escalated through `transition.ts`'s
      existing generic `limit_exceeded → escalated` edge, fired as its own transaction —
      the same "manager-initiated escalation outside the normal round close" shape
      `checkProtectedPaths` (5.16) already uses.
      **Shipped:** `dispatcher.ts`'s `.find()` predicate became an async `for` loop —
      candidates are still tried in the same FIFO order, and one blocked by the pause brake
      or the concurrency cap is still skipped with **zero** reads, exactly as before; only a
      candidate that clears both now gets a database read. Only a *continuation* candidate
      (`state !== 'queued'` with an existing `effective_config_json`) is ever checked — a
      fresh `queued` row, including one a human just `resume`d out of an escalation, has
      spent nothing new to check and gets a clean slate, matching `isContinuation`'s own
      existing "snapshotted at lease time" discipline one paragraph below. An over-budget
      candidate is escalated by a new `escalateFeatureForBudget` (`transition()` then a
      version-guarded CAS and audit-event append, in one transaction) and the loop moves on
      to the next candidate — nothing about the concurrency slot it would have taken is
      spent. **The degradation policy this step also had to decide:** an unpriced
      `usage_events` row (5.18's `cost_source: 'unknown'`, or any model this build cannot
      price) is never folded into the compared total as zero (D-31) — the dollar figure a
      candidate is checked against is a confirmed floor, not true spend, so a continuation
      candidate with any unpriced row logs a `warn` **every time it is checked**, not only
      when it happens to tip the feature over budget, naming the gap rather than silently
      trusting an understated number; enforcement for the unconfirmed portion leans on the
      round ceiling (LOOP-03, 6.2) rather than a dollar figure that cannot see it. **No round
      is touched by the escalation itself** — the `limit_exceeded` edge moves every counter
      by zero (`NO_COUNTER_CHANGE`), so a round still open under a `gating` candidate is left
      exactly as it stood; a human `resume` re-leases from the same stage, and `openAttempt`'s
      own "reuse the open round" rule (04-04) picks it back up, the identical recovery shape a
      retryable stage error already leaves behind via `reapOne`. Five new cases in
      `packages/manager/test/scheduler/dispatcher.test.ts`: escalates over budget and leaves
      `round`/`current_stage_index` untouched; dispatches normally under budget; logs the
      degradation without escalating when an unpriced row still leaves confirmed spend under
      budget; never checks a fresh `queued` candidate even against usage rows already on
      file for it; and skips one over-budget candidate to dispatch the next admissible one
      behind it. `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format` all clean.
- [x] **6.5** — Global spend cap (LOOP-05), same `dispatchOnce` predicate extended with a
      second, feature-independent condition. Fully greenfield: a new `DaemonConfig` field
      (no `global_budget_usd`-shaped field exists anywhere in the schema today) and a new
      repository method summing spend across every feature. `budget.warn` at 80% (the
      original 6.10) is a cheap addition here, on the same check, not a separate step.
      **Shipped:** `DaemonConfigSchema` gains `global_budget_usd` — optional, no default,
      no repo-side counterpart (like `concurrency`), sitting *above* every feature's own
      `limits.budget_usd` (LOOP-04) rather than instead of it. `usageRepository()` gains
      `totalSpend()`, summing every `usage_events` row across every feature into one
      `{total, unpricedEvents}` — the same "never fold an unpriced row in as zero" (D-31)
      shape `spendByCategory`/`spendByFeature` already hold themselves to, implemented the
      same way (read the rows, reduce in application code) rather than reaching for a SQL
      aggregate this codebase had not yet used. `dispatchOnce` checks it **once per tick**,
      before the per-candidate loop — this cap is feature-independent, so there is nothing
      candidate-specific to check it against, unlike LOOP-04's per-candidate read. When
      fleet-wide confirmed spend exceeds the cap, dispatch halts entirely for that tick
      (`{dispatched: false}`, no candidate touched, nothing escalated) — a fleet-wide limit
      is not any single feature's fault, so the response is the concurrency cap's own
      "dispatch nothing" shape, never a per-feature `limit_exceeded`. `budget.warn` (the
      original step 6.10, folded in here rather than tracked separately) fires as a
      structured `logger.warn({event: 'budget.warn', ...})` once spend crosses 80% of the
      cap, without halting — a heads-up before the hard stop. Absent `global_budget_usd`,
      `checkGlobalBudget` is never called at all: zero extra reads on every tick for an
      install that never configured a fleet-wide ceiling, matching every other "absent
      means skip" seam in this file. Six new cases across
      `packages/db/test/repos-usage.test.ts` (`totalSpend` summing, unpriced-row handling,
      the zero-rows case) and `packages/manager/test/scheduler/dispatcher.test.ts` (halts
      with the candidate left untouched, dispatches under the cap, `budget.warn` at 80%
      without halting, the incomplete-cost-data warning, and — absent `global_budget_usd`
      — the check never runs at all, proven against a spend row huge enough that it would
      have failed loudly if the guard were live). Three new cases in
      `packages/core/test/config/daemon-config-schema.test.ts` for the schema field itself.
      `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format` (on the touched code —
      `docs/plan/`'s pre-existing formatting debt is unrelated, see `DEBT.md` § 3) all clean.
- [x] **6.6** — Stalemate detection over repeated finding fingerprints (LOOP-06),
      independent of the round and budget caps. `fingerprintFinding` and
      `limits.repeat_finding_threshold` already exist (CORE-04, `finding.ts`); nothing
      counts repeats across a feature's round history yet. A pure function in `@adl/core`
      (sibling to `violatedProtectedPaths`/`planRoundStep`) plus a manager-side caller at
      the same point `checkProtectedPaths` runs — before `planRoundStep`, since this is
      also "detected by evaluating state, not by asking." **Correction to the original step
      text:** the "M01's deferred fingerprint-strength question" it referenced is not in
      `DEBT.md` — it lives in the archived `.planning/research/01-RESEARCH.md` § Open
      Questions 1 (cross-referenced from `finding.ts`'s own docblock). Real evidence from
      this step is still the right moment to revisit it; the pointer was just stale.
      **Shipped:** `@adl/core/loop`'s new `detectStalemate` (`packages/core/src/loop/stalemate.ts`)
      takes this round's `send_back` findings and a fingerprint→occurrence-count map and
      reports which findings have already met `limits.repeat_finding_threshold` — pure, and
      de-duplicated by fingerprint so a gate that lists the identical finding twice in one
      round's own output cannot inflate the count. The manager half,
      `loop/stalemate-check.ts`'s `checkStalemate`, reads the count from a new
      `verdictsRepository().fingerprintCountsForFeature()` — how many *distinct rounds*
      (never raw finding rows) have raised each fingerprint across a feature's whole
      history — and hands it to the pure function, following `checkProtectedPaths`'s exact
      three-way `clean`/`stalled`/`error` shape (never fail-open on a database read
      failure, CORE-06). `round-runner.ts` fires it unconditionally on every gate's
      `send_back` (never `warn`, which does not consume a round), **after**
      `recordGateVerdict` writes this round's own findings — so the count it reads already
      includes the round just judged, with no separate "+1" adjustment needed — and
      **before** `planRoundStep` ever runs, exactly the ROLE-11 precedent: a stalled finding
      overrides `planRoundStep`'s own `aggregate()`-driven decision with a hard `escalate`,
      via a new `stalemateStep`, rather than letting the loop send the developer back one
      more time to fail identically. `command-gate.ts`'s finding title already carries "the
      stage and the exit code and nothing that varies between runs" — a comment written
      during 5.14 anticipating exactly this step — which is what makes an identical command
      failure recurring across rounds recognisable as the same finding at all.
      **`repeatFindingThresholdOf` mirrors `maxRoundsOf`'s exact degrade-on-malformed
      shape** (a missing/unreadable snapshot degrades to `0`, the same fail-closed direction
      `maxRoundsOf` already chose for the round ceiling) — which promptly found two existing
      test fixtures whose minimal fake snapshots omitted `repeat_finding_threshold`
      entirely, previously harmless because nothing read it: `round-runner.test.ts`'s shared
      `snapshot()` helper gained the same kind of defaulted parameter `maxRounds` already
      has, and `round-loop.test.ts`'s LOOP-03 ceiling scenario — whose scripted gate reports
      the identical fingerprint on both of its two send-backs by construction — needed an
      explicit higher threshold to keep proving the round ceiling in isolation from this new
      check (its own `RunOptions` docblock explains why, and the fix had to raise the
      *daemon's* ceiling too, not just the repo's requested value, since `mergeConfig` clamps
      a repo's request down to the daemon's own limit and never lets it rise past it, D-22).
      **A new scenario proves the collision the other way round:** `round-loop.test.ts`
      gained "escalates a repeated identical finding before the round ceiling is reached",
      using the *default* threshold (2) against a round ceiling six rounds away, so the
      "Done when" claim — stall detection firing before the round cap, not merely capable of
      firing — is checked through a real daemon, not only argued. Three new unit cases in
      `round-runner.test.ts` (under threshold sends back normally; at threshold escalates
      without touching `round`/`current_stage_index`, matching the round ceiling's own
      `NO_COUNTER_CHANGE` shape; a `warn` is never checked at all), nine new cases across
      `packages/core/test/loop/stalemate.test.ts` (the pure boundary) and
      `packages/db/test/repos-verdicts.test.ts` (`fingerprintCountsForFeature`'s
      per-round-not-per-row counting, cross-feature isolation, and the zero-rows case).
      `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format` (on the touched code) all
      clean.
- [ ] **6.7** — Provider-failure backoff, decoupled from the crash-count ceiling (LOOP-07).
      Classification already exists (`StageError`'s `provider_error`/`timeout`/`auth`
      kinds, CORE-06) and a retryable error already costs no round (5.13's own doing) — but
      today every retryable kind shares one generic `crash_count` ceiling
      (`scheduler/reaper.ts`'s `planRecovery`), so a sustained provider outage escalates a
      feature that was never actually broken, exactly what this requirement exists to
      prevent. A new pure backoff policy (parallel to `planRecovery`), keyed on
      `StageErrorKind`, giving `provider_error`/`timeout`/`auth` their own retry budget.
      The classification and the loop are buildable and testable against synthetic
      `StageError`s now; only confirming real Anthropic 429/5xx shapes map to the right
      `kind` needs the live batch, and that confirmation folds into `DEBT.md` §1 rather
      than blocking this step.
- [ ] **6.8** — Escalation posts to the pull request (LOOP-08). Two real gaps, not one:
      (1) the sticky-comment/CR-open publish path (5.10/5.11) fires only on
      `dev_committed`, so a round that escalates via `blocked`/`dispute`/`limit_exceeded`
      without a commit — including everything 6.4–6.7 add — posts nothing a human would
      ever see; extend the trigger to those events too, reusing the existing machinery
      rather than building a second one. (2) Only a one-line `reason` string reaches the
      comment today (`role-rounds.ts`'s `describeRoundOutcome`); the **full transcript**
      has never been posted anywhere. Exposing it is a real design choice, not a mechanical
      extension — it sits in direct tension with FORGE-06's "PR stays readable" constraint
      the same way 5.11's own bounded-fold mechanism had to resolve once already (link to
      an artifact vs. an excerpt within the sticky comment's `maxLength` budget). **Needs a
      maintainer check-in when this step starts**, not a unilateral pick.
- [ ] **6.9** — The selected model actually reaches the agent CLI (BACK-10), developer role
      only: the tracer slice through every layer before any widening (convention 14).
      **Almost all of this already exists and does nothing.** `adl.yml`'s
      `agents.<role>.{backend,model}` (`adl-yml.ts`, whose own `.describe()` calls it
      “Shape-only”), `DaemonConfigSchema.agents.<role>`, `mergeConfig`'s resolution into
      `EffectiveConfig.agents.<role>`, the vendor-neutral `AgentTask.model` port field, and
      `worker-entry/stage-runner.ts`'s read of `effectiveConfig.agents.developer.model` are
      all built and tested. The missing link is the last one:
      `packages/agent-claude-code/src/backend.ts` builds its argv with **no `--model`**, and
      a repo-wide grep confirms there is not one anywhere in the project. `task.model` is
      consumed only as a fallback _label_ for the spend ledger, never to select anything.
      Add `'--model', task.model` to that argv when `task.model` is present, and make the
      manager **omit** `AgentTask.model` entirely when the resolved value is the `'default'`
      sentinel — so the sentinel never crosses the port and the adapter structurally cannot
      misinterpret it (convention 9). Export `BACKEND_DEFAULT_MODEL` from
      `effective-config.ts` and derive `DEFAULT_AGENT_BLOCK.model` from it rather than
      restating the literal (convention 8). Note the existing `!== undefined` guard at the
      call site is dead: `ResolvedAgentBlockSchema.model` is `z.string().min(1)`, so it is
      always present, and today always `'default'`. Nothing changes in `@adl/core`'s
      vocabulary rule and nothing branches on backend identity, so this stays BACK-04-clean.
      **Probe the pinned CLI before encoding the flag** (convention 15): `claude --help` on
      a local **2.1.227** build shows `--model <model>`, but the project pins **2.1.237**
      (`agent-claude-code/src/version.ts`) and the flag's interaction with `--bare` is
      unverified. **Watched-failing guards:** argv carries `--model <id>` for a configured
      model, and carries **no** `--model` under the sentinel — both watched red by reverting
      the argv edit. **No migration and no new IPC field**: `AssignMessage` already carries
      `effectiveConfigJson`, which is where the worker reads this from today.
- [ ] **6.10** — Every role, not just the developer (BACK-10). `stage-runner.ts` hardcodes
      `.agents.developer`, while `resolveStageRole` beside it already classifies a dispatch
      as `developer` / `command-gate` / `unsupported` — so map that to core's `AgentRole` and
      read `effectiveConfig.agents[role].model`. Drive the mapping off the exported frozen
      `AGENT_ROLES` with the house's `Exclude<T, Arr[number]> extends never` assertion, so a
      fourth role fails the **build** rather than silently falling back to the developer's
      model (convention 7). A command gate runs `adl.yml`'s test command rather than an
      agent, so it takes no model and writes no usage row — the property
      `test/scenario/command-gate-loop.test.ts` already asserts (5.18); that assertion is
      the negative half of this step and stays exactly as it is. `reviewer` and `tester` have
      **no producer** until M07/M08, so their branch is built and unreached, documented as a
      gap on the `forge.promoteToReady` precedent (5.9 built it, 5.13 wired it in one line)
      rather than given an invented consumer. **Plus the accounting half this milestone
      actually owns:** at boot, `logger.warn` for any configured role model with no
      `model_prices` row. _A model you cannot price is a budget you cannot enforce_ — D-31
      keeps unpriced rows out of the compared total, so an unpriceable model quietly removes
      its own spend from 6.4's and 6.5's gates. A warning and never a refusal, since a new
      model is usable before it is priced. **Proven end to end** by teaching
      `test/helpers/fake-claude-success.mjs` to record its own argv, then asserting in a real
      scenario both that the configured model reached the binary and that the resulting
      `usage_events.model_id` is priceable rather than `'unknown'`.
- [ ] **6.11** — The daemon-declared allowlist, and the D-22 amendment (BACK-10).
      `DAEMON_ONLY_FIELDS` holds both `agents.<role>.backend` and `agents.<role>.model`
      today, and `mergeConfig` discards a repo-supplied value for either. Keep `backend`
      exactly as it is; gate `model` on a new optional daemon field
      **`repo_model_allowlist: string[]`**, top-level beside `global_budget_usd`. **Absent
      means no repository may choose a model at all** — byte-identical to today's behaviour,
      so the field ships closed and opening it is a deliberate daemon act. (Same “absent
      means the check never runs” _shape_ as `global_budget_usd`, but the polarity is
      inverted — absent is restrictive here and permissive there. Say so in the
      `.describe()`, or a reader carries the wrong intuition across from one to the other.)
      `DiscardedField` gains `reason: 'daemon_only' | 'not_allowlisted'` as a frozen array
      plus derived union, so a caller can tell “never permitted” from “not on this daemon's
      list” (convention 6); `dispatcher.ts` already logs the merge report and needs no new
      channel. **The reasoning is recorded in `DECISIONS.md`**: D-22's credential-selection
      rationale is about `backend`, and D-22's own text calls this direction trivial —
      _“Loosening it later is trivial; tightening it later breaks adopters' working
      configs.”_ **Four load-bearing documents assert the opposite today and become false**
      (convention 18) — `packages/manager/README.md`'s “A repository's `adl.yml` can never
      set these”, `adl-yml.ts`'s `backend`/`model` `.describe()` strings, `stage/agent.ts`'s
      `AgentTask.model` docblock (“D-22, daemon/config-controlled”), and `adl-yml.ts`'s own
      docblock example, which `adl-yml.test.ts` executes.

## Notes

- **Check the budget before dispatch, never after.** A check-after design overshoots by
  one full agent run; at Opus rates on a long turn that is real money, and it will be the
  first bug a user reports.
- **Model prices live in a versioned table with `effective_from`, never in code** — that
  table already exists (`model_prices`, seeded in migration `0003`). A price change in code
  silently rewrites historical spend.
- **Prefer the backend's reported cost over your own arithmetic**, and record
  `cost_source ∈ {reported, computed, unknown}` so you can tell later which numbers you trust.
- **Never use `tiktoken` / `gpt-tokenizer` to estimate Anthropic tokens** — wrong
  tokenizer, undercounts by ~15–20% on prose and far more on code. Use backend-reported
  usage or `messages.countTokens()`.
- Budget is a hard gate, so this is core-loop code, not observability.
