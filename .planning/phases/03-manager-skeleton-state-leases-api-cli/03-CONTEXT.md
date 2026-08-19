# Phase 3: Manager Skeleton — State, Leases, API, CLI - Context

**Gathered:** 2026-08-19
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers the **manager daemon**: a long-running control plane that owns the lease queue, supervises separate-process workers, recovers from worker crashes and its own restarts, exposes an HTTP API, and ships the `adl` CLI. Its correctness is proven end-to-end with a **fake worker and zero AI in the loop** — recovery semantics are cheapest to test before an agent's nondeterminism is confounding the signal.

**In scope:** lease acquire/renew/expire, the reaper, worker fork + IPC, fencing against zombie writes, crash recovery policy, concurrency limits, daemon config, repo registration, schema-version startup gate, graceful shutdown, HTTP API, `adl` CLI (`status`, `pause`, `resume`, `kill`, `gc`, `daemon`), and wiring Phase 2's `sweepOrphans` to a schedule and a verb.

**Out of scope:** feature detection (Phase 5), any agent backend (Phase 4), live transcript streaming (Phase 4 — the SSE seam is reserved, not built), spend display (Phase 6, OBS-05), budget enforcement (Phase 6), the dashboard (Phase 17), forge operations (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Lease Timing & The Heartbeat Path

- **D-01:** The **worker heartbeats over the `fork()` IPC channel and the manager writes `heartbeat_at`** — the worker never opens the database. This keeps `schema.ts`'s "the manager is the only writer" claim literally true rather than aspirational, keeps `@adl/db` out of the worker's dependency graph (which pnpm's strict `node_modules` then enforces structurally, per Phase 1 D-24), and makes a dead IPC channel a liveness signal in its own right. The accepted cost: a worker wedged with a live channel still looks alive, which is what the TTL exists to catch. — **Reversibility:** costly — reversing it gives the worker a database dependency and a second writer into the SQLite file, which invalidates the single-writer reasoning that the whole lease-table-instead-of-Redis choice rests on.

- **D-02:** **Lease TTL 30s, heartbeat interval 10s** — 3× headroom absorbs a GC pause or a slow disk without a false expiry, and agent turns are minutes long so a 10s beat is negligible overhead. Both are daemon-config keys (`lease_ttl_ms`, `heartbeat_interval_ms`) so tests can drive them to ~200ms/50ms and CI stays fast; a validation rule enforces **TTL ≥ 3× interval**. — **Reversibility:** reversible.

- **D-03:** Expiry is detected by a **periodic reaper tick** sweeping `WHERE lease_expires_at < now` and applying the `lease_expired` transition. Recovery must happen without anyone asking — a lazy check evaluated only when a lease is next requested leaves a crashed feature sitting expired indefinitely at concurrency 1 with nothing else queued, which fails success criterion 2. This is the same scheduling shape as the D-15 GC sweep being wired up in this phase. — **Reversibility:** reversible.

- **D-04:** The manager **also treats an unexpected `child.on('exit')` as immediate lease expiry**, applying the same `lease_expired` transition. Recovery on the common crash case becomes milliseconds rather than 30 seconds, and criterion 2's "within the lease TTL" becomes a ceiling rather than the actual latency. The reaper remains the backstop for what `exit` structurally cannot cover: a manager that itself restarted (no child handle to listen on) and a worker wedged but alive. — **Reversibility:** reversible — the reaper path must work regardless, so this is a fast path over a guaranteed one.

- **D-05:** A worker whose lease renewal fails, or whose IPC channel dies, **self-terminates immediately** — treats it as fatal, aborts the current stage, exits non-zero. Defence in depth: fencing at the database is the guarantee, but a worker that stops on its own never races a replacement worker inside the same worktree, so the file-level conflict never arises in the first place. — **Reversibility:** reversible.

### Fencing — Rejecting the Zombie's Write

- **D-06:** Because D-01 routes results through IPC, the "stale write" of success criterion 3 arrives as a **message**, not an `UPDATE`. The fence is therefore applied in **both places**: the manager rejects a result message whose `lease_token` does not match the current row, **and** every lease-scoped `UPDATE` carries `WHERE lease_token = ?`. The message check yields a clean, loggable rejection with context; the SQL predicate makes the guarantee structural, so criterion 3 stays true even if a future code path bypasses the message handler. — **Reversibility:** costly — dropping the SQL predicate later means the guarantee lives only in manager logic, and re-establishing it means auditing every write path added since.

- **D-07:** `lease_token` is a **ULID minted per lease acquisition**. `ulid` is already the project's primary-key scheme (chosen over `nanoid`/UUIDv4 for lexicographic sortability), so this introduces no new concept; tokens are greppable in logs and need no coordination to be unique. Explicitly **not** reusing `state_version` as the fence: it moves on every transition including ones the valid lease holder itself makes, so a legitimate worker's second write would be fenced out unless it re-read the row each time. — **Reversibility:** costly — the token is persisted on the feature row and referenced by every lease-scoped write; changing its shape is a migration plus a change to the IPC message contract.

- **D-08:** `leaseToken` is a **required, non-optional parameter on every lease-scoped repository method**, so omitting it is a compile error rather than a runtime bug. This deliberately mirrors Phase 1's `TransitionResult.expectedStateVersion`, which exists so that "a state write cannot be issued without its guard" — same philosophy, same shape, one mental model for a contributor. Rejected the `LeaseHandle` object alternative because it fights the flat named-function repository surface D-28 chose deliberately. — **Reversibility:** costly — relaxing it to optional later silently un-guards every call site that then forgets it.

- **D-09:** A rejected stale result is **dropped, logged at `warn` (feature id, presented token, current token), and counted**, with the counter surfaced in the status view. It is expected-but-notable, not an error — Phase 1 established that `InvalidTransition` is "returned, never thrown" precisely because a benign race and a real bug are indistinguishable at the call site and an exception forecloses the caller's judgement. Silent dropping was rejected: criterion 3's test would have nothing to assert on but absence, and a real fencing bug would be invisible in production. — **Reversibility:** reversible.

### Crash Recovery Policy

- **D-10:** A feature whose worker died mid-`gating` resumes at the **same round, replaying the pipeline from stage 0**. The round is preserved so the round ceiling cannot be cheated by crashing; the pipeline re-runs because stage verdicts are evidence about a specific commit, and trusting a half-walked pipeline whose earlier gates ran against state that cannot be fully attested to is exactly the silently-wrong-but-green failure this project exists to prevent. Accepted cost: re-running gates that already passed. — **Reversibility:** reversible — `current_stage_index` is still on the row, so resuming mid-pipeline later is a policy change, not a schema change.

- **D-11:** `crash_count` **escalates the feature after 3 consecutive crashes** (`unrecoverable` → `escalated`), and **resets on any successful round**. Without a ceiling, a reproducibly-crashing feature recovers forever and burns budget silently. This mirrors Phase 1's D-15, which already bounds non-transient `StageError` looping with a consecutive counter escalating at a small default — same concept, same shape, no new vocabulary. — **Reversibility:** reversible.

- **D-12:** Recovery **re-attaches the existing worktree** via `features.workspace_handle` rather than rebuilding it. Criterion 2's "committed work preserved" is then true because nothing deleted it, not because a restore step ran correctly. Phase 2's D-14 tears down worktrees only on *terminal* state, so a crash is deliberately not teardown, and this decision is the other half of that one. — **Reversibility:** reversible.

- **D-13:** On daemon startup the manager **expires every lease and kills any still-running orphan worker before requeueing**. Deterministic clean slate: no orphan from the previous daemon can race a replacement worker inside the same worktree — the one scenario D-04's `child.on('exit')` fast path structurally cannot cover, because the new manager has no child handle for a process it did not spawn. Re-adopting orphans was rejected: `fork()` IPC channels do not survive the parent, so it would need an entire second control channel. — **Reversibility:** reversible.

- **D-14:** `lease_owner` records the worker's **PID *and* process start time**, and the boot-time orphan kill **verifies the start time still matches before signalling**. PIDs are reused, so a stale PID may belong to an unrelated process by the time the daemon restarts; start time is the standard discriminator and makes the kill safe by construction. This matters disproportionately because ADL is installed on other teams' infrastructure — a control plane that SIGKILLs an unrelated process on restart is not shippable. Reading process start time is platform-specific, which Phase 2's D-05 already accounted for by naming Linux the deployment target with documented degradation elsewhere. — **Reversibility:** costly — `lease_owner`'s content is written by the manager and read by the boot path; widening it later is easy, but the safety property is the reason it exists.

### Concurrency

- **D-15:** Concurrency is a **global cap (default 1) with an optional per-repo cap (default unset)**. The global limit protects the host — each in-flight feature is a process, a worktree, and eventually a paid agent turn — while the optional per-repo limit stops one busy repository starving the others. EXEC-05 literally asks only for the global number, and the roadmap's "run CI at concurrency 3" reads as a single global value; the per-repo cap is the additive escape hatch. — **Reversibility:** reversible.

- **D-16:** Lowering the concurrency cap while features are in flight **drains** — the cap governs *dispatch*, never existing leases, and nothing in flight is destroyed. Lowering a limit can therefore never lose committed work or burn spend for nothing, and `adl kill` remains the deliberate tool for stopping now. This is also the same check shape Phase 6 needs for budgets, which must be "checked before the next agent turn is dispatched, never after it has been paid for". — **Reversibility:** reversible.

- **D-17:** When a slot opens, the **oldest queued feature by id wins** — ULIDs are lexicographically sortable, so `ORDER BY id` is FIFO for free with no extra column, which is precisely why `ulid` was chosen over `nanoid` and UUIDv4. Starvation-free and predictable; it is already the ordering `listByState` uses. Round-robin across repositories can layer on later if the per-repo cap proves insufficient. — **Reversibility:** reversible.

### CLI ↔ Daemon Transport

- **D-18:** **Every CLI verb goes through the HTTP API** — no direct SQLite reads, even for `adl status`. One code path, one authorization point, and the Phase 17 dashboard consumes the identical surface rather than a second one grown later. It also keeps the single-writer/single-reader story intact and makes the CLI work against a remote daemon for free. Accepted cost: `adl status` fails when the daemon is down, which is honest — a daemon-less answer would be a stale snapshot presented as current. — **Reversibility:** costly — adding a direct-DB read path later gives `@adl/cli` an `@adl/db` dependency and two read paths that can disagree.

- **D-19:** The API **binds `127.0.0.1` by default and is protected by a shared bearer token in the daemon config**, read by both the daemon and the CLI. Loopback means the network is not the v1 threat surface; the token means that enabling a non-loopback bind later (for the dashboard) does not ship an unauthenticated control plane, and does not become a breaking change for adopters' scripts. — **Reversibility:** one-way in the safe direction — shipping without auth and adding it later breaks every adopter script that already exists; shipping with it costs nothing to relax.

- **D-20:** The API is **REST-ish JSON over resources**: `GET /features`, `GET /features/:id`, `POST /features/:id/pause|kill`, `POST /control/pause`, `GET /health`. **SSE is reserved, not built** — Phase 4's `adl logs -f` slots into the same Hono server with no new transport, which is part of why Hono was chosen (`streamSSE` built in, trivial raw-body access). Curl-able and obvious to a contributor. OpenAPI generation deliberately declined — Hono was chosen over Fastify partly by declining that story. — **Reversibility:** costly — this is the contract the Phase 17 dashboard and Phase 4 log streaming both build against.

- **D-21:** **`@adl/cli` and `@adl/manager` are separate packages**, shipping **one `adl` binary** with an `adl daemon` verb. Matches D-25's "scaffold real packages, no placeholders" and keeps the CLI structurally unable to reach past HTTP into manager internals — pnpm's strict `node_modules` (D-24) makes that a resolve-time failure rather than a review convention. One installed binary is a simpler install story than two. — **Reversibility:** costly — the package split is a published dependency boundary; merging or splitting later touches every import.

### `adl status` Output

- **D-22:** The **manager resolves the stage name** by joining `current_stage_index` against the pipeline in `effective_config_json` (snapshotted at lease time), rendering e.g. `gating 2/4 (test)`. The lifecycle stays ignorant of stage identity, so EXEC-07 is intact, while the operator still sees a name. `feature-state.ts` explicitly anticipates this — "the dashboard reads `current_stage_index` against the pipeline plus the `stage_attempts` table" — and calls it strictly richer than a state name would have been. — **Reversibility:** reversible.

- **D-23:** Default columns: **feature, repo, state, stage, round, age, worker**. That is criterion 1's three required fields plus the context that makes them actionable — which repository, how long it has been in this state (the stuck-detector), and whether a worker holds it. **Spend is deliberately absent**: OBS-05 is mapped to Phase 6, and with no AI in the loop every row would render zero. — **Reversibility:** reversible.

- **D-24:** **Human table by default, `--json` for machines.** The criterion-1 test asserts on structured JSON fields rather than string-matching a table that any cosmetic change breaks. Formatting stays at the `picocolors` level — no TUI, consistent with the stack's rejection of Ink for a status table. — **Reversibility:** reversible.

- **D-25:** With the daemon down, `adl status` **fails with a clear message and a non-zero exit**: `Cannot reach the ADL daemon at 127.0.0.1:PORT. Is it running? Try: adl daemon start`. Auto-starting the daemon was rejected — a status command with a side effect that spawns a long-running process is surprising and hard to undo. — **Reversibility:** reversible.

### Pause & Kill

- **D-26:** **`adl pause` stops dispatch; in-flight features finish their current round and then park.** Pause is a brake on new work, not a kill: nothing paid-for is discarded and the worktree is left at a coherent commit boundary. This is the same drain semantics as D-16's concurrency lowering, so the maintainer learns one rule. `adl kill` remains the tool for stopping now. — **Reversibility:** reversible.

- **D-27:** A killed feature lands in **`paused`**, not `escalated` or `queued`. Kill stops the process; it does not judge the feature. `paused` already has a `resume` edge back to `queued`, so the maintainer decides what happens next, nothing is silently discarded, and no false "this failed" signal is recorded. Using `escalated` was rejected because it is the state limits and unrecoverable errors use — conflating "ADL gave up" with "a human pressed stop" pollutes the escalation signal Phase 6 builds on. — **Reversibility:** reversible.

- **D-28:** Workers are stopped with **SIGTERM, then SIGKILL after a configurable grace period (~10s default)**, giving the worker a chance to abort its stage and release the worktree cleanly before being killed unconditionally. `execa` was chosen partly for `cancelSignal` and `forceKillAfterDelay`, which is exactly this pattern with cross-platform child cleanup already handled. — **Reversibility:** reversible.

- **D-29:** Scoping is **`adl kill <feature-id>` / `--repo <id>` / `--all`, with `--all` requiring interactive confirmation** (bypassable via `--yes` for scripts). Positional argument for the common single-feature case, explicit flags for wider blast radii, and a confirmation proportionate to an operation that can stop every in-flight run on the host. The same shape applies to `adl pause`. — **Reversibility:** reversible.

### Fake Worker & The No-AI Proof

- **D-30:** The double is the **real worker entry point with a scripted stage runner injected** — the actual process, the actual IPC handshake, the actual heartbeat loop and lease plumbing, with only the thing that would call an agent swapped for a scripted no-op. Everything criteria 2, 3 and 4 are about (fork, IPC, lease, crash, fence) is therefore the production path under test. A standalone fake-worker script was rejected because it would re-implement the IPC handshake, meaning the tests prove the *fake's* plumbing works while the part most likely to be wrong goes untested. An `--fake` flag on the shipped binary was rejected as a foot-gun on a real installation. Phase 4 then replaces one injected module rather than deleting a test harness. — **Reversibility:** reversible.

- **D-31:** The criterion-3 zombie is built by having the **scripted worker pause past the TTL with self-termination suppressed for that scenario, then report with its now-stale token**. With `lease_ttl_ms` at ~200ms in tests, the manager has meanwhile reaped and re-leased, so the token no longer matches — exercising both halves of D-06's fence (the IPC check and the SQL predicate) end-to-end, with no process trickery. — **Reversibility:** reversible.

- **D-32:** The roadmap's "run CI at concurrency 3" is **one scenario test**: three concurrent features, one worker `SIGKILL`ed, and the daemon restarted mid-flight. It asserts at the end that all three features are accounted for, committed work is intact, the spend ledger is unchanged by the crash, no orphan worktrees remain, and no feature was ever double-leased. This is the roadmap's own reasoning — "a crashed worker plus a restarted daemon is concurrency 2 in practice" — and it is the interaction that separate single-failure tests each individually miss. — **Reversibility:** reversible.

- **D-33:** The recovery suite **runs on both Linux and Windows in CI**. Signals, PID/start-time lookup, and `fork()` child cleanup all differ meaningfully by platform, and the recovery guarantees are the entire phase. The Linux job already exists from Phase 2's D-21, so this is a matrix entry rather than new infrastructure; Windows is the development machine, so a Windows-green suite keeps local iteration honest instead of silently skipping the phase's core guarantees. Phase 2's rule stands: any platform-gated test **skips with a visible reason**, never passes vacuously. — **Reversibility:** reversible.

### Manager Lifecycle, Config & Repo Registration

- **D-34:** Phase 2's deferred D-15 is discharged as: **a manager timer runs `sweepOrphans` periodically, and `adl gc` triggers it on demand.** Phase 2's D-20 already split mechanism from policy — `@adl/workspace` exposes `listManagedWorktrees()` as the mechanism with no `@adl/db` dependency, and `sweepOrphans` is the policy half reaching feature state through an **injected `FeatureStateLookup`**; the manager binds that lookup and owns the trigger. **The pass itself must not be re-derived.** The GC schedule is a separate, much longer interval than the lease reaper's; the two sweeps share a scheduling mechanism, not a cadence.

  **The same schedule must also call `sweepScratchHomes`.** `packages/workspace/src/index.ts` says so explicitly at the export site — "Phase 3's manager owns the schedule that must call this beside `sweepOrphans`; it cannot reach it until it is on the barrel (WR-06)". Scratch-home GC is therefore a named Phase 3 deliverable, not an inference. — **Reversibility:** reversible.

- **D-35:** Watched repositories are **declared in the daemon config and reconciled into the `repos` table at startup**. Configuration is already the trust anchor — D-22 makes backend and credential selection daemon-only precisely because repo-supplied files are untrusted — so repository identity belongs there too. Declarative, reviewable, version-controllable, and it survives a rebuild of the database. A `adl repo add` CLI verb was rejected for v1: it turns the watched-repo set into DB state with no file to review. — **Reversibility:** reversible — a CLI verb can be added later as an editor of the same file.

- **D-36:** The **daemon config is a separate file from repo-level `adl.yml`**, holding concurrency caps, `lease_ttl_ms`/`heartbeat_interval_ms`, API port and token, and watched repositories. D-22 already defines the cascade as `defaults ← daemon config ← repo adl.yml` **with daemon-enforced clamps**, so the two files carry different authority over the same settings; giving them the same name or location would invite exactly the confusion those clamps exist to prevent. Same format and parser as `adl.yml` (the `yaml` package, Zod-validated like every other contract in the project) so contributors learn one parsing path. — **Reversibility:** costly — the daemon config path and schema become an operator-facing convention adopters have deployed.

- **D-37:** Manager startup implements **`feature-state.ts`'s versioning rule 2 in full**: refuse to run against a schema newer than the daemon, **copy the database file before auto-migrating** an older one, then reconcile repositories (D-35) and expire leases (D-13). Shutdown on SIGTERM is graceful: stop dispatch, SIGTERM workers with the same grace period as `adl kill` (D-28), flush, exit. This is the first phase with a daemon to hold either; criterion 4 is literally about surviving restart; and rule 2 was written to prevent one bad upgrade corrupting a team's history — cheapest to get right before anyone has installed it. — **Reversibility:** one-way — the schema gate protects databases ADL does not own. Shipping without it means a version of the daemon exists in the wild that will open a newer schema optimistically, and no later fix can repair a database that version already corrupted.

### Claude's Discretion

The following were explicitly left to the planner and executor:

- Exact JSON field names and response envelope shape for the HTTP API
- Log line formats and pino child-logger binding keys (beyond `{ featureId, round, agent }` already named in the stack)
- Table column widths, alignment, and colour choices in `adl status`
- Exact wording of user-facing error messages (beyond D-25's daemon-down message, which is specified)
- Test file layout and naming within each package
- Whether the reaper and GC timers share one scheduler object or are two independent timers (D-34 fixes only that their cadences differ)
- The concrete IPC message union between manager and worker — its typed contract is the planner's to design, constrained by D-01 (heartbeat), D-06 (results carry `lease_token`) and D-05 (worker self-terminates)
- How `effective_config_json` is assembled and snapshotted at lease time — the *requirement* is fixed by Phase 1's versioning rule 3; the mechanism is not

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition and requirements
- `.planning/ROADMAP.md` § "Phase 3: Manager Skeleton — State, Leases, API, CLI" — goal, the five success criteria, and the Notes paragraph fixing manager/worker ownership and the concurrency-3 CI instruction
- `.planning/REQUIREMENTS.md` — EXEC-01 … EXEC-06, OBS-01, OBS-03, OBS-04 (this phase's nine requirement IDs)

### Phase 1 contracts this phase must satisfy (do not re-derive)
- `packages/core/src/state/feature-state.ts` — `FEATURE_STATES`, `FeatureEvent` union, `TransitionCtx`, `TransitionResult.expectedStateVersion`, and the three versioning rules in the header comment (rule 2 is D-37, rule 3 is the config snapshot)
- `packages/core/src/state/transition.ts` — the pure transition function the manager must route every state change through
- `packages/db/src/schema.ts` — `FeaturesTable` lease columns (`lease_owner`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `state_version`, `crash_count`), and the header comment asserting the manager is the only writer (D-01 preserves this)
- `packages/db/src/repository/features.ts` — the existing narrow repository surface; `compareAndSwapState` is the optimistic-concurrency pattern the new lease methods must match. **Lease acquire/renew/expire methods do not exist yet — this phase adds them.**
- `.planning/phases/01-core-contracts/01-CONTEXT.md` — D-15 (consecutive-error escalation, the model for D-11), D-22 (config cascade + daemon clamps, the basis for D-36), D-24/D-25 (pnpm strict workspaces, real packages only), D-28/D-29 (`@adl/db` ownership, table set)

### Phase 2 contracts and the explicit carry-forward
- `.planning/phases/02-workspace-the-exec-boundary/02-CONTEXT.md` § "Deferred Ideas" — **the D-15 carry-forward bullet naming this phase as the place `sweepOrphans` gets a schedule and a CLI verb, and instructing the planner not to re-derive the pass**
- `packages/workspace/src/index.ts` — the exported surface the manager consumes; note `run`/`ExecOwner` is the only process-launch path (WORK-02, enforced by the `adl/no-direct-spawn` lint rule)
- `packages/workspace/src/worktree/gc.ts` — `sweepOrphans`, the pass D-34 wires up
- `.planning/phases/02-workspace-the-exec-boundary/02-CONTEXT.md` — D-05/D-18 (Linux privilege drop and platform degradation, context for D-14 and D-33), D-14 (teardown only on terminal state, the other half of D-12), D-20 (GC mechanism/policy split, the basis for D-34), D-21 (Linux CI and visible-skip rule, extended by D-33)

### Downstream phases this phase's contracts constrain
- `.planning/ROADMAP.md` § "Phase 4" — `adl logs -f` and live transcripts land on the SSE seam D-20 reserves
- `.planning/ROADMAP.md` § "Phase 6" — OBS-05 spend display (deliberately excluded from D-23) and the budget gate whose "check before dispatch" shape D-16 mirrors

### Stack constraints
- `./.claude/CLAUDE.md` § Technology Stack — `child_process.fork()` for the manager/worker seam (**not** `worker_threads`), Hono 4.13.2 + `@hono/node-server`, commander 15, execa 10 (`cancelSignal`, `forceKillAfterDelay`), pino 10, croner 10, ulid 3, `yaml` 2.9, better-sqlite3 13 + Kysely; and the "What NOT to Use" table (no Redis/BullMQ, no Express, no Ink, no pm2)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`packages/db/src/repository/features.ts`** — `compareAndSwapState` already implements the version-guarded `UPDATE ... WHERE state_version = ?` pattern returning a boolean rather than throwing. The new lease methods (`acquireLease`, `renewLease`, `expireLease`, and the lease-scoped result writes) follow this exact shape, with `leaseToken` as a required parameter (D-08).
- **`packages/core/src/state/transition.ts`** — the pure transition function. Every manager state change (`lease_acquired`, `lease_expired`, `pause`, `resume`, `unrecoverable`) routes through it and writes the returned `FeatureEventEffect` in the same transaction as the state update.
- **`packages/workspace/src/worktree/gc.ts` → `sweepOrphans`** (line 109) — already built and deterministically invokable, taking a `GcDeps` with an injected `FeatureStateLookup` and, notably, **no clock**. D-34 wires it to a timer and a verb; it must not be reimplemented. The same module also exports `sweepScratchHomes` (which D-34 requires on the same schedule) and **`processIsAlive`** — the latter is directly reusable for D-13/D-14's boot-time orphan kill, so the manager should bind it rather than write a second liveness probe.
- **`packages/workspace/src/exec/run.ts` → `run`** — the only sanctioned process launch. Note the `adl/no-direct-spawn` lint rule exempts only `packages/workspace/**`, so the manager's `fork()` of the worker needs an explicit decision about whether it goes through this path or earns a second exemption — **flag for the planner**.
- **`packages/db/src/migrator.ts` and `checksum.ts`** — the migration runner and the checksum guard D-37's startup gate builds on. Migrations `0001`–`0004` already exist; the lease columns are already present, so this phase likely needs **no new migration** for leases.

### Established Patterns
- **Hand-written schema + bidirectional drift test** (`schema.ts` / `test/schema-drift.test.ts`) — any new column added this phase must be added to `FeaturesTable`, `FEATURES_COLUMNS`, and `TABLE_COLUMNS`, or the build and the drift test fail. This is the mechanism that will catch a forgotten column for D-14's `lease_owner` content change.
- **Compile-time exhaustiveness assertions** — `FEATURE_STATES`/`FEATURE_EVENT_KINDS`/`TRANSITION_CTX_FIELDS` each pair a frozen runtime list with a type-level `Exclude<>` check. New unions introduced this phase (the IPC message union, CLI verb set) should follow the same pattern.
- **Return, don't throw, for expected-but-notable outcomes** — `InvalidTransition` and `compareAndSwapState`'s boolean. D-09's stale-result handling follows this.
- **Zod as the source of truth, types via `z.infer`** (D-26) — the daemon config schema, HTTP request/response bodies, and the IPC message union are all Zod-first.
- **`DEFERRED_TABLES`** asserts the absence of tables not yet needed, keeping "not built yet" distinguishable from "forgotten". If this phase needs no new tables, that assertion stays untouched — a useful signal in review.

### Integration Points
- **`@adl/manager` (new)** — owns the reaper, the GC schedule, the scheduler/dispatcher, worker supervision, the Hono HTTP server, and startup/shutdown. Depends on `@adl/db`, `@adl/core`, `@adl/workspace`.
- **`@adl/cli` (new)** — depends on **neither** `@adl/db` nor `@adl/manager` internals; speaks HTTP only (D-18, D-21). This boundary is enforced by pnpm strict `node_modules` plus the existing `no-restricted-imports` dependency-graph rule from D-27.
- **Worker entry point (new)** — the forked process. Depends on `@adl/core` and `@adl/workspace`; **must not depend on `@adl/db`** (D-01). This is a lint/dependency-graph rule worth adding alongside the package, in the spirit of D-27.
- **`meta.schema_version`** — read at manager startup by D-37's gate, before any other database access.

</code_context>

<specifics>
## Specific Ideas

- The daemon-down error message is specified verbatim: `Cannot reach the ADL daemon at 127.0.0.1:PORT. Is it running? Try: adl daemon start`, exit code 1.
- `adl status` stage column renders as `gating 2/4 (test)` — state, position, pipeline length, resolved stage name.
- The concurrency-3 scenario test's closing assertions are enumerated in D-32 and should become acceptance criteria verbatim: all three features accounted for, committed work intact, spend ledger unchanged by the crash, zero orphan worktrees, no feature ever double-leased.
- Config validation must reject `lease_ttl_ms < 3 × heartbeat_interval_ms` (D-02).
- Tests drive `lease_ttl_ms ≈ 200` and `heartbeat_interval_ms ≈ 50` — real timers, small values, no fake clock (D-02, D-31).

</specifics>

<deferred>
## Deferred Ideas

- **Round-robin scheduling across repositories** — D-17 chose FIFO by ULID; round-robin can layer on later if the optional per-repo cap (D-15) proves insufficient in practice. Not a v1 need with a default concurrency of 1.
- **`adl repo add` / `remove` / `list` CLI verbs** — D-35 makes the daemon config the source of truth for watched repositories. A future CLI verb should *edit that file*, not write to the `repos` table directly, or the two sources diverge.
- **OpenAPI document for the HTTP API** — declined in D-20 for this phase. If the Phase 17 dashboard or third-party clients make a published contract worthwhile, it is additive over the REST-ish surface.
- **Non-loopback API bind for remote dashboard access** — D-19 ships loopback-only but includes the bearer token specifically so this can be enabled later without shipping an unauthenticated control plane.
- **Resuming mid-pipeline after a crash** — D-10 chose replay-from-stage-0. `current_stage_index` is still persisted, so this is a future policy change rather than a schema change. Revisit if gate re-runs become expensive once real agent-backed gates land (Phase 7+).
- **macOS CI** — D-33 covers Linux and Windows. macOS has no stated deployment role; add if contributor demand appears.
- **Spend column in `adl status`** — deliberately excluded by D-23; belongs with OBS-05 in Phase 6.

</deferred>

---

*Phase: 3-Manager Skeleton — State, Leases, API, CLI*
*Context gathered: 2026-08-19*
