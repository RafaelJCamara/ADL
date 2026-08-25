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
| The `ForgeAdapter` port + a real GitHub adapter | `@adl/core/forge` + `packages/forge-github` — done, 5.8/5.9. Both list calls paginate as of 5.11. |
| A sticky per-role comment | `@adl/core/forge`'s `renderStickyComment` (pure) + `packages/manager/src/publish/sticky-comment.ts` and `role-rounds.ts` (the DB half) — done, 5.11. A new role needs a `{key, title, stageId}` and a caller, nothing more. |
| The never-merge guard | `@adl/core/forge`'s `FORGE_ADAPTER_MEMBERS` (the port half, compile-time) + `eslint.config.js`'s `adl/no-forge-merge` (the adapter half) — done, 5.12. A new forge package under `packages/forge-*` is governed automatically; a new merge verb is one entry in `FORGE_MERGE_MEMBERS` plus one case in the fixture. |
