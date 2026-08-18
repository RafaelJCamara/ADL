---
status: testing
phase: 02-workspace-the-exec-boundary
source: [02-VERIFICATION.md]
started: 2026-08-18T22:40:00Z
updated: 2026-08-18T22:40:00Z
---

## Current Test

number: 1
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
awaiting: user response

## Tests

### 1. Accept or reject the cross-feature isolation residual (D-2-R-1)
expected: A human decides whether v1 ships with one trust domain per daemon, or whether per-feature uids block the milestone. See Current Test for the full picture.
result: [pending]

### 2. Reproduce D-2-R-1 on a Linux host
expected: |
  D-2-R-1's reproduction is still marked `[NOT YET REPRODUCED ON A LINUX HOST]`.
  It was written from the code, not run. Confirm on a provisioned Linux
  deployment that feature A's agent can in fact write into feature B's worktree.
  Until this runs, the severity is argued rather than demonstrated — the same
  standard this phase applied to every other claim.
result: [pending]

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
result: [pending]

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
result: [pending]

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
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps

None. All 5 must-haves verified at `84d1d16`; CI run 32184817674 green on both
matrix legs with workspace 205 passed / 0 skipped and zero `[ADL][SKIPPED]`
lines. Every item above is a human decision, not a missing implementation.
