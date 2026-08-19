# Phase 3: Manager Skeleton — State, Leases, API, CLI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-19
**Phase:** 3-manager-skeleton-state-leases-api-cli
**Areas discussed:** Lease timing & heartbeat path, Fencing enforcement, Crash recovery policy, Concurrency scoping, CLI ↔ daemon transport, `adl status` output, Pause & kill semantics, Fake worker & the no-AI proof, plus four follow-up gaps (GC wiring, repo registration, daemon config, manager lifecycle)

All eight initially-offered gray areas were selected for discussion, then a further four gaps were surfaced and explored before writing context.

---

## Lease Timing & Heartbeat Path

### Who writes `features.heartbeat_at`?

| Option | Description | Selected |
|--------|-------------|----------|
| Worker → IPC → manager writes | Keeps schema.ts's single-writer claim true; no `@adl/db` in the worker; dead IPC is itself a liveness signal | ✓ |
| Worker writes to SQLite directly | Survives a wedged manager; proves liveness of the working process | |
| Both — IPC primary, direct write fallback | Most robust; most machinery | |

**User's choice:** Worker → IPC → manager writes
**Notes:** Surfaced because `schema.ts` explicitly asserts "the manager is the only writer" while the worker is the process that knows it is alive — a direct contradiction that had to be resolved before anything else in the phase.

### Lease TTL and heartbeat interval

| Option | Description | Selected |
|--------|-------------|----------|
| 30s TTL / 10s heartbeat | 3× headroom for GC pauses; sub-30s detection | ✓ |
| 120s TTL / 30s heartbeat | Near-zero false-expiry risk; slow criterion-2 test | |
| Configurable, with those defaults | Test-friendly; adds config surface | |

**User's choice:** 30s TTL / 10s heartbeat
**Notes:** The follow-up question established that the values are *also* config-overridable, so this and the third option converged.

### How does the manager notice an expired lease?

| Option | Description | Selected |
|--------|-------------|----------|
| Periodic reaper tick | Recovery happens unbidden; same shape as the D-15 GC sweep | ✓ |
| Lazy — checked on next lease request | Simpler, deterministic; can strand a crashed feature at concurrency 1 | |
| Reaper tick + on every lease request | Belt and braces | |

**User's choice:** Periodic reaper tick

### Worker behaviour on failed lease renewal

| Option | Description | Selected |
|--------|-------------|----------|
| Self-terminate immediately | Defence in depth; no two processes in one worktree | ✓ |
| Keep working, let fencing reject the write | Exercises the fence in real operation; real file conflicts | |
| Finish current stage, then exit without writing | Middle ground; still overlaps for a stage | |

**User's choice:** Self-terminate immediately

### Follow-up: does the manager use `child.on('exit')`?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — exit event expires the lease immediately | Millisecond recovery; reaper stays as backstop | ✓ |
| No — TTL expiry is the only path | One path to test | |

**User's choice:** Yes
**Notes:** Raised because the IPC decision hands the manager a faster signal than the TTL for free. TTL becomes a ceiling rather than the observed latency.

### Follow-up: how does the criterion-2 test avoid a 30s wait?

| Option | Description | Selected |
|--------|-------------|----------|
| Daemon config override, defaults 30s/10s | Real values ship; CI fast; doubles as an operator knob | ✓ |
| Inject a clock into the reaper | Fully deterministic; skips real timer scheduling | |
| Both | Config for integration, clock for unit tests | |

**User's choice:** Daemon config override

---

## Fencing Enforcement

### Where is the fence applied?

| Option | Description | Selected |
|--------|-------------|----------|
| Both — IPC message carries the token, DB write guards on it | Loggable rejection *and* a structural guarantee | ✓ |
| IPC message check only | Sufficient today; guarantee lives in manager logic | |
| DB predicate only | Unbypassable; poor rejection context | |

**User's choice:** Both
**Notes:** Reframed at the start of this area — because the worker never writes to SQLite (D-01), criterion 3's "stale write" arrives as an IPC message, not an `UPDATE`. That changed what the fence had to guard.

### Token shape

| Option | Description | Selected |
|--------|-------------|----------|
| ULID minted per lease acquisition | Reuses the existing PK scheme; sortable, greppable | ✓ |
| Monotonic integer counter | Classic fencing token; rejects *older*, not merely *different* | |
| Reuse `state_version` | One concept; but it moves on the lease holder's own writes | |

**User's choice:** ULID per acquisition

### How the token is plumbed

| Option | Description | Selected |
|--------|-------------|----------|
| Required parameter on every lease-scoped repository method | Omission is a compile error; mirrors `expectedStateVersion` | ✓ |
| A `LeaseHandle` object owning the writes | Impossible to call without a lease; fights the flat repository surface | |
| Manager-side guard before the repository | Least churn to `@adl/db`; relies on one checkpoint | |

