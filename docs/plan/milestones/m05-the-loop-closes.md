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
- [x] **5.5** — Polling loop (DETECT-03). A croner job that re-runs detection on an
      interval and enqueues what's new. Reuse the `gc-schedule.ts` shape — `protect: true`,
      one pass per tick, each step in its own try/catch.
      **Shipped:** `packages/manager/src/scheduler/poll-schedule.ts`'s `runPollOnce` +
      `startPollSchedule` — the first production caller of 5.1's `listFeatureFolders`, 5.2's
      `undevelopedFeatures`, and 5.3's `evaluateFeatureTrust` together: scan → undeveloped
      filter → trust filter → enqueue (a `queued` `features` row, the same shape
      `POST /dev-run/:featureId` already inserts, `spec_hash` computed the same way). Each
      pipeline step runs through a `gc-schedule.ts`-style `step()` wrapper (catch, log,
      fall back to empty rather than crash the tick); each trusted folder is enqueued in
      its own try/catch so one folder's spec-load failure doesn't stop the rest.
      `daemonConfig.poll.interval_ms` (new, default 60s) is `startGcSchedule`'s exact
      croner shape at a much shorter cadence.
      **Deviation:** the forge dependency (`ForgeAdapter` + `ForgeRepoRef`) is injected via
      `StartDaemonOptions.forge`, matching the backend preflight gate's own "absent means
      skip" precedent — no live GitHub App credentials exist yet (`DEBT.md` item 1.7), so
      the poll schedule does not start unless a caller supplies one. **Scope note (matching
      5.4's):** v1 watches exactly one physical repository, so this reads
      `reposRepository(db).list()[0]`, the same single-configured-repository assumption
      `dispatchOnce` and `resolveProductionAdlYml` already make. Proven both in isolation
      (`test/scheduler/poll-schedule.test.ts`, against a real committed git repo + the mock
      GitHub server) and wired for real through `startDaemon`
      (`test/boot/poll-schedule-wiring.test.ts`: a feature folder committed to a real repo
      appears via `GET /features` with no `adl dev-run` call, and does not when
      `options.forge` is absent).
- [x] **5.6** — Exclusive claim + restart reconciliation (DETECT-05). A feature is claimed
      exactly once across re-detection *and* a daemon restart mid-flight, reconciled
      against open ADL change requests. Build on the existing lease CAS in
      `packages/db/src/repository/features.ts` — don't invent a second claim mechanism.
      **Shipped:** the two mechanisms the milestone doc named — the lease CAS
      (`FeaturesRepository.acquireLease` + `dispatchOnce`'s CAS write, M02/M03) and 5.2's
      `undevelopedFeatures` (already 5.5's first production caller) — turned out to already
      be sufficient in isolation; what this step actually built was the proof they compose
      correctly under restart (`packages/manager/test/scenario/detect-restart-reconciliation.test.ts`):
      a feature detected and dispatched for real is left alone by repeated re-detection while
      still in flight, and by a fresh `startDaemon()` booted against the same database and
      repository after the first is stopped — never a second `features` row for the same
      folder, and the recovered row is re-leaseable, not stuck.
      **The real finding, and the actual engineering work:** tracing `undevelopedFeatures`'s
      lost-row reconciliation all the way through a *real* dispatch (`dispatchOnce` →
      `createProductionStageRunner` → `@adl/workspace`'s `createWorktree`) surfaced that it was
      built against a branch shape production never creates. `@adl/workspace`'s GC sweep
      (`gc.ts`'s `sweepOrphans`, Phase 2) reads a managed worktree's branch back through
      `featureIdFromBranch` and calls `FeaturesRepository.findById` with the result — it needs
      the `features` row's own ULID. DETECT-05's reconciliation needs the opposite: the
      folder's basename, recovered from an open change request whose row is gone — the ULID
      is exactly what was lost with it. A real dispatch was handing `backend.create()` the bare
      ULID (`assign.featureId`) as the worktree/branch identity, so `featureIdFromBranch` could
      only ever return one of the two, never both, and the reconciliation this step exists to
      prove would have silently never matched a real production branch. Fixed by composing both
      into the branch a real dispatch creates — `adl/<folderName>--<ulid>`
      (`packages/manager/src/branch-identity.ts`'s `composeBranchFeatureId`/`decodeBranchFeatureId`,
      a manager-package-local convention; `@adl/workspace`'s `branchNameFor`/`featureIdFromBranch`
      are unchanged and stay unaware of the compound shape, exactly as their own tests still
      assume). `worker-entry/stage-runner.ts` composes it before `backend.create()`;
      `scheduler/gc-schedule.ts`'s `createFeatureStateLookup` and `detect/undeveloped.ts`'s
      `undevelopedFeatures` each call one of `branch-identity.ts`'s own fallback-aware readers —
      `ulidOf`/`folderNameOf` — rather than `decodeBranchFeatureId(x)?.half` inline: a bare id
      with no `--` (every pre-5.6 fixture, and the tracer's own non-composed branch) must fall
      back to being treated as the answer whole, never be dropped, and the two real call sites
      independently hand-rolled that fallback and disagreed until code review caught it —
      `undevelopedFeatures` was silently dropping an unrecognised branch instead of falling
      back, which would have made a real, still-open change request invisible to reconciliation
      the moment production ever created one. Centralising the fallback in the two named
      exports is what makes a third future call site copy the correct behaviour structurally
      rather than reinvent the same bug a third time. A ULID never contains `-` (Crockford
      base32), so splitting on the last `--` is unambiguous no matter what the folder name
      itself contains. Watched failing against the exact defect before landing each fix
      (`undevelopedFeatures`'s reconciliation test, the new restart scenario's lost-row case,
      and — after the review round — a dedicated bare-branch case all reproduced the false
      "not yet developed" verdict), per the house convention.
      **Deviation:** `stage-runner.test.ts`'s and `dev-run-end-to-end.test.ts`'s own worktree-path
      assertions were checking `scratchRoot/<bare-featureId>` — silently vacuous once the real
      path became `scratchRoot/<folderName>--<ulid>` — updated to compute the same composition
      the production code now does, rather than asserting against a path that was never created.
- [x] **5.7** — Make `adl daemon start` actually boot the manager in-process. This closes
      the honest gap M03 shipped deliberately; 5.4 is its blocker.
      **Shipped:** the package-boundary decision (D-21's "which package owns the binary",
      left open by M03) is resolved: `@adl/manager` now depends on `@adl/cli` as a library
      and ships `packages/manager/src/bin.ts` as the real, installed `adl` executable.
      `@adl/cli` is completely unchanged in behaviour and dependency graph — still zero
      resolution of `@adl/manager`/`@adl/db` — it only gained one new injection seam,
      `BuildProgramDeps.startDaemon` (defaulting to its own honest-gap
      `daemonStartCommand`), which `bin.ts` fills with `@adl/manager`'s new
      `createProductionDaemonStartRunner` (`packages/manager/src/boot/cli-entry.ts`): loads
      `.adl/daemon.json` (`ensureDaemonConfig` — zero-config first run, exactly as
      `packages/manager/README.md` already documented), maps it into a real
      `StartDaemonOptions` (`.adl/adl.db`, colocated `scratch/`, `mainRepo` all derived from
      `cwd()`), wires `claudeVersionCheckRunner` unconditionally (04-07's real backend
      preflight gate, never skipped from this entry point), and reports each of
      `startDaemon`'s three named refusals (`SchemaVersionRefusalError`,
      `AdlYmlUnavailableError`, `BackendUnavailableError`) to `stderr` with exit code 1
      rather than a stack trace. `daemon stop` is untouched — still `@adl/cli`'s own
      `POST /control/shutdown` over HTTP.
      **The real finding:** the tracer test for this step (`packages/manager/test/boot/cli-entry.test.ts`,
      real `startDaemon`, a scripted `claude --version` double) is the first thing in this
      project ever to call `startDaemon` against a truly virgin `.adl/adl.db` — a file with
      *zero tables*, not merely an unseeded-but-migrated one. Every prior test, and
      `runStartupGate`'s own test suite, pre-ran `migrateToLatest` before ever touching
      `metaRepository`, so `meta.getSchemaVersion()`'s very first read had always already
      found the `meta` table (migration 0001's own work) waiting for it. Against a real fresh
      install, that same read threw a raw `SqliteError: no such table: meta` instead of the
      `{kind:'absent'}` `runStartupGate` already knows how to handle (copy, then migrate) —
      the honest gap this step exists to close would have reproduced itself one layer down,
      on literally the first real run. Watched failing for real (the raw `SqliteError` above,
      captured verbatim) before the fix: `packages/db/src/repository/meta.ts`'s shared `get()`
      now catches SQLite's "no such table" (no distinguishable error *code* exists for it —
      message-text matching, mirroring `daemon-config.ts`'s own `isEnoent()` precedent) and
      treats it exactly as the row-not-found case it already had a name for, self-healing
      through `runStartupGate`'s existing, unmodified copy-then-migrate path regardless of
      *why* the table is missing. A regression test for the exact defect —
      `packages/db/test/repos-meta.test.ts`, deliberately with no `migrateToLatest` call —
      is now permanent.
      **Code review caught two more, both real.** (1) `ensureDaemonConfig`'s zero-config
      first-run write (`mkdir`/`writeFile`/`chmod`) had no try/catch, so a real provisioning
      failure (a read-only mount, a full disk) would have thrown raw past `cli-entry.ts`'s
      own `DaemonStartRunner` — which has no `try` around loading config precisely because it
      trusts this function's stated contract — breaking the "never throws" guarantee on
      exactly the first-run path this step exists to make work. Fixed at the source, matching
      `loadDaemonConfig`'s own established contract; a POSIX-only regression test
      (`packages/manager/test/config/daemon-config.test.ts`, an unwritable parent directory)
      proves it returns `{kind:'invalid'}` rather than throwing. (2) The SIGINT/SIGTERM
      handler was neither idempotent nor guarded against a stop already in flight over HTTP
      (`adl daemon stop`) — `process.once` only deregisters the listener for the event it
      fired on, so SIGTERM's own listener survives after SIGINT already triggered shutdown,
      and `gracefulShutdown` is not idempotent (a second `server.close()` rejects). Watched
      failing for real — reverting the fix reproduced both a double `handle.stop()` call and
      an unasserted rejection — before landing a `stopping` guard plus a caught-and-logged
      `.catch()` on `handle.stop()`, so a duplicate stop from any source is a harmless no-op
      rather than a crash.

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
- [x] **5.10** — Draft CR at round 1, promoted to ready only when every gate is green
      (FORGE-05).
      **Shipped, the draft-at-round-1 half:** a real commit now automatically pushes and
      opens a real draft change request, with no manual stitching — the automatic version of
      what 5.0b's tracer proved by hand. The push has to happen *inside* the worker, before
      `createProductionStageRunner`'s own `finally` destroys the workspace (`Workspace.destroy()`
      reclaims the branch along with the worktree), so the manager mints a fresh,
      short-lived, already-credentialed URL once per dispatch
      (`scheduler/dispatcher.ts`'s new `DispatcherDeps.forge.pushCredential`) and threads it
      through the existing `AssignMessage` as a new optional `pushUrl` field —
      `worker-entry/stage-runner.ts` pushes with it right after confirming a real commit, still
      inside its own `try`. A push failure is reported through the exact same `stage_error`
      channel as "could not create the workspace" (`provider_error`, retryable) rather than a
      degraded-but-`committed` outcome or a new `DeveloperOutcome` variant. Opening the change
      request itself stays in the manager: `worker-supervisor/supervisor.ts` gained
      `onDeveloperCommitted`, the first production reader of the `StageRunnerVerdict` envelope
      M04 left unread — fired only for a fence-matched `stage_result` reporting
      `developer_outcome: committed`, which (because a push failure is a `stage_error`
      instead) is itself the guarantee the branch is already on the remote. `daemon.ts` wires
      it to a new `publish/draft-cr.ts`'s `publishDraftChangeRequest`, gated on
      `options.forge` exactly like 5.5's poll schedule.
      **No DB migration.** Idempotency ("don't open a second draft CR for a feature that
      already has one") is answered by asking the forge — `listOpenChangeRequests`, matched
      against the exact branch this feature's own dispatch would push
      (`branch-identity.ts`'s `composeBranchFeatureId` + `@adl/workspace`'s `branchNameFor`)
      — the same "evaluate state, don't remember events" discipline 5.2/5.6 already
      established, rather than a new `features` column or table.
      **`packages/forge-github` gained one new capability and two pure helpers:**
      `githubForgeAdapter` now also returns `getPushToken()` (via `octokit.auth({type:
      'installation'})`, reusing the adapter's own already-configured `octokit` instance —
      no second `createAppAuth` call, no new dependency), exposed through a new
      `GithubForgeAdapter` type (`ForgeAdapter` plus this one GitHub-specific extension,
      never added to the neutral port itself — FORGE-10's minimal-interface spirit). New
      `src/repo-ref.ts`: `parseGithubRemoteUrl` (derives `ForgeRepoRef` from a GitHub-shaped
      `remote_url` — no production call site did this before) and `githubPushUrl` (formats
      the token into `https://x-access-token:<token>@host/owner/repo.git`), both pure and
      unit-tested with no network.
      **Closing the real entry point's gap, as planned:** `@adl/core/config`'s
      `WatchedRepoSchema` gained an optional `github_app` block (`app_id`/`private_key`/
      `installation_id`, stored inline like `api.token` already is). `boot/cli-entry.ts` — the
      real `adl daemon start` — now builds a real `ForgeAdapter` and push credential from
      `repos[0].github_app` when configured, wiring `StartDaemonOptions.forge` for the real
      binary for the first time; a `remote_url` `parseGithubRemoteUrl` can't resolve is
      logged and skipped, never a hard refusal. This is also the first real production caller
      of 5.5's poll schedule dependency. `@adl/forge-github` moved from `devDependencies` to
      a real runtime `dependencies` entry of `@adl/manager`. **No live GitHub App credentials
      are configured yet** — `DEBT.md` item 1.7 is unchanged; this only makes the real binary
      *capable*.
      **Scope decision, confirmed with the maintainer before implementation:** the
      "promoted to ready only when every gate is green" half is genuinely not buildable yet —
      group C (5.13's round loop) is what will ever produce an aggregate "every gate is
      green" verdict, and nothing in production evaluates one today. `forge.promoteToReady`
      stays built (5.9) and uncalled, exactly like `resetCrashCountOnSuccess`'s own
      documented-gap precedent — a one-line call site for 5.13 once `aggregate()` exists.
      **No state-machine change.** `publishing`/`cr_opened`/`pr_open`
      (`@adl/core/state/feature-state.ts`) model the loop's *final* hand-off to a human,
      entered only after `all_gates_passed` — which nothing fires yet. A draft CR opened
      early, during `gating`, is a side artifact for visibility, not a lifecycle state; its
      existence is fully answerable by asking the forge, exactly as this step's idempotency
      check already does.
      **`DEBT.md` D-5-R-1 is now live**, not hypothetical: a real credentialed push URL is
      constructed and passed as a `git` argv element on every real dispatch with a forge
      configured. No mitigation attempted this step — the residual is accepted exactly as
      already documented, updated to say so.
      **Proof:** a new tracer, `test/tracer/draft-cr-wiring.test.ts` — real `startDaemon()`
      with a real `forge` (mock GitHub server + a local bare remote standing in for a
      credentialed push target) → `POST /dev-run/:featureId` → real forked worker → real
      commit → real push → real draft CR, with no manual stitching. 5.0b's own manual tracer
      (`detect-to-draft-cr-end-to-end.test.ts`) still passes unmodified — the pieces it
      proved compose by hand are the same pieces this step wired behind the scheduler.
- [x] **5.11** — Sticky per-role comments (FORGE-06). One comment per role, edited in
      place, prior rounds collapsed into `<details>`. Four gates over five rounds is twenty
      comments if you get this wrong — the AI-slop pattern maintainers are revolting
      against, and the exact shape GitHub's secondary rate limiter penalises.
      **Shipped:** the two halves that already existed separately and had never met are now
      joined by a real production caller. `@adl/core/forge`'s new `renderStickyComment`
      (pure, and in core rather than in an adapter because `<details>`/`<summary>` is HTML
      that GitHub, GitLab and Gitea all render — three adapters would otherwise reimplement
      and drift) turns a role's rounds into one comment: the newest round expanded, every
      earlier one folded newest-first. `packages/manager/src/publish/sticky-comment.ts` is
      the caller, fired from the same `onDeveloperCommitted` event 5.10 already used, right
      after the draft CR is opened or confirmed
      (`publish/on-developer-committed.ts` orders the two; `publishDraftChangeRequest` now
      **returns** the `ChangeRequest` — including on its idempotent path, which is the
      normal case from round 2 on — so the comment is published against the change request
      the first step resolved rather than a second, independently-derived answer).
      **No DB migration, no `sticky_comments` table.** The comment is re-derived in full
      from `rounds`/`stage_attempts`/`verdicts`/`findings` every round
      (`publish/role-rounds.ts`) and overwritten — the same "evaluate state, don't remember
      events" discipline 5.2/5.6/5.10 established, which also means a comment a human edited
      or a change request that was deleted is repaired by the next round rather than
      corrupted by it. A role is addressed by `stage_attempts.stage_id`, taken from the
      dispatch that ran, never by a hardcoded `'develop'`.
      **The renderer is where the substance is**, and both of its properties were watched
      failing first. (1) *A round body cannot break the fold it is placed in.* Bodies are
      agent-authored; a literal `</details>` in one closes the block early and spills every
      prior round into view — the exact unreadable pull request FORGE-06 exists to prevent,
      arriving through the mechanism meant to prevent it. `<details`/`</details` are escaped
      to `&lt;…`, and **only outside code spans** — a forge already escapes HTML inside a
      fence, an indented block, and an inline span, so escaping there would turn a correct
      code sample into a visible `&lt;/details>`. Code-span offsets come from
      `mdast-util-from-markdown` (already a `@adl/core` dependency), verified by probe to
      report `position.*.offset` for all three node kinds before anything was written.
      (2) *A comment edited in place forever grows without bound.* Every forge caps a body;
      past the cap `upsertComment` starts failing and the comment silently freezes at
      whichever round last fit. `maxLength` (default 60,000 — deliberately under GitHub's
      documented 65,536, leaving room for the adapter's own hidden marker) makes that
      bounded and *visible*: the newest round is kept whole, older folds are dropped
      oldest-first with the count stated in the comment, the newest round's own body is
      truncated with a notice if it alone overflows, and the returned string is **never**
      longer than `maxLength` for any input — a final surrogate-safe clamp, asserted as a
      property down to a one-character budget.
      **The owned debt item is closed, and it was worse than filed.** `upsertComment` now
      paginates `issues.listComments` (`octokit.paginate`, `per_page: 100`) — but so does
      `listOpenChangeRequests`, which had the identical defect and a heavier consequence:
      5.10's draft-CR idempotency check and 5.2's restart reconciliation both ask it "is one
      already open for this branch?", so a repository with more than one page of open pull
      requests would have answered "no" for a change request that plainly exists and opened
      a duplicate draft every round. The mock GitHub server gained real `per_page`/`page` +
      `Link: rel="next"` pagination so both fixes are *proven*, not asserted — without it a
      first-page-only adapter and a paginating one were indistinguishable, and the guard
      could not have been written at all. Both cases were watched failing against the
      un-paginated code (the comment case only after the seed was corrected: ADL's marker
      has to land *past* page 1, which an ADL-comments-first seed does not reproduce).
      **Found and not fixed — `DEBT.md` D-5-11-1, owner 5.13:** a round's commit sha lives
      only while that round is the newest. It arrives on the event, not from a table, so
      republishing during round 2 renders round 1 from the database alone and its fold loses
      the sha. The durable home is `rounds.outcome_json`, whose writer is 5.13's round loop;
      fabricating a `RoundOutcome` here to hold a sha would corrupt the column that step is
      built on. Asserted as current behaviour rather than merely noted, so 5.13 trips over it.
      **Proof:** 24 renderer cases in `packages/core/test/forge/sticky-comment.test.ts`,
      the DB reader and publisher in `packages/manager/test/publish/`, and 5.10's own tracer
      (`test/tracer/draft-cr-wiring.test.ts`) extended — one real `startDaemon` run now ends
      with a real developer comment carrying the real sha the worker actually pushed.
- [x] **5.12** — Never-merge guard (FORGE-10). A structural assertion that no code path
      can call merge — prefer "the adapter has no merge method" over "we don't call it".
      **Shipped as two guards at two layers, because the preferred one cannot reach the
      whole property on its own.** `ForgeAdapter` has never declared a merge method, but
      until this step that was a fact about what happened to be typed into `forge.ts` — a
      `merge()` added to it would have compiled, linted, typechecked and shipped green, since
      the `DECISIONS.md` entry forbidding it is prose and prose does not fail a build.
      **Layer 1, the port (the preferred form).** `@adl/core/forge`'s new
      `FORGE_ADAPTER_MEMBERS` pairs the interface with a frozen list of its own members, in
      the house's `Exclude<T, Arr[number]> extends never` shape, putting two independently
      locked doors between a merge method and a green build: adding a member *without*
      listing it fails the **build** (the exhaustiveness assertion), and getting past that by
      listing `'merge'` fails the **suite** (`packages/core/test/forge/never-merge.test.ts`,
      which rejects any merge-shaped name in the list). The `satisfies readonly (keyof
      ForgeAdapter)[]` clause closes the third direction — a stale name left behind by a
      rename, which would quietly shrink what the test reads, is also a build error. Both
      doors were watched failing against the exact defect before landing: `merge()` on the
      interface alone reproduced `TS2322: Type 'true' is not assignable to type 'never'`, and
      adding `'merge'` to the list turned typecheck green and the core test red, verbatim.
      **Layer 2, the adapter (the residual layer 1 structurally cannot reach).** A forge
      adapter does not merge by calling ADL's port — it merges by calling the *forge*, and
      `packages/forge-github` holds a live `octokit` whose `rest.pulls.merge()` exists no
      matter what ADL's interface declares. `getPushToken` is the standing proof that a forge
      package legitimately reaches past the neutral port when it has to, so "the port has no
      merge method" is not by itself the property FORGE-10 asks for. New
      `eslint.config.js` rule **`adl/no-forge-merge`**, scoped to `packages/forge-*` (a
      package *prefix*, so M14's GitLab and Gitea adapters are governed on the day they are
      created — D-27's own argument, that the rule which lands before the thing it would have
      prevented is the only kind that prevents it), banning two derived selector families
      from two frozen tuples: `FORGE_MERGE_MEMBERS` (`merge`, `mergePullRequest`,
      `enablePullRequestAutoMerge`, `mergeWhenPipelineSucceeds`, `accept`) and
      `FORGE_MERGE_ROUTES` (the REST route suffix, and the two GraphQL mutation names in both
      their template-literal and plain-string forms).
      **Three design points that are the actual substance.** (1) Banned as **member
      expressions**, not call expressions: `const m = octokit.rest.pulls.merge; await m({…})`
      is a call-selector's blind spot and an obvious way to arrive at a merge while
      refactoring — taking the reference is banned, so there is nothing to call later.
      (2) A **vocabulary list, never a search for the substring `merge`**: GitLab spells this
      `accept` and `mergeWhenPipelineSucceeds`, neither of which reads as a merge in a diff,
      while `backend.ts` legitimately reads `pr.merged_at` and compares against `'merged'` /
      `'MERGED'` and `CHANGE_REQUEST_STATES` legitimately contains `'merged'` — a substring
      ban flags all of those, and a guard that noisy gets switched off. A dedicated assertion
      keeps the real GitHub adapter linting clean, and it was watched failing by widening one
      route pattern to `merge`, which immediately reported `backend.ts`'s own state literals.
      (3) `enablePullRequestAutoMerge` is banned alongside the immediate form because it
      merges *after this process exits* — nothing in ADL's logs, transcripts or accounting
      would record the moment the branch landed, and the deferred form is exactly what
      somebody reaches for when the immediate one is refused.
      **Every selector was verified empirically against this repository's own eslint before
      being written** (house convention 15): a throwaway probe confirmed all eight real merge
      shapes fire and that `merged_at` / `'merged'` / `'MERGED'` /
      `markPullRequestReadyForReview` fire on none of them. Two Pitfall-1 hazards are
      handled and asserted: `SPAWN_SYNTAX` is spread into the new rule object (the new entry
      overlaps `adl/no-direct-spawn`'s glob, and flat config replaces rather than merges, so
      omitting it would have made forge packages the one place a dynamic `import('execa')`
      lints clean — watched failing), and `no-restricted-imports` is deliberately left
      unconfigured here so the static-import half keeps resolving from the spawn entry.
      **The guard caught a gap in its own fixture on first run**, which is the fixture
      arrangement working: `mergePullRequest` and `enablePullRequestAutoMerge` were banned as
      member names but exercised only as GraphQL strings, so the "every banned verb fires"
      assertion went red until a typed-SDK case was added for each.
      **Found and not fixed:** `pnpm format` is red on `main` — 23 files, all under `docs/`,
      none touched by this step (`DEBT.md` § 4). `.prettierignore` excludes `.planning/` for
      reasoning that applies verbatim to `docs/plan/`, but that tree was never added. CI runs
      `pnpm format`, so that leg is failing independently of any code change. Left for a
      maintainer decision rather than resolved here.
      **Proof:** 16 cases in `packages/core/test/forge/never-merge.test.ts` (including a
      has-teeth control on the vocabulary matcher itself, and a vacuity control on the member
      list), plus five assertions and one deliberate-violation fixture
      (`test/lint/fixtures/forge-merge-call.ts`) in `test/lint/no-restricted-imports.test.ts`
      — every one of them driven off the exported tuples rather than hand-written per verb,
      so a verb added to the ban gains its assertions automatically and a verb whose selector
      is lost goes red without anyone remembering to add a case.

### C · The loop — the middle (AC2, AC3)

- [x] **5.13** — The round-loop runner. Wire `resolvePipeline` into production for the
      first time (it exists in `@adl/core/config` with no caller). develop → gates →
      `aggregate()` → advance or send back. Read back the `StageRunnerVerdict` envelope
      M04 left unread, and call `resetCrashCountOnSuccess` at the round-completion write
      site, in the same transaction as the round outcome.
      **Shipped, and the loop turns:** `packages/manager/test/scenario/round-loop.test.ts`
      drives a real `startDaemon()` through `develop → gate → green → publishing`, and —
      the case AC2 says is the only one that proves anything — through
      `develop → gate says send_back → round 2's developer runs again → gate passes →
      publishing`, with one real forked worker process per stage.
      **Split in two, as the house splits every decision from its I/O.**
      `@adl/core/loop`'s new `planRoundStep` (pure, total, never throws) answers *which
      lifecycle events a finished stage raises* and *whether the round is over, with what
      `RoundOutcome`* — `aggregate()`'s first production caller. It decides no state:
      `transition()` is still the only code that does, and this function feeds it
      `FeatureEvent`s so a state change still cannot be issued without its audit row and
      version guard. It knows no stage names either — an index, a length, and an opaque
      id that travels straight onto the audit record (EXEC-07's discipline, verbatim from
      `TransitionCtx`). `packages/manager/src/loop/round-runner.ts` is the other half:
      record the evidence, apply the events, close the round.
      **Three sequencing decisions that are the actual substance.**
      (1) *Index 0 is the developer.* `stage/developer-outcome.ts` has stated this contract
      since M01 — "the sequencer special-cases index 0" — and it is enforced rather than
      assumed: a gate verdict arriving in the developer's slot, or a developer outcome in a
      gate's, escalates instead of counting. That is what keeps self-approval from arriving
      through the one door the `DeveloperOutcome` union was shaped to close. It also means a
      pipeline of `develop` alone reaches `aggregate([])` and **escalates** — the developer
      contributes no verdict, so a zero-gate pipeline reporting green is unreachable rather
      than merely unlikely.
      (2) *v1 stops on the first `send_back`.* ARCHITECTURE.md §3 defaults this **by cost
      class** — cheap gates continue and merge findings, expensive ones stop — and neither
      half is buildable: `Stage.costClass` has no implementations, and `OnSendBackSchema`'s
      own `.describe()` records `on_send_back` as Phase 7's. Half a policy is worse than
      none, so `ResolvedStage.onSendBack` is read by nothing and the conservative half
      ships. It also keeps `gate_passed` honest — that event is emitted only when the stage
      did not stop the pipeline. `fail` stops immediately regardless; `inconclusive`
      deliberately does not, because `aggregate`'s own precedence says an inconclusive
      beside real findings usually resolves once the code changes.
      (3) *The pipeline position is written from the sequencer's answer, not from a counter
      delta.* `TransitionResult.counters` expresses position as a delta and the developer's
      step off index 0 is not one — `dev_committed`'s edge *resets* the index (its job is to
      undo a send-back's position). Left to the delta alone, a committed round re-dispatches
      the developer forever. Written absolutely in the same transaction, for the identical
      reason `planRecovery`'s `resetStageIndexTo` is written outside `transition()`.
      **What made the loop actually turn**, and it was not in the step's wording: nothing
      dispatched a feature that was already inside the loop. `transition()` draws no edge
      from `gating` back to `queued` — correctly, since a feature midway through its
      pipeline has not lost its position — so `dispatchOnce`'s `listQueued()` could never
      see it again. New `FeaturesRepository.listDispatchable()` adds "in `developing` or
      `gating`, and unleased"; the round loop hands the lease back when a stage finishes and
      the next tick leases it again from the stage it is on. A **continuation dispatch runs
      no transition at all** and — this is the load-bearing half — **does not re-merge
      `adl.yml`**: versioning rule 3 says the effective configuration is snapshotted at
      lease time precisely so a mid-flight edit cannot change a running feature's pipeline,
      and re-merging on every stage would have done exactly what that rule forbids.
      `dispatchOnce`'s assign-assembly is factored into one `dispatchAssigned` both paths
      call, so the two cannot drift.
      **`StageRunnerVerdict` moved and grew a schema.** It lived in
      `worker-entry/stage-runner.ts` and the manager's only reader was a cast that peeked at
      one field — enough to answer "is there a sha to publish?", not enough to drive a round.
      It is now `ipc/stage-verdict.ts` (a wire contract with two ends belongs beside
      `protocol.ts`, not inside one end), a real Zod union, with a third member for a gate's
      `Verdict`, and `parseStageRunnerVerdict` returns a discriminated result — an
      unreadable payload becomes a `StageError` the loop routes, never a verdict it half
      believes.
      **The worker refuses what it cannot run.** `createProductionStageRunner` implements
      index 0 and nothing else, so a later index now returns a non-retryable
      `binary_missing` naming step 5.14 — before a workspace is created. Running the
      developer agent again as a "gate" would have been self-approval with extra steps.
      **5.10's deferred one-liner is wired**: `promoteChangeRequestToReady`
      (`publish/promote.ts`) is called from exactly one place, reached only through
      `RoundOutcome.kind === 'green'` — so "promoted only when every gate is green" is
      structural, there being no other producer of `green`. Watched failing: promoting on
      any completed round turned a `send_back` round's draft ready.
      `publish/branch.ts` extracts the branch both publish-side callers join on, so there is
      one answer to "which change request is this feature's?" rather than two.
      **`resetCrashCountOnSuccess` finally has its caller** (`DEBT.md` § 5), in the same
      transaction as the round close, per D-11's "the increment and the decision happen
      together". Every *completed* round resets it, not only a green one: the counter
      measures consecutive **crashes**, and a round that reached a `RoundOutcome` broke the
      streak. A retryable stage error takes a different path entirely — `reapOne`, the same
      function a dead worker's exit calls — so the consecutive-failure ceiling applies and a
      provider outage cannot retry forever, and **no round is recorded at all**, because
      nothing was judged (CORE-06, LOOP-07).
      **`DEBT.md` D-5-11-1 is answered, and its premise was wrong.** The item said writing a
      real `RoundOutcome` into `rounds.outcome_json` would stop a prior round losing its
      commit sha. `RoundOutcome` has no field for a commit, so it never could have. What the
      column *does* now carry is the round's real result, and `role-rounds.ts` reads it: a
      finished round folds away as `send_back — 3 findings` or `escalate — <reason>` instead
      of a bare kind. The sha specifically needs a `rounds.head_sha` column — a migration,
      with a second consumer already waiting (a gate needs the diff between the base and
      exactly that commit), so it moves to 5.14 rather than being smuggled in here.
      **Found and not fixed:** the workspace does not survive a stage
      (`Workspace.destroy()` runs in the stage runner's `finally` and `createWorktree`
      refuses to attach to an existing worktree), so a real gate would branch from `baseRef`
      and see none of the developer's work — and the same gap breaks crash recovery today.
      `DEBT.md` § 3, **owner 5.14**, since that is the first step with a gate that needs one.
- [x] **5.14** — The command-gate stage. Runs `adl.yml`'s test command through
      `workspace.exec` and translates the exit code into a verdict. **Deterministic and
      forceable to fail on demand** — that is why the first gate is a command gate and not
      the reviewer agent: no agent nondeterminism confounding the send-back signal.
      **Blocked on workspace continuity, which this step therefore owns** (`DEBT.md` § 3,
      found by 5.13): today `createProductionStageRunner` destroys the worktree in its
      `finally` and `createWorktree` **refuses** to attach to an existing one, so the gate
      would branch from `baseRef` and judge a tree with none of the developer's work in it.
      The same gap breaks crash recovery — a recovery dispatch re-creates over a surviving
      worktree and throws. `WorkspaceBackend.attach` is the shape ARCHITECTURE.md §1 already
      names ("recovery re-attaches to the existing workspace rather than recloning —
      `WorkspaceBackend.attach(handle)` exists for exactly this"); it was never built.
      Also inherits `rounds.head_sha` from 5.13 (`DEBT.md` D-5-11-1): a gate needs the diff
      between the base and this round's commit, which is the same column a prior round's
      sticky-comment fold needs to stop losing its sha.
      **Shipped, and a real gate now turns the loop:**
      `packages/manager/test/scenario/command-gate-loop.test.ts` drives a real
      `startDaemon()` through `develop → test fails → send back → round 2's developer →
      test passes → publishing`, with the **real** `createProductionStageRunner` in four
      real forked workers and only the billed `claude` binary doubled. 5.13's own scenario
      proved the same shape against a *scripted* worker; the difference is that nothing in
      it ever ran a command, so nothing ever needed the developer's commit to still exist —
      which is exactly why D-5-13-1 was found by reading code rather than by a red test.
      **Workspace continuity, the half this step actually owns.** The port was missing two
      symmetric pairs, not one method: `create ↔ destroy` reclaims the **workspace**,
      `attach ↔ detach` reclaims the **run**. `WorkspaceBackend.attach(spec)` returns
      `Workspace | undefined` — `undefined` for the ordinary "nothing here" first-stage
      case, and a **throw** for a half-present workspace, because reporting the second as
      the first would send the caller to `create()` and silently replace an agent's
      committed work. `Workspace.detach()` reclaims the scratch `HOME` and leaves the
      worktree; the stage runner now does `attach(spec) ?? create(spec)` and ends with
      `detach()`, and **no stage calls `destroy()` at all** — reclaiming a workspace is a
      decision made from feature state (D-16) and `gc.ts`'s sweep is what makes it. That
      also fixes crash recovery, which `dispatchOnce` has preserved `workspace_handle` for
      since M03 with nothing to attach with. **Deviation, confirmed with the maintainer
      before implementation:** `detach()` widens `Workspace`, which **is** republished
      through `@adl/plugin-sdk` and therefore one-way (D-01) — the debt item claimed
      `WorkspaceBackend` was the published half and it is not, which inverts which of the
      two methods is expensive. Added now, before that package ships (M18), for D-27's
      reason: the change that lands before the contract it would break costs nothing. The
      alternatives — `backend.detach(ws)`, keeping the published port frozen, or no detach
      at all and letting `sweepScratchHomes` collect — were put to the maintainer with
      their costs and this one chosen.
      **The gate itself is deliberately small.** `worker-entry/command-gate.ts` runs one
      command through `workspace.exec` and answers three ways: exit 0 → `pass` citing
      `{kind:'global', category:'build'}` (never a criterion — `verdict.ts`'s own docblock
      names this gate's honest answer, and a green `npm test` is not evidence that AC-3 was
      verified); non-zero → `send_back` with one blocker finding carrying a **bounded tail**
      of the output; and **killed rather than exited → a `StageError`, not a verdict**,
      because a command with no exit code judged nothing and reporting one anyway would make
      an infrastructure failure cost the developer a round (CORE-06, D-12). The finding's
      title carries the stage and the exit code and nothing that varies per run, so the same
      failure recurring across rounds fingerprints identically — which is what M06's stall
      detection reads. The gate takes a workspace and a command and **nothing else**: no
      spec, no prompt, no agent, so ROLE-03's fresh-context isolation (5.17) is already the
      shape of the call rather than a rule to remember. Which stage ids this build can run
      is a frozen `GATE_IMPLEMENTATIONS` record — `test` today — and an id with no entry is
      refused with a non-retryable `binary_missing` **before a workspace is opened**.
      **`rounds.head_sha` (`0005_rounds_head_sha.ts`) closes D-5-11-1**, written when the
      developer stage reports `committed` rather than at round close — a developer stage in
      any pipeline with a gate in it `advance`s, so a round-close-only write would never
      fire for the pipelines this milestone exists to run. `RoundNote` now carries the raw
      sha rather than rendered text, so the event and the column go through one formatter.
      **A race found and removed while doing it:** the first cut derived a round's headline
      from `roundOutcome === null`, and `onDeveloperCommitted` fires *unawaited, before*
      `onStageCompleted` — so whether a round was closed at render time depended on which
      of two concurrent tasks won, and the tracer caught the resulting flip. The note's
      presence is the deterministic signal and stays the headline's source.
      **Everything load-bearing was watched failing first** (convention 13): reverting
      `detach()` to `destroy()` turned the gate's own case red with `expected 'send_back'
      to be 'pass'` — a gate judging a `baseRef` tree, D-5-13-1 exactly; making `detach()`
      destroy the worktree turned three contract cases red on both backends; dropping the
      `head_sha` read reproduced D-5-11-1's `- Attempt 1 — completed` fold. The six
      `expect(worktree).toBe(false)` assertions in `stage-runner.test.ts` went red on the
      lifecycle change, which is their job, and are inverted rather than deleted.
      **Two empirical corrections, both from probes rather than from reading** (convention
      15): `git rev-parse --abbrev-ref --end-of-options HEAD` **echoes the terminator as a
      rev** and prints two lines, so `attachWorktree` uses `symbolic-ref --short` — which
      honours `--end-of-options` and exits 128 on a detached HEAD, where `rev-parse` prints
      the string `HEAD` and exits 0. And `fake-claude-success.mjs` had to start appending a
      *distinct* line: round 2's developer now attaches to a worktree already containing
      round 1's commit, so a double writing identical content staged nothing, `git commit`
      exited non-zero, and the round retried forever — reproduced on the new scenario's
      first run.
      **Found and not fixed:** `DEBT.md` **D-5-14-1** (a finished feature's worktree is
      never collected — `TERMINAL_STATES` is `merged`/`abandoned` and v1 produces neither,
      owner M09) and **D-5-14-2** (a worker whose `stage_result` was accepted is still
      logged as "exited without an accepted result"; predates this step, reproduces on
      5.13's own scenario, owner M06).
- [x] **5.15** — Send-back carries the failing verdict into the next developer prompt as
      context (LOOP-02).
      **Shipped, and it is the input `ARCHITECTURE.md` named for `buildDeveloperPrompt`'s
      signature before M01 and Phase 4 shipped without** — `SendBackBrief` is now a real
      producer, a real wire crossing, and a real consumer, closing that gap rather than
      merely restating it. **Two halves, split the way this project splits every I/O-vs-pure
      decision:** `packages/manager/src/loop/send-back-brief.ts` (new) holds two pure
      functions with no database and no wire access of their own —
      `sendBackBriefFromClosedRound` reads a `RoundsTable` row (already fetched) and returns
      the `SendBackBrief` only when it closed as `send_back`, and `parseSendBackBriefJson`
      reads the wire string back. Both degrade to `undefined` on anything malformed rather
      than throw — the same "a fold that says less is much better than one that throws"
      discipline `publish/role-rounds.ts`'s `describeRoundOutcome` already established for
      this exact column (rule 5, CORE-06's spirit extended to a plumbing gap rather than a
      stage failure): losing the brief costs round 2's developer a worse prompt, never a
      broken dispatch or a broken stage.
      **The plumbing constraint named in `STATUS.md` held exactly as stated:** a worker
      cannot read the database (`adl/worker-entry-no-db`), so the brief travels on
      `AssignMessage` the way `pushUrl` and `effectiveConfigJson` already do —
      `AssignMessageSchema` gained an optional `sendBackBriefJson`, and
      `scheduler/dispatcher.ts`'s `dispatchAssigned` (the one function both the fresh-dispatch
      and the continuation-dispatch paths already share, precisely so an `AssignMessage`
      cannot drift into two shapes) attaches it, mirroring `pushUrl`'s own "optional, minted
      per-dispatch" precedent.
      **A real ordering bug found before it shipped, and the reason it needed its own DB
      method.** `openAttempt` — called moments later in the same function — reuses a
      feature's open round or **opens a new one**. Reading "the prior round" with the
      existing `latestRound` *after* that call would, on an ordinary first attempt at round
      2's developer, still be correct — but on a **crash-recovery retry of that same
      dispatch**, round 2's own row already exists and is still open, so `latestRound` would
      return *that* row instead of round 1's closed `send_back`, and the brief would silently
      vanish on exactly the retry where it still applies. Closed by a new
      `FeaturesRepository.latestClosedRound` (`packages/db`) — "the newest round with
      `ended_at` set", immune to whether an even newer round is currently open, because only
      one round can ever be open at a time (`openAttempt`'s own invariant) — and by reading it
      **before** `openAttempt` runs rather than after, so the two calls stay in the order
      they are conceptually in. Watched failing first: swapping `latestClosedRound` back to
      `latestRound` reproduced `expected undefined to be defined` on exactly the
      crash-recovery-retry case, and reverting `stage-runner.ts`'s read of
      `assign.sendBackBriefJson` reproduced the real end-to-end scenario asserting round 2's
      persisted prompt artifact still carried `"(first round — no prior feedback)"` — both
      restored immediately after.
      **The renderer is where `buildDeveloperPrompt`'s determinism contract gets a fifth
      input rather than a bolt-on.** `DeveloperPromptInput.sendBackBrief` is optional;
      `undefined` renders a fixed `"(first round — no prior feedback)"` placeholder rather
      than an absent section, because the module's own determinism rule applies to this
      section exactly like every other one (round 1's prompt must still be byte-identical
      across two calls and two processes) — a template branch would have been the one
      exception to a rule the rest of the file enforces uniformly. A present brief renders
      each finding's severity, title, criterion (`AC-n` or `global / <category>`), workspace-
      relative location and detail, plus a suggested action when the gate offered one — in the
      brief's own order (`aggregate()`'s `sortFindings`, preserved verbatim through the JSON
      round trip), never re-sorted. New `## Feedback from the previous round` section in
      `prompt/templates/developer.md`, between Acceptance Criteria and Repository Context.
      **Proof, at three levels.** Unit: `test/loop/send-back-brief.test.ts` (both pure
      functions' degrade-on-malformed-input behaviour) and new cases in
      `test/prompt/build.test.ts` (placeholder, full rendering, criterion-only rendering,
      ordering, determinism). Integration: `test/scheduler/dispatcher.test.ts` gained four
      cases proving the field is threaded exactly on round-2-developer continuations and
      nowhere else — including the crash-recovery-retry case above — and
      `test/rounds.test.ts` gained four cases for `latestClosedRound` itself. End to end:
      `test/scenario/command-gate-loop.test.ts` (5.14's own real-worker, real-gate scenario)
      now reads round 2's *persisted* prompt artifact off disk and asserts it contains round
      1's real finding's title and detail verbatim — the same file's round 1 artifact is read
      too, as the negative control proving the placeholder is what "no brief yet" actually
      renders. **No DB migration** — `sendBackBriefFromClosedRound` reads `rounds.outcome_json`
      as already-stored text; nothing new is written.
- [x] **5.16** — Protected-path enforcement (ROLE-11). Diff what the developer wrote; if
      it touched a spec, the gate configuration, or a test that judges it, hard-fail the
      round. **Detected by diffing, never by asking the agent.**
      **Shipped, and unconditional rather than pipeline-configured.** Three protections,
      and only the third needed a design decision: the feature's own spec folder and
      `adl.yml` are structurally protected with no configuration at all (`@adl/core/loop`'s
      new `violatedProtectedPaths` + `GATE_CONFIG_PATH`); "the tests that judge it" have no
      existing concept in this codebase to hang off (`commands.test` is an opaque argv, and
      `adl-yml.ts`'s own governing rule is that commands are explicit by design, never
      auto-detected) — **confirmed with the maintainer before implementation:** a new,
      optional `adl.yml` field, `protected_paths` (repo-relative globs, default `[]`),
      resolved into `EffectiveConfig` verbatim like `features_dir`. A small, deliberately
      narrow glob dialect (`**`, `*`, literal segments) backs it, matched by memoized
      recursion — polynomial in pattern-segments × path-segments — rather than naive
      backtracking, since the path side is a developer-authored diff (the same "no
      catastrophic backtracking" discipline `path-guard.ts`'s own regex holds itself to).
      **The check runs in the manager, never as a pipeline stage or a worker dispatch.**
      ROLE-11 has to be unconditional — a maintainer's `adl.yml` that forgets to declare a
      gate must not silently drop the one check that exists to catch the developer editing
      that same file — so `packages/manager/src/loop/protected-paths-check.ts`'s
      `checkProtectedPaths` fires from `round-runner.ts` on every `committed` developer
      outcome, before `planRoundStep` ever runs, using a `ManagerGitClient` rooted at
      `mainRepo` (one `hostGitWorkspace` built once for the daemon's lifetime, not per
      round). This is the first real consumer of `rounds.head_sha`: the diff base is the
      previous round's `head_sha` (`FeaturesRepository.latestClosedRound`, 5.15's own
      method) or, for round 1, the repo's `default_branch` — one `ManagerGitClient
      .diffNameOnly(base, head)` expression covers both, because git's `base...head`
      (three-dot) diffs against the merge base rather than `base`'s own tip, which is what
      makes it correct even when `default_branch` has moved on for unrelated reasons since
      the feature forked. A worktree shares its parent repository's object database, so
      both commits are reachable from `mainRepo` alone — no second workspace, no worker
      round-trip, no new `AssignMessage` field. A violation overrides what
      `planRoundStep` would have decided with a synthetic `CompleteStep` built by hand
      (`dev_committed` first, so the real commit stays on the audit trail, then
      `unrecoverable`) rather than a `send_back` — `fail`-shaped, not retryable, matching
      "hard-fail" exactly. A failure to even compute the diff overrides it with a
      `RetryStep` instead, routed through the same `reapOne` crash-recovery path a transient
      stage error already takes — CORE-06's discipline held to the letter: an infrastructure
      failure here must not silently pass as clean (fail-open would defeat the whole
      guarantee) and must not cost the developer a round either.
      **Two real bugs found while proving this end to end, neither in the check itself.**
      (1) `scripted-pipeline-worker-entry.ts` (5.13's own round-loop scenario double)
      reported a fabricated `committed` sha with no real commit behind it — harmless until a
      check tried to diff it, which is exactly what an unconditional ROLE-11 does on every
      run. Fixed by making that double's developer step attach a real workspace through
      `@adl/workspace`'s own registry and make a real commit, mirroring
      `fake-claude-success.mjs`'s precedent for the identical reason. (2) Making
      `onStageCompleted` measurably slower (a real `git diff` subprocess where before there
      was none) widened a pre-existing, unrelated race: the supervisor's `closeAttempt`
      wiring in `daemon.ts` had no error handling, unlike `onStageCompleted`'s own
      documented "never throws" contract, and an in-flight write losing a race against a
      test's own database teardown surfaced as an unhandled rejection often enough to be a
      real flake rather than a coincidence of the old, faster timing. Fixed by hardening
      `closeAttempt`'s wiring to the same standard, and by making
      `dev-run-end-to-end.test.ts` wait for the round to actually close (`rounds.ended_at`)
      rather than merely for the worker process to exit, which was never the right signal
      for "the manager finished its own async work" to begin with. Confirmed against a clean
      baseline both ways: `pnpm -r test` was fully green on `main` before this step and
      reproduced both failures reliably once the check went in, unfixed.
      **D-2-R-3 is unmoved by this step, and that is worth stating rather than leaving
      implicit:** the diff reads git's object database through `ManagerGitClient`, never a
      worktree path through `assertWithinRoot`/`Workspace.read`, so this is not the live
      instance of that debt item's TOCTOU risk. It remains open for whichever future step
      first reads agent-influenced worktree files (5.17's gate context, or M07/M08's
      reviewer/tester).
      **Proof:** `packages/core/test/loop/protected-paths.test.ts` (the glob dialect and
      `violatedProtectedPaths`, including a pathological multi-`**` case bounded under a
      second), `packages/workspace/test/git/manager-git.test.ts` (`diffNameOnly` against a
      real repository, including a three-dot-vs-moved-default-branch case proving the
      merge-base semantics), `packages/manager/test/loop/round-runner.test.ts` (violation
      via the structural spec/`adl.yml` protections, violation via a configured
      `protected_paths` glob, an unrelated diff passing through exactly as before, and a
      diff failure retrying rather than judging), and a new real end-to-end scenario,
      `test/scenario/protected-paths-loop.test.ts` — every layer production (real
      `startDaemon`, real dispatcher, real forked workers, the real
      `createProductionStageRunner`), only the `claude` binary replaced with a double that
      makes a real commit editing `adl.yml`, proving the round escalates on round 1 with the
      gate never even dispatched (`stage_attempts` has no row for stage index 1 at all).
- [x] **5.17** — Fresh-context gate isolation (ROLE-03). Gate context is assembled from
      spec + diff + repository only. Make the developer's session and transcript
      *structurally* unreachable from a gate — a type the gate cannot name, not a rule it
      is asked to follow.
      **Shipped as a type, an assembly, and a lint rule — the same two-layer shape 5.12
      needed for FORGE-10, for the same reason.** `@adl/core/stage`'s new `GateContext`
      (`gate-context.ts`) is what a gate takes: `stageId`, `workspace`, `spec`, `diff`,
      `onEvent`, `signal`, and **nothing else**. There is no member on it through which a
      `sessionRef`, a transcript, a `logsRoot`, a rendered prompt or a send-back brief can
      be *named* — which is the property AC3 asks for expressed as a parameter list rather
      than as a rule somebody has to follow. Every one of those exists in this codebase and
      every one is reachable from the `AssignMessage` a worker receives, which is exactly
      why a gate is no longer handed one.
      **Two doors, as in 5.12.** `GATE_CONTEXT_MEMBERS` (plus `GATE_DIFF_MEMBERS`, because
      `GateDiff` is nested and a member-name guard is blind through a nested type) pairs
      each interface with a frozen list in the house's
      `Exclude<keyof T, Arr[number]> extends never` shape: adding a member *without* listing
      it fails the **build**, and getting past that by listing a forbidden name fails the
      **suite** (`packages/core/test/stage/gate-context.test.ts`, with a has-teeth control on
      the vocabulary matcher and a vacuity control on both list lengths). Both were watched
      failing against the exact defect — an unlisted member reproduced
      `TS2322: Type 'true' is not assignable to type 'never'` verbatim, and each of
      `sessionRef` on `GateContext` and `developerTranscript` on `GateDiff` turned the core
      test red with the message naming it.
      **`GateContext` is deliberately NOT added to `@adl/plugin-sdk`.** That surface is the
      published third-party contract and `StageContext` is its context type; publishing a
      second one before M13 has a real harness to shape it against is the only move in this
      step that would be one-way (D-01). `StageContext` could not carry this guarantee
      instead: four of its nine members are still forward declarations nothing supplies, no
      production code implements `Stage` at all, and an `Exclude<>` assertion over opaque
      placeholders proves nothing. `FeatureView` specifically could not simply be filled in
      passing — its declared shape wants the round *number*, which is not on the worker's
      wire at all, only the round id.
      **The assembly is one function and it is the boundary.**
      `packages/manager/src/worker-entry/gate-context.ts`'s `buildGateContext` is the single
      place an `AssignMessage` is narrowed, reading exactly three fields off it (`stageId`,
      `workspaceHandle`, `baseRef` — each repository state, none of it agent output) and
      taking the commit under judgement from the workspace's own `HEAD` rather than from the
      wire. The diff is `baseRef...HEAD`, three-dot, computed by `ManagerGitClient` inside
      the attached worktree — which shares its parent repository's object database, so no
      second workspace and no manager round trip. An assembly failure is a `StageError`, never
      a verdict, split by kind for a reason: an unloadable spec is non-retryable
      `unparseable` (it will not load next time either), a failed `git` invocation is
      retryable `provider_error` (CORE-06 — a gate that could not run must not cost a round).
      `runCommandGate` now takes `(gate: GateContext, config: CommandGateConfig)` and moved
      to `worker-entry/gates/`; it *ignores* `spec` and `diff`, which is the point — what a
      gate cannot do is reach for context it was not given.
      **Layer 2, `eslint.config.js`'s new `adl/gate-fresh-context`**, is the residual the
      type structurally cannot reach, and it is the identical argument `adl/no-forge-merge`
      rests on: a gate does not have to arrive at the developer's transcript through its
      parameters — it can `import { transcriptPathFor }` and rebuild the path out of ids it
      legitimately knows. Scoped to `packages/manager/src/worker-entry/gates/**` — a
      **directory**, so a gate is a *place* rather than a filename convention and M07's
      reviewer is governed the day it is written (D-27, and ROLE-03's own wording is about
      the reviewer, so a guard reaching only the command gate would be scoped to the one gate
      the requirement does not name). It bans four module groups (`**/store/*`,
      `**/prompt/*`, `**/loop/*`, `**/ipc/protocol.js` — named as a *file* because
      `ipc/stage-verdict.js` sits beside it and is exactly what a gate must import) and six
      member names, and the narrowing function itself deliberately lives *outside* that
      directory because it has to import the thing it narrows.
      **Every selector was verified empirically against this repository's own eslint before
      being written (convention 15), and two probe findings changed what got written.**
      (1) `no-restricted-imports`' `patterns` **does** match relative specifiers — its
      documented examples only ever show bare package names, and every one of a gate's
      imports of these is relative, so the whole import layer rested on an unverified
      assumption. (2) `MemberExpression[property.name=…]` alone is **not enough**:
      `const { logsRoot } = assign` lints clean under it. That is the destructuring analogue
      of the aliasing blind spot 5.12 documents for call expressions, so the ban carries
      three selector families per name — member, `Property[key.name=…]` (which also catches
      renamed destructuring and object-literal laundering), and computed literal access. The
      one residual no static selector can reach — a fully dynamic `a[k]` — is stated in the
      rule's own comment rather than left for a reader to discover.
      **Both flat-config merges are mandatory and both were watched failing.**
      `worker-entry/gates/**` is matched by `adl/no-direct-spawn` (`**/*`) *and* is a strict
      subset of `adl/worker-entry-no-db`'s glob, and flat config REPLACES per rule id — so
      the new entry re-merges `FORBIDDEN_SPAWN`, `SPAWN_SYNTAX` and D-01's `@adl/db` ban, and
      must be registered **after** `adl/worker-entry-no-db` or it is silently overwritten for
      every gate file while still looking configured. Dropping each merge, and moving the
      entry earlier, were each reproduced red.
      **The one link in the fresh-context argument that lives outside the type is asserted,
      not argued.** `GateContext.workspace` is a live filesystem handle and looks like the
      widest member here; that it is not comes down entirely to transcripts living *outside*
      a workspace root — `logsRootFor(db)` is `dirname(db)/logs` while a workspace root is
      `<scratchRoot>/<id>` under `dirname(db)/scratch`, two independent derivations in two
      modules that happen to be siblings. `packages/manager/test/worker-entry/gate-context.test.ts`
      asserts the separation with `isWithinRoot`, plus the behavioural half (a `..`-climbing
      read is refused), and it was watched failing by pointing the transcript root inside the
      workspace. The same file asserts the narrowing **over the value, not only the type** —
      a builder that spread the whole `AssignMessage` in typechecks fine, because a wider
      object satisfies a narrower interface everywhere except at a fresh object literal, and
      that defect was reproduced too.
      **`DEBT.md` WR-02 is closed and D-2-R-3 is now live.** Both belong to this step
      because gate-context assembly reads the spec out of a worktree the developer's agent
      has already written to — the first read in this project to happen *after* an agent had
      write access to the directory being walked, which is the precondition D-2-R-3 has been
      waiting on since M02 (5.16 looked and correctly reported *not this one*). WR-02 is
      closed at the source: one shared `spec-from-worktree.ts` (the developer stage and the
      gate must not read two different documents) resolves the directory through
      `resolveWithinRoot` and reads the file through `Workspace.read`, so the content read
      goes through the port's own `assertWithinRoot` rather than around it. D-2-R-3's
      check-then-use race is **accepted**, and the entry's own stated deliverable for that
      case is done — `packages/workspace/src/paths.ts`'s docblock now says outright that the
      realpath walk cannot see a symlink planted after the check, which was the actual harm
      (its four-rejection list read as a complete answer). Bounded by ROLE-11: the attack
      needs an *uncommitted* working-tree swap, since a committed one hard-fails the round
      before the gate is dispatched. **Owner M15.**
      **Found and not fixed:** nothing new. The negative control in
      `test/lint/no-restricted-imports.test.ts` needed a one-line correction — it counted
      `FIXTURES` entries where ESLint returns one result per *file*, and this step's fixture
      is the first to be listed twice (it violates two independently-escapable rule ids).

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
| The `ForgeAdapter` port + a real GitHub adapter | `@adl/core/forge` + `packages/forge-github` — done, 5.8/5.9. Both list calls paginate as of 5.11. |
| A sticky per-role comment | `@adl/core/forge`'s `renderStickyComment` (pure) + `packages/manager/src/publish/sticky-comment.ts` and `role-rounds.ts` (the DB half) — done, 5.11. A new role needs a `{key, title, stageId}` and a caller, nothing more. |
| The never-merge guard | `@adl/core/forge`'s `FORGE_ADAPTER_MEMBERS` (the port half, compile-time) + `eslint.config.js`'s `adl/no-forge-merge` (the adapter half) — done, 5.12. A new forge package under `packages/forge-*` is governed automatically; a new merge verb is one entry in `FORGE_MERGE_MEMBERS` plus one case in the fixture. |
| The round loop's decision | `@adl/core/loop`'s `planRoundStep` (pure) — done, 5.13. A new stage kind is a `StageCompletion` member; the events it raises still go through `transition()`. |
| The round loop's writes | `packages/manager/src/loop/round-runner.ts`'s `onStageCompleted` — done, 5.13. Wired unconditionally in `daemon.ts`; `options.forge` only decides whether a green round also promotes. |
| Re-dispatching a feature mid-pipeline | `FeaturesRepository.listDispatchable()` + `dispatchOnce`'s continuation path — done, 5.13. A continuation runs no transition and never re-merges `adl.yml`. |
| The `stage_result` wire envelope | `packages/manager/src/ipc/stage-verdict.ts` — done, 5.13. A real Zod union with a validated parser; a gate reports `{kind:'verdict', verdict}`. |
| Workspace continuity across stages | `WorkspaceBackend.attach` + `Workspace.detach` (`@adl/core/stage`) — done, 5.14. A stage does `attach(spec) ?? create(spec)` and ends with `detach()`; nothing in the loop calls `destroy()`, which is the GC sweep's decision from feature state. |
| A gate implementation | `packages/manager/src/worker-entry/command-gate.ts` — done, 5.14. A new gate kind is an entry in `stage-runner.ts`'s `GATE_IMPLEMENTATIONS` plus a runner; an unlisted stage id is refused with a non-retryable `binary_missing`. |
| The commit a round produced | `rounds.head_sha` (`0005_rounds_head_sha.ts`) — done, 5.14. Written when the developer stage reports `committed`, never at round close. |
| Send-back context into the next prompt | `packages/manager/src/loop/send-back-brief.ts` (both directions, pure) + `FeaturesRepository.latestClosedRound` (the DB half) — done, 5.15. `AssignMessage.sendBackBriefJson` is the wire crossing; `buildDeveloperPrompt`'s `sendBackBrief` field is the renderer. |
| A round's diff, by path list only | `ManagerGitClient.diffNameOnly` (`packages/workspace/src/git/manager-git.ts`) — done, 5.16. `base...head` (three-dot); needs only two shas/refs reachable from `mainRepo`'s object database, no worktree checkout. `packages/manager/src/loop/protected-paths-check.ts` is the one production caller. |
| Protected-path classification | `@adl/core/loop`'s `violatedProtectedPaths` + `matchesGlob` (pure) — done, 5.16. Structural (spec folder, `adl.yml`) plus `EffectiveConfig.protected_paths` (maintainer-declared globs). |
| What a gate may see | `@adl/core/stage`'s `GateContext` + `GATE_CONTEXT_MEMBERS`/`GATE_DIFF_MEMBERS` (pure, compile-time exhaustive) — done, 5.17. A new field is a member plus a list entry, and it has to survive the forbidden-vocabulary test; `@adl/plugin-sdk` deliberately does not republish it. |
| Turning a dispatch into gate context | `packages/manager/src/worker-entry/gate-context.ts`'s `buildGateContext` — done, 5.17. The one place an `AssignMessage` is narrowed; returns a classified `StageError` kind rather than throwing. A new gate goes in `worker-entry/gates/`, which `adl/gate-fresh-context` governs on the day it is created. |
| The spec, out of the worktree | `packages/manager/src/worker-entry/spec-from-worktree.ts` — done, 5.17. Shared by the developer stage and gate-context assembly so the two cannot read different documents; contained through `resolveWithinRoot` + `Workspace.read` (WR-02 closed, D-2-R-3 accepted). |
