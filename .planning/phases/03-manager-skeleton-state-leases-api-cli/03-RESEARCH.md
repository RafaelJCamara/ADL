# Phase 3: Manager Skeleton — State, Leases, API, CLI - Research

**Researched:** 2026-08-19
**Domain:** Long-running Node.js control-plane daemon — process supervision via `child_process.fork()`, SQLite-backed optimistic-concurrency lease queue, Hono HTTP API, commander CLI
**Confidence:** MEDIUM-HIGH (stack mechanics HIGH via in-repo verification and registry checks; cross-platform signal semantics MEDIUM via web search, cross-checked against Node's own issue tracker and the pinned execa docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Lease Timing & The Heartbeat Path**

- **D-01:** The worker heartbeats over the `fork()` IPC channel and the manager writes `heartbeat_at` — the worker never opens the database. This keeps `schema.ts`'s "the manager is the only writer" claim literally true rather than aspirational, keeps `@adl/db` out of the worker's dependency graph (which pnpm's strict `node_modules` then enforces structurally, per Phase 1 D-24), and makes a dead IPC channel a liveness signal in its own right. The accepted cost: a worker wedged with a live channel still looks alive, which is what the TTL exists to catch. — Reversibility: costly.
- **D-02:** Lease TTL 30s, heartbeat interval 10s — 3× headroom absorbs a GC pause or a slow disk without a false expiry, and agent turns are minutes long so a 10s beat is negligible overhead. Both are daemon-config keys (`lease_ttl_ms`, `heartbeat_interval_ms`) so tests can drive them to ~200ms/50ms and CI stays fast; a validation rule enforces TTL ≥ 3× interval. — Reversibility: reversible.
- **D-03:** Expiry is detected by a periodic reaper tick sweeping `WHERE lease_expires_at < now` and applying the `lease_expired` transition. Recovery must happen without anyone asking — a lazy check evaluated only when a lease is next requested leaves a crashed feature sitting expired indefinitely at concurrency 1 with nothing else queued, which fails success criterion 2. This is the same scheduling shape as the D-15 GC sweep being wired up in this phase. — Reversibility: reversible.
- **D-04:** The manager also treats an unexpected `child.on('exit')` as immediate lease expiry, applying the same `lease_expired` transition. Recovery on the common crash case becomes milliseconds rather than 30 seconds, and criterion 2's "within the lease TTL" becomes a ceiling rather than the actual latency. The reaper remains the backstop for what `exit` structurally cannot cover: a manager that itself restarted (no child handle to listen on) and a worker wedged but alive. — Reversibility: reversible — the reaper path must work regardless, so this is a fast path over a guaranteed one.
- **D-05:** A worker whose lease renewal fails, or whose IPC channel dies, self-terminates immediately — treats it as fatal, aborts the current stage, exits non-zero. Defence in depth: fencing at the database is the guarantee, but a worker that stops on its own never races a replacement worker inside the same worktree, so the file-level conflict never arises in the first place. — Reversibility: reversible.

**Fencing — Rejecting the Zombie's Write**

- **D-06:** Because D-01 routes results through IPC, the "stale write" of success criterion 3 arrives as a message, not an `UPDATE`. The fence is therefore applied in both places: the manager rejects a result message whose `lease_token` does not match the current row, and every lease-scoped `UPDATE` carries `WHERE lease_token = ?`. The message check yields a clean, loggable rejection with context; the SQL predicate makes the guarantee structural, so criterion 3 stays true even if a future code path bypasses the message handler. — Reversibility: costly.
- **D-07:** `lease_token` is a ULID minted per lease acquisition. `ulid` is already the project's primary-key scheme (chosen over `nanoid`/UUIDv4 for lexicographic sortability), so this introduces no new concept; tokens are greppable in logs and need no coordination to be unique. Explicitly not reusing `state_version` as the fence: it moves on every transition including ones the valid lease holder itself makes, so a legitimate worker's second write would be fenced out unless it re-read the row each time. — Reversibility: costly.
- **D-08:** `leaseToken` is a required, non-optional parameter on every lease-scoped repository method, so omitting it is a compile error rather than a runtime bug. This deliberately mirrors Phase 1's `TransitionResult.expectedStateVersion`, which exists so that "a state write cannot be issued without its guard" — same philosophy, same shape, one mental model for a contributor. Rejected the `LeaseHandle` object alternative because it fights the flat named-function repository surface D-28 chose deliberately. — Reversibility: costly.
- **D-09:** A rejected stale result is dropped, logged at `warn` (feature id, presented token, current token), and counted, with the counter surfaced in the status view. It is expected-but-notable, not an error — Phase 1 established that `InvalidTransition` is "returned, never thrown" precisely because a benign race and a real bug are indistinguishable at the call site and an exception forecloses the caller's judgement. Silent dropping was rejected: criterion 3's test would have nothing to assert on but absence, and a real fencing bug would be invisible in production. — Reversibility: reversible.

**Crash Recovery Policy**

- **D-10:** A feature whose worker died mid-`gating` resumes at the same round, replaying the pipeline from stage 0. The round is preserved so the round ceiling cannot be cheated by crashing; the pipeline re-runs because stage verdicts are evidence about a specific commit, and trusting a half-walked pipeline whose earlier gates ran against state that cannot be fully attested to is exactly the silently-wrong-but-green failure this project exists to prevent. Accepted cost: re-running gates that already passed. — Reversibility: reversible — `current_stage_index` is still on the row.
- **D-11:** `crash_count` escalates the feature after 3 consecutive crashes (`unrecoverable` → `escalated`), and resets on any successful round. Without a ceiling, a reproducibly-crashing feature recovers forever and burns budget silently. This mirrors Phase 1's D-15, which already bounds non-transient `StageError` looping with a consecutive counter escalating at a small default — same concept, same shape, no new vocabulary. — Reversibility: reversible.
- **D-12:** Recovery re-attaches the existing worktree via `features.workspace_handle` rather than rebuilding it. Criterion 2's "committed work preserved" is then true because nothing deleted it, not because a restore step ran correctly. Phase 2's D-14 tears down worktrees only on terminal state, so a crash is deliberately not teardown, and this decision is the other half of that one. — Reversibility: reversible.
- **D-13:** On daemon startup the manager expires every lease and kills any still-running orphan worker before requeueing. Deterministic clean slate: no orphan from the previous daemon can race a replacement worker inside the same worktree — the one scenario D-04's `child.on('exit')` fast path structurally cannot cover, because the new manager has no child handle for a process it did not spawn. Re-adopting orphans was rejected: `fork()` IPC channels do not survive the parent, so it would need an entire second control channel. — Reversibility: reversible.
- **D-14:** `lease_owner` records the worker's PID and process start time, and the boot-time orphan kill verifies the start time still matches before signalling. PIDs are reused, so a stale PID may belong to an unrelated process by the time the daemon restarts; start time is the standard discriminator and makes the kill safe by construction. This matters disproportionately because ADL is installed on other teams' infrastructure — a control plane that SIGKILLs an unrelated process on restart is not shippable. Reading process start time is platform-specific, which Phase 2's D-05 already accounted for by naming Linux the deployment target with documented degradation elsewhere. — Reversibility: costly.

**Concurrency**

- **D-15:** Concurrency is a global cap (default 1) with an optional per-repo cap (default unset). The global limit protects the host — each in-flight feature is a process, a worktree, and eventually a paid agent turn — while the optional per-repo limit stops one busy repository starving the others. EXEC-05 literally asks only for the global number, and the roadmap's "run CI at concurrency 3" reads as a single global value; the per-repo cap is the additive escape hatch. — Reversibility: reversible.
- **D-16:** Lowering the concurrency cap while features are in flight drains — the cap governs dispatch, never existing leases, and nothing in flight is destroyed. Lowering a limit can therefore never lose committed work or burn spend for nothing, and `adl kill` remains the deliberate tool for stopping now. This is also the same check shape Phase 6 needs for budgets, which must be "checked before the next agent turn is dispatched, never after it has been paid for". — Reversibility: reversible.
- **D-17:** When a slot opens, the oldest queued feature by id wins — ULIDs are lexicographically sortable, so `ORDER BY id` is FIFO for free with no extra column, which is precisely why `ulid` was chosen over `nanoid` and UUIDv4. Starvation-free and predictable; it is already the ordering `listByState` uses. Round-robin across repositories can layer on later if the per-repo cap proves insufficient. — Reversibility: reversible.

**CLI ↔ Daemon Transport**

- **D-18:** Every CLI verb goes through the HTTP API — no direct SQLite reads, even for `adl status`. One code path, one authorization point, and the Phase 14 dashboard consumes the identical surface rather than a second one grown later. It also keeps the single-writer/single-reader story intact and makes the CLI work against a remote daemon for free. Accepted cost: `adl status` fails when the daemon is down, which is honest — a daemon-less answer would be a stale snapshot presented as current. — Reversibility: costly.
- **D-19:** The API binds `127.0.0.1` by default and is protected by a shared bearer token in the daemon config, read by both the daemon and the CLI. Loopback means the network is not the v1 threat surface; the token means that enabling a non-loopback bind later (for the dashboard) does not ship an unauthenticated control plane, and does not become a breaking change for adopters' scripts. — Reversibility: one-way in the safe direction.
- **D-20:** The API is REST-ish JSON over resources: `GET /features`, `GET /features/:id`, `POST /features/:id/pause|kill`, `POST /control/pause`, `GET /health`. SSE is reserved, not built — Phase 4's `adl logs -f` slots into the same Hono server with no new transport, which is part of why Hono was chosen (`streamSSE` built in, trivial raw-body access). Curl-able and obvious to a contributor. OpenAPI generation deliberately declined. — Reversibility: costly.
- **D-21:** `@adl/cli` and `@adl/manager` are separate packages, shipping one `adl` binary with an `adl daemon` verb. Matches D-25's "scaffold real packages, no placeholders" and keeps the CLI structurally unable to reach past HTTP into manager internals — pnpm's strict `node_modules` (D-24) makes that a resolve-time failure rather than a review convention. One installed binary is a simpler install story than two. — Reversibility: costly.

**`adl status` Output**

- **D-22:** The manager resolves the stage name by joining `current_stage_index` against the pipeline in `effective_config_json` (snapshotted at lease time), rendering e.g. `gating 2/4 (test)`. The lifecycle stays ignorant of stage identity, so EXEC-07 is intact, while the operator still sees a name. — Reversibility: reversible.
- **D-23:** Default columns: feature, repo, state, stage, round, age, worker. That is criterion 1's three required fields plus the context that makes them actionable. Spend is deliberately absent: OBS-05 is mapped to Phase 6, and with no AI in the loop every row would render zero. — Reversibility: reversible.
- **D-24:** Human table by default, `--json` for machines. The criterion-1 test asserts on structured JSON fields rather than string-matching a table. Formatting stays at the `picocolors` level — no TUI. — Reversibility: reversible.
- **D-25:** With the daemon down, `adl status` fails with a clear message and a non-zero exit: `Cannot reach the ADL daemon at 127.0.0.1:PORT. Is it running? Try: adl daemon start`. Auto-starting the daemon was rejected. — Reversibility: reversible.

**Pause & Kill**

- **D-26:** `adl pause` stops dispatch; in-flight features finish their current round and then park. Pause is a brake on new work, not a kill: nothing paid-for is discarded and the worktree is left at a coherent commit boundary. This is the same drain semantics as D-16's concurrency lowering. `adl kill` remains the tool for stopping now. — Reversibility: reversible.
- **D-27:** A killed feature lands in `paused`, not `escalated` or `queued`. Kill stops the process; it does not judge the feature. `paused` already has a `resume` edge back to `queued`. Using `escalated` was rejected because it is the state limits and unrecoverable errors use. — Reversibility: reversible.
- **D-28:** Workers are stopped with SIGTERM, then SIGKILL after a configurable grace period (~10s default), giving the worker a chance to abort its stage and release the worktree cleanly before being killed unconditionally. `execa` was chosen partly for `cancelSignal` and `forceKillAfterDelay`, which is exactly this pattern with cross-platform child cleanup already handled. — Reversibility: reversible. **(See § Common Pitfalls — Pitfall 1/3: this needs an IPC-message implementation for the forked worker, not a literal OS SIGTERM, to actually deliver on Windows.)**
- **D-29:** Scoping is `adl kill <feature-id>` / `--repo <id>` / `--all`, with `--all` requiring interactive confirmation (bypassable via `--yes` for scripts). The same shape applies to `adl pause`. — Reversibility: reversible.

**Fake Worker & The No-AI Proof**

- **D-30:** The double is the real worker entry point with a scripted stage runner injected — the actual process, the actual IPC handshake, the actual heartbeat loop and lease plumbing, with only the thing that would call an agent swapped for a scripted no-op. A standalone fake-worker script was rejected; an `--fake` flag on the shipped binary was rejected as a foot-gun. Phase 4 then replaces one injected module. — Reversibility: reversible.
- **D-31:** The criterion-3 zombie is built by having the scripted worker pause past the TTL with self-termination suppressed for that scenario, then report with its now-stale token. With `lease_ttl_ms` at ~200ms in tests, the manager has meanwhile reaped and re-leased, so the token no longer matches — exercising both halves of D-06's fence end-to-end, with no process trickery. — Reversibility: reversible.
- **D-32:** The roadmap's "run CI at concurrency 3" is one scenario test: three concurrent features, one worker SIGKILLed, and the daemon restarted mid-flight. It asserts at the end that all three features are accounted for, committed work is intact, the spend ledger is unchanged by the crash, no orphan worktrees remain, and no feature was ever double-leased. — Reversibility: reversible.
- **D-33:** The recovery suite runs on both Linux and Windows in CI. Signals, PID/start-time lookup, and `fork()` child cleanup all differ meaningfully by platform, and the recovery guarantees are the entire phase. The Linux job already exists from Phase 2's D-21; Windows is the development machine, so a Windows-green suite keeps local iteration honest. Any platform-gated test skips with a visible reason, never passes vacuously. — Reversibility: reversible. **(See § Environment Availability — the Windows CI matrix leg does not exist yet and must be added.)**

**Manager Lifecycle, Config & Repo Registration**

- **D-34:** Phase 2's deferred D-15 is discharged as: a manager timer runs `sweepOrphans` periodically, and `adl gc` triggers it on demand. `@adl/workspace` exposes `listManagedWorktrees()` as the mechanism; `sweepOrphans` is the policy half reaching feature state through an injected `FeatureStateLookup`; the manager binds that lookup and owns the trigger. **The pass itself must not be re-derived.** The GC schedule is a separate, much longer interval than the lease reaper's; the two sweeps share a scheduling mechanism, not a cadence. The same schedule must also call `sweepScratchHomes`. — Reversibility: reversible.
- **D-35:** Watched repositories are declared in the daemon config and reconciled into the `repos` table at startup. Configuration is already the trust anchor — D-22 makes backend and credential selection daemon-only precisely because repo-supplied files are untrusted — so repository identity belongs there too. A `adl repo add` CLI verb was rejected for v1. — Reversibility: reversible — a CLI verb can be added later as an editor of the same file.
- **D-36:** The daemon config is a separate file from repo-level `adl.yml`, holding concurrency caps, `lease_ttl_ms`/`heartbeat_interval_ms`, API port and token, and watched repositories. D-22 already defines the cascade as `defaults ← daemon config ← repo adl.yml` with daemon-enforced clamps, so the two files carry different authority over the same settings. Same format and parser as `adl.yml` (the `yaml` package, Zod-validated like every other contract in the project). — Reversibility: costly.
- **D-37:** Manager startup implements `feature-state.ts`'s versioning rule 2 in full: refuse to run against a schema newer than the daemon, copy the database file before auto-migrating an older one, then reconcile repositories (D-35) and expire leases (D-13). Shutdown on SIGTERM is graceful: stop dispatch, SIGTERM workers with the same grace period as `adl kill` (D-28), flush, exit. — Reversibility: one-way — the schema gate protects databases ADL does not own.

### Claude's Discretion

The following were explicitly left to the planner and executor:

- Exact JSON field names and response envelope shape for the HTTP API
- Log line formats and pino child-logger binding keys (beyond `{ featureId, round, agent }` already named in the stack)
- Table column widths, alignment, and colour choices in `adl status`
- Exact wording of user-facing error messages (beyond D-25's daemon-down message, which is specified)
- Test file layout and naming within each package
- Whether the reaper and GC timers share one scheduler object or are two independent timers (D-34 fixes only that their cadences differ) — see § Open Questions 2 for research input
- The concrete IPC message union between manager and worker — its typed contract is the planner's to design, constrained by D-01 (heartbeat), D-06 (results carry `lease_token`) and D-05 (worker self-terminates) — see § Architecture Patterns, Pattern 2 for a recommended addition (a `soft_stop` message kind)
- How `effective_config_json` is assembled and snapshotted at lease time — the requirement is fixed by Phase 1's versioning rule 3; the mechanism is not — see § Don't Hand-Roll: `mergeConfig` already exists and should be reused directly

### Deferred Ideas (OUT OF SCOPE)

- Round-robin scheduling across repositories — D-17 chose FIFO by ULID; round-robin can layer on later if the optional per-repo cap (D-15) proves insufficient in practice.
- `adl repo add` / `remove` / `list` CLI verbs — D-35 makes the daemon config the source of truth for watched repositories. A future CLI verb should edit that file, not write to the `repos` table directly.
- OpenAPI document for the HTTP API — declined in D-20 for this phase.
- Non-loopback API bind for remote dashboard access — D-19 ships loopback-only but includes the bearer token specifically so this can be enabled later.
- Resuming mid-pipeline after a crash — D-10 chose replay-from-stage-0. `current_stage_index` is still persisted, so this is a future policy change rather than a schema change.
- macOS CI — D-33 covers Linux and Windows. macOS has no stated deployment role.
- Spend column in `adl status` — deliberately excluded by D-23; belongs with OBS-05 in Phase 6.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| EXEC-01 | Manager process owns detection, queue, state, config, credentials, and accounting | § Architectural Responsibility Map (Control Plane tier); § Don't Hand-Roll (daemon config extension); § Architecture Patterns (project structure) |
| EXEC-02 | Worker runs as a separate OS process holding a lease on one feature | § Architecture Patterns Pattern 3 (`fork()` as a named `@adl/workspace` export); § Common Pitfalls Pitfall 3 (execa does not extend to the forked worker) |
| EXEC-03 | A worker killed mid-loop is detected and its feature recovered, with committed work preserved and burned spend retained on the ledger | § Architecture Patterns Pattern 5 (ISO-8601 lease-expiry comparison); D-03/D-04 timing; § Validation Architecture (EXEC-03 test map row) |
| EXEC-04 | A resumed zombie worker cannot write stale results over newer state | § Architecture Patterns Pattern 1 (lease-scoped `compareAndSwapState`-shaped methods); § Security Domain (fencing as the V4 access-control equivalent) |
| EXEC-05 | Maintainer sets concurrency; it defaults to one feature in flight | § Don't Hand-Roll (daemon config extension for `concurrency`); § Validation Architecture (D-32 scenario test) |
| EXEC-06 | Feature state, rounds, spend, and transcripts survive daemon restart | § Architecture Patterns Pattern 6 (`busy_timeout`/WAL); D-37 startup gate reuse of `migrator.ts`/`checksum.ts` (already shipped, verified) |
| OBS-01 | Maintainer can see what every feature is doing right now | D-22/D-23/D-24 (already locked in CONTEXT.md); § Validation Architecture (OBS-01 e2e test row) |
| OBS-03 | Maintainer can pause work | § Architecture Patterns Pattern 2 (IPC soft-stop, needed for D-26's drain-then-park semantics to actually deliver on Windows) |
| OBS-04 | Maintainer can kill a single feature, everything in one repo, or everything | § Architecture Patterns Pattern 2 and § Common Pitfalls Pitfall 1 (the SIGTERM-then-SIGKILL escalation must be IPC-based to work cross-platform, directly enabling D-28) |
</phase_requirements>

## Summary

Phase 3 has no new domain concepts to discover — every mechanism (fencing, leases, optimistic concurrency, GC, purity-of-decision) already has a canonical shape in Phases 1–2's code, and this phase's job is almost entirely *composition*: wire `sweepOrphans`/`sweepScratchHomes` to a schedule, extend the **already-existing** `DaemonConfigSchema` (`packages/core/src/config/effective-config.ts`) with the new lease/API/repo fields rather than inventing a second config schema, add lease-scoped methods to `featuresRepository` following the exact shape of `compareAndSwapState`, and stand up two new packages (`@adl/manager`, `@adl/cli`) plus a worker entry point that speaks IPC and never imports `@adl/db`.

The one genuinely new piece of engineering is **process supervision under `child_process.fork()` with cross-platform signal semantics**, and it carries the single most load-bearing finding of this research: **on Windows, `child.kill('SIGTERM')` does not give the child process a chance to run cleanup code — it terminates the process forcefully and immediately, identically to `SIGKILL`** (verified against Node's own child_process docs and cross-checked against `nodejs/node#12378`). D-28's "SIGTERM, then SIGKILL after a grace period" is written as if it degrades gracefully cross-platform; on the manager→worker `fork()` seam it does not, because a forked child is killed with the OS `kill()` primitive, not run through execa (execa is confined to `packages/workspace/src/exec/run.ts` and is not used to launch or stop the worker itself — the worker is a `fork()`'d process, not an execa subprocess). The fix that makes D-28 actually work identically on both platforms is to route the "please wind down" signal over the **existing IPC channel** (an application-level message, not an OS signal) and reserve `child.kill('SIGKILL')` — which *is* reliably forceful on both platforms — for the hard stop after the grace period. This also composes cleanly with D-05 (the worker already self-terminates on IPC failure) and D-01 (heartbeat already flows over the same channel).

The second load-bearing finding resolves an item CONTEXT.md explicitly flags for the planner: `eslint.config.js`'s own header comment (line 21) already states the intended resolution to "how does `fork()` relate to `adl/no-direct-spawn`" — *"Phase 3, when the manager→worker `fork()` seam lands as a named export of `packages/workspace` rather than as a second exemption"*. The codebase has already made this decision; research confirms it as the lowest-friction path (one exemption, one process-launch policy, no rule duplication) and the planner should treat it as settled rather than open.

**Primary recommendation:** Extend `DaemonConfigSchema`/`mergeConfig` in place, add lease methods to `featuresRepository` mirroring `compareAndSwapState`'s `WHERE ... AND state_version = ?` shape (but keyed on `lease_token`), export a `forkWorker` primitive from `@adl/workspace` rather than adding a second lint exemption, and make every worker-shutdown signal — pause, kill, grace-period escalation — an IPC message first and an OS signal only as the unconditional final step.

## Architectural Responsibility Map

This project has no browser/frontend-server/CDN tiers — it is a CLI-driven daemon. The table below adapts the standard tier vocabulary: **Client** = the `adl` CLI process; **Control Plane** = `@adl/manager` (the only tier with HTTP, scheduling, and DB write access); **Execution** = the forked worker process; **Storage** = SQLite via `@adl/db`.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Lease acquire/renew/expire | Control Plane | Storage | Manager decides; SQLite's `WHERE lease_token = ?` predicate is the structural backstop (D-06) |
| Reaper tick / GC schedule | Control Plane | — | Scheduling lives in the manager; `sweepOrphans`/`sweepScratchHomes` (mechanism) live in `@adl/workspace` and are injected, not owned |
| Worker fork + IPC supervision | Control Plane | Execution | Manager owns the fork call and the IPC protocol; the worker only ever speaks back over that one channel |
| Fencing / stale-write rejection | Control Plane | Storage | IPC-level rejection (loggable) + SQL predicate (structural) — D-06's "both places" |
| HTTP API (`/features`, `/control/*`) | Control Plane | — | Single code path per D-18; CLI never reaches Storage directly |
| `adl` CLI verbs | Client | Control Plane | CLI speaks HTTP only (D-18, D-21); zero DB/manager-internals dependency |
| Concurrency dispatch | Control Plane | — | Cap enforcement and FIFO-by-ULID selection is a scheduling decision, not a data-layer one |
| Daemon config / repo registration | Control Plane | Storage | Config file is the trust anchor (D-35); reconciled into `repos` table at startup |
| Schema-version startup gate / graceful shutdown | Control Plane | Storage | Runs before any other DB access; the DB file itself is copied, not just read |

## Standard Stack

All packages below are already pinned in `./.claude/CLAUDE.md`. No alternatives are proposed; versions are re-verified against the npm registry this session.

### Core (new to this phase)

| Library | Pinned | Registry-current | Purpose | Why Standard |
|---------|--------|-------------------|---------|---------------|
| `hono` | 4.13.2 | 4.13.3 [VERIFIED: npm registry, 2026-08-19] | HTTP API server | Web-standard `Request`/`Response`, `streamSSE` built in for Phase 4's seam, raw-body access trivial for future webhook HMAC (Phase 5) |
| `@hono/node-server` | 2.1.1 | 2.1.1 [VERIFIED: npm registry, 2026-08-19] | Node HTTP adapter for Hono | `serve()` returns a `http.Server`-like handle with `.close(cb)` — the graceful-shutdown seam (see Code Examples) |
| `commander` | 15.0.0 | 15.0.0 [VERIFIED: npm registry, 2026-08-19] | `adl` CLI | Matches `engines >=22.12.0` floor already set by the workspace; lowest-friction subcommand ergonomics |
| `pino` | 10.3.1 | 10.3.1 [VERIFIED: npm registry, 2026-08-19] | Structured logging | Child-logger binding for `{ featureId, round, agent }` context, already named in CLAUDE.md |
| `croner` | 10.0.1 | 10.0.1 [VERIFIED: npm registry, 2026-08-19] | GC schedule (the longer-cadence sweep) | `protect` option for overlap prevention on the sweep that has no hard latency requirement |
| `ulid` | 3.0.2 | (already in use — `@adl/db`) | `lease_token` minting | Already the project's PK scheme (D-07); no new concept introduced |

### Supporting (already in the dependency graph, reused)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `better-sqlite3` | 13.0.3 [VERIFIED: packages/db/package.json] | Lease table storage | Already the sole DB driver in `@adl/db`; this phase adds columns' *methods*, not a new table (lease columns already exist per schema.ts:63-71) |
| `kysely` | 0.29.5 [VERIFIED: packages/db/package.json] | Query builder for lease methods | `featuresRepository` is the existing narrow surface; lease methods are new functions in the same file, same shape |
| `execa` | 10.0.1 [VERIFIED: packages/workspace/package.json] | Killing agent-CLI/git subprocesses *inside* a worker's stage | **Not** used to launch or kill the worker process itself — the worker is `fork()`'d, and `run()` is the sole execa call site, confined to `packages/workspace/src/exec/run.ts` |
| `zod` | 4.4.3 [VERIFIED: pnpm-workspace.yaml catalog] | IPC message union, HTTP request/response schemas, `DaemonConfigSchema` extension | Zod-first is already the project convention (adl.yml, verdicts) |
| `yaml` | 2.9.0 [VERIFIED: packages/core/package.json] | Daemon config file parsing | Same parser as `adl.yml` per D-36; `parseYamlDocument` in `@adl/core/config` is already pure and reusable |
| `vitest` | 4.1.10 (pinned) / 4.1.11 registry-current [VERIFIED: npm registry] | Multi-process integration tests | `pool: 'forks'` is Vitest 4's **default** — each test file already gets its own OS process, which is exactly the isolation a real-`fork()` test needs (see § Vitest Patterns) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| IPC-message soft-stop for worker shutdown | OS `SIGTERM` only (as D-28 reads literally) | Rejected — verified to be a no-op-for-cleanup on Windows; would make D-33's cross-platform CI assert two different behaviors under one decision |
| Extending existing `DaemonConfigSchema` | A new, separate `ManagerConfigSchema` | Rejected — `DaemonConfigSchema` already implements exactly the cascade D-36 describes (`mergeConfig`, clamp-not-merge for limits, reject-not-clamp for daemon-only fields); a second schema would duplicate the fold logic Phase 1 already built |
| `child.on('exit')` fast path + reaper backstop (as decided, D-04) | Reaper-only (no fast path) | Rejected by CONTEXT.md already — noted here only because it is the natural alternative a planner might reach for if D-04 is under-read |

**Installation:**
```bash
pnpm --filter @adl/manager add hono@4.13.2 @hono/node-server@2.1.1 pino@10.3.1 croner@10.0.1 ulid@3.0.2
pnpm --filter @adl/cli add commander@15.0.0
```
(`zod`, `yaml` come from the catalog / are already `@adl/core` dependencies and should be referenced via `workspace:*` + `catalog:` respectively, matching the existing packages' `package.json` shape.)

## Package Legitimacy Audit

| Package | Registry | Latest publish | Weekly downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------------|-------------------|--------------|---------|-------------|
| `hono` | npm | 2026-08-18 [VERIFIED: gsd-tools package-legitimacy] | 49.3M/wk | github.com/honojs/hono | **SUS** (`too-new`) | **Keep — false-positive context below** |
| `@hono/node-server` | npm | 2026-08-14 [VERIFIED: gsd-tools package-legitimacy] | 45.8M/wk | github.com/honojs/node-server | **SUS** (`too-new`) | **Keep — false-positive context below** |
| `commander` | npm | 2026-05-29 [VERIFIED: gsd-tools package-legitimacy] | 414.8M/wk | github.com/tj/commander.js | OK | Approved |
| `pino` | npm | 2026-02-09 [VERIFIED: gsd-tools package-legitimacy] | 37.0M/wk | github.com/pinojs/pino | OK | Approved |
| `croner` | npm | 2026-02-01 [VERIFIED: gsd-tools package-legitimacy] | 7.0M/wk | github.com/hexagon/croner | OK | Approved |

**Packages removed due to `[SLOP]` verdict:** none.

**Packages flagged as suspicious `[SUS]`:** `hono`, `@hono/node-server` — both flagged solely on the `too-new` signal, which measures the **most recent publish date**, not the package's age or trustworthiness. Both packages have tens of millions of weekly downloads, an established GitHub organization (`honojs`), no postinstall script, and are the exact versions already named — with `HIGH` confidence — in `./.claude/CLAUDE.md`'s own upstream research pass. This reads as a routine version bump landing inside the automated check's lookback window, not a supply-chain risk signal. **The planner should still add a `checkpoint:human-verify` task before the `pnpm add` step per protocol** — the flag is procedurally binding even though the evidence points to a false positive — but the task description should note this context so the human check is fast rather than alarming.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────┐  HTTP (bearer token, 127.0.0.1)   ┌──────────────────────────────┐
│   adl CLI    │ ─────────────────────────────────▶│        @adl/manager          │
│ (commander)  │◀───────────────────────────────── │                              │
└─────────────┘        JSON (D-24 --json)          │  Hono API  ┌───────────────┐ │
                                                     │  (D-20)    │  Scheduler /  │ │
                                                     │            │  Dispatcher   │ │
                                                     │            │  (D-15..17)   │ │
                                                     │            └───────┬───────┘ │
                                                     │                    │ fork()  │
                                                     │            ┌───────▼───────┐ │
                                                     │            │  Reaper tick  │ │
                                                     │            │  (D-03, D-04) │ │
                                                     │            └───────┬───────┘ │
                                                     │  ┌─────────────────▼────────┐│
                                                     │  │  @adl/db (featuresRepo)  ││
                                                     │  │  lease acquire/renew/    ││
                                                     │  │  expire, compareAndSwap  ││
                                                     │  └─────────────────┬────────┘│
                                                     └────────────────────┼─────────┘
                                                                          │ SQLite (WAL)
                                                              ┌───────────▼──────────┐
                                                              │   adl.db (lease-     │
                                                              │   table-as-queue)    │
                                                              └───────────────────────┘
        IPC (fork channel: heartbeat, results, soft-stop)  ▲
                                                             │
                                                     ┌───────┴────────────┐
                                                     │   worker process   │
                                                     │  (real entry point,│
                                                     │   scripted stage   │
                                                     │   runner — D-30)   │
                                                     └───────┬────────────┘
                                                              │ Workspace.exec (execa,
                                                              │ @adl/workspace only)
                                                     ┌────────▼────────────┐
                                                     │  agent CLI / git /  │
                                                     │  adl.yml commands   │
                                                     └─────────────────────┘
```

Entry points: the CLI over HTTP, and the manager's own timers (reaper tick, GC sweep) which require no external trigger. Decision points: the fencing check on every lease-scoped write (both the IPC message handler and the SQL predicate), and the crash-vs-clean-shutdown branch at boot (D-13/D-37).

### Recommended Project Structure
```
packages/
├── manager/                  # @adl/manager — new
│   ├── src/
│   │   ├── daemon.ts          # startup gate (D-37), config load, wiring
│   │   ├── api/
│   │   │   ├── app.ts         # Hono app assembly, bearer middleware
│   │   │   └── routes/        # GET /features, /features/:id, POST .../pause|kill, /control/*, /health
│   │   ├── scheduler/
│   │   │   ├── dispatcher.ts  # concurrency cap + FIFO-by-ULID (D-15..17)
│   │   │   ├── reaper.ts      # lease-expiry tick (D-03)
│   │   │   └── gc-schedule.ts # binds sweepOrphans + sweepScratchHomes (D-34) via croner
│   │   ├── worker-supervisor/
│   │   │   ├── fork.ts        # the fork() primitive — see § Don't Hand-Roll
│   │   │   ├── ipc-protocol.ts# the typed message union (Claude's Discretion item)
│   │   │   └── lifecycle.ts   # SIGTERM-soft-stop-then-SIGKILL escalation
│   │   ├── config/
│   │   │   └── daemon-config.ts # loadDaemonConfig() — file I/O around the EXTENDED DaemonConfigSchema
│   │   └── worker-entry/
│   │       └── index.ts       # the forked process's own main — no @adl/db import
│   └── test/
├── cli/                       # @adl/cli — new
│   └── src/
│       ├── index.ts           # commander program, `adl daemon` subcommand
│       ├── commands/           # status.ts, pause.ts, resume.ts, kill.ts, gc.ts, daemon.ts
│       └── http-client.ts     # thin fetch wrapper reading daemon config for port/token
```

### Pattern 1: Lease-scoped repository methods, following `compareAndSwapState`'s shape

**What:** Every lease-scoped write is a conditional `UPDATE ... WHERE id = ? AND lease_token = ?`, returning a boolean from the affected-row count — never throwing, mirroring the existing pattern exactly.
**When to use:** `acquireLease`, `renewLease`, `expireLease`, and any lease-scoped result write.
**Example (the pattern to extend, verified in-repo):**
```typescript
// Source: packages/db/src/repository/features.ts:82-109 (existing, verified this session)
async compareAndSwapState({
  id, expectedVersion, state, currentStageIndex, round, updatedAt,
}) {
  let query = db
    .updateTable('features')
    .set({ state, state_version: expectedVersion + 1, updated_at: updatedAt })
    .where('id', '=', id)
    .where('state_version', '=', expectedVersion);
  // ...
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
},
```
The new `renewLease`/`expireLease`/result-write methods should follow this exactly, substituting `.where('lease_token', '=', leaseToken)` for the version predicate (D-06, D-08), and `leaseToken` is a **required** parameter per D-08 — never `string | undefined`, so a call site that forgot it is a compile error.

### Pattern 2: IPC soft-stop instead of relying on OS SIGTERM for the forked worker

**What:** The manager's "stop gracefully" signal to the worker is an **application-level IPC message** sent over the existing `fork()` channel (the same channel D-01 already uses for heartbeat), not `child.kill('SIGTERM')`. `child.kill('SIGKILL')` is reserved for the unconditional hard stop after the grace period.
**When to use:** `adl pause`/`adl kill` (D-26, D-28), and daemon shutdown (D-37).
**Why (verified this session):**
- Node's own child_process documentation and `nodejs/node#12378` confirm that on Windows, signals sent via `child.kill()` — including `'SIGTERM'` — are emulated by forceful, unconditional termination (`TerminateProcess`), giving the target process **no opportunity to run a handler**. This is not a corner case; it is documented, current behavior. [CITED: nodejs.org/api/child_process.html; cross-checked github.com/nodejs/node/issues/12378]
- `execa`'s own docs confirm `forceKillAfterDelay` is explicitly **a no-op on Windows** for exactly this reason. [CITED: github.com/sindresorhus/execa/blob/main/docs/termination.md] This is strong secondary confirmation that the standard library the project trusts elsewhere (`packages/workspace/src/exec/run.ts`) has already hit and documented this exact platform gap — but that code path is for execa-launched grandchildren, not the fork()'d worker, so its mitigation does not automatically extend to worker supervision.
- Since D-01 already routes heartbeat over IPC ("the worker never opens the database... a dead IPC channel is a liveness signal in its own right"), the same channel is the natural, already-justified place for a shutdown request too — no new capability is introduced, only a new message kind in the union Claude's Discretion already leaves open.

**Example (pattern to implement, no direct source — composed from the verified constraints above):**
```typescript
// manager side — worker-supervisor/lifecycle.ts
async function stopWorker(child: ChildProcess, graceMs: number): Promise<void> {
  child.send({ t: 'soft_stop' }); // IPC message — works identically on Linux and Windows
  const exited = await raceExit(child, graceMs);
  if (!exited) {
    child.kill('SIGKILL'); // the ONE signal that is reliably forceful cross-platform
  }
}
```
```typescript
// worker side — worker-entry/index.ts
process.on('message', (msg) => {
  if (isSoftStop(msg)) {
    void abortCurrentStageAndExit(); // D-05's self-termination path, reused
  }
});
```

### Pattern 3: `fork()` as a named export of `@adl/workspace`, not a second lint exemption

**What:** `eslint.config.js` (line 21) already states the intended resolution: *"Phase 3, when the manager→worker `fork()` seam lands as a named export of `packages/workspace` rather than as a second exemption."* [VERIFIED: eslint.config.js:21 — quoted verbatim] This is a decision already recorded in the codebase, not an open question for the planner to weigh from scratch.
**Why this reading wins over a second exemption:** `packages/workspace/src/index.ts`'s header comment states the package's whole reason for existing is "every process ADL starts goes through this package" [VERIFIED: packages/workspace/src/index.ts:4-9, quoted]. A second exemption for `@adl/manager` would mean the "one process-launch boundary" claim is enforced by two independent carve-outs instead of one, which is exactly the "careless glob silently deletes the two bans" failure mode the same file's Pitfall-1 reference warns about.
**Recommended shape:** add a `forkWorker(entryPath, opts): ChildProcess` (or similar) function to `packages/workspace/src/exec/` (a sibling of `run.ts`, not a modification of it — `run` is execa-specific and `fork()` is a different primitive), exported from the barrel alongside `run`. `WORKSPACE_EXEMPTION` (`eslint.config.js:318`, `[mod('packages/workspace/**/*')]`) already covers this without any config change.

### Pattern 4: Process start-time read for PID-reuse-safe orphan kill (D-14)

**What:** Read `/proc/<pid>/stat` field 22 (0-indexed 21) on Linux to get the process start time in clock ticks since boot, and compare it against the value recorded in `lease_owner` at fork time, before signalling on daemon boot (D-13).
**Precision/pitfall:** the value is in **clock ticks** (`sysconf(_SC_CLK_TCK)`, almost always 100 on Linux) since boot, not wall-clock time — comparing it directly against a stored value from a *previous boot* of the host is meaningless; the comparison is only valid within the same boot session, which is exactly D-14's use case (comparing a value recorded and read by the *same* long-running daemon's uptime window). [CITED: /proc/pid/stat field 22 documentation, cross-checked against a second source]
**On Windows (the dev machine, per D-33):** there is no `/proc` filesystem. `processIsAlive` (`packages/workspace/src/worktree/gc.ts:200-212`, already verified in-repo) already handles the *liveness* half using `process.kill(pid, 0)` and treats `EPERM` as alive — this pattern is directly reusable for D-13's "is this PID still running" check, but it answers a **different question** than start-time verification and does not by itself solve PID reuse. Windows start-time reading with no native dependency is a genuine gap: the standard no-native-deps approach is WMI via `wmic process where ProcessId=<pid> get CreationDate` (deprecated in recent Windows builds) or PowerShell `Get-Process -Id <pid> | Select StartTime`, both of which require shelling out — which on the manager side is permitted only through the `@adl/workspace` exec boundary once `fork()` lands there (Pattern 3). **Flag for the planner:** decide whether Windows gets full start-time verification via a PowerShell shell-out (adds an exec call to the boot path) or documented degradation (compare PID liveness only, accepting the residual PID-reuse risk on Windows specifically) — this is the same "Linux is the deployment target, other platforms degrade with a stated reason" posture Phase 2's D-05/D-18 already established, and D-33 only requires the CI *suite* to run and *skip with a visible reason* on Windows, not that every guarantee be equally strong on every platform. [ASSUMED: WMI/PowerShell as the no-native-dep Windows option — not verified against a working code sample this session; treat as a lead]

### Pattern 5: SQLite lease predicate over ISO-8601 TEXT timestamps

**What:** `lease_expires_at < ?` (bound to the reaper tick's `now`) is a plain **lexicographic string comparison** in SQLite, and it is safe *because* every timestamp in this codebase is written with `new Date().toISOString()`, which always produces a fixed-width, zero-padded `YYYY-MM-DDTHH:mm:ss.sssZ` — lexicographic order and chronological order coincide exactly for that one fixed format. [VERIFIED: packages/db/src/checksum.ts:52 — `const appliedAt = new Date().toISOString();` — confirms the format actually used in this codebase] The reaper's tick handler is the one place that should read `Date.now()`/`toISOString()`, then pass the resulting string down as data — mirroring `TransitionCtx.at`'s existing purity discipline (`feature-state.ts:229-230`, verified: *"`at` is a caller-supplied timestamp rather than a clock read... The function is pure"*).
**Pitfall:** this safety property breaks silently if any code path ever writes a *different* timestamp format (e.g., a locale-formatted string, or a format without the trailing `Z`) into `lease_expires_at`. No schema-level guard currently enforces the format (the column is plain `TEXT`); this is worth a runtime assertion or a shared `nowIso()` helper used everywhere a lease timestamp is written, so there is exactly one place the format could drift.

### Pattern 6: `busy_timeout` under a single writer

**What:** `better-sqlite3`'s WAL mode already permits concurrent readers alongside the one writer; a `busy_timeout` (`PRAGMA busy_timeout`, or the `timeout` option to the `Database` constructor) still matters because SQLite's write lock is held for the duration of a transaction, and the reaper tick, the dispatcher, and an API-triggered read can all be mid-transaction simultaneously even with a single logical writer process. [CITED: WAL mode documentation, cross-checked against a second source] Given the manager is explicitly the sole writer (schema.ts's own header comment, verified), a short `busy_timeout` (low hundreds of ms) is sufficient headroom — this is not a multi-process contention scenario, just intra-process transaction interleaving.
**Recommendation:** set `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 2000`, `PRAGMA synchronous = NORMAL` once at `createDb()` time (currently `packages/db/src/migrator.ts:36-42` does not set any pragmas — this is new for Phase 3, since Phases 1–2 never ran the manager's concurrent-access pattern).

### Anti-Patterns to Avoid
- **Killing the forked worker with `SIGTERM` and expecting cleanup to run on Windows:** verified false expectation (Pattern 2). Route the soft-stop over IPC instead.
- **A second `adl/no-direct-spawn` exemption for `@adl/manager`:** the codebase's own eslint comment already names the alternative (Pattern 3).
- **A brand-new "manager config" Zod schema:** `DaemonConfigSchema` already exists and already implements the exact cascade D-36 describes; extend it (§ Don't Hand-Roll).
- **Reading `Date.now()` inside the reaper's per-row loop:** breaks the purity discipline `TransitionCtx` already establishes and makes a single reaper tick see a moving target across rows it is comparing.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Daemon config schema + cascade (D-36) | A new `ManagerConfigSchema`/merge function | **Extend** `DaemonConfigSchema` and `mergeConfig` in `packages/core/src/config/effective-config.ts` (lines 119-130, 246-318, verified this session) | It already implements "clamp for limits, reject for daemon-only fields," exported from `@adl/core/config`'s barrel (`index.ts:47-64`, verified). Add `lease_ttl_ms`, `heartbeat_interval_ms`, `concurrency`, `api.port`, `api.token`, `repos` as new top-level fields on the same schema rather than parallel-inventing the fold logic |
| Effective-config snapshot at lease time (Claude's Discretion item) | A bespoke snapshot builder | `mergeConfig(DEFAULT_CONFIG, daemonConfig, parsedAdlYml)` — already returns a deep-frozen `EffectiveConfig` (verified: `deepFreeze` call at `effective-config.ts:315`) | The function that produces exactly the frozen, resolved object `feature-state.ts`'s versioning rule 3 requires already exists; the only new work is calling it at lease-acquire time and `JSON.stringify`-ing the result into `effective_config_json` |
| Lease-expiry liveness probe for boot-time orphan kill (D-13) | A new PID-liveness check | `processIsAlive` — `packages/workspace/src/worktree/gc.ts:200-212` (verified, already exported from the barrel at `index.ts:120`) | Already handles the `EPERM`-is-alive / `ESRCH`-is-dead distinction correctly and is directly reusable; writing a second implementation is exactly the "two liveness probes that can disagree" risk the code comment there warns against |
| GC scheduling / worktree + scratch-home reclamation (D-34) | Reimplementing the sweep passes | `sweepOrphans` + `sweepScratchHomes` — `packages/workspace/src/worktree/gc.ts` (verified, already exported) | D-34 and the module's own header comment are explicit: "the pass itself must not be re-derived" — the manager's job is binding `FeatureStateLookup` to `featuresRepository.findById` and owning the timer, nothing more |
| Escalation-after-N-crashes counter (D-11) | New crash-counting logic | The same shape as Phase 1's `StageError` consecutive-crash escalation (D-15 in `01-CONTEXT.md`, cited by D-11 itself) | D-11 explicitly names this as "same concept, same shape, no new vocabulary" — reuse the pattern rather than inventing a second counter semantics |
| Platform-gated test skipping (D-33) | A bespoke `if (process.platform !== ...)` per test | `linuxOnly`/`posixOnly` helpers — `packages/workspace/test/helpers/platform.ts` (verified, full file read this session) | Already implements the "skip writes its reason to stderr, a misconfigured Linux run throws rather than silently skips" discipline D-33 requires by extension; a Windows-only or cross-platform-comparison gate for Phase 3's own tests should follow the identical shape (a new `windowsOnly`/`crossPlatformGate` helper beside these, not a divergent pattern) |

**Key insight:** almost every "new" mechanism this phase needs already has a shipped, tested twin from Phases 1–2. The research risk in this phase is not technical novelty — it is a planner re-deriving something that already exists two directories away, which the codebase itself repeatedly warns against in its own comments (`gc.ts`, `index.ts`, `effective-config.ts` all contain "do not reimplement this" language, verified by direct reads this session).

## Runtime State Inventory

Not applicable — Phase 3 is new construction (manager daemon, two new packages), not a rename/refactor/migration. No existing runtime state (stored data, live service config, OS registrations, secrets, build artifacts) is being renamed or moved.

## Common Pitfalls

### Pitfall 1: D-28's grace period is silently defeated on Windows if implemented as an OS signal
**What goes wrong:** `child.kill('SIGTERM')` on the forked worker returns immediately and the process is gone before any cleanup code runs, so "the worker gets a chance to abort its stage and release the worktree cleanly" (D-28) never happens on the platform D-33 requires CI to run on.
**Why it happens:** Windows has no POSIX signal delivery; Node's `child.kill()` emulates a small signal set by unconditional forceful termination. [CITED, verified this session — see Pattern 2]
**How to avoid:** Send the soft-stop as an IPC message (Pattern 2); reserve `SIGKILL`/`kill()` for the unconditional final step, which *is* reliably forceful on both platforms and therefore safe to treat identically everywhere.
**Warning signs:** a Windows CI run where "graceful kill releases the worktree cleanly" passes on Linux and fails (worktree left dirty, or the grace-period test times out) on Windows — this is exactly the D-33 matrix's job to catch, but only if the test asserts on the *effect* of graceful shutdown (clean worktree state) rather than merely on process exit.

### Pitfall 2: Process start time is boot-relative clock ticks, not wall-clock time
**What goes wrong:** comparing a `starttime` value read at one point against a value from a different boot session (e.g., after a host reboot) produces a meaningless comparison — both values are "ticks since this boot," and two different boots have two different epochs.
**Why it happens:** `/proc/<pid>/stat` field 22 documents the value as relative to system boot, not to any absolute epoch. [CITED, cross-checked]
**How to avoid:** the comparison is only meaningful *within* a single daemon uptime session comparing against a value the *same* daemon recorded — which is D-14's actual use case (orphan kill at boot, comparing against what was recorded before the crash/restart the daemon just experienced). Do not attempt to persist or compare start-time values across a full host reboot as if they were portable identifiers.
**Warning signs:** a "PID reuse" test that passes locally but produces false-positive kills after a CI runner reboot between test batches.

### Pitfall 3: `execa`'s `forceKillAfterDelay` pattern does not transfer to the `fork()`'d worker
**What goes wrong:** a planner reading D-28's "execa was chosen partly for `cancelSignal` and `forceKillAfterDelay`, which is exactly this pattern with cross-platform child cleanup already handled" might conclude execa can be reused to manage the worker process's lifecycle.
**Why it happens:** execa's escalation options only apply to processes execa itself spawned; the worker is launched via `child_process.fork()` (per D-01 and CLAUDE.md's explicit "not `worker_threads`" instruction), which returns a plain Node `ChildProcess`, not an execa subprocess. Execa in this codebase is confined to one call site (`packages/workspace/src/exec/run.ts`, verified) that never launches the worker itself.
**How to avoid:** the manager implements its own send-soft-stop / wait / `kill('SIGKILL')` escalation for the worker (a few lines — see Pattern 2's code example), independent of execa. Execa's `forceKillAfterDelay: 5_000` inside `run()` remains relevant only for the *agent CLI / git subprocesses the worker itself launches* during a stage, which is a separate, already-solved layer.
**Warning signs:** an attempt to pass a `ChildProcess` returned by `fork()` into an execa API and getting a type error, or worse, silently wrapping `fork()` in an execa call and losing the IPC channel (`fork()`'s IPC channel is not something execa's generic subprocess API preserves the same way).

### Pitfall 4: A daemon-config schema built from scratch duplicates Phase 1's clamp/reject fold
**What goes wrong:** implementing a second "merge defaults with daemon overrides" function for the new lease/API/repo fields, parallel to the existing `mergeConfig`.
**Why it happens:** the new fields (`lease_ttl_ms`, `concurrency`, `api.port`, `repos`) do not obviously belong to "agents" or "limits" at first glance, tempting a fresh top-level schema.
**How to avoid:** these fields have **no repo-side counterpart at all** — they are daemon-only in the strongest sense (`adl.yml` never mentions concurrency or API ports). They can be added directly as new required/defaulted fields on `DaemonConfigSchema` without needing clamp-or-reject logic in `mergeConfig` at all, since `mergeConfig`'s job is folding *repo-supplied* values against daemon ceilings — these new fields are read straight off the parsed daemon config with no fold step. The existing schema is still the right home; the existing merge function largely does not need to touch them.
**Warning signs:** review turns up a second Zod schema exported from `@adl/manager` that duplicates field names already declared in `@adl/core/config`.

### Pitfall 5: `croner`'s overlap protection is per-schedule, not shared between the reaper and the GC sweep
**What goes wrong:** assuming one `protect: true` setting on a shared scheduler object prevents the reaper tick and the GC sweep from ever running concurrently with *each other*.
**Why it happens:** `croner`'s overlap protection (verified via web search, cross-checked) blocks a *given* scheduled job from re-entering itself while a prior run of the *same* job is still in flight — it says nothing about two *different* scheduled jobs (reaper vs. GC) running at the same wall-clock moment. CONTEXT.md's Claude's Discretion item ("whether the reaper and GC timers share one scheduler object or are two independent timers") is explicitly left open, but this pitfall applies either way: even sharing one `Cron` instance's job list does not implicitly serialize two distinct jobs against each other.
**How to avoid:** if the reaper and the GC sweep must never touch overlapping rows/files, add an explicit mutex or ensure `sweepOrphans`/`sweepScratchHomes`'s own idempotency (already documented as "safe to run concurrently with itself," verified in `gc.ts`'s doc comments) covers the case. Given `sweepOrphans` is explicitly documented as safe under concurrent overlapping passes, this is likely a non-issue in practice — but it should not be assumed true of the reaper's lease-expiry sweep without the same explicit check.

### Pitfall 6: sub-minute croner intervals vs. an unref'd timer for the 10s heartbeat/reaper cadence
**What goes wrong:** using `croner` for the 10s-heartbeat-driven reaper tick when a plain `setInterval` (unref'd so it doesn't keep the process alive during graceful shutdown) is simpler and has none of cron's calendar-expression overhead for a fixed short interval.
**Why it happens:** CLAUDE.md names croner for "polling-fallback schedule" generically, which could read as "use it for every timer in the manager."
**How to avoid:** research question 5 in the brief already anticipates this — croner is well-suited to the GC sweep's longer, calendar-like cadence (and its `protect` option matters there), while the reaper's ~10s tick against a config-driven interval (which tests drive down to ~50ms per D-02) is more naturally an `setInterval`/`setTimeout` loop that reads the current `heartbeat_interval_ms`/`lease_ttl_ms` from daemon config on each tick. Using croner for both is not wrong, but the planner should not assume sub-100ms cron scheduling is croner's sweet spot — it is built for cron-expression scheduling, and a numeric-interval loop is a more natural fit for a value that must go as low as 50ms in tests.
**Warning signs:** test flakiness at the ~50ms interval floor if croner's own scheduling resolution/overhead does not comfortably support that granularity — this should be verified empirically early in implementation rather than assumed.

## Code Examples

### Bearer-token middleware (Hono), matching D-19
```typescript
// Composed from Hono's bearer-auth middleware docs [CITED: hono.dev/docs/middleware/builtin/bearer-auth]
import { bearerAuth } from 'hono/bearer-auth';

app.use('/*', async (c, next) => {
  if (c.req.path === '/health') return next(); // health check is unauthenticated, loopback-only
  return bearerAuth({ token: config.api.token })(c, next);
});
```

### Zod-validated request body
```typescript
// Composed from @hono/zod-validator docs [CITED: github.com/honojs/middleware/tree/main/packages/zod-validator]
import { zValidator } from '@hono/zod-validator';

app.post('/features/:id/pause', zValidator('json', PauseRequestSchema), (c) => {
  const body = c.req.valid('json');
  // ...
});
```
Note: validation middleware is added per-route (not via `app.use()`) so the validated type is inferred correctly at the handler — documented Hono behavior, cited above.

### `@hono/node-server` graceful shutdown, matching D-37's "flush, exit"
```typescript
// Source pattern: Hono's own Node.js getting-started docs [CITED: hono.dev/docs/getting-started/nodejs]
const server = serve({ fetch: app.fetch, port: config.api.port });

process.on('SIGTERM', () => {
  stopDispatch();               // D-37: stop dispatch first
  server.close((err) => {       // stop accepting new connections; let in-flight finish
    if (err) { logger.error(err); process.exitCode = 1; }
  });
  // D-37: SIGTERM workers with the same grace period as adl kill (Pattern 2 above),
  // then flush pino, then exit.
});
```

### Kysely conditional UPDATE with affected-row count (the pattern every lease method follows)
```typescript
// Source: packages/db/src/repository/features.ts:82-109 — verified, already shipped
// New lease methods substitute `.where('lease_token', '=', leaseToken)` for the
// `state_version` predicate, per D-06/D-08.
const result = await db
  .updateTable('features')
  .set({ heartbeat_at: nowIso })
  .where('id', '=', featureId)
  .where('lease_token', '=', leaseToken)
  .executeTakeFirst();
return Number(result.numUpdatedRows) === 1;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|-------------------|---------------|--------|
| `node-cron` for scheduling | `croner` (already CLAUDE.md's pinned choice) | n/a — decided in prior research | `croner` has native overlap protection (`protect`) and no dependencies; not a change this phase needs to research further |
| `wmic` for Windows process metadata | PowerShell `Get-Process`/CIM cmdlets | `wmic` deprecated in recent Windows Server/11 builds | Relevant only if the planner chooses full Windows start-time verification (Pattern 4) — worth checking the actual CI runner's Windows build supports whichever is chosen |
| Manual SIGTERM/SIGKILL escalation | execa's `cancelSignal`/`forceKillAfterDelay` for execa-spawned children | Already in place, `packages/workspace/src/exec/run.ts` | Does not extend to the `fork()`'d worker (Pitfall 3) — the manager needs its own small escalation helper |

**Deprecated/outdated:** none identified as directly relevant beyond the `wmic` note above.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | Windows start-time verification for D-14's PID-reuse guard is best done via a PowerShell shell-out (`Get-Process -Id <pid> \| Select StartTime`) if the planner chooses not to degrade to liveness-only on Windows | Pattern 4 | Low — this is presented as an open decision for the planner either way, not a locked recommendation; if the mechanism is wrong the fallback (liveness-only, documented degradation) is already the fully-supported alternative |
| A2 | `croner`'s scheduling resolution comfortably supports the ~50ms test-driven interval floor from D-02 | Pitfall 6 | Medium — if croner cannot reliably fire sub-100ms, the reaper's test suite (which needs `lease_ttl_ms ≈ 200ms`, D-31/D-02) would need to fall back to `setInterval` regardless of which library is chosen for the longer GC cadence; verify empirically in an early implementation task rather than assuming |
| A3 | The concurrency-3 CI scenario test (D-32) is achievable within Vitest's default per-file process isolation (`pool: 'forks'`) without additional configuration | § Vitest Patterns | Low — Vitest 4's own docs confirm `forks` is the default pool; if the project's `vitest.config.ts` overrides this workspace-wide, the scenario test would need an explicit `pool: 'forks'` override in its own config, which is a one-line fix, not a design problem |

**If this table is empty:** N/A — see entries above; all three are low-to-medium risk and none blocks planning, but each should be spot-checked early in execution.

## Open Questions

1. **Windows PID-reuse guard strength (D-14 on Windows)**
   - What we know: `processIsAlive` already gives liveness on both platforms; Linux has a precise start-time comparison via `/proc`.
   - What's unclear: whether Windows should get an equivalent start-time check (via a shell-out, adding exec-boundary surface to the boot path) or a documented, weaker guarantee.
   - Recommendation: default to documented degradation on Windows (liveness-only, explicit README note, following the Phase 2 D-05/D-18 precedent exactly), and treat full Windows start-time verification as a stretch goal only if the boot-path exec call is judged low-risk. This does not block D-33's CI requirement, which is about the recovery *test suite* running (with visible skips where a guarantee genuinely has no Windows subject), not about every guarantee being platform-symmetric.

2. **Where the reaper/GC "share one scheduler or two independent timers" decision lands**
   - What we know: CONTEXT.md leaves this to the planner explicitly; croner's overlap protection is per-job, not shared (Pitfall 5).
   - What's unclear: whether a single `Cron` scheduler instance managing both jobs offers any advantage over two independent timers, given they do not need mutual exclusion by any decision recorded so far.
   - Recommendation: two independent timers (reaper via `setInterval`, GC via `croner`) is the simpler default given Pitfall 6's cadence mismatch; a shared scheduler object buys nothing here since croner does not serialize distinct jobs against each other regardless.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| Node.js | manager/CLI runtime | ✓ | v22.23.2 [VERIFIED: `node --version`, this session] | — (matches CI matrix floor; CI also exercises 24) |
| git | worktree operations (already Phase 2 territory) | ✓ | 2.49.0.windows.1 [VERIFIED: `git --version`, this session] | — |
| pnpm | workspace install/build | not on bare PATH in this shell | — | Activated via `corepack enable && corepack prepare pnpm@11.22.0` per `.github/workflows/ci.yml:40-47` (verified) — not a real gap, just not pre-activated in this probe shell |
| Windows runner in CI | D-33's cross-platform recovery suite | ✗ — **not yet in `.github/workflows/ci.yml`** [VERIFIED: full file read this session — matrix is `runs-on: ubuntu-latest`, `node-version: [22, 24]` only, no `os` dimension] | — | **No fallback — this is a concrete, required task for this phase's plan**: add a Windows leg to the CI matrix (`runs-on: windows-latest` or an `os` matrix dimension). D-33 states "the Linux job already exists... so this is a matrix entry" — true, but the matrix entry itself does not exist yet and must be added, not merely relied upon. |

**Missing dependencies with no fallback:**
- Windows CI leg — must be added in this phase's plan (see above); this is infrastructure work, not a research gap.

**Missing dependencies with fallback:**
- pnpm on bare PATH — non-issue, corepack activation is already the established CI pattern.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.10 (pinned) [VERIFIED: pnpm-workspace.yaml catalog] |
| Config file | `vitest.config.ts` (root, project-based) + new `packages/manager/vitest.config.ts`, `packages/cli/vitest.config.ts` following the existing per-package pattern [VERIFIED: packages/workspace/vitest.config.ts read this session] |
| Quick run command | `pnpm --filter @adl/manager test` / `pnpm --filter @adl/cli test` |
| Full suite command | `pnpm -r test && vitest run --project root` (existing root script, verified in `package.json`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| EXEC-01 | Manager owns detection/queue/state/config/credentials/accounting | integration | `pnpm --filter @adl/manager test -- daemon.test.ts` | ❌ Wave 0 |
| EXEC-02 | Worker runs as separate OS process holding one lease | integration (real `fork()`) | `pnpm --filter @adl/manager test -- worker-supervisor/fork.test.ts` | ❌ Wave 0 |
| EXEC-03 | Killed worker detected, feature recovered, spend retained | scenario (D-32's SIGKILL leg) | `pnpm --filter @adl/manager test -- scenario/crash-recovery.test.ts` | ❌ Wave 0 |
| EXEC-04 | Zombie worker's stale write rejected on fencing token | integration (D-31's scripted-pause-past-TTL) | `pnpm --filter @adl/manager test -- lease/fencing.test.ts` | ❌ Wave 0 |
| EXEC-05 | Concurrency configurable, defaults to 1 | unit + scenario (D-32's concurrency-3 leg) | `pnpm --filter @adl/manager test -- scheduler/dispatcher.test.ts` | ❌ Wave 0 |
| EXEC-06 | State/rounds/spend/transcripts survive daemon restart | integration (D-37's startup gate) | `pnpm --filter @adl/manager test -- daemon-restart.test.ts` | ❌ Wave 0 |
| OBS-01 | Maintainer sees what every feature is doing now | e2e (CLI → HTTP → real state) | `pnpm --filter @adl/cli test -- status.test.ts` | ❌ Wave 0 |
| OBS-03 | Maintainer can pause work | integration (D-26's drain semantics) | `pnpm --filter @adl/manager test -- control/pause.test.ts` | ❌ Wave 0 |
| OBS-04 | Maintainer can kill one/repo/all | integration (D-28's SIGTERM-then-SIGKILL) | `pnpm --filter @adl/manager test -- control/kill.test.ts` | ❌ Wave 0 |

Every file in this map is new — `@adl/manager` and `@adl/cli` do not exist yet (verified: `packages/` currently contains only `core`, `db`, `plugin-sdk`, `workspace`).

### Sampling Rate
- **Per task commit:** package-scoped quick run (`pnpm --filter @adl/manager test`)
- **Per wave merge:** `pnpm -r test && vitest run --project root`
- **Phase gate:** full suite green on **both** CI matrix legs (Linux existing, Windows to be added — see § Environment Availability) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/manager/package.json` + `vitest.config.ts` — package does not exist yet
- [ ] `packages/cli/package.json` + `vitest.config.ts` — package does not exist yet
- [ ] `packages/manager/test/scenario/` — the D-32 concurrency-3 scenario test harness (temp SQLite DB per test, real `fork()`, deterministic `SIGKILL`, restart-mid-flight)
- [ ] `packages/workspace/test/helpers/platform.ts`-equivalent for Phase 3's own Windows-vs-Linux gated assertions (a `windowsOnly`/cross-platform-comparison helper beside the existing `linuxOnly`/`posixOnly`, following the identical visible-skip discipline)
- [ ] `.github/workflows/ci.yml` Windows matrix leg (see § Environment Availability — required, not optional, for D-33)

## Vitest Patterns for Multi-Process Integration Tests

- **`pool: 'forks'` is Vitest 4's default** [CITED, cross-checked via two independent sources: vitest.dev/config/pool and community comparisons] — each test *file* already runs in its own OS process. This is coincidentally exactly the isolation direction this phase's own subject matter needs (testing real `fork()`), but it is Vitest's file-level isolation, **separate from** the test code's own act of calling `child_process.fork()` on the worker entry point — the two are unrelated fork() calls at different layers and do not conflict.
- **Real forked-child tests:** the D-30 approach (real worker entry point, scripted stage runner injected) means the integration tests fork the *actual* `worker-entry/index.ts`, with an env var or IPC-provided flag selecting the scripted runner. `child.kill('SIGKILL')` from the test to simulate D-32's crash leg is deterministic and immediate on both platforms (verified — `SIGKILL` is the one signal execa's own docs confirm works identically cross-platform).
- **Temp SQLite per test:** `createDb(filePath)` already takes a plain file path (verified, `packages/db/src/migrator.ts:36`); a per-test temp directory (`fs.mkdtempSync`) plus `migrateToLatest(db, migrationsDir)` gives full test isolation with no shared state — the same pattern the existing `checksum-guard.test.ts` already implies is in use (migration tests deliberately use a real file per the migrator's own doc comment, verified).
- **Port collisions:** bind the test API server to port `0` (OS-assigned ephemeral port) and read the assigned port back from the `http.Server` handle `@hono/node-server`'s `serve()` returns, rather than a fixed test port — avoids CI flakiness from parallel test files racing for the same port.
- **Platform-gated skip discipline (D-33):** reuse `linuxOnly`/`posixOnly`'s shape (`packages/workspace/test/helpers/platform.ts`, fully verified this session) for any Phase 3 assertion that has no meaning on one platform — e.g., if Open Question 1 resolves to "Windows gets liveness-only," the stronger start-time assertion should `skip` on Windows with a stated reason via the same `SKIP_PREFIX`/`process.stderr.write` mechanism, not a silent `it.skipIf`.

## Security Domain

`security_enforcement: true`, `security_asvs_level: 1` in `.planning/config.json` — this section is required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | yes | Bearer token comparison for the HTTP API (D-19) — **must use a constant-time comparison** (`crypto.timingSafeEqual`), not `===`, to avoid a timing side-channel on the token even though the API is loopback-only |
| V3 Session Management | no | Stateless bearer-token auth per request; no session concept in this phase |
| V4 Access Control | yes | Lease fencing (D-06) is the access-control-equivalent for this phase: a worker that does not hold the current `lease_token` cannot mutate feature state, enforced at both the application layer (IPC message check) and the data layer (SQL predicate) |
| V5 Input Validation | yes | Zod for every HTTP request body, the daemon config file, and the IPC message union — already the established project convention (`adl.yml`, verdicts) |
| V6 Cryptography | yes (narrow) | The bearer token itself should be generated with `crypto.randomBytes`/similar at `adl daemon init`-equivalent time, never a predictable value; comparison must be constant-time (see V2) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|------------------------|
| Zombie worker resubmits a stale result after its lease expired | Tampering | D-06's dual fence — IPC-level rejection + SQL `WHERE lease_token = ?` predicate (already the phase's own success criterion 3) |
| Timing attack against the bearer token comparison | Information Disclosure | `crypto.timingSafeEqual`, not `===` or `String.prototype.includes` |
| A crashed/malicious worker floods the IPC channel with malformed messages | Denial of Service | Zod-validate every inbound IPC message before acting on it; an unparseable message should be treated the same way CORE-06 treats a malformed agent verdict — an infrastructure failure, not trusted data |
| `adl kill --all` invoked accidentally via a scripted `--yes` bypass | Repudiation (of the "who killed everything" question) | D-29 already requires interactive confirmation without `--yes`; ensure the actor (`CLI` vs. an eventual dashboard user) is recorded on the resulting `feature_events` row via the existing `actor` field on `TransitionCtx` (already present, verified `feature-state.ts:227-228`) |
| A worker's IPC message spoofs a heartbeat for a lease it no longer holds | Spoofing | The IPC handler must check the sender is the currently-registered child process for that feature id (the `fork()` return value itself is the trust boundary — there is exactly one `ChildProcess` object per active lease, and messages arrive only from the channel the manager itself opened, so cross-worker spoofing over IPC is structurally impossible unless the manager conflates two workers' channels in its own bookkeeping) |

## Sources

### Primary (HIGH confidence)
- `packages/core/src/state/feature-state.ts`, `transition.ts` — read in full this session
- `packages/db/src/schema.ts`, `repository/features.ts`, `migrator.ts`, `checksum.ts` — read in full this session
- `packages/workspace/src/index.ts`, `worktree/gc.ts`, `exec/run.ts`, `test/helpers/platform.ts` — read in full this session
- `packages/core/src/config/effective-config.ts`, `adl-yml.ts`, `index.ts` — read in full this session
- `eslint.config.js` — targeted reads this session, including the load-bearing line-21 comment
- `.github/workflows/ci.yml` — read in full this session (confirms no Windows leg exists yet)
- `pnpm-workspace.yaml`, root `package.json`, per-package `package.json` files — read this session (version ground truth)
- `npm view <pkg> version` for hono, @hono/node-server, commander, pino, croner, zod, yaml, execa, better-sqlite3, kysely, ulid, vitest — run this session
- `gsd-tools query package-legitimacy check` for hono, @hono/node-server, commander, pino, croner — run this session

### Secondary (MEDIUM confidence)
- [Node.js child_process docs](https://nodejs.org/api/child_process.html) — event ordering, Windows signal emulation, cross-checked against [nodejs/node#12378](https://github.com/nodejs/node/issues/12378)
- [execa termination docs](https://github.com/sindresorhus/execa/blob/main/docs/termination.md) — `forceKillAfterDelay` Windows no-op, cross-checked against the Node.js signal-emulation finding above
- [Hono bearer-auth middleware](https://hono.dev/docs/middleware/builtin/bearer-auth), [Hono Node.js getting-started](https://hono.dev/docs/getting-started/nodejs), [@hono/zod-validator](https://github.com/honojs/middleware/tree/main/packages/zod-validator)
- [Vitest pool config](https://vitest.dev/config/pool), [Vitest improving-performance guide](https://vitest.dev/guide/improving-performance)
- WAL mode / busy_timeout — cross-checked across two independent SQLite-concurrency sources

### Tertiary (LOW confidence, flagged for validation)
- `/proc/pid/stat` field-22 semantics — single-source web search, standard and well-known but not independently re-derived from the kernel docs this session
- Windows start-time-without-native-deps (WMI/PowerShell) — not verified against a working code sample; recorded as Assumption A1
- `croner`'s sub-100ms scheduling resolution — not independently benchmarked; recorded as Assumption A2

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version is either already shipped in the repo (verified by reading `package.json` files) or confirmed against the live npm registry this session, matching CLAUDE.md's pins exactly
- Architecture: HIGH — the fencing, lease-repository, and GC-scheduling patterns are extensions of code already read in full this session, not novel design
- Cross-platform signal semantics (Pitfalls 1 & 3): MEDIUM-HIGH — the core claim (Windows SIGTERM emulation is forceful, not catchable) is corroborated by two independent sources (Node's own docs/issue tracker, and execa's own documented Windows limitation) but not verified by running code on this session's Windows machine
- Pitfalls (process start-time, croner resolution): LOW-MEDIUM — flagged explicitly in the Assumptions Log; recommend an early, cheap implementation spike to confirm before the plan depends on either

**Research date:** 2026-08-19
**Valid until:** 30 days for the stack/version claims (fast-moving npm ecosystem, though these are already pinned in CLAUDE.md and unlikely to need re-verification); the cross-platform signal-handling findings are Node.js/Windows platform facts and are stable for the life of the phase
