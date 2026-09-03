# Session handoff — resume prompt

_Written 2026-09-03, after M07 step 7.4._

This file exists for one job: a session ran out of context mid-queue, and the
next one needs to pick the queue up without re-deriving it. **Everything about
the _project_ lives in [`STATUS.md`](./STATUS.md); what lives here is the
_work queue_ and the in-flight design notes**, which are session state and would
otherwise be lost.

> **Delete or rewrite this file when the queue below is finished.** A handoff
> that outlives its handoff is a stale instruction someone will follow.

---

## The prompt

Paste this into a fresh session.

```
Continue the ADL delivery-loop work. Read docs/plan/STATUS.md first — it's current
as of the last commit and says exactly where things stand.

CONTEXT: In a previous session you were asked to take every remaining item up to
and including M10, build a work queue, and implement them one by one. Eight items
are done and committed to main (6.10, 6.11, M06 close-out, an M07 step-sketch
refinement, 7.1, 7.2, 7.3, 7.4). M06 is closed and code-complete; M07 is in
progress with 7.1–7.4 done.

REMAINING QUEUE — 31 items, in order. Rebuild this as a task list, then work
through it one at a time:

  7.5  Fresh context proven for the reviewer (ROLE-03)   <- NEXT
  7.6  Spec-clause citation checked against the spec (ROLE-04)
  7.7  Known-bad-diff fixture corpus, red-build in CI
  7.8  Follow-ups instead of fresh send-backs after round 1 (LOOP-09)
  7.9  Removal proof: delete the reviewer from config, pipeline still runs
  M07 close-out (tick criteria, REQUIREMENTS.md, ROADMAP.md, STATUS.md)
  8.1–8.8, M08 close-out
  9.1–9.8, M09 close-out
  10.1–10.6, M10 close-out

Each milestone's steps are in docs/plan/milestones/. M07's steps are already
refined with real detail; M08–M10 still ship as step *sketches* and each says
"refine into small steps when this milestone starts" — do that refinement as its
own docs commit, after a pre-implementation audit, the way M06 and M07 were
opened. The audits have been high-value: M07's found seven things, two of which
changed what the steps were.

WORKING RULES (also in .claude/CLAUDE.md — follow them exactly):
- One step, one commit, conventional-commit scoped: feat(07-05): …
- Formatting-only changes go in a separate style commit.
- Every load-bearing guard must be WATCHED FAILING against the defect it exists
  to catch, then restored, and the observation written into the commit message
  and the milestone file.
- Anything found and not fixed goes in docs/plan/DEBT.md with a reproduction and
  an owning milestone.
- Update STATUS.md and the milestone file at the end of every step.
- Verify with: pnpm typecheck, pnpm lint, pnpm format, and the package suites.

WHAT 7.5 NEEDS (design was in flight):
The structural guarantee already exists — GateContext has no member naming a
transcript, and eslint's adl/gate-fresh-context fences packages/manager/src/
worker-entry/gates/. What does NOT exist is a run where a real reviewer had a
real developer transcript on disk beside it and demonstrably could not reach it.
Planned shape: a real-daemon scenario (pipeline ['develop','review']) with a fake
claude double that switches role by inspecting its own --append-system-prompt
argv (the reviewer's begins "You are the ADL code reviewer"). As the reviewer it
should actively hunt for the developer's transcript from inside its workspace —
walk the tree for *.ndjson and any logs/ directory — and record what it found.
Assert: the developer's transcript really exists at its real path; the reviewer
found nothing; the reviewer's own prompt artifact contains none of the
developer's transcript content. The reviewer writes its verdict to
.adl/review-verdict.json (see packages/manager/src/worker-entry/gates/
reviewer-gate.ts).

ONE JUDGEMENT CALL TO MAKE, at 7.7: the known-bad-diff corpus measures
rubber-stamping, and measuring it against a fake reviewer measures the fake. It
probably belongs in DEBT.md §1's end-of-project credential batch (items 1.1–1.4)
rather than being faked — but that is a maintainer decision. Raise it, record the
decision in the milestone file the way M06's 6.1 deferral was recorded, and move
on rather than blocking.

KNOWN ENVIRONMENT ISSUE: the manager and workspace suites flake on this Windows
dev machine — always "Test timed out in 5000ms", never a failed assertion, always
passing in isolation. DEBT.md §4 records it. The mitigation already applied to
several files is an explicit per-file timeout ({ timeout: 30_000 }) on tests that
build a real temp repo, worktree or daemon; extend that to new tests of the same
shape. Always baseline against main by stashing before believing a red suite.
```

---

## What the last session actually shipped

Nine commits on `main`, each its own step:

| Commit        | Step                                                                              |
| ------------- | --------------------------------------------------------------------------------- |
| `style(docs)` | normalise three plan files to prettier's output                                   |
| `feat(06-10)` | every role runs on its own model; unpriceable model warned at boot (BACK-10)      |
| `feat(06-11)` | `repo_model_allowlist` — a repo may request an allowlisted model; D-22 amended    |
| `docs(06)`    | close out M06 — code complete, M07 next                                           |
| `docs(07)`    | refine M07's step sketch into steps, after a pre-implementation audit             |
| `feat(07-01)` | `GateContext` replaces `StageContext` as the published gate contract (HARN-01/04) |
| `feat(07-02)` | `on_send_back` is real, and `gate_passed` stays honest (HARN-03)                  |
| `feat(07-03)` | a gate can be any program, judged on a verdict it prints (HARN-02)                |
| `feat(07-04)` | the reviewer agent, on the same interface a third party uses (ROLE-02)            |

**Four findings worth carrying forward**, all recorded in
[`milestones/m07-code-reviewer-gate.md`](./milestones/m07-code-reviewer-gate.md)
and in the commit messages:

1. **`adl/gate-fresh-context` made the reviewer impossible.** It banned the
   identifiers `systemPrompt` and `instructions` outright, and those are
   `AgentTask`'s two required fields — so after 7.1 gave gates an `AgentRunner`,
   a gate still could not invoke a model. Fixed precisely rather than loosened:
   those two moved to `GATE_COMPOSE_ONLY_MEMBERS`, where every _read_ form stays
   banned and composing your own is allowed. An eslint probe established the
   forms are distinguishable before the selector was written, and a second
   fixture asserts a composing gate lints **clean** — the negative control the
   fire-check fixture structurally cannot give.
2. **`D-5-18-1` closed in a better shape than the debt proposed.** It suggested
   watching the transcript stream for a terminal event; that makes reporting a
   consequence of a gate _choosing_ to emit events. The obligation went on the
   runner instead, so there is no call a gate can forget.
3. **7.2's end-to-end proof was genuinely unwritable** when 7.2 shipped —
   `on_send_back: continue` only matters when a gate that is not last sends back,
   and only one gate implementation existed. It landed in 7.3, which made a
   two-gate pipeline buildable, rather than being quietly skipped.
4. **Two existing assertions correctly went red and were updated**: `review` is
   no longer an unsupported stage id, and `GATE_CONTEXT_MEMBERS` gained two
   members. Both are the guards doing their job, and both are recorded as such
   rather than silently edited.

**A side benefit worth not losing:** the manager's `test/worker-entry/`,
`test/scenario/` and `test/loop/` now run green _together_ (108 tests). The
flakiness in `DEBT.md` § 4 was partly real-workspace tests sitting on vitest's
5 s default; that entry's own proposed mitigation is now applied per file, where
the cost is incurred.
