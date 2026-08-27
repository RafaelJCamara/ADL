# M06 — Accountant: Budgets, Stalls, Escalation

**Status:** ◀ **IN PROGRESS**
**Depends on:** M05
**Requirements:** LOOP-03…08, OBS-05 (7)

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

- [ ] A per-feature round cap and a per-feature token/cost budget both exist, and whichever
      is hit first stops the feature — **checked before the next agent turn is dispatched,
      never after it has been paid for.**
- [ ] A global spend cap above the per-feature caps halts new dispatch across every
      feature once reached, and where a backend's usage reporting is unreliable the budget
      **visibly degrades** to round and wall-clock caps rather than silently ceasing to enforce.
- [ ] A developer/reviewer stalemate is caught by repeated finding fingerprints and
      escalated _before_ the round cap is reached.
- [ ] A provider outage, rate limit, or auth failure consumes neither a round nor budget,
      and the feature resumes rather than being marked failed.
- [ ] Hitting any limit posts the full transcript and the disagreement to the pull request
      where a human will see it, and spend is visible broken down per feature and per role.

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
- [ ] **6.3** — Spend visible per feature in `adl status` (OBS-05). `usageRepository`'s
      `spendByCategory`/`listForFeature` (5.18) already have everything needed; this is a
      `FeatureView` field plus CLI rendering, not new accounting. Cheap, demoable
      immediately, and no dependency on 6.4–6.8 — a deliberately early, low-risk step.
- [ ] **6.4** — Per-feature token/cost budget, checked before dispatch (LOOP-04), and the
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
- [ ] **6.5** — Global spend cap (LOOP-05), same `dispatchOnce` predicate extended with a
      second, feature-independent condition. Fully greenfield: a new `DaemonConfig` field
      (no `global_budget_usd`-shaped field exists anywhere in the schema today) and a new
      repository method summing spend across every feature. `budget.warn` at 80% (the
      original 6.10) is a cheap addition here, on the same check, not a separate step.
- [ ] **6.6** — Stalemate detection over repeated finding fingerprints (LOOP-06),
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
