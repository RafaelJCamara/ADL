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

## After 8.5 — read this before the prompt below (2026-09-26)

**An incident on `main`, resolved.** Three commits titled `agent: implement the feature`
(2026-09-25 19:21:57) landed under `fix(08-05)`: a replay double committed
`agent-output.txt` and a root `adl.yml` into the REAL checkout. The source was not
identified — no transcript in that session ran a test at 19:21, and the serial baseline
before it (19:11–19:14, from `packages/manager`) logs no daemon rooted at the real repo.
They were dropped before the first push, at the maintainer's request, with
`git rebase --onto 1d5ae39 9a2c62a main` (2026-09-26); the rebased tip differs from the
pre-rebase one by exactly those two files. The `test(manager)` commit makes every
committing double refuse to write inside its own source checkout, watched failing in a
throwaway copy of the checkout. `DEBT.md` D-8-05-13 keeps the unexplained cause.

**Three things 8.5 learned that the next steps inherit:**

1. **Pair a table with its key union through `satisfies`, never a type annotation.** An
   annotated `Readonly<Record<K, V>>` makes `keyof typeof TABLE` the annotation's keys, so an
   `Exclude<keyof typeof TABLE, K>` "stale key" guard asserts nothing — and an
   `Object.freeze` argument gets no excess-property check. 8.5's watched-failing pass found it
   in its own mode table and in 8.3's `app-failure.ts`, the precedent it was copied from.
2. **`Workspace.exec` delivers one line per chunk, newline stripped** — now on the port's
   docblock and pinned by the contract suite. Anything reading structured output rejoins with
   `\n`; `gates/captured-exec.ts` does it for both gates that capture output.
3. **For 8.6:** the tester's suite currently runs every test in its `visible_paths`, so
   pre-existing tests are credited to it (D-8-05-3, reproduced by `behaviour-tester.test.ts`).
   8.6 identifies the tester's own files — it must, to commit them — and should scope the
   suite to them. **For 8.7–8.9:** re-running the suite (stability runs, the run at the base
   commit, the suite-time delta) needs ADL to run it, so `with.suite` probably becomes a
   pipeline-entry key then, under `visible_paths`' principle — `DECISIONS.md` records the
   seam.

---

## The prompt

Paste this into a fresh session.

```
Continue the ADL delivery-loop work. Read docs/plan/STATUS.md first — it's current
as of the last commit and says exactly where things stand.

CONTEXT: You were asked to take every remaining item up to and including M10, build
a work queue, and implement them one by one. M06 and M07 are both closed and
code-complete. Twenty-one items are done and committed to main: 6.10, 6.11, the M06
close-out, an M07 step-sketch refinement, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, the 7.7
deferral, 7.8, 7.9, the M07 close-out, M08's step refinement, 8.0, 8.1, 8.2, 8.3,
8.4 and 8.5.

REMAINING QUEUE — 20 items, in order. Rebuild this as a task list, then work
through it one at a time:

  8.6 — the tester's tests are committed (ROLE-09; D-8-A-1, D-8-05-3)  <- NEXT
  8.7–8.9, M08 close-out
  M09 step refinement, 9.1–9.8, M09 close-out
  M10 step refinement, 10.1–10.6, M10 close-out

M08's sketch HAS been refined — ten steps, 8.0 through 8.9, with the audit's ten
findings in the milestone file's own header. 8.0 through 8.5 are done. Before
starting 8.6, read "After 8.5" at the top of HANDOFF.md, the 8.5 done-text in the
milestone file, and DEBT.md's D-8-A-1 and D-8-05-3 — 8.6 owns both. 8.0's spike
record decided that ADL, not the tester, carries the surviving tests back into the
developer's worktree and commits them, at a point it controls relative to
`recordRoundHeadSha`.

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

3. D-8-01-1 is CLOSED by 8.2 — the contract suite's comment stripper is now a
   real scanner in `packages/workspace/test/helpers/source-scan.ts`, so a `//`
   line containing `/**` no longer blinds it. Two things that fix taught, both
   still live:
   - A fixture that is supposed to REPRODUCE a defect can be green against it.
     The first version of `source-scan.test.ts` passed against the restored
     block-first stripper, because the lazy block regex closed immediately on a
     line comment containing the four-character opener-plus-closer run. A
     watched-failing pass that does not go red is telling you about your fixture
     as often as about your fix.
   - A `*/` inside a block comment still ends it, obviously — and writing
     "packages/*/src/**" in a docblock is how you discover that at runtime. It
     broke an app fixture with `ReferenceError: src is not defined`.

4. Prettier and Markdown list items do not mix. It silently breaks a blockquote
   when a continuation line starts with `<` or `{` (HTML/JSX), and inside a
   `- [x]` list item it also RE-INDENTS continuation lines on every `--write`,
   growing the indent run after run and eventually de-indenting a line out of the
   item altogether. Lines starting with a backtick-continuation of an inline-code
   span, or with `1`-plus-punctuation, trigger it too. The stable shape for a long
   note inside a list item is ONE UNWRAPPED LINE — which is what step 8.1's note
   already was, and now 8.2's. Always run `pnpm exec prettier --write` twice and
   diff, because a single pass that "succeeds" can still be non-idempotent.

5. A watched-failing injection that stays GREEN may mean your assertion is
   measuring something other than ADL. 8.2's reap assertion passed with
   `controller.abort()` deleted, because the worker exits at the end of a dispatch
   and execa's own `cleanup: true` kills its subprocess then. Before accepting a
   green injection as "not load-bearing", ask what ELSE produces the observable.
   The fix was an ordering change that made the reap observable from outside ADL.

6. `node:child_process` is banned in test fixtures too, including `.mjs` ones —
   `adl/no-direct-spawn`'s `no-restricted-imports` half covers them even though
   DEBT.md § 4 notes the syntax-selector half does not. Do not take an exemption
   for a double. 8.2 needed a multi-process app fixture and used `node:cluster`,
   which is realistic and takes no exemption; that `node:cluster` and
   `node:worker_threads` are missing from the ban's specifier list is now recorded
   in DEBT.md § 4 as a real hole.

7. Do not write a fixture that reproduces a defect without watching it FAIL. Two
   injections in 8.2 and 8.3 passed against the very defect they were written for —
   one because a regex closed earlier than expected, one because the assertion had
   no coverage of the code path at all. Both were found only by running the
   injection, and both changed the test rather than the fix.

KNOWN ENVIRONMENT ISSUE: the manager suite flakes on this Windows dev machine, and
so does the workspace suite. DEBT.md § 4 records it. Run both with
`pnpm exec vitest run --no-file-parallelism`: the workspace suite's default parallel
run is red in 25 places with a clean tree AND with 8.2's changes (identical counts),
and green serially. The manager suite serially is 536/537, the one failure being
D-7-05-1 — confirmed by stashing and re-running, which failed in exactly the same
place. The mitigation already applied to several files is an
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
