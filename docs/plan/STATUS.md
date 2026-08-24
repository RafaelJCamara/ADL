# STATUS — start here

*Last updated: 2026-08-24*

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

**4 of 18 milestones delivered. Milestone 5 is in progress — the opener (5.0, 5.0b) and
four of its steps (5.1, 5.2, 5.8, 5.9) are done; groups A–D still have 5.3–5.7, 5.10–5.12,
and all of C and D ahead.**

```
M01 Core Contracts .................. ✅ done
M02 Workspace & Exec Boundary ....... 🟡 code complete (1 deferred check)
M03 Manager Skeleton ................ ✅ done
M04 First Agent Backend ............. 🟡 code complete (1 deferred check)
M05 The Loop Closes ................. ◀ IN PROGRESS — opener + 5.1/5.2/5.8/5.9 done
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
the forge) so that cross-reference is possible at all.

**What does not exist yet:** enqueueing the *undeveloped* predicate's output (still not
called from anywhere but its own tests), the trusted-path filter (5.3), a production
`resolveAdlYml` and the polling loop (5.4–5.7), promote-to-ready/sticky-comments/never-merge
wiring (5.10–5.12), and the whole round loop — gates, send-back, protected-path enforcement
(group C) — plus per-round accounting (group D). None of the new pieces above are wired into
`daemon.ts`'s automatic dispatch yet; they were proven to compose by calling each directly,
matching the milestone's own tracer-then-widen discipline. `dev-run` still fires a single
synthetic `develop` stage by hand.

The two 🟡 milestones are *not* unfinished work. Their code is merged, tested and CI-green;
what's outstanding is one environment precondition each (a live API key; a Linux host),
batched deliberately into an end-of-project verification pass. See [`DEBT.md`](./DEBT.md) § 1.

---

## What to do next

Open [`milestones/m05-the-loop-closes.md`](./milestones/m05-the-loop-closes.md) and continue
with group A: **5.3**, the trusted-path filter (SPEC-06) — default branch only, author must
have write permission, fork PRs ignored unless explicitly opted in. Reject *before* anything
is enqueued.

After 5.3: **5.4** (production `resolveAdlYml` — also unblocks **5.7**, `adl daemon start`),
**5.5** (the polling loop, reusing `gc-schedule.ts`'s shape — this is also the first
production caller of 5.2's `undevelopedFeatures`), **5.6** (exclusive claim + restart
reconciliation, DETECT-05 — reuses 5.2's predicate for the lost-row case). Then group B's
remainder — **5.10** (draft-at-round-1/promote-when-green wiring),
**5.11** (sticky per-role comments — `upsertComment`'s marker-based find-or-create already
exists in `@adl/forge-github`; 5.11 is *using* it from the loop, not building it again),
**5.12** (the never-merge structural guard — `ForgeAdapter` already has no merge method;
5.12 is the assertion that reads its own shape and fails if one is ever added). Group C (the
round loop itself) needs 5.4's `resolveAdlYml` and reuses `resolvePipeline`
(`@adl/core/config`, still no caller). Group D (accounting) can run in parallel with C once a
round exists to record against.

Steps 5.4 and 5.7 close a gap M03 shipped deliberately: **`adl daemon start`
currently prints an honest gap message and exits 1**, because it needs a production
`resolveAdlYml` that only detection can provide.

**Before you plan M05 in detail, skim:**
- [`DECISIONS.md`](./DECISIONS.md) — so settled questions stay settled
- [`DEBT.md`](./DEBT.md) § 2 — D-2-R-3 (a TOCTOU in the path guard) is currently harmless
  *because nothing runs concurrently with ADL's own file access*. **M05 changes that.**

---

## How to run it

```bash
pnpm install --frozen-lockfile
pnpm build            # required — the CLI bin points at dist/

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

**Running the daemon.** There is no shipped daemon binary and `adl daemon start` does not
work yet (see above). Call `startDaemon(options)` from `@adl/manager` programmatically. The
working reference callers are the tests:

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
| `packages/forge-github` | The GitHub `ForgeAdapter` (M05). `octokit` + `@octokit/auth-app` — a GitHub App, never a PAT. Not yet wired into the manager's automatic dispatch; proven by the M05 tracer calling it directly. | core |
| `packages/manager` | The control-plane daemon — lease queue, worker supervision via `fork()`, reaper, GC schedule, Hono HTTP API, prompt builder, NDJSON transcript store, worker entry. **Only package that writes to the DB.** | core, db, workspace, agent-claude-code (forge-github: test-only so far) |
| `packages/cli` | The `adl` binary. Talks to the daemon **over HTTP only** — structurally cannot resolve `@adl/db` or `@adl/manager`. | nothing, by design |

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
