# STATUS — start here

_Last updated: 2026-08-26_

**If you are a fresh Claude session picking this project up, read this file top to bottom.
It is the only file you need to start working.**

---

## What ADL is

A self-hosted daemon that turns a feature folder into a reviewed, tested,
human-approvable pull request without a human driving the handoffs. A team drops a
subfolder into their repo's `features/` directory; ADL notices it hasn't been built, and
runs it through a closed loop of AI agents — developer → code reviewer → pluggable
harnesses → behaviour tester — sending work back to the developer whenever a gate fails,
and opening a PR when every gate passes.

TypeScript / Node, pnpm monorepo, ESM-only, `tsc`-only builds. Solo project, nights and
weekends, no deadline.

---

## Where we are

**4 of 18 milestones delivered. Milestone 5 is in progress — the opener (5.0, 5.0b), all of
group A (5.1–5.7), all of group B (5.8–5.12), all of group C (5.13–5.17) and the accounting
half of group D (5.18) are done. Only 5.19, the end-to-end proof, remains.**

```
M01 Core Contracts .................. ✅ done
M02 Workspace & Exec Boundary ....... 🟡 code complete (1 deferred check)
M03 Manager Skeleton ................ ✅ done
M04 First Agent Backend ............. 🟡 code complete (1 deferred check)
M05 The Loop Closes ................. ◀ IN PROGRESS — opener + groups A, B, C + 5.18 done; 5.19 next
M06–M18 ............................. not started
```

