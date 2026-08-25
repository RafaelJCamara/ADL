# STATUS — start here

*Last updated: 2026-08-25*

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
group A (5.1–5.7), and 5.8–5.10 from group B are done; group B still has 5.11–5.12 ahead, and
groups C and D haven't started.**

```
M01 Core Contracts .................. ✅ done
M02 Workspace & Exec Boundary ....... 🟡 code complete (1 deferred check)
M03 Manager Skeleton ................ ✅ done
M04 First Agent Backend ............. 🟡 code complete (1 deferred check)
M05 The Loop Closes ................. ◀ IN PROGRESS — opener + 5.1–5.10 done
M06–M18 ............................. not started
```

**What actually works today:** a real Claude Code agent, driven through a bounded workspace,
makes a real commit in a per-feature git worktree, streamed live to `adl logs -f`, with its
cost recorded — all supervised by a crash-surviving manager you can pause and kill. On top
of that, as of this session: a `features/` folder committed to a repo is *detected* by
evaluating real repository state (`@adl/core/detect` + `ManagerGitClient.listFiles`); a
branch can be *pushed* to a remote (`ManagerGitClient.push`); and a real `ForgeAdapter`
(`@adl/forge-github`, a real GitHub App auth flow via `octokit` + `@octokit/auth-app`) opens
a real draft change request, proven end to end in
`packages/manager/test/tracer/detect-to-draft-cr-end-to-end.test.ts` against a local mock
GitHub server (live GitHub credentials are deliberately deferred — see `DEBT.md` § 1 item 1.7).
And the scanner's output can now be told apart from what ADL already knows about: the
*undeveloped* predicate (`@adl/core/detect`'s `undevelopedFeatureFolders` +
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
is now the first production caller of 5.1's scanner, 5.2's *undeveloped* predicate, and
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
*different* identity back out of that same branch (GC needs the ULID, reconciliation needs
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
automatic version of what 5.0b's tracer proved by hand. The push has to happen *inside* the
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

**What does not exist yet:** promote-to-ready/sticky-comments/never-merge wiring
(5.11–5.12, though `promoteToReady` and `upsertComment`'s marker-based find-or-create are
already built and just need a caller), and the whole round loop — gates, send-back,
protected-path enforcement (group C) — plus per-round accounting (group D). `dev-run` still
fires a single synthetic `develop` stage by hand.

The two 🟡 milestones are *not* unfinished work. Their code is merged, tested and CI-green;
what's outstanding is one environment precondition each (a live API key; a Linux host),
batched deliberately into an end-of-project verification pass. See [`DEBT.md`](./DEBT.md) § 1.

---

## What to do next

Open [`milestones/m05-the-loop-closes.md`](./milestones/m05-the-loop-closes.md) and continue
with group B's remainder — **5.11** (sticky per-role comments — `upsertComment`'s
marker-based find-or-create already exists in `@adl/forge-github`; 5.11 is *using* it from
the loop, not building it again — note `@adl/forge-github`'s `upsertComment` does not
paginate `issues.listComments`, `DEBT.md` § 4, owned by this step), **5.12** (the never-merge
structural guard — `ForgeAdapter` already has no merge method; 5.12 is the assertion that
reads its own shape and fails if one is ever added). Group C (the round loop itself) reuses
`resolvePipeline` (`@adl/core/config`, still no caller) and is also where 5.10's deferred
half — calling `forge.promoteToReady` once `aggregate()` says every gate passed — gets wired
in. Group D (accounting) can run in parallel with C once a round exists to record against.

**Before you plan M05 in detail, skim:**
- [`DECISIONS.md`](./DECISIONS.md) — so settled questions stay settled
- [`DEBT.md`](./DEBT.md) § 2 — D-2-R-3 (a TOCTOU in the path guard) is currently harmless
  *because nothing runs concurrently with ADL's own file access*. **M05 changes that.**

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

| Package | Does | Depends on |
|---------|------|------------|
| `packages/core` | The settled vocabulary — verdicts, findings, criterion IDs, normalized specs, `adl.yml`/`EffectiveConfig`, the lifecycle state machine, and the port *declarations* (`Workspace`, `AgentRunner`, `Stage`). **Pure and I/O-free, lint-enforced.** | nothing, deliberately |
| `packages/plugin-sdk` | The small published contract a third-party gate depends on. Re-exports `@adl/core`; **defines nothing of its own.** | core |
| `packages/db` | Kysely schema, hand-written migrations, migration runner, repositories, model pricing. Only package touching `better-sqlite3`. | core (dev) |
| `packages/workspace` | **The exec boundary.** Worktree lifecycle, zero-inherit child env, scratch `HOME`, privilege drop, git-config neutralisation, backend registry, GC. Only package allowed to import `execa` / `simple-git` / `child_process`. | core |
| `packages/agent-claude-code` | The Claude Code headless adapter. Translates `--output-format stream-json` into ADL `AgentEvent`s. Receives a `Workspace`, never constructs one. | core |
| `packages/forge-github` | The GitHub `ForgeAdapter` (M05). `octokit` + `@octokit/auth-app` — a GitHub App, never a PAT. Wired into the manager's automatic dispatch for the polling loop's read-only calls (5.5, gated behind `StartDaemonOptions.forge`); the credentialed publish side (push, open/promote a change request) is still 5.10's. | core |
| `packages/manager` | The control-plane daemon — lease queue, worker supervision via `fork()`, reaper, GC schedule, Hono HTTP API, prompt builder, NDJSON transcript store, worker entry. **Only package that writes to the DB.** Ships the real, installed `adl` binary (5.7, `src/bin.ts`). | core, db, workspace, agent-claude-code, cli (forge-github: test-only so far) |
| `packages/cli` | The `adl` verb set. Talks to the daemon **over HTTP only** — structurally cannot resolve `@adl/db` or `@adl/manager`, unchanged by 5.7. A library, not the installed binary itself (`@adl/manager` depends on it and owns `bin.ts`; `daemon start` is the one verb `@adl/manager` fills in via `BuildProgramDeps.startDaemon`). | nothing, by design |

No `apps/` directory — the dashboard is M17 and unbuilt.

**Architecture guards** live in `eslint.config.js` (662 annotated lines) and `test/`:
`adl/no-direct-spawn`, `adl/core-purity`, `adl/verdict-schema`, `adl/worker-entry-no-db`,
plus `test/toolchain.test.ts` (TypeScript pinned to exactly 6.0.3),
`test/ci-matrix.test.ts`, and `test/platform-gate-discipline.test.ts`. Each rule is proven
by a deliberate-violation fixture in `test/lint/fixtures/`.

**CI:** `.github/workflows/ci.yml`, one `verify` job, matrix Node 22/24 × ubuntu/windows
minus windows+24 (3 legs). The Linux legs provision an `adl-worker` OS user and a scoped
sudoers rule so the privilege-drop assertions actually execute.

---

## Open blockers

Nothing blocks M05. Two things to know before you start:

1. **The end-of-project verification pass** ([`DEBT.md`](./DEBT.md) § 1) — 6 items needing
   either a live `ANTHROPIC_API_KEY` + the unshadowed pinned CLI, or a Linux host. Batched
   by maintainer decision so they don't stall the roadmap.
   **M06 is blocked on one of them** (reconciling reported cost against a real bill) — the
   natural moment to close it is *during* M05.
2. **D-2-R-1** ([`DEBT.md`](./DEBT.md) § 2) — the highest-severity open item. Concurrent
   features are not isolated from each other. Accepted for v1, with "concurrency > 1 on a
   shared host" as an explicit revisit trigger.

---

## Keeping this file honest

Update **this file** when you finish a work session — position, and what the next person
should do. Update the milestone file's checkboxes as steps land. Update
[`ROADMAP.md`](./ROADMAP.md) only at a milestone boundary.

Anything you discover and don't fix goes in [`DEBT.md`](./DEBT.md) with an owner milestone
and, where possible, a reproduction. A prose "didn't touch this" note is not good enough —
that standard is the reason this project's known risks are still legible a year later.
