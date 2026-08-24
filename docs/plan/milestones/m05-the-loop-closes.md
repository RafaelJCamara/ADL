# M05 — The Loop Closes

**Status:** ◀ **NEXT — this is the active milestone**
**Depends on:** M04
**Requirements:** DETECT-01, DETECT-03, DETECT-05, LOOP-01, LOOP-02, ROLE-01, ROLE-03,
ROLE-11, SPEC-06, BACK-09, FORGE-01, FORGE-02, FORGE-05, FORGE-06, FORGE-10 (15)

**Goal:** a feature folder committed to a repository becomes a draft pull request on
GitHub, after a gate failed and sent the developer back, with no human touching a single
handoff.

> **This is the milestone where the product first exists.** M01–M04 built machinery
> nobody can see. After M05 there is something to demo.

---

## Done when

- [ ] **AC1 — Detection → draft PR.** A feature folder is committed and, with no further
      action, a draft pull request appears on GitHub at round 1 carrying the developer's
      work. Undeveloped features are identified by *evaluating repository state*, not by
      remembering events, and each feature is claimed exactly once even when detection
      re-runs or the daemon restarts mid-flight.
- [ ] **AC2 — Send-back works.** A deliberately failing command gate (`npm test`) returns
      the developer to work carrying the failing verdict as context, and a subsequent
      round passes and promotes the draft to ready. **The loop is *not* considered proven
      by a feature that passes first try.**
- [ ] **AC3 — Gate integrity.** A developer that edits a spec, the gate configuration, or
      a test that judges it has that round hard-failed — detected by *diffing what it
      wrote*, not by asking. Gate context is assembled from spec, diff and repository
      only; the developer's session and transcript are structurally unreachable.
- [ ] **AC4 — The PR stays readable.** Each agent role's presence on the PR is one sticky
      comment edited in place with prior rounds collapsed — not one comment per role per
      round. **ADL never merges**; the pull request waits for a human.
- [ ] **AC5 — Accounting and trust.** Every agent invocation records its tokens and cost
      against the feature, and a spec arriving from a fork, a non-default branch, or an
      author without write permission is ignored rather than run.

---

## Steps

Four groups, plus two openers. Within a group the order is a suggestion; across groups it
mostly isn't — group C needs a gate to run and group D needs everything.

### Openers — the house pattern

- [x] **5.0** — **Supply-chain gate.** `octokit` and `@octokit/auth-app` are the first new
      runtime dependencies since M04. Every prior milestone opened by confirming
      repository/org and version against the public registry *with a human in the loop*,
      **before** installing, and recorded the exact pins for the installing step to consume
      verbatim. Do that.
      **Approved 2026-08-24:** `octokit@5.0.5` (`github.com/octokit/octokit.js`) and
      `@octokit/auth-app@8.3.0` (`github.com/octokit/auth-app.js`) — both MIT, both
      `node >=20`, both published by the official `octokit` org (`gr2m` / `octokitbot`),
      matching `.claude/CLAUDE.md`'s existing research pins exactly. Consumed verbatim by
      the `packages/forge-github` scaffold in 5.9.
- [x] **5.0b** — **Tracer, not a feature.** One thin, production-quality path all the way
      through before any widening: a committed feature folder is detected → a draft change
      request appears on a real GitHub repo. This touches 5.1, 5.8 and 5.9 at once. Every
      earlier milestone proved this ordering pays; it is how the layer that's wrong gets
      found on day one instead of at integration.
      **Credential decision (2026-08-24, human-in-the-loop):** matches M04's precedent
      exactly (see `DEBT.md` § 1) — no live GitHub App is wired up this session. The
      production `ForgeAdapter`/GitHub-App code path is built and proven end to end in an
      automated test against a local mock GitHub HTTP server (real `octokit` +
      `@octokit/auth-app` wiring, zero network), and the one live-credentialed run against
      a real GitHub App and a real test repo is added to the end-of-project batch.

### A · Detection — turn on the front door (AC1, AC5)

- [x] **5.1** — `features/` scanner. A pure function over repository state that lists
      feature folders on the default branch. Reads through `ManagerGitClient` (M02) so it
      inherits the config neutralisation for free.
      **Shipped:** `@adl/core/detect`'s `scanFeatureFolders` (pure) +
      `packages/manager/src/detect/scanner.ts`'s `listFeatureFolders` (the I/O half, through
      a new `ManagerGitClient.listFiles`). The *undeveloped* predicate (5.2) is not built —
      this step only proves detection, not enqueueing.
- [x] **5.2** — The *undeveloped* predicate. Cross-reference scanned folders against the
      `features` table and open ADL change requests. Pure and exhaustively testable —
      this is the heart of DETECT-01, and "evaluate state" rather than "remember events"
      is the whole point.
      **Shipped:** `@adl/core/detect`'s `undevelopedFeatureFolders` (pure) +
      `packages/manager/src/detect/undeveloped.ts`'s `undevelopedFeatures` (the I/O half,
      through `FeaturesRepository.findByPath` and `ForgeAdapter.listOpenChangeRequests`).
      A folder is excluded either by a known `features` row or by a currently-open change
      request, so a lost `features` row does not re-admit a feature whose change request is
      still open — the same predicate DETECT-05's restart reconciliation (5.6) will reuse.
      **Deviation:** `ChangeRequest` gained a `head` field (the branch it was opened from,
      echoed back by the forge) so a change request can be matched to a folder via
      `@adl/workspace`'s `featureIdFromBranch` — `listOpenChangeRequests` had no way to
      report this before. Not yet wired into `daemon.ts`'s automatic dispatch (5.5's job).