**User's choice:** Required repository parameter

### Handling a rejected stale result

| Option | Description | Selected |
|--------|-------------|----------|
| Drop it, log at warn, count it | Expected-but-notable; mirrors `InvalidTransition` being returned not thrown | ✓ |
| Drop silently | Less noise; invisible fencing bugs | |
| Record as a `feature_event` | Durable audit; but a rejection is not a transition | |

**User's choice:** Drop, log at warn, count

---

## Crash Recovery Policy

### Where does a feature crashed mid-`gating` resume?

| Option | Description | Selected |
|--------|-------------|----------|
| Same round, replay pipeline from stage 0 | Round ceiling not cheated; no trust in unattestable prior verdicts | ✓ |
| Same round, resume at `current_stage_index` | Cheapest; trusts pre-crash `stage_attempts` rows | |
| Restart the round entirely | Safest; burns a developer turn per crash | |

**User's choice:** Same round, replay from stage 0

### What does `crash_count` drive?

| Option | Description | Selected |
|--------|-------------|----------|
| Escalate after N consecutive crashes, default 3 | Mirrors D-15's consecutive-error counter; bounds a poison pill | ✓ |
| Record only — surface it, never act | Visibility without policy | |
| Escalate after configurable N | Same plus a config knob | |

**User's choice:** Escalate after N=3

### The worktree on recovery

| Option | Description | Selected |
|--------|-------------|----------|
| Re-attach the existing worktree | Preservation by not deleting; complements Phase 2 D-14 | ✓ |
| Rebuild from the branch | Guaranteed clean tree; loses uncommitted work | |
| Re-attach, hard-reset to last commit | Clean tree, cheaper than rebuild | |

**User's choice:** Re-attach

### Orphaned children on daemon restart

| Option | Description | Selected |
|--------|-------------|----------|
| Expire every lease at startup, kill orphans by recorded PID | Deterministic clean slate; covers what `child.on('exit')` cannot | ✓ |
| Let the reaper expire them naturally | No extra startup logic; up to 30s dead time per restart | |
| Try to re-adopt orphans | Loses nothing; needs a whole second control channel | |

**User's choice:** Expire all + kill orphans

---

## Concurrency Scoping

### Scope of the limit

| Option | Description | Selected |
|--------|-------------|----------|
| Global cap + optional per-repo cap | Host protection plus anti-starvation | ✓ |
| Global only | Exactly what EXEC-05 asks; one repo can monopolise | |
| Per-repo only | Fair across repos; no bound on total host load | |

**User's choice:** Global + optional per-repo

### Lowering the cap while work is in flight

| Option | Description | Selected |
|--------|-------------|----------|
| Drain — in-flight finishes, no new dispatch | Never loses work; same shape Phase 6 needs for budgets | ✓ |
| Kill the excess immediately | Literal enforcement; duplicates `adl kill` | |
| Reject the change while over cap | Ignores stated intent | |

**User's choice:** Drain

### Queue ordering

| Option | Description | Selected |
|--------|-------------|----------|
| Oldest first by feature id (ULID = creation order) | FIFO for free; already the `listByState` ordering | ✓ |
| Round-robin across repos, oldest within | Fairest; more scheduler state | |
| Fewest crashes first, then oldest | Avoids poison-pill blocking; risks starvation | |

**User's choice:** Oldest by ULID

### Follow-up: PID reuse hazard in `lease_owner`

| Option | Description | Selected |
|--------|-------------|----------|
| PID + process start time, verified before killing | Standard PID-reuse discriminator; safe by construction | ✓ |
| PID + worker ULID verified over IPC | An orphan from a dead parent has no IPC channel | |
| PID only, accept the risk | Simplest; can SIGKILL an unrelated process | |

**User's choice:** PID + start time
**Notes:** Raised as a direct consequence of the boot-time orphan-kill decision. Weighted heavily by ADL running on other teams' infrastructure.

---

## CLI ↔ Daemon Transport

### Transport for read-only verbs

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP API for everything | One code path; dashboard reuses it; honest failure when down | ✓ |
| HTTP for mutations, direct SQLite read for status | Works with the daemon down; two read paths that can disagree | |
| Unix socket / named pipe | No port; awkward on Windows, forecloses remote dashboard | |

**User's choice:** HTTP for everything

### Bind address and auth

| Option | Description | Selected |
|--------|-------------|----------|
| Bind 127.0.0.1; shared token in daemon config | Loopback now, safe non-loopback later without a breaking change | ✓ |
| Loopback, no auth in v1 | Simplest; risky the day someone binds 0.0.0.0 | |
| Loopback + token + runtime port-discovery file | Handles ephemeral ports and multiple daemons | |

**User's choice:** Loopback + config token

### API shape

