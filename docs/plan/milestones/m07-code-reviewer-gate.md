# M07 — Code Reviewer on the Gate Plugin Interface

**Status:** ⬜ Not started
**Depends on:** M06
**Requirements:** HARN-01…04, ROLE-02, ROLE-04, LOOP-09 (7)

**Goal:** the reviewer is the first real plugin gate — judging implementation against spec
and code quality from fresh context, on exactly the interface a third party would use.

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

## Step sketch

_Refine into small steps when this milestone starts._

- [ ] **7.1** — Finalise the gate plugin interface against two real consumers (this
      reviewer, and M08's tester). Publish it through `@adl/plugin-sdk`.
- [ ] **7.2** — Configuration-driven pipeline positioning — a gate declared in `adl.yml`
      lands anywhere in the pipeline with no lifecycle change. (M01's EXEC-07 test already
      asserts this is _possible_; this makes it real.)
- [ ] **7.3** — Plain-command gate contract (a gate that is just a program returning a verdict).
- [ ] **7.4** — The reviewer agent itself, built on 7.1 with zero special-casing.
- [ ] **7.5** — Fresh context enforced structurally — the reviewer never inherits the
      developer's session, transcript, or reasoning.
- [ ] **7.6** — Spec-clause citation required; a `pass` citing nothing is malformed.
- [ ] **7.7** — The known-bad-diff fixture corpus, wired into ADL's own CI as a red-build
      condition.
- [ ] **7.8** — Follow-ups instead of fresh send-backs after round 1 (LOOP-09).
- [ ] **7.9** — Removal proof: delete the reviewer from configuration, watch the pipeline
      run without it and without a code change.

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
  as *the recommended default*, on the grounds that a reviewer sharing the developer's
  model makes the gate decorative — a risk it ranks #5. That request did not survive into
  the live plan. **`DEBT.md`'s `D-6-09-1` owns the decision and is owed an answer by this
  milestone**, alongside its sibling `D-5-18-1` (a gate-invoked agent has no member of
  `GateContext` to report spend through). Both are about the reviewer being the first
  agent-backed gate; neither is a hole in v1 today.
