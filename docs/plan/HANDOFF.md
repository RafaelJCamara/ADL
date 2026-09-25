# Session handoff — resume prompt

_Rewritten 2026-09-03, after the M07 close-out; queue advanced 2026-09-24, after M08's
step refinement._

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

CONTEXT: You were asked to take every remaining item up to and including M10, build
a work queue, and implement them one by one. M06 and M07 are both closed and
code-complete. Seventeen items are done and committed to main: 6.10, 6.11, the M06
close-out, an M07 step-sketch refinement, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, the 7.7
deferral, 7.8, 7.9, the M07 close-out, M08's step refinement, 8.0, and 8.1.

REMAINING QUEUE — 24 items, in order. Rebuild this as a task list, then work
through it one at a time:

  8.2 — the app lifecycle ADL owns (ROLE-07; the milestone's TRACER slice)  <- NEXT
  8.3–8.9, M08 close-out
  M09 step refinement, 9.1–9.8, M09 close-out
  M10 step refinement, 10.1–10.6, M10 close-out

M08's sketch HAS been refined — ten steps, 8.0 through 8.9, with the audit's ten
findings in the milestone file's own header. 8.0 and 8.1 are done: read "The 8.0
spike record" in that file before starting 8.2, because it revised finding 3, and
read 8.1's own note, because the end-to-end proof there found that a gate's
WORKSPACE and the place ADL reads the spec and diff from are two different
things. Start at 8.2 — it is the milestone's tracer slice. M09 and M10 still ship as
step *sketches* and each says "refine into small steps when this milestone starts"
— do that refinement as its own docs commit, after a pre-implementation audit, the
way M06 and M07 were opened. The audits have been high-value: M07's found seven
things, two of which changed what the steps were, and M08's found ten, four of
which did.

WORKING RULES (also in .claude/CLAUDE.md — follow them exactly):
- One step, one commit, conventional-commit scoped: feat(08-01): …
- Formatting-only changes go in a separate style commit.
- Every load-bearing guard must be WATCHED FAILING against the defect it exists
  to catch, then restored, and the observation written into the commit message
  and the milestone file.
- Anything found and not fixed goes in docs/plan/DEBT.md with a reproduction and
  an owning milestone.
- Update STATUS.md and the milestone file at the end of every step.
- Verify with: pnpm typecheck, pnpm lint, pnpm format, and the package suites.

FOUR TRAPS THESE SESSIONS HIT, all worth knowing before you start:

1. `@adl/manager` resolves `@adl/core` through its BUILT dist, not through src.
   A core-only edit is invisible to a manager test until `pnpm --filter @adl/core
   exec tsc -b .` runs. One watched-failing injection passed green for exactly
   this reason before being re-run against a rebuilt dist. Any watched-failing
   pass that edits @adl/core and observes @adl/manager must rebuild in between,
   or it is observing the old code.

2. `git checkout -- <file>` to undo an injection also reverts the step's own
   uncommitted work in that file. Undo injections by reversing the edit, not by
   checking the file out.

3. A `//` line comment containing the three characters `/**` BLINDS the contract
   suite's comment stripper for the rest of the file, because
   `workspace-contract.test.ts`'s `withoutComments` strips block comments first.
   8.1 hit this documenting a glob: its `exec` DID call `assertCwdWithinRoot` and
   the suite reported it as an unguarded `run()` caller, because 5223 of 15066
   characters survived the strip and `async exec` was not among them. This is
   DEBT.md's D-8-01-1 and 8.2 OWNS IT — the dangerous direction is the inverse, a
   genuinely unguarded module passing because an innocent `/**` hid it.

4. Prettier silently breaks a Markdown blockquote when a continuation line starts
   with `<` or `{` — it reads them as HTML/JSX and drops the `> ` prefix, so
   everything after that line falls out of the quote. It bit the M08 milestone
   file twice (`<path> <baseRef>` and `{ test: 'command' }` at a line start).
   Re-wrap so no quoted line begins with either character, and re-run
   `pnpm exec prettier --check` after writing any long blockquote.

KNOWN ENVIRONMENT ISSUE: the manager suite flakes on this Windows dev machine.
DEBT.md § 4 records it. The mitigation already applied to several files is an
explicit per-file timeout ({ timeout: 30_000 } or larger) on tests that build a
real temp repo, worktree or daemon; extend that to new tests of the same shape.
Always baseline against main by stashing before believing a red suite — that is
how `test/tracer/draft-cr-wiring.test.ts` was found red on a clean tree and became
DEBT.md's D-7-05-1. It is INTERMITTENT: 8.1 measured four full-suite runs on a
clean main (one failure) against four with its changes applied (two), so a single
red run proves nothing either way. Baseline with several runs, not one.
```

---

## What the M07 sessions shipped

Fourteen commits on `main`, each its own step. The five from this session:

| Commit        | Step                                                                |
| ------------- | ------------------------------------------------------------------- |
| `feat(07-05)` | fresh context, observed rather than declared (ROLE-03)              |
| `feat(07-06)` | a citation must name a criterion the spec actually has (ROLE-04)    |
| `docs(07-07)` | defer the known-bad-diff corpus to `DEBT.md` § 1 (maintainer call)  |
| `feat(07-08)` | a gate's later findings become follow-ups, not send-backs (LOOP-09) |
| `feat(07-09)` | deleting the reviewer from `adl.yml` removes it (HARN-04)           |
| `docs(07)`    | close out M07 — code complete, M08 next                             |

**Five findings worth carrying forward**, all recorded in
[`milestones/m07-code-reviewer-gate.md`](./milestones/m07-code-reviewer-gate.md)
and in the commit messages:

1. **The step sketch's rule for LOOP-09 was wrong twice, and writing it found
   both.** "A finding first raised in round 2+" cannot be the rule: `review`
   defaults to `on_send_back: stop`, so a reviewer may not run until round 2 and
   its first opinion would be non-blocking. And the rule must not apply to every
   gate — the command gate's finding title carries the exit code, so `exit 1`
   then `exit 2` are two fingerprints and demoting the second would turn a broken
   build green. The contract is per stage, and only `opinion`-judged gates are
   demotable.
2. **ROLE-04's check belongs one level out from where the sketch put it.** A
   plain-command gate can cite `AC-99` exactly as easily as a model can, and the
   `verdict_checked_criteria` row is exactly as false. Enforcing it once for all
   gates is stricter _and_ less special-casing, which is what HARN-04 asks for.
3. **7.5 and 7.9 both proved something by observing the external process**, not
   by asking ADL. The double writes a report file only when launched as the
   reviewer, so the file's presence answers "did ADL start one" without trusting
   ADL's own bookkeeping. That pattern is reusable for M08's tester.
4. **`gate_passed`'s honesty has now cost two extra event kinds** —
   `gate_deferred` (7.2) and `gate_follow_ups` (7.8), both on the identical
   `gating → gating` edge. Three kinds, one edge: they differ in what they mean
   to a reader, never in what they do to the state machine. Expect M08 to face
   the same question.
5. **Two maintainer decisions were raised rather than guessed**, and both are
   recorded where the reasoning lives: 7.7's deferral (`DEBT.md` § 1 item 1.8)
   and D-6-09-1's answer (warn at boot, including the backend default, because
   that is where the risk bites and its remedy is one config line).

**Two debts closed:** `D-5-18-1` (7.1) and `D-6-09-1` (the close-out). **One
opened:** `D-7-05-1` — `upsertComment` is check-then-act, so a sticky comment can
be posted twice; reproduced on `main` with no local changes — intermittently, as
8.1 later measured — owner M09.
