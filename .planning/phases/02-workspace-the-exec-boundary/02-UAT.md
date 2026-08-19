---
status: complete
phase: 02-workspace-the-exec-boundary
source: [02-VERIFICATION.md]
started: 2026-08-18T22:40:00Z
updated: 2026-08-19T09:20:00Z
---

## Current Test

[testing complete]

<!-- resolved: number: 1
name: Accept or reject the cross-feature isolation residual (D-2-R-1)
expected: |
  A human decides whether ADL v1 ships with one trust domain per daemon.

  The privilege drop isolates ADL's agents from the HOST. It provides NO
  isolation between one feature and another: `ADL_WORKER_USER` names one user
  and one group per deployment, so every concurrent feature's child is the same
  uid in the same group. Feature A's agent can rewrite feature B's source AFTER
  B's reviewer stage passed and BEFORE its PR opens — which bears directly on
  ADL's core promise that the loop's review gate means something.

  What was narrowed: scratch homes moved out of world-readable `os.tmpdir()`
  into a daemon-owned `0700` `<tmp>/adl-homes`, with an `--x`-only group grant,
  so reaching a sibling's HOME requires guessing an `mkdtemp` name rather than
  reading `ls /tmp`. Worktrees cannot be narrowed this way — `<root>/<featureId>`
  is predictable by design.

  Why it was not fully fixed: group and mode bits CANNOT separate two processes
  running as the same uid. A real fix needs a pool of distinct uids, manager-owned
  lease state that does not exist until Phase 3, and one sudoers entry per pool
  member — a change to what an adopting team signs off on.

  Note WORK-05's wording ("a dedicated unprivileged OS user with a per-run
  scratch home directory") IS satisfied: the user is singular per deployment by
  specification, and the scratch home genuinely is per-run. This is an
  acceptance decision, not a requirement failure.
awaiting: resolved — accepted 2026-08-19 -->

## Tests

### 1. Accept or reject the cross-feature isolation residual (D-2-R-1)
expected: A human decides whether v1 ships with one trust domain per daemon, or whether per-feature uids block the milestone. See Current Test for the full picture.
result: pass
note: |
  ACCEPTED FOR v1 BY THE MAINTAINER, EXPLICITLY TO BE REVISITED — not closed,
  not withdrawn as a risk. v1 ships with one trust domain per daemon.

  Documented in two places so it resurfaces rather than fading:
  - `deferred-items.md` § D-2-R-1 now carries a DISPOSITION block with the
    decision, the reasoning, and four revisit triggers.
  - `.planning/todos/pending/revisit-cross-feature-isolation.md` — deliberately
    carries NO `resolves_phase:`, so no phase completion can auto-close it. It
    surfaces in `/gsd-progress` and `/gsd-audit-uat` until a uid pool ships or
    the risk is re-accepted with fresh reasoning.

  Revisit triggers: (1) Phase 3 lands manager-owned lease state, the first point
  a uid pool is buildable; (2) concurrency > 1 on a shared/multi-tenant host;
  (3) the mandatory human approval gate before merge is relaxed or automated —
  it is the only remaining control; (4) before any public/multi-tenant
  deployment is advertised.

### 2. Reproduce D-2-R-1 on a Linux host
expected: |
  D-2-R-1's reproduction is still marked `[NOT YET REPRODUCED ON A LINUX HOST]`.
  It was written from the code, not run. Confirm on a provisioned Linux
  deployment that feature A's agent can in fact write into feature B's worktree.
  Until this runs, the severity is argued rather than demonstrated — the same
  standard this phase applied to every other claim.
result: skipped
reason: |
  Cannot be run from the maintainer's Windows development machine — it needs a
  provisioned Linux host with the `adl-worker` user. Maintainer's direction at
  the UAT gate: this MUST be run on Linux eventually; skip for now.

  TRACKED, not dropped:
  `.planning/todos/pending/reproduce-d-2-r-1-on-linux.md` carries the full
  reproduction, deliberately with NO `resolves_phase:` so no phase completion
  can auto-close it. It closes when the reproduction is actually RUN.

  Consequence while it stays open: the v1 acceptance of D-2-R-1 (test 1) rests
  on an ARGUED rather than DEMONSTRATED severity. If the reproduction does not
  behave as reasoned, that acceptance was made against a wrong model of the risk
  and must be re-decided. The todo says so explicitly.

### 3. Accept D-2-R-4 against WORK-07
expected: |
  `neutralisation-residual-risk.test.ts` demonstrates a LIVE arbitrary-execution
  path with full neutralisation in force: a committed `.gitattributes` plus a
  `filter.<driver>.clean` driver executes a chosen program during ADL's own
  `snapshot()`. `git status` does not reach it; `git stash create` does, and
  that is what `snapshot()` runs.

  The six fixed-name keys (`core.askPass`, `gpg.program`, `sequence.editor`,
  `core.alternateRefsCommand`, `gpg.ssh.program`, `uploadpack.packObjectsHook`)
  are NOT reachable through any operation ADL ships today. Owner proposed:
  Phase 15, accepted by the verifier on the grounds that the published threat
  model is where an accepted residual either appears with its reasoning or
  silently stops being accepted.

  Decide: accept for v1 with Phase 15 as the owner, or pull it forward.