| Option | Description | Selected |
|--------|-------------|----------|
| REST-ish JSON over resources, SSE reserved for logs | Curl-able; Phase 4 logs slot into the same server | ✓ |
| Single RPC-style `POST /command` | Tiny surface; no resource URLs for the dashboard | |
| REST-ish plus a published OpenAPI document | Real contract; extra machinery Hono was chosen to avoid | |

**User's choice:** REST-ish resources, SSE reserved

### Packaging

| Option | Description | Selected |
|--------|-------------|----------|
| `@adl/cli` + `@adl/manager`; one `adl` binary with an `adl daemon` verb | Matches D-25; CLI structurally cannot reach manager internals | ✓ |
| Separate `adl` and `adl-daemon` binaries | Unambiguous systemd target; two things to install | |
| One `@adl/manager` package containing both | Fewest packages; erodes the boundary pnpm was chosen to enforce | |

**User's choice:** Separate packages, one binary

---

## `adl status` Output

### Rendering the stage column

| Option | Description | Selected |
|--------|-------------|----------|
| Resolve the name from the snapshotted pipeline in the manager | Operator sees a name; lifecycle stays stage-ignorant (EXEC-07 intact) | ✓ |
| Raw index only — `gating 2/4` | Zero coupling; maintainer must open adl.yml | |
| Name only — `gating (test)` | Most readable; loses pipeline progress | |

**User's choice:** Resolve the name in the manager
**Notes:** `feature-state.ts` explicitly anticipates this approach and argues it is strictly richer than a per-stage state name would have been.

### Default columns

| Option | Description | Selected |
|--------|-------------|----------|
| feature, repo, state, stage, round, age, worker | Criterion 1's fields plus what makes them actionable | ✓ |
| Add a spend column now | Cheap to add; renders zero, and OBS-05 is Phase 6 | |
| Add crash_count and last-error | Surfaces the escalation policy; zero in the healthy case | |

**User's choice:** feature, repo, state, stage, round, age, worker

### Output format

| Option | Description | Selected |
|--------|-------------|----------|
| Human table by default, `--json` for machines | Stable assertions for the criterion test; readable default | ✓ |
| Human table only | One path; brittle string-matching tests | |
| JSON by default, `--pretty` for humans | Pipes into jq; worst default for the maintainer | |

**User's choice:** Table by default, `--json` available

### Behaviour with the daemon down

| Option | Description | Selected |
|--------|-------------|----------|
| Fail with a clear message and non-zero exit | Honest; a daemon-less answer would be stale-presented-as-current | ✓ |
| Fall back to the DB, labelled stale | Reintroduces the rejected second read path | |
| Auto-start the daemon | Convenient; a status command with a large side effect | |

**User's choice:** Fail clearly, exit non-zero

---

## Pause & Kill Semantics

### Pause and in-flight work

| Option | Description | Selected |
|--------|-------------|----------|
| Stop dispatching; in-flight finishes its round, then parks | Brake not kill; same drain rule as lowering concurrency | ✓ |
| Park everything immediately, mid-round | Literal; discards partial work | |
| Stop dispatch only; in-flight runs all remaining rounds | Least disruptive; doesn't feel like a pause | |

**User's choice:** Finish current round, then park

### State a killed feature lands in

| Option | Description | Selected |
|--------|-------------|----------|
| `paused` — parked, resumable by a human | Uses an existing edge; records no false failure | ✓ |
| `escalated` | Loud; conflates "ADL gave up" with "a human pressed stop" | |
| `queued` | Treats kill as restart; re-dispatches what was just killed | |

**User's choice:** `paused`

### Stop mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| SIGTERM, then SIGKILL after a grace period | Clean release first; execa's `forceKillAfterDelay` is this exactly | ✓ |
| SIGKILL immediately | Deterministic; leaves debris on every deliberate stop | |
| IPC shutdown message, then SIGTERM, then SIGKILL | Most graceful; three stages to test | |

**User's choice:** SIGTERM → SIGKILL with grace

### Verb scoping

| Option | Description | Selected |
|--------|-------------|----------|
| `adl kill <id>` / `--repo <id>` / `--all`, `--all` confirms | Natural reading; confirmation proportionate to blast radius | ✓ |
| Same flags, no confirmation | Scriptable; one typo stops everything | |
| A separate `adl kill-all` verb | Unmistakable; duplicates the verb, and repeats for pause | |

**User's choice:** Flags with confirmation on `--all`

---

## Fake Worker & The No-AI Proof

### Shape of the double

| Option | Description | Selected |
|--------|-------------|----------|
| Real worker entry point, scripted stage runner injected | Production path under test; Phase 4 swaps one module | ✓ |
| Separate fake-worker script | Isolated; re-implements the plumbing most likely to be wrong | |
| `--fake` flag on the real binary | Real plumbing; a foot-gun on a real installation | |