- [x] **5.3** — Trusted-path filter (SPEC-06). Default branch only; author must have write
      permission; fork PRs ignored unless explicitly opted in. Reject *before* anything is
      enqueued.
      **Shipped:** `@adl/core/detect`'s `evaluateSpecTrust` (pure) +
      `packages/manager/src/detect/trust.ts`'s `evaluateFeatureTrust` (the I/O half). The
      write-permission check is real: `ForgeAdapter.authorPermission` finds the most recent
      commit touching a folder and the GitHub account it resolves to (`repos.listCommits` +
      `repos.getCollaboratorPermissionLevel`), never trusting the raw, spoofable git author
      identity. `'unknown'` (unresolvable author) is a distinct rejection reason from
      `'none'` (a real, checked account with zero access) so a caller can log which one fired.
      **Deviation:** `ForgeAdapter` gained `authorPermission` and `CollaboratorPermission`.
      **Scope note:** the branch/fork dimensions are real in the pure predicate and fully
      tested, but M05's own call site always passes `ref === defaultBranch` and
      `isFork: false` — 5.1's scanner only ever reads the default branch, so there is no live
      M05 path that could produce anything else. M10's webhook path is the first real caller
      of those two dimensions, reusing this same predicate rather than a second one. Not yet
      wired into `daemon.ts`'s automatic dispatch (5.5's job).
- [x] **5.4** — Production `resolveAdlYml`. M03 left this as a required injected function
      with no real implementation; implement it and wire it into `startDaemon`.
      **Shipped:** `packages/manager/src/config/resolve-adl-yml.ts`'s `resolveProductionAdlYml`
      reads `adl.yml` off `mainRepo`'s own working tree through `@adl/workspace`'s
      `hostGitWorkspace.read()` — a plain, D-02-contained working-tree read that
      `git/host-backend.ts`'s own `read()` docblock reserved for exactly this since M02,
      deliberately never a git-ref lookup: `mainRepo` is ADL's own checkout, which no agent
      ever touches, unlike a feature's worktree (5.1's scanner reads a committed ref for the
      opposite reason). `StartDaemonOptions.resolveAdlYml`/`DispatcherDeps.resolveAdlYml`
      keep M03's exact required-synchronous shape (`boot/startup.ts`'s own docblock names it
      as the precedent) — the one real read happens once at boot, before the synchronous
      closure `dispatchOnce` receives ever exists. `startDaemon` now refuses to start
      (`AdlYmlUnavailableError`, mirroring `SchemaVersionRefusalError`/`BackendUnavailableError`
      exactly) when `adl.yml` is missing or fails `AdlYmlSchema` validation — before the API
      binds, before any lease is acquired. `resolveAdlYml` is now optional on
      `StartDaemonOptions`: every pre-5.4 test fixture keeps supplying its own explicit
      value unchanged (zero test churn), and the production path only fires when one is
      absent. **Scope note:** v1 has exactly one physical `mainRepo`, so this resolves ONE
      `AdlYml` and returns it for every feature regardless of `repo_id` — matching
      `dispatchOnce`'s and `gc-schedule.ts`'s own existing single-repo assumption, not a new
      one. This unblocks 5.7.
- [ ] **5.5** — Polling loop (DETECT-03). A croner job that re-runs detection on an
      interval and enqueues what's new. Reuse the `gc-schedule.ts` shape — `protect: true`,
      one pass per tick, each step in its own try/catch.
- [ ] **5.6** — Exclusive claim + restart reconciliation (DETECT-05). A feature is claimed
      exactly once across re-detection *and* a daemon restart mid-flight, reconciled
      against open ADL change requests. Build on the existing lease CAS in
      `packages/db/src/repository/features.ts` — don't invent a second claim mechanism.
- [ ] **5.7** — Make `adl daemon start` actually boot the manager in-process. This closes
      the honest gap M03 shipped deliberately; 5.4 is its blocker.

### B · Forge — the output side (AC1, AC4)

- [x] **5.8** — The `ForgeAdapter` port. **Forge-neutral vocabulary throughout —
      `ChangeRequest`, never `PullRequest`.** Design to Gitea's floor: top-level comments
      only, no line-level diff comments, no review updates, no PR-code-comment webhook.
      Operations needed: create branch, open draft CR, promote to ready, upsert a comment,
      list open CRs, read a file, read a diff.
      **Shipped:** `packages/core/src/forge/forge.ts`. **Deviation, explained in the
      docblock:** no `createBranch` method — that's `ManagerGitClient.push` (an ordinary
      authenticated git push), not a forge REST call; no forge in scope has one either.