**What actually works today:** a real Claude Code agent, driven through a bounded workspace,
makes a real commit in a per-feature git worktree, streamed live to `adl logs -f`, with its
cost recorded — all supervised by a crash-surviving manager you can pause and kill. On top
of that, as of this session: a `features/` folder committed to a repo is _detected_ by
evaluating real repository state (`@adl/core/detect` + `ManagerGitClient.listFiles`); a
branch can be _pushed_ to a remote (`ManagerGitClient.push`); and a real `ForgeAdapter`
(`@adl/forge-github`, a real GitHub App auth flow via `octokit` + `@octokit/auth-app`) opens
a real draft change request, proven end to end in
`packages/manager/test/tracer/detect-to-draft-cr-end-to-end.test.ts` against a local mock
GitHub server (live GitHub credentials are deliberately deferred — see `DEBT.md` § 1 item 1.7).
And the scanner's output can now be told apart from what ADL already knows about: the
_undeveloped_ predicate (`@adl/core/detect`'s `undevelopedFeatureFolders` +
`packages/manager/src/detect/undeveloped.ts`'s `undevelopedFeatures`) cross-references a scan
against both the `features` table and every open change request, so a folder is only ever
admitted once — even across a lost `features` row, so long as its change request is still
open. `ChangeRequest` gained a `head` field (the branch it was opened from, echoed back by
the forge) so that cross-reference is possible at all. And a folder that clears both checks
still has to clear one more: the trusted-path filter (SPEC-06)
(`@adl/core/detect`'s `evaluateSpecTrust` + `packages/manager/src/detect/trust.ts`'s
`evaluateFeatureTrust`) rejects a folder whose most recent commit was authored by an account
without write access — a real check against `ForgeAdapter.authorPermission`, never the raw
git author identity, which is trivially spoofable. And `startDaemon` now has a real,
production `resolveAdlYml` (`packages/manager/src/config/resolve-adl-yml.ts`'s
`resolveProductionAdlYml`): it reads `adl.yml` off `mainRepo`'s own working tree through
`@adl/workspace`'s `hostGitWorkspace.read()` once at boot, and refuses to start
(`AdlYmlUnavailableError`) rather than dispatch a single feature when the file is missing or
invalid — the same refuse-before-the-API-binds shape the schema and backend-preflight gates
already use. It is the default now, used whenever a caller doesn't inject its own
`resolveAdlYml` (every pre-5.4 test still does, unchanged). And the polling loop
(`packages/manager/src/scheduler/poll-schedule.ts`'s `runPollOnce` + `startPollSchedule`)
is now the first production caller of 5.1's scanner, 5.2's _undeveloped_ predicate, and
5.3's trust filter, composed together: on a croner cadence (`daemonConfig.poll.interval_ms`,
default 60s, `startGcSchedule`'s exact shape), it scans the watched repository's default
branch, filters to undeveloped and then trusted folders, and enqueues each as a `queued`
`features` row — proven both in isolation and wired for real through `startDaemon`, where a
committed feature folder shows up via `GET /features` with no `adl dev-run` call. It is
wired in only when a caller supplies `StartDaemonOptions.forge` (a `ForgeAdapter` + repo
ref) — absent, matching the backend preflight gate's own precedent, it does not start,
since no live GitHub App credentials exist yet (`DEBT.md` item 1.7).
And exclusive claim now demonstrably survives both re-detection and a daemon restart
(DETECT-05, 5.6) — `packages/manager/test/scenario/detect-restart-reconciliation.test.ts`
drives a feature through a real `startDaemon()`, lets the poll schedule re-scan it several
times while it is still leased, stops the daemon, and boots a fresh one against the same
database and repository: never a second `features` row for the same folder. Building that
proof surfaced a real bug in the mechanism 5.2 shipped: a real dispatch's worktree branch
was named from the `features` row's bare ULID (`assign.featureId`), but DETECT-05's
lost-row reconciliation — and `@adl/workspace`'s own GC sweep — each need to recover a
_different_ identity back out of that same branch (GC needs the ULID, reconciliation needs
the folder name, precisely when the row and its ULID are the thing that's gone). Fixed by
composing both into the branch a real dispatch creates
(`packages/manager/src/branch-identity.ts`'s `composeBranchFeatureId`, plus its
fallback-aware readers `ulidOf`/`folderNameOf` — `adl/<folderName>--<ulid>`), read back by
whichever of GC's `createFeatureStateLookup` and `undevelopedFeatures` needs which half.
`@adl/workspace`'s own `branchNameFor`/`featureIdFromBranch` are untouched — this is a
manager-package-local convention layered on top, and every pre-5.6 branch (a bare id, no
`--`) still resolves exactly as before. (Code review caught a real asymmetry here first —
`undevelopedFeatures` was dropping a non-composed branch instead of falling back to it,
which would have made a real open change request invisible to reconciliation; centralising
the fallback in `ulidOf`/`folderNameOf` is the fix.)
And `adl daemon start` now really boots the manager in-process (5.7), closing the last gap
group A left open. The package-boundary question this needed — `@adl/cli` structurally
cannot resolve `@adl/manager`, and the repo-wide `adl/no-direct-spawn` rule bans it from
spawning one either — is resolved by moving the installed `adl` binary itself:
`@adl/manager` now depends on `@adl/cli` as a library (never the reverse — `@adl/cli` is
completely unchanged) and ships `packages/manager/src/bin.ts` as the real executable, which
injects `@adl/manager`'s `createProductionDaemonStartRunner`
(`packages/manager/src/boot/cli-entry.ts`) into `@adl/cli`'s own `buildProgram` for exactly
one verb, `daemon start`. That runner turns `.adl/daemon.json` (zero-config first run,
`ensureDaemonConfig`) into a real `startDaemon()` call — `.adl/adl.db`, the backend preflight
gate wired unconditionally, every refusal reported cleanly. Proving that end to end
(`packages/manager/test/boot/cli-entry.test.ts`) is the first time anything in this project
has called `startDaemon` against a truly virgin database file, and it surfaced a real bug
one layer down: `runStartupGate`'s first read assumed migration 0001 had already created the
`meta` table, which every prior test's `migrateToLatest` call had silently guaranteed —
against a real fresh install it threw a raw `SqliteError` instead of taking the
already-correct "absent, migrate" path. Fixed at the source (`@adl/db`'s `metaRepository`)
with a regression test that deliberately skips `migrateToLatest`, so a fresh `.adl/adl.db`
now migrates itself exactly once, on the very first `adl daemon start`. Code review of this
step caught two more real bugs before they shipped: `ensureDaemonConfig`'s first-run write
could throw raw past the "never throws" `DaemonStartRunner` contract (fixed at the source,
regression-tested on POSIX), and the SIGINT/SIGTERM handler could call an already-stopped
`handle.stop()` a second time — unguarded, since `process.once` only deregisters the signal
it fired on — crashing on the resulting unhandled rejection (fixed with an idempotency guard
plus a caught `.catch()`, both watched failing against the exact defect first).
And a real commit now automatically becomes a real draft pull request (5.10) — the
automatic version of what 5.0b's tracer proved by hand. The push has to happen _inside_ the
worker, before `createProductionStageRunner`'s own teardown destroys the workspace and
reclaims the branch with it, so the manager mints a fresh, short-lived, already-credentialed
push URL once per dispatch (`scheduler/dispatcher.ts`'s new `DispatcherDeps.forge.pushCredential`)
and threads it through `AssignMessage` as a new `pushUrl` field; a push failure is reported as
the same `stage_error`/`provider_error` a workspace-creation failure already uses, never a
false `committed`. Opening the change request stays in the manager:
`worker-supervisor/supervisor.ts` gained `onDeveloperCommitted`, the first production reader
of the `StageRunnerVerdict` envelope M04 left unread, wired in `daemon.ts` to a new
`publish/draft-cr.ts`. **No DB migration** — idempotency ("don't open a second draft CR")
is answered by asking the forge (`listOpenChangeRequests`, matched by the exact branch a real
dispatch would push), the same "evaluate state, don't remember events" discipline 5.2/5.6
already established. `packages/forge-github` gained `getPushToken()` (reusing the adapter's
own `octokit` instance, no new dependency) and two pure helpers, `parseGithubRemoteUrl`/
`githubPushUrl`. And `boot/cli-entry.ts` — the real `adl daemon start` — now builds a real
`ForgeAdapter` and push credential from a new optional `repos[0].github_app` daemon-config
block when one is configured, closing the gap 5.5 left open (`@adl/forge-github` is now a
real runtime dependency of `@adl/manager`, not test-only); left absent by default, since no
live GitHub App credentials exist yet (`DEBT.md` item 1.7, unchanged). **Deviation, confirmed
with the maintainer before implementation:** 5.10's other stated half — promoting the draft
to ready once every gate is green — is genuinely not buildable yet, since nothing in
production produces an aggregate "every gate passed" verdict until group C's round loop
exists; `forge.promoteToReady` (5.9) stays built and uncalled, exactly like
`resetCrashCountOnSuccess`'s own documented-gap precedent, for 5.13 to wire in one line.
Proven automatic and end to end by a new tracer,
`packages/manager/test/tracer/draft-cr-wiring.test.ts`; 5.0b's own manual tracer still passes
unmodified.
And that draft CR now carries a real, sticky per-role comment (5.11, FORGE-06). The two
halves that existed separately and had never met — `upsertComment`'s marker-based
find-or-create, and "what belongs in one" — are joined by a real caller fired from the same
`onDeveloperCommitted` event, right after the draft CR is opened or confirmed
(`publish/on-developer-committed.ts`; `publishDraftChangeRequest` now **returns** the
`ChangeRequest`, including on its idempotent path, so the comment goes to the change request
that step resolved rather than to a second, independently-derived answer). **No migration
and no `sticky_comments` table:** the comment is re-derived in full from
`rounds`/`stage_attempts`/`verdicts`/`findings` every round
(`packages/manager/src/publish/role-rounds.ts`) and overwritten — the same "evaluate state,
don't remember events" discipline 5.2/5.6/5.10 established, which also means a comment a
human edited, or one lost with a deleted change request, is _repaired_ by the next round
rather than corrupted by it. A role is addressed by `stage_attempts.stage_id` taken from the
dispatch that ran, never a hardcoded `'develop'`, so a new role is a `{key, title, stageId}`
and a caller — nothing more.
The substance is the pure renderer, `@adl/core/forge`'s `renderStickyComment` (in core, not
in an adapter: `<details>` is HTML that all three forges render, so three adapters would
otherwise reimplement and drift). Two properties carry it, both watched failing first.
_A round body cannot break its own fold_ — bodies are agent-authored, and a literal
`</details>` in one closes the block early and spills every prior round into view, the exact
unreadable PR FORGE-06 exists to prevent arriving through the mechanism meant to prevent it;
`<details`/`</details` are escaped, and **only outside code spans**, since a forge already
escapes HTML inside a fence, an indented block or an inline span (offsets from
`mdast-util-from-markdown`, already a core dependency, verified by probe first). _And a
comment edited in place forever grows without bound_ — past a forge's cap `upsertComment`
starts failing and the comment silently freezes at whichever round last fit, so a
`maxLength` budget (default 60,000, under GitHub's documented 65,536, leaving room for the
adapter's own hidden marker) keeps the newest round whole, drops older folds oldest-first
_with the count stated in the comment_, and guarantees the output is never longer than the
budget for any input — asserted as a property down to a one-character budget.
**The debt item this step owned is closed, and it was worse than filed:** `upsertComment`
paginates now, but so does `listOpenChangeRequests`, which had the identical defect and a
heavier consequence — 5.10's idempotency check and 5.2's reconciliation both ask it "is one
already open for this branch?", so a repository with more than one page of open pull
requests would have opened a duplicate draft every round. The mock GitHub server gained real
`per_page`/`page` + `Link` pagination so both fixes are _proven_: without it a
first-page-only adapter and a paginating one are indistinguishable, and the guard could not
have been written at all.

And "ADL never merges" is now a build property rather than a sentence in `DECISIONS.md`
(5.12, FORGE-10) — two guards, at the two layers, because the preferred one cannot reach the
whole property alone. `ForgeAdapter` had never declared a merge method, but until this step
that was a fact about what happened to be typed into `forge.ts`: adding `merge()` would have
compiled, linted and shipped green. `@adl/core/forge`'s new `FORGE_ADAPTER_MEMBERS` pairs
the interface with a frozen list of its own members in the house's
`Exclude<T, Arr[number]> extends never` shape, so a merge method now has two independently
locked doors in front of it — adding a member _without_ listing it fails the **build**, and
getting past that by listing `'merge'` fails the **suite**
(`packages/core/test/forge/never-merge.test.ts`). Both were watched failing against the exact
defect. That guard structurally cannot reach the second layer, though: a forge adapter
doesn't merge through ADL's port, it merges through the _forge_, and `packages/forge-github`
holds a live `octokit` whose `rest.pulls.merge()` exists regardless — `getPushToken` is the
standing proof a forge package legitimately reaches past the neutral port when it has to. So
`eslint.config.js` gained **`adl/no-forge-merge`**, scoped to `packages/forge-*` by package
_prefix_ so M14's GitLab and Gitea adapters are governed the day they're created. It bans
**member expressions** rather than call expressions (aliasing the function first is a
call-selector's blind spot) drawn from a **vocabulary list, never a substring search for
`merge`** — GitLab spells it `accept` and `mergeWhenPipelineSucceeds`, while `backend.ts`
legitimately reads `pr.merged_at` and `CHANGE_REQUEST_STATES` legitimately contains
`'merged'`, so a substring ban flags the wrong things and gets switched off. Every selector
was probed against the real eslint before being written; the precision guard was watched
failing by widening one pattern, which immediately reported the adapter's own state literals.

And the loop turns (5.13, LOOP-01). A real `startDaemon()` now walks
`develop → gate → green → publishing`, and — the case AC2 says is the only one that proves
anything — `develop → gate says send_back → round 2's developer runs again → gate passes →
publishing`, one real forked worker process per stage, proven in
`packages/manager/test/scenario/round-loop.test.ts`. The decision and its writes are split
the way this project splits everything: `@adl/core/loop`'s **`planRoundStep`** is pure and
total — given the stage that just finished, which `FeatureEvent`s it raises and whether the
round is over with what `RoundOutcome` (`aggregate()`'s first production caller) — and
`packages/manager/src/loop/round-runner.ts`'s `onStageCompleted` records the evidence,
applies the events through `transition()` (still the only code that decides a state), and
closes the round. Three sequencing decisions carry it. _Index 0 is the developer_, enforced
rather than assumed — a gate verdict in the developer's slot, or a developer outcome in a
gate's, escalates; which is also why a pipeline of `develop` alone reaches `aggregate([])`
and **escalates** rather than reporting a green round that verified nothing. _v1 stops on the
first `send_back`_ — ARCHITECTURE's cost-class defaults need a `Stage.costClass` that has no
implementations, and half a policy is worse than none, so the conservative half ships and
`gate_passed` stays honest (emitted only when the stage did not stop the pipeline). And _the
pipeline position is written absolutely, from the sequencer's answer_ — `dev_committed`'s
edge **resets** the index rather than advancing it, so left to the counter delta alone a
committed round would re-dispatch the developer forever; written in the same transaction,
for the identical reason `planRecovery`'s `resetStageIndexTo` is written outside
`transition()`.
What actually made the loop turn was not in the step's wording: **nothing dispatched a
feature already inside the loop.** `transition()` draws no edge from `gating` back to
`queued` — correctly — so `listQueued()` could never see it again. New
`FeaturesRepository.listDispatchable()` adds "in `developing` or `gating`, and unleased"; the
round loop hands the lease back when a stage finishes and the next tick leases it again from
the stage it is on. A continuation dispatch runs **no transition** and **never re-merges
`adl.yml`** — versioning rule 3 exists precisely so a mid-flight edit cannot change a running
feature's pipeline. `StageRunnerVerdict` moved to `ipc/stage-verdict.ts` (a wire contract with
two ends belongs beside `protocol.ts`), became a real Zod union with a third member for a
gate's `Verdict`, and gained a validated parser — an unreadable payload is now a `StageError`
the loop routes, not a verdict it half believes. The production stage runner **refuses** a
non-zero stage index with a non-retryable `binary_missing`: running the developer agent again
as a "gate" would be self-approval with extra steps. 5.10's deferred one-liner is wired —
`promoteChangeRequestToReady` is reached only through `RoundOutcome.kind === 'green'`, so
"promoted only when every gate is green" is structural rather than promised. And
`resetCrashCountOnSuccess` finally has its caller, in the same transaction as the round close
(D-11); a _retryable_ stage error takes `reapOne` instead, so the consecutive-failure ceiling
applies and **no round is recorded at all**, because nothing was judged (CORE-06, LOOP-07).
`DEBT.md` D-5-11-1 turned out to rest on a false premise — `RoundOutcome` has no field for a
commit, so writing it could never have carried a sha. What the column does now carry is the
round's real result, which `role-rounds.ts` reads: a finished round folds away as
`send_back — 3 findings` rather than a bare kind. The sha needs a `rounds.head_sha` column,
and moves to 5.14 alongside its second consumer.

And there is now a **real gate** (5.14, and it is the step the milestone's own AC2 turns
on). `packages/manager/test/scenario/command-gate-loop.test.ts` drives a real
`startDaemon()` through `develop → the test command fails → send back → round 2's developer
→ the test command passes → publishing`, with the _real_ `createProductionStageRunner` in
four real forked workers and only the billed `claude` binary doubled. 5.13 proved that shape
against a **scripted** worker; the difference is that nothing in it ever ran a command, so
nothing ever needed the developer's commit to still exist — which is exactly why
`DEBT.md` D-5-13-1 was found by reading code rather than by a red test.
**Closing D-5-13-1 is most of this step**, and the port was missing two symmetric pairs
rather than one method: `create ↔ destroy` reclaims the **workspace**, `attach ↔ detach`
reclaims the **run**. `WorkspaceBackend.attach(spec)` (the method ARCHITECTURE.md §1 has
named since before M01 and that was never built) returns `Workspace | undefined` —
`undefined` for the ordinary "nothing here" first-stage case, and a _throw_ for a
half-present workspace, since reporting the second as the first would send the caller to
`create()` and silently replace an agent's committed work. `Workspace.detach()` reclaims the
scratch `HOME` and leaves the worktree. The stage runner now does
`attach(spec) ?? create(spec)` and ends with `detach()`, and **no stage calls `destroy()`
at all** — reclaiming a workspace is a decision made from feature state (D-16) and `gc.ts`'s
sweep is what makes it. That also fixes crash recovery, which `dispatchOnce` has preserved
`workspace_handle` for since M03 with nothing to attach with. **Maintainer decision:**
`detach()` widens `Workspace`, which _is_ republished through `@adl/plugin-sdk` and so is
one-way (D-01) — the debt item claimed `WorkspaceBackend` was the published half and it is
not, inverting which method is expensive; added now, before that package ships (M18), for
D-27's reason.
The gate itself is deliberately small (`worker-entry/command-gate.ts`): one command through
`workspace.exec`, three answers — exit 0 → `pass` citing `{kind:'global', category:'build'}`
(never a criterion), non-zero → `send_back` with one blocker finding carrying a bounded tail
of the output, and **killed rather than exited → a `StageError`, not a verdict**, because a
command with no exit code judged nothing and reporting one anyway would make an
infrastructure failure cost the developer a round (CORE-06). It takes a workspace and a
command and nothing else — no spec, no prompt, no agent — so ROLE-03's isolation (5.17) is
already the shape of the call. `rounds.head_sha` (migration `0005`) closes D-5-11-1: written
when the developer stage reports `committed`, never at round close, because a developer
stage in a pipeline with any gate in it `advance`s rather than completing.

And send-back now means something (5.15, LOOP-02) — round 2's developer is no longer handed
the identical prompt round 1 got. `buildDeveloperPrompt` gained the fifth input
`ARCHITECTURE.md` named for its signature before M01 and Phase 4 shipped without:
`SendBackBrief`, rendered into a new "Feedback from the previous round" section, `undefined`
on round 1 rendering a fixed placeholder rather than an absent one — the module's own
determinism rule applies to this section exactly like every other. The plumbing constraint
held exactly as `STATUS.md` predicted: a worker cannot read the database
(`adl/worker-entry-no-db`), so the brief travels on `AssignMessage` the way `pushUrl` and
`effectiveConfigJson` already do, read and attached by `dispatchOnce`'s shared
`dispatchAssigned` (`packages/manager/src/loop/send-back-brief.ts`'s new
`sendBackBriefFromClosedRound` on the manager side, `parseSendBackBriefJson` on the worker
side — both degrade to "no brief" on anything malformed rather than throw, the same
discipline `publish/role-rounds.ts`'s `describeRoundOutcome` already established for this
exact column). **A real ordering bug found before it shipped:** `openAttempt`, called moments
later in the same function, may open round 2's own row before a crash-recovery retry of that
same dispatch reads back "the prior round" — reading the existing `latestRound` at that point
would return round 2's own still-open row instead of round 1's closed `send_back`, silently
dropping the brief on exactly the retry where it still applies. Closed by a new
`FeaturesRepository.latestClosedRound` (immune to whether a newer round is currently open,
since only one round is ever open at a time) read _before_ `openAttempt` runs. Watched failing
twice — swapping `latestClosedRound` back to `latestRound` reproduced the crash-recovery-retry
case exactly, and reverting the worker's read of `assign.sendBackBriefJson` reproduced the
real end-to-end scenario's persisted prompt artifact still carrying the placeholder — both
restored immediately after. **No DB migration**; `rounds.outcome_json` already held everything
needed, and nothing new is written. Proven at three levels: unit tests for both pure
functions and the renderer, dispatcher-level integration tests for the field-threading
(including the crash-recovery-retry case), and `test/scenario/command-gate-loop.test.ts`
(5.14's own real-worker scenario) extended to read round 2's persisted prompt artifact off
disk and assert it carries round 1's real finding verbatim, with round 1's own artifact read
as the negative control.

And a developer that edits its own gate configuration now hard-fails the round it did it in
(5.16, ROLE-11) — unconditionally, not something `adl.yml`'s `pipeline:` list has to name.
Three protections: the feature's own spec folder and `adl.yml` are structurally protected
with zero configuration (`@adl/core/loop`'s new `violatedProtectedPaths`); a third,
maintainer-declared `protected_paths` glob list (a new optional `adl.yml` field, confirmed
with the maintainer before implementation, since ADL has no existing way to know which
files in an arbitrary repo "are tests" — `adl-yml.ts`'s own rule is that commands are
explicit by design and never auto-detected, and this follows it) covers the tests that judge
a gate. **The check runs in the manager, never as a pipeline stage** — a maintainer's
`adl.yml` that simply forgets to declare a gate must not silently drop the one check meant to
catch the developer editing that same file — firing from `round-runner.ts`
(`loop/protected-paths-check.ts`'s `checkProtectedPaths`) on every `committed` developer
outcome, before `planRoundStep` ever runs. It is the first real consumer of `rounds.head_sha`
for a computation rather than a rendered string: the diff base is the previous round's
`head_sha` or, on round 1, the repo's `default_branch`, and one `ManagerGitClient
.diffNameOnly(base, head)` call (new; `git diff --name-only base...head`, three-dot) covers
both, diffing against the merge base rather than `base`'s own moved tip. A worktree shares
its parent repository's object database, so this reads through a `hostGitWorkspace` rooted
at `mainRepo` alone — no second workspace, no worker round-trip, no new `AssignMessage`
field. A violation is a hand-built `CompleteStep` (`dev_committed` first, so the real commit
stays on the audit trail, then `unrecoverable`) — `fail`-shaped and non-retryable, never a
`send_back`, matching "hard-fail" exactly; a diff that could not even be computed routes
through `reapOne`'s crash-recovery path instead, the same CORE-06 discipline every other
infrastructure failure in this loop already holds to — never fail-open, never a round spent
on a problem nobody judged.
**Two real bugs found proving this end to end, neither in the check itself.**
`scripted-pipeline-worker-entry.ts` (5.13's own round-loop scenario double) reported a
fabricated `committed` sha with no real commit behind it — harmless until a check tried to
diff it, which an unconditional ROLE-11 does on every run. Fixed by making that double's
developer step attach a real workspace and commit for real, mirroring
`fake-claude-success.mjs`'s own precedent. And making `onStageCompleted` measurably slower
(a real `git diff` subprocess where before there was none) widened a pre-existing race:
`daemon.ts`'s `closeAttempt` wiring had no error handling, unlike `onStageCompleted`'s own
documented "never throws" contract, and losing a race against a test's database teardown
surfaced as a real, reproducible unhandled rejection rather than a coincidence of the old,
faster timing — confirmed against a clean `pnpm -r test` baseline on `main` both ways. Fixed
by hardening `closeAttempt` to the same standard and by making `dev-run-end-to-end.test.ts`
wait for the round to actually close rather than for the worker process to merely exit, which
was never the right signal for "the manager's own async work is done".
**D-2-R-3 is unmoved by this step** — the diff reads git's object database through
`ManagerGitClient`, never a worktree path through `assertWithinRoot`, so this is not that
debt item's live TOCTOU instance; it stays open for whichever future step first reads
agent-influenced worktree files (5.17's gate context, most likely). _(It was — see below.)_

And a gate now works from fresh context **because of what it is handed, not because it was
asked to** (5.17, ROLE-03, AC3). `@adl/core/stage`'s new `GateContext` is a gate's whole
parameter list — `stageId`, `workspace`, `spec`, `diff`, `onEvent`, `signal` — and it has no
member through which a `sessionRef`, a transcript, a `logsRoot`, a rendered prompt or a
send-back brief can be _named_. Every one of those exists in this codebase and every one
rides on the `AssignMessage` a worker receives, which is exactly why a gate is no longer
handed one: `packages/manager/src/worker-entry/gate-context.ts`'s `buildGateContext` is the
single narrowing point, reading three fields off the message (`stageId`, `workspaceHandle`,
`baseRef` — all repository state) and taking the commit under judgement from the workspace's
own `HEAD` rather than the wire. It is guarded the way 5.12 guarded FORGE-10, in the same
two shapes for the same reasons. **Door 1, compile time:** `GATE_CONTEXT_MEMBERS` and
`GATE_DIFF_MEMBERS` (two lists, because `GateDiff` is nested and a member-name guard is blind
through a nested type) each pair their interface with a frozen list in the house's
`Exclude<T, Arr[number]> extends never` shape, so an unlisted member fails the **build**.
**Door 2, the suite:** `packages/core/test/stage/gate-context.test.ts` rejects any
session-, transcript- or prompt-shaped name in either list, so getting past door 1 by listing
one lands on it. **Layer 2, the residual a type cannot reach:** `eslint.config.js`'s new
`adl/gate-fresh-context`, scoped to `packages/manager/src/worker-entry/gates/**` — a
_directory_, so M07's reviewer is governed the day it is written — bans four module groups
(`store/`, `prompt/`, `loop/`, and `ipc/protocol.js` by _file_, since `ipc/stage-verdict.js`
beside it is exactly what a gate must import) and six member names, because a gate does not
have to reach the developer's transcript through its parameters: it can import
`transcriptPathFor` and rebuild the path from ids it legitimately knows. That is the identical
argument `adl/no-forge-merge` rests on. `runCommandGate` now takes
`(gate: GateContext, config: CommandGateConfig)` and lives in `gates/`; it _ignores_ `spec`
and `diff`, which is the point — what a gate cannot do is reach for context it was not given.
**Two probe findings changed what got written** (convention 15): `no-restricted-imports`'
`patterns` does match _relative_ specifiers, which the documented examples never show and the
whole import layer rested on; and `MemberExpression[property.name=…]` alone lints
`const { logsRoot } = assign` clean — the destructuring analogue of 5.12's aliasing blind
spot — so each name carries three selector families. Both flat-config merges are mandatory
(`gates/**` is matched by `adl/no-direct-spawn` _and_ is a strict subset of
`adl/worker-entry-no-db`'s glob) and the entry must be registered **after** the latter or it
is silently overwritten while still looking configured; dropping each merge and moving the
entry earlier were each watched failing.
**The one link that lives outside the type is asserted rather than argued.**
`GateContext.workspace` is a live filesystem handle and looks like the widest member here;
that it is not comes down entirely to transcripts living _outside_ a workspace root —
`logsRootFor(db)` is `dirname(db)/logs` while a workspace root sits under
`dirname(db)/scratch`, two independent derivations in two modules that happen to be siblings.
`packages/manager/test/worker-entry/gate-context.test.ts` asserts that separation with
`isWithinRoot`, and asserts the narrowing **over the value, not only the type** — a builder
that spread the whole `AssignMessage` in typechecks fine, since a wider object satisfies a
narrower interface everywhere except at a fresh object literal, and that defect was
reproduced.
**`DEBT.md` WR-02 is closed and D-2-R-3 is now live** — both because this is the first read
in the project to happen _after_ an agent has had write access to the directory being walked.
WR-02 is closed at the source: one shared `worker-entry/spec-from-worktree.ts` (the developer
stage and the gate must not read two different documents) resolves through `resolveWithinRoot`
and reads through `Workspace.read`'s own `assertWithinRoot`. D-2-R-3's check-then-use race is
**accepted**, with the entry's own nominated deliverable done — `paths.ts`'s docblock now says
outright that the realpath walk cannot see a symlink planted after the check. Bounded by
ROLE-11: the attack needs an _uncommitted_ working-tree swap, since a committed one hard-fails
the round before the gate is dispatched. Owner M15.

And every agent invocation in the loop is now on the spend ledger, **including the ones that
report nothing** (5.18, BACK-09, AC5). M04's recording path was already correct for the case
it was proven against and already fires every round — the developer stage is dispatched
afresh each round with its own `roundId`/`stageAttemptId`, taken by the supervisor from its
own assignment rather than from the message (T-4-38). What was missing was the proof that it
does, and one genuinely silent degradation. `claudeCodeBackend` attached a usage record only
when a run reached its terminal `result` event, so a CLI killed by a timeout or exiting
non-zero mid-stream — a provider outage, a crashed agent — burned tokens, reported none, and
the worker's guard then sent nothing at all: that invocation was **indistinguishable on the
ledger from a stage that never invoked an agent**. New `unknownUsageRecord`
(`@adl/agent-claude-code`'s `usage.ts`) is the honest answer — every counter null,
`costSource: 'unknown'`, resolved once after `flush()` and shared by all three post-exec
return paths. **The negative half is the load-bearing half:** the property is not "always
produce a record" but "produce one exactly when an agent process ran", so the spawn-failure
path still reports nothing — its cost is _zero, not unknown_, and a `'unknown'` row there
would put a phantom invocation on the ledger every time the pinned binary is missing.
A gate reporting nothing is now a _checked_ property rather than an accident of the code
path: a command gate runs `adl.yml`'s test command, not an agent, and a zero-token row would
be a claim that an agent ran for free — one `spendByCategory` would fold into the totals as
confirmed spend. `test/scenario/command-gate-loop.test.ts` — the real two-round, two-role
loop — asserts exactly two rows, one per round, each joined to _that_ round's developer
attempt, and zero against either gate attempt; watched failing by adding a zero-valued
`sendUsage` to the gate branch (2 rows became 4). **A real bug found doing it, in the same
class 5.16 found on `closeAttempt`:** `daemon.ts`'s `recordUsage` had no try/catch, and both
callbacks fire from the supervisor's floating message task — so a failed spend write was an
unhandled rejection that takes the manager down, at precisely the moment a stopping daemon
closes the database. Watched failing (`Unhandled Rejection: simulated ledger write failure`)
and watched recovering, then filed as a coverage gap covering both callbacks, since
`startDaemon` has no seam for making one repository write fail on demand. **No migration and
no new IPC field** — `UsageMessageSchema` already carried `'unknown'` in its `costSource`
enum, which is what made the honest answer expressible without one.

**What does not exist yet:** the milestone's own end-to-end proof (5.19).

The two 🟡 milestones are _not_ unfinished work. Their code is merged, tested and CI-green;
what's outstanding is one environment precondition each (a live API key; a Linux host),
batched deliberately into an end-of-project verification pass. See [`DEBT.md`](./DEBT.md) § 1.

---

## What to do next

Open [`milestones/m05-the-loop-closes.md`](./milestones/m05-the-loop-closes.md) and write
**5.19 — the last step in the milestone.** Everything it composes is built: the loop turns,
with a real gate, real send-back context, a real unconditional protected-path check, gates
that structurally cannot see the developer's session or transcript, and a spend ledger that
covers every agent invocation including the ones that report nothing.

It is the end-to-end scenario test: feature folder → draft CR at round 1 → gate fails → send
back → round 2 passes → promoted to ready. **It must fail the first time through by
construction.** Much of the chain already has a scenario test of its own
(`test/scenario/command-gate-loop.test.ts`, `test/tracer/draft-cr-wiring.test.ts`,
`test/scenario/protected-paths-loop.test.ts`); 5.19 is the one that runs all of it in a single
daemon lifetime, detection included.

**The cost-accounting spike is still open and still blocked** — M06 needs a reported cost
reconciled against a real bill ([`DEBT.md`](./DEBT.md) item 1.2). 5.18 put the numbers on the
ledger, but every one of them came from a replay double; the reconciliation needs a live
`ANTHROPIC_API_KEY` and belongs to the end-of-project batch with the rest of § 1.

**Before you start, skim:**

- [`DECISIONS.md`](./DECISIONS.md) — so settled questions stay settled
- [`DEBT.md`](./DEBT.md) § 3 — **D-5-14-2** (a worker whose `stage_result` was accepted is
  still logged as "exited without an accepted result") and **D-5-13-2** (`features.round` and
  `rounds.number` are silently one apart) are both owned by M06 and both sit directly on
  5.19's path. Neither is blocking; both will be in the logs you are reading.

---

## How to run it

```bash
pnpm install --frozen-lockfile
pnpm build            # required — @adl/manager's `adl` bin points at dist/bin.js (5.7)

pnpm test             # pnpm -r test && vitest run --project root
pnpm typecheck        # pnpm -r typecheck
pnpm lint             # eslint .
pnpm format           # prettier --check .

pnpm vitest run --project core        # one package: core | manager | workspace
                                      # db | agent-claude-code | cli | plugin-sdk | root
```

> ⚠️ `pnpm -r test` **excludes the root project**. That's why the root `test` script chains
> `vitest run --project root`, and why CI has a separate step for it. If you only run
> `pnpm -r test` you skip every architecture guard.

**Running the daemon.** `adl daemon start` (5.7) really boots the manager in-process now,
from `@adl/manager`'s own bin (`node packages/manager/dist/bin.js daemon start`, or the
linked `adl` once the package is installed) — run it from the repository ADL should watch;
it reads/mints `.adl/daemon.json` there and creates `.adl/adl.db` beside it. It has no live
GitHub App wired up yet (`options.forge` is absent — `DEBT.md` item 1.7), so the polling
detection loop (5.5) does not start from this entry point; `startDaemon(options)` called
programmatically with a real `forge` is still how to exercise that. The working reference
callers, still useful for anything the CLI entry point doesn't wire up yet:

- `packages/manager/test/boot/cli-entry.test.ts` — the real `adl daemon start` chain, 5.7's own tracer
- `packages/manager/test/tracer/dev-run-end-to-end.test.ts`
- `packages/manager/test/scenario/concurrency-crash-restart.test.ts`

Once a daemon is up:

```bash
adl status [--json]
adl dev-run <feature-id>              # → prints a stage-attempt id
adl logs -f <stage-attempt-id>
adl pause | resume | kill [<feature-id> | --repo <id> | --all [--yes]]
adl gc
```

HTTP surface (bearer token on everything but `/health`; binds `127.0.0.1:4173`; config
minted at `.adl/daemon.json` on first run): `GET /health`, `GET /features`,
`POST /features/:id/pause|resume|kill`, `POST /control/…`, `POST /dev-run/:featureId`,
`GET /stages/:id/logs?offset=N&follow=1` (SSE).

---

## Repo map

| Package                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/core`              | The settled vocabulary — verdicts, findings, criterion IDs, normalized specs, `adl.yml`/`EffectiveConfig`, the lifecycle state machine, **the round loop's decision** (5.13, `@adl/core/loop`), **what a gate may see** (5.17, `@adl/core/stage`'s `GateContext`), and the port _declarations_ (`Workspace`, `AgentRunner`, `Stage`). **Pure and I/O-free, lint-enforced.**                                                                                                                                                                                                                                                                                     | nothing, deliberately                                                        |
| `packages/plugin-sdk`        | The small published contract a third-party gate depends on. Re-exports `@adl/core`; **defines nothing of its own.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | core                                                                         |
| `packages/db`                | Kysely schema, hand-written migrations, migration runner, repositories, model pricing. Only package touching `better-sqlite3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | core (dev)                                                                   |
| `packages/workspace`         | **The exec boundary.** Worktree lifecycle — including `attach`/`detach`, so a workspace outlives the stage that created it (5.14) — zero-inherit child env, scratch `HOME`, privilege drop, git-config neutralisation, backend registry, GC. Only package allowed to import `execa` / `simple-git` / `child_process`.                                                                                                                                                                                                                                                                                                                                           | core                                                                         |
| `packages/agent-claude-code` | The Claude Code headless adapter. Translates `--output-format stream-json` into ADL `AgentEvent`s, and one invocation's spend into a `usage_events`-shaped record — `usageFromResult` when the run reported one, `unknownUsageRecord` when it ran and did not (5.18). Receives a `Workspace`, never constructs one.                                                                                                                                                                                                                                                                                                                                             | core                                                                         |
| `packages/forge-github`      | The GitHub `ForgeAdapter` (M05). `octokit` + `@octokit/auth-app` — a GitHub App, never a PAT. Wired into the manager's automatic dispatch for the polling loop's read-only calls (5.5, gated behind `StartDaemonOptions.forge`) and for the credentialed publish side — push, open a draft change request, upsert each role's sticky comment (5.10, 5.11). Both list calls paginate.                                                                                                                                                                                                                                                                            | core                                                                         |
| `packages/manager`           | The control-plane daemon — lease queue, worker supervision via `fork()`, reaper, GC schedule, **the round loop** (5.13, `src/loop/round-runner.ts`), **the command gate** (5.14, now `src/worker-entry/gates/command-gate.ts`), **the protected-path check** (5.16, `src/loop/protected-paths-check.ts` — runs in the manager, not a pipeline stage), **gate-context assembly** (5.17, `src/worker-entry/gate-context.ts` — the one place an `AssignMessage` is narrowed for a gate), Hono HTTP API, prompt builder, NDJSON transcript store, worker entry. **Only package that writes to the DB.** Ships the real, installed `adl` binary (5.7, `src/bin.ts`). | core, db, workspace, agent-claude-code, cli (forge-github: test-only so far) |
| `packages/cli`               | The `adl` verb set. Talks to the daemon **over HTTP only** — structurally cannot resolve `@adl/db` or `@adl/manager`, unchanged by 5.7. A library, not the installed binary itself (`@adl/manager` depends on it and owns `bin.ts`; `daemon start` is the one verb `@adl/manager` fills in via `BuildProgramDeps.startDaemon`).                                                                                                                                                                                                                                                                                                                                 | nothing, by design                                                           |

No `apps/` directory — the dashboard is M17 and unbuilt.

**Architecture guards** live in `eslint.config.js` (~1,000 annotated lines) and `test/`:
`adl/no-direct-spawn`, `adl/core-purity`, `adl/verdict-schema`, `adl/worker-entry-no-db`,
`adl/no-forge-merge` (5.12 — ADL never merges, paired with `@adl/core/forge`'s
compile-time-exhaustive `FORGE_ADAPTER_MEMBERS`),
`adl/gate-fresh-context` (5.17 — a gate never inherits the developer's session or
transcript, paired with `@adl/core/stage`'s compile-time-exhaustive
`GATE_CONTEXT_MEMBERS`/`GATE_DIFF_MEMBERS`; **must stay registered last**, since its glob is
a strict subset of `adl/worker-entry-no-db`'s and flat config resolves by last match),
plus `test/toolchain.test.ts` (TypeScript pinned to exactly 6.0.3),
`test/ci-matrix.test.ts`, and `test/platform-gate-discipline.test.ts`. Each rule is proven
by a deliberate-violation fixture in `test/lint/fixtures/`.

**CI:** `.github/workflows/ci.yml`, one `verify` job, matrix Node 22/24 × ubuntu/windows
minus windows+24 (3 legs). The Linux legs provision an `adl-worker` OS user and a scoped
sudoers rule so the privilege-drop assertions actually execute.

---

## Open blockers

Nothing blocks M05. Three things to know before you start:

1. **The end-of-project verification pass** ([`DEBT.md`](./DEBT.md) § 1) — 6 items needing
   either a live `ANTHROPIC_API_KEY` + the unshadowed pinned CLI, or a Linux host. Batched
   by maintainer decision so they don't stall the roadmap.
   **M06 is blocked on one of them** (reconciling reported cost against a real bill) — the
   natural moment to close it is _during_ M05.
2. **D-2-R-1** ([`DEBT.md`](./DEBT.md) § 2) — the highest-severity open item. Concurrent
   features are not isolated from each other. Accepted for v1, with "concurrency > 1 on a
   shared host" as an explicit revisit trigger.
3. **D-5-14-1** ([`DEBT.md`](./DEBT.md) § 3) — a finished feature's worktree is now
   never collected. `TERMINAL_STATES` is `merged`/`abandoned`, and v1 produces neither
   (ADL never merges; nothing watches for a human doing it until M10). Invisible before
   5.14 only because the stage runner destroyed the worktree every stage, which was itself
   the defect. Owner M09; not blocking, but it accumulates.

---

## Keeping this file honest

Update **this file** when you finish a work session — position, and what the next person
should do. Update the milestone file's checkboxes as steps land. Update
[`ROADMAP.md`](./ROADMAP.md) only at a milestone boundary.

Anything you discover and don't fix goes in [`DEBT.md`](./DEBT.md) with an owner milestone
and, where possible, a reproduction. A prose "didn't touch this" note is not good enough —
that standard is the reason this project's known risks are still legible a year later.
