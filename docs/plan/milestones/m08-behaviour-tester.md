# M08 — Behaviour Tester & Committed Regression Tests

**Status:** ⬜ Not started
**Depends on:** M07
**Requirements:** ROLE-05…10 (6)

**Goal:** behaviour is verified by an agent that *structurally cannot read the
implementation*, against an app ADL starts and tears down itself, leaving tests the team
keeps.

> Simultaneously the highest-leverage feature and the highest-risk one. Thirty features
> means thirty batches of tests the team did not write — the guardrails below are what
> keep that an asset instead of pollution.

---

## Done when

- [ ] The tester designs and runs tests from a workspace containing only the spec, the
      test directory, `adl.yml`, and the running app. **The implementation source is
      *absent*, not merely forbidden by instruction.**
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

## Step sketch

*Refine into small steps when this milestone starts.*

- [ ] **8.1** — Composed workspace: build a workspace view containing spec + test dir +
      `adl.yml` + the running app, with implementation source physically absent. This is a
      `WorkspaceBackend` composition problem, not a prompt problem.
- [ ] **8.2** — App lifecycle owned by ADL: build → start → readiness probe → teardown,
      on an allocated port, reaping the process group. `adl.yml`'s `ready` /
      `ready_timeout` contract from M01 is the input.
- [ ] **8.3** — Never-ready → `inconclusive` (never `pass`).
- [ ] **8.4** — The tester agent on M07's gate interface.
- [ ] **8.5** — Structured runner output parsing; zero tests executed → `inconclusive`.
- [ ] **8.6** — Commit the tester's tests into a demarcated location in the repository.
- [ ] **8.7** — The four committed-test guardrails: assertion floor, spec-clause link,
      repeated stability runs, **and a mandatory failure against the pre-feature commit.**
- [ ] **8.8** — Report the added suite-time delta so test debt is visible as it accrues.

## Notes

- ⚠️ **Research flagged.** Tester prompt design under the *structural* code-blind
  constraint has no public exemplar. Budget a spike.
- **The code-blindness must be structural.** A tester that can read the implementation
  starts approving intent instead of outcomes — which is exactly the failure the
  behaviour-first framing exists to prevent.
- **Guardrail 4 is the load-bearing one.** A test that passes against the pre-feature
  commit tested nothing. Without it, committed coverage is a machine for generating
  green noise.
- This is where ImpossibleBench's finding bites hardest: frontier models exploit
  conflicting tests up to 76% of the time, and Claude-family models specifically prefer
  to *modify the tests*. Committing agent-authored tests is exactly the surface that
  exposes. M01's protected paths and the honest "this gate is wrong" exit are the
  mitigations already in place.
