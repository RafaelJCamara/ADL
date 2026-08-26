# M12 — DOGFOOD ⛔ HARD GATE

**Status:** ⛔ Gate — blocks M13 through M18 absolutely
**Depends on:** M11
**Requirements:** none — this is a validation gate over M01–M11, not new scope

**Goal:** ADL ships a real feature into its own repository, unattended, ending in a pull
request the maintainer is _willing to merge_.

> **This is a precondition, not a milestone label.** A verdict-schema change costs roughly
> 8× more once it must propagate through three forge adapters, four backend adapters and a
> dashboard. Nothing below this line starts until the gate passes.

---

## Done when

- [ ] A feature folder is committed to ADL's own repository and, with **no human touching
      a single handoff**, a pull request arrives that the maintainer **actually merges**.
- [ ] At least one gate failed and sent the developer back during that run, **and** the
      tester's committed tests fail against the pre-feature commit.
- [ ] The run is **measured, not demonstrated** — first-round approval rate, round-count
      distribution, cost variance, and human-found defects in the merged PR are recorded as
      the baseline every later change is compared against.
- [ ] The "looks done but isn't" checklist passes: no `inconclusive` was rendered as green,
      no protected path was written, and the PR's coverage table matches what was _actually
      executed_.

---

## Step sketch

- [ ] **12.1** — Choose a real feature for ADL's own backlog. Real, not a toy — a demo repo
      can be tuned to pass; ADL's own repo cannot.
- [ ] **12.2** — Write it as a feature folder under `features/` and commit.
- [ ] **12.3** — Run unattended. Touch nothing.
- [ ] **12.4** — Record the baseline metrics (criterion 3). These become the regression
      reference for everything after.
- [ ] **12.5** — Walk the "looks done but isn't" checklist (criterion 4) explicitly, item
      by item, and write down the answers.
- [ ] **12.6** — Merge — or don't, and write down honestly why not. **A gate you talk
      yourself past is not a gate.**

## Notes

- **Blocks:** M13, M14, M15, M16, M17, M18. None of them begins until this passes.
- The one exception already taken is M11 (second agent backend), because an adapter
  interface with a single implementation cannot be shown to be vendor-neutral.
- Criterion 2 exists because a feature that passes first try proves the happy path only.
  The send-back is the product.
- Criterion 3 is the one most likely to be skipped under the excitement of a green run.
  Don't. Without a recorded baseline, every later "did that change make it worse?" is
  unanswerable.