**User's choice:** Real entry point, injected stage runner

### Constructing the zombie

| Option | Description | Selected |
|--------|-------------|----------|
| Scripted worker pauses past the TTL, reports with a stale token | Exercises both halves of the fence end-to-end | ✓ |
| Call the result handler directly with a stale token | Instant and deterministic; skips the out-of-process path | |
| Both — unit the predicate, integration the live zombie | Most confidence; two tests for one criterion | |

**User's choice:** Live scripted zombie
**Notes:** Framed by the tension that workers self-terminate on failed renewal (D-05), so a zombie has to be constructed deliberately by suppressing that for the scenario.

### The concurrency-3 CI run

| Option | Description | Selected |
|--------|-------------|----------|
| One scenario: 3 features, one SIGKILLed, daemon restarted mid-flight | Tests the interaction the roadmap note is specifically about | ✓ |
| Run the whole suite at concurrency 3 | Broad; slower and flakier, nothing asserts a concurrency property | |
| Concurrency-3 test plus a separate restart test | Names which failure broke; misses the interaction | |

**User's choice:** One combined scenario test

### CI platforms

| Option | Description | Selected |
|--------|-------------|----------|
| Linux and Windows | Signals/PID/child-cleanup differ by platform; dev machine stays honest | ✓ |
| Linux only, skip visibly elsewhere | Stated deployment target; local suite would skip the core guarantees | |
| Linux, Windows, macOS | Widest; a third job for a platform with no deployment role | |

**User's choice:** Linux and Windows

---

## Follow-Up Gaps (surfaced after the eight selected areas)

### Wiring Phase 2's deferred GC

| Option | Description | Selected |
|--------|-------------|----------|
| Manager timer runs it periodically + `adl gc` on demand | Exactly what D-15 asked for; D-20's split already supports it | ✓ |
| Fold into the reaper tick | One timer; conflates cadences that should differ | |
| `adl gc` only, no schedule | Deterministic; reopens what the backstop was written to close | |

**User's choice:** Timer + on-demand verb
**Notes:** Discovered by reading Phase 2's Deferred Ideas, which names this phase explicitly and instructs the planner not to re-derive the pass. Post-write verification of `packages/workspace/src/index.ts` surfaced that `sweepScratchHomes` must ride the same schedule — recorded in CONTEXT.md D-34.

### Repository registration

| Option | Description | Selected |
|--------|-------------|----------|
| Declared in daemon config, reconciled into `repos` at startup | Config is already the trust anchor per D-22; reviewable and versioned | ✓ |
| `adl repo add <path>` CLI verb writing to the DB | Discoverable; watched set becomes unreviewable DB state | |
| Both | Covers both workflows; two sources of truth to reconcile | |

**User's choice:** Daemon config, reconciled at startup

### Daemon config location and format

| Option | Description | Selected |
|--------|-------------|----------|
| A separate daemon config file, distinct from `adl.yml` | D-22's cascade gives them different authority; same parser, different file | ✓ |
| Same format, different filename/location | One mental model; similar-looking files with different authority | |
| JSON instead of YAML | No YAML ambiguity; no comments, second format in the project | |

**User's choice:** Separate file, same YAML parser

### Manager startup and shutdown

| Option | Description | Selected |
|--------|-------------|----------|
| Full versioning rule 2 now, plus graceful shutdown | First phase with a daemon; criterion 4 is about surviving restart | ✓ |
| Schema gate only, shutdown deferred | Protects the DB; every restart takes the crash path | |
| Graceful shutdown only, gate deferred | Clean restarts; ships into databases ADL does not own | |

**User's choice:** Both — full rule 2 and graceful shutdown

---

## Claude's Discretion

Explicitly deferred to the planner and executor (recorded in CONTEXT.md `<decisions>` § Claude's Discretion):

- Exact JSON field names and HTTP response envelope shape
- Log line formats and pino child-logger binding keys
- `adl status` table widths, alignment, colour
- Error message wording other than D-25's specified daemon-down message
- Test file layout and naming within each package
- Whether the reaper and GC timers share a scheduler object
- The concrete manager↔worker IPC message union, constrained by D-01, D-05 and D-06
- The mechanism for assembling and snapshotting `effective_config_json` at lease time

## Deferred Ideas

Recorded in CONTEXT.md `<deferred>`:

- Round-robin scheduling across repositories (if the per-repo cap proves insufficient)
- `adl repo add`/`remove`/`list` verbs — must edit the config file, not the `repos` table
- OpenAPI document for the HTTP API
- Non-loopback API bind for remote dashboard access (the token exists so this stays safe)
- Resuming mid-pipeline after a crash (revisit when gates become paid agent turns, Phase 7+)
- macOS CI
- Spend column in `adl status` (OBS-05, Phase 6)

No scope creep was raised during discussion — every area stayed inside the phase boundary.