result: pass
note: |
  ACCEPTED FOR v1 BY THE MAINTAINER, OWNER: PHASE 15. Not closed.

  Unlike test 1's residual, this one is DEMONSTRATED, not argued —
  `neutralisation-residual-risk.test.ts` passes today and executes a chosen
  program during `snapshot()` with full neutralisation in force. If that test
  goes red the residual closed by accident; if it is deleted or weakened, this
  acceptance stops being observable.

  Documented in two places:
  - `deferred-items.md` § D-2-R-4 — DISPOSITION block with what bounds it and
    three triggers for revisiting EARLIER than Phase 15 (ManagerGitClient gains
    an operation reaching the six excluded fixed-name keys; snapshot() runs
    against a repo ADL does not control; the .gitattributes path becomes
    reachable without a commit).
  - `.planning/todos/pending/phase-15-needs-config-neutralisation-criterion.md`
    — because Phase 15's stated criteria (write auditing, secret scanning,
    egress) say NOTHING about config neutralisation. Without a criterion added
    when Phase 15 is planned, this residual lands in a phase with no acceptance
    point and becomes invisible rather than re-decided. That todo carries
    `resolves_phase: 15` so it closes with the phase that owns it.

### 4. Disposition Warning A — an assertion that cannot fail
expected: |
  `test/lint/no-restricted-imports.test.ts:501-507` claims to assert that the
  workspace exemption reaches `.{ext}`. It cannot fail from the mutation it
  exists to catch: it measures at `packages/workspace/src/exec/run.{ext}`, and
  `adl/no-simple-git-in-workspace-src` REPLACES `no-restricted-imports` for
  everything under `src/`, masking the result.

  Demonstrated: narrowing `WORKSPACE_EXEMPTION` back to `.ts` while leaving the
  ban wide → 40 passed (should have failed). Under that mutation
  `src/exec/probe-run.mts` came back clean (masked) while
  `test/tmpprobe/probe.mts` picked up the ban — the real, untested breakage.

  Fix is small: move the measurement to a `packages/workspace/test/` path.
  Not a blocker — the undetected direction is a lint FALSE POSITIVE (a loud red
  build), and the silent direction is covered. But it is this phase's signature
  defect: a control that passes for the wrong reason.
result: [passed]
note: |
  FIXED in `81d2f19`. The exemption is now measured at
  `packages/workspace/test/helpers/temp-repo.{ext}` — inside the exemption,
  outside the `src/` carve-out, and the only path where narrowing
  `WORKSPACE_EXEMPTION` is observable at all — for both the static-import and
  the require()/import() layer. The identical masked measurement in
  `exempts packages/workspace, and nothing else` was repaired the same way; both
  `src/` assertions are KEPT, each annotated as unfailable-alone and paired with
  one that can fail. Mutation (narrow `WORKSPACE_EXEMPTION` to `.ts`, ban left
  wide): 40 passed before -> 3 failed after -> 40 passed on revert. Second
  mutation (exemption emptied entirely) exposed the defect as worse than
  reported: 1 failure before, from an unrelated control, and 6 after.

### 5. Disposition Warning B — `.mjs` still lints clean
expected: |
  `packages/db/src/probe.mjs` with `import { execa } from 'execa'` produces zero
  architecture errors. The verifier did NOT score this as an SC2 failure: no
  tsconfig compiles `.mjs`, the only two JS files are `eslint.config.js` and a
  test helper inside the exemption, and — unlike the gap it replaces — the scope
  is now named and exported (`TS_SOURCE_EXTENSIONS`) rather than an invisible
  coincidence across six literals.

  The counter-argument, which the verifier recorded so you can disagree:
  `TS_SOURCE_EXTENSIONS`' own docblock says "a build property that holds because
  of a file-naming coincidence is a review property wearing the rule's clothes"
  — and that applies verbatim to `.mjs`.

  Decide: extend the ban to JS extensions, or record `.mjs` as accepted scope.
result: [passed]
note: |
  EXTENDED in `49ff874`, per the counter-argument. `TS_SOURCE_EXTENSIONS` keeps
  its name and docblock; a new `JS_SOURCE_EXTENSIONS` and a derived
  `MODULE_SOURCE_EXTENSIONS` union now build every `adl/*` glob — ban,
  exemption, CR-01 carve-out, core-purity, verdict-schema, all fixture entries,
  and the contract walker (the per-rule reasoning is recorded on the union
  constant; `.jsx` deliberately excluded). Three permanent fixtures added, one
  per JS extension and one per import form. `packages/db/src/probe.mjs` — the
  verifier's exact CLEAN reproduction — now reports at severity 2; probed in
  both directions, `packages/workspace/src/probe.mjs` still permits `execa` and
  still refuses `simple-git`. Mutations: ban narrowed to TS-only -> 3 failed;
  exemption narrowed to TS-only -> 3 failed; walker narrowed with a
  `src/leak.mjs` planted -> walker case red while the simple-git scan went green
  over a file naming `simpleGit`.

## Summary

total: 5
passed: 4
issues: 0
pending: 0
skipped: 1
blocked: 0

## Gaps

None. All 5 must-haves verified at `84d1d16`; CI run 32184817674 green on both
matrix legs with workspace 205 passed / 0 skipped and zero `[ADL][SKIPPED]`
lines.

Items 4 and 5 were the two verifier WARNINGS. Both were routed here as
fix-or-accept and both were FIXED rather than accepted — `81d2f19` and
`49ff874`, each mutation-proven to fail when its property is broken. Items 1, 2
and 3 remain human decisions (a Linux reproduction and two risk acceptances),
not missing implementations.
