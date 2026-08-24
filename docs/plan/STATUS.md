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

**4 of 18 milestones delivered. Milestone 5 is next and has not been started.**

```
M01 Core Contracts .................. ✅ done
M02 Workspace & Exec Boundary ....... 🟡 code complete (1 deferred check)
M03 Manager Skeleton ................ ✅ done
M04 First Agent Backend ............. 🟡 code complete (1 deferred check)
M05 The Loop Closes ................. ◀ NEXT — nothing written yet
M06–M18 ............................. not started
```

**What actually works today:** a real Claude Code agent, driven through a bounded workspace,
makes a real commit in a per-feature git worktree, streamed live to `adl logs -f`, with its
cost recorded — all supervised by a crash-surviving manager you can pause and kill. Every
piece of that is tested and merged to `main`.

**What does not exist yet:** anything that reaches a forge. No GitHub adapter, no feature
detection, no round loop, no gates. `dev-run` fires a single synthetic `develop` stage by
hand. **That gap is exactly what M05 closes**, and closing it is the moment ADL first
becomes a product rather than machinery.

The two 🟡 milestones are *not* unfinished work. Their code is merged, tested and CI-green;
what's outstanding is one environment precondition each (a live API key; a Linux host),
batched deliberately into an end-of-project verification pass. See [`DEBT.md`](./DEBT.md) § 1.

---

## What to do next

Open [`milestones/m05-the-loop-closes.md`](./milestones/m05-the-loop-closes.md). It has 19
small steps in four groups, and the acceptance criteria that define done.

**Suggested opening, matching this repo's own convention of starting a milestone with a
supply-chain gate and then a tracer:**

1. **Supply-chain gate.** M05 needs `octokit` and `@octokit/auth-app` — the first new
   runtime dependencies since M04. Every prior milestone opened by confirming
   repository/org and version against the public registry *before* installing, with a human
   in the loop. Do that first, and record the exact pins.
2. **Then a tracer, not a feature.** One thin, production-quality path all the way through:
   a committed feature folder is detected → a draft change request appears on a real
   GitHub repo. That touches detection, the forge port and the adapter at once, and every
   earlier milestone proved this ordering pays.
3. **Then widen** through groups A → B → C → D.

Steps 5.1, 5.4 and 5.7 also close a gap M03 shipped deliberately: **`adl daemon start`
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
| `packages/manager` | The control-plane daemon — lease queue, worker supervision via `fork()`, reaper, GC schedule, Hono HTTP API, prompt builder, NDJSON transcript store, worker entry. **Only package that writes to the DB.** | core, db, workspace, agent-claude-code |
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