- [x] **5.9** — GitHub adapter (`octokit` + `@octokit/auth-app`) implementing 5.8. A
      GitHub App, not a PAT — scoped, revocable, per-installation, higher rate limits.
      **Shipped:** `packages/forge-github` — every 5.8 operation, `promoteToReady` via a
      GraphQL `markPullRequestReadyForReview` mutation (REST has no "unset draft"). Tested
      against a hand-rolled `node:http` mock GitHub server; the one live-credentialed run
      is `DEBT.md` item 1.7.
- [ ] **5.10** — Draft CR at round 1, promoted to ready only when every gate is green
      (FORGE-05).
- [ ] **5.11** — Sticky per-role comments (FORGE-06). One comment per role, edited in
      place, prior rounds collapsed into `<details>`. Four gates over five rounds is twenty
      comments if you get this wrong — the AI-slop pattern maintainers are revolting
      against, and the exact shape GitHub's secondary rate limiter penalises.
- [ ] **5.12** — Never-merge guard (FORGE-10). A structural assertion that no code path
      can call merge — prefer "the adapter has no merge method" over "we don't call it".

### C · The loop — the middle (AC2, AC3)

- [ ] **5.13** — The round-loop runner. Wire `resolvePipeline` into production for the
      first time (it exists in `@adl/core/config` with no caller). develop → gates →
      `aggregate()` → advance or send back. Read back the `StageRunnerVerdict` envelope
      M04 left unread, and call `resetCrashCountOnSuccess` at the round-completion write
      site, in the same transaction as the round outcome.
- [ ] **5.14** — The command-gate stage. Runs `adl.yml`'s test command through
      `workspace.exec` and translates the exit code into a verdict. **Deterministic and
      forceable to fail on demand** — that is why the first gate is a command gate and not
      the reviewer agent: no agent nondeterminism confounding the send-back signal.
- [ ] **5.15** — Send-back carries the failing verdict into the next developer prompt as
      context (LOOP-02).
- [ ] **5.16** — Protected-path enforcement (ROLE-11). Diff what the developer wrote; if
      it touched a spec, the gate configuration, or a test that judges it, hard-fail the
      round. **Detected by diffing, never by asking the agent.**
- [ ] **5.17** — Fresh-context gate isolation (ROLE-03). Gate context is assembled from
      spec + diff + repository only. Make the developer's session and transcript
      *structurally* unreachable from a gate — a type the gate cannot name, not a rule it
      is asked to follow.

### D · Accounting and proof (AC5, AC2)

- [ ] **5.18** — Record tokens and cost for *every* agent invocation in the loop
      (BACK-09). M04 built the recording path and proved it for `dev-run`; extend it to
      every role and round. Degrade visibly to `cost_source: 'unknown'` — never silently.
- [ ] **5.19** — The end-to-end scenario test. Feature folder → draft CR at round 1 → gate
      fails → send back → round 2 passes → promoted to ready. This is AC2's proof and the
      milestone's tracer; it must fail the first time through by construction.

---

## Notes and constraints

- **Polling only.** Webhooks are deliberately M10 — polling already works, so webhooks
  block nothing.
- **The first gate is a command gate, not the reviewer.** Deterministic and forceable to
  fail, so send-back plumbing is proven without agent nondeterminism in the signal.
- **Forge-neutral vocabulary from day one.** `ChangeRequest`, not `PullRequest`. Renaming
  this later costs a sweep through every adapter.
- **Best moment for the cost-accounting spike.** M06 is blocked on reconciling a reported
  cost against a real bill. A real agent turn happens here for the first time in anger —
  do the reconciliation while you're in it. See [`DEBT.md`](../DEBT.md).
- **Deliberately excluded:** reviewer agent (M07), tester agent (M08), third-party
  harnesses (M13), webhooks (M10), budget enforcement (M06), dashboard (M17), second forge
  (M14), second backend (M11).

## Where the seams already are

| You need | It already exists at |
|---|---|
| A pipeline resolver | `packages/core/src/config/pipeline.ts` — `resolvePipeline`, no caller yet |
| Verdict aggregation | `packages/core/src/verdict/aggregate.ts` |
| Round / attempt rows | `packages/manager/src/bookkeeping/attempt.ts` |
| A stage runner | `packages/manager/src/worker-entry/stage-runner.ts` |
| Exclusive claim (CAS) | `packages/db/src/repository/features.ts` |
| A scheduled-sweep pattern to copy | `packages/manager/src/scheduler/gc-schedule.ts` |
| Cost recording | `packages/db/src/repository/usage.ts` + the `usage` IPC message |
| ADL's own git chokepoint | `packages/workspace/src/git/adl-git.ts` |
| The `features/` scanner | `@adl/core/detect` (pure) + `packages/manager/src/detect/scanner.ts` (I/O) — done, 5.1 |
| Branch push | `ManagerGitClient.push` (`packages/workspace/src/git/manager-git.ts`) — done, no credential-URL construction included |
| The `ForgeAdapter` port + a real GitHub adapter | `@adl/core/forge` + `packages/forge-github` — done, 5.8/5.9. `upsertComment`'s sticky-marker find-or-create is already there for 5.11 to call. |
