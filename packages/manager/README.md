# `@adl/manager` — the control plane

The manager is the long-running daemon: the one process that owns the lease
queue, watches over forked worker processes, exposes the HTTP API, and is the
only thing that ever writes to the database. This document is written for the
person who runs it, not the person who reads its source.

---

## What the daemon owns

Everything that must be singular in a self-hosted install lives here, not in
a worker:

- **The lease queue.** Every feature is either `queued`, held by exactly one
  lease, or in a terminal/paused/escalated state — the manager is the single
  writer of `features.state`, and a worker never opens the database itself
  (D-01). This is what keeps "the manager is the only writer" a literal
  claim rather than an aspiration.
- **Worker supervision.** The manager `fork()`s one Node child process per
  in-flight feature, tracks its heartbeats, and recovers from it dying —
  whether that death is a clean exit, a crash, or the manager's own restart.
- **The lease reaper.** A periodic tick reclaims any lease whose holder has
  gone silent past `lease_ttl_ms`, and a forked child's own `exit` event is a
  fast path over the same recovery — usually milliseconds, not the full TTL.
- **The HTTP API.** `GET /features`, `POST /features/:id/pause|resume|kill`,
  `POST /control/pause|resume|kill|gc|shutdown`, `GET /health`. Every route
  except `/health` requires the bearer token.
- **Config, credentials, and accounting.** The daemon config file (below),
  the concurrency caps, and — in a later phase — round/budget accounting all
  live here, never in a worker's environment.

Since M05 it also owns three things this section used to list as "later
phases":

- **Feature detection.** A croner poll re-scans the watched repository's default
  branch, filters to folders that are undeveloped _and_ authored by someone with
  write access, and enqueues what is left. It starts only when a forge is
  configured — see the config file below.
- **The round loop.** `develop → gates → aggregate → advance or send back`, one
  forked worker per stage, with the decision itself pure and the writes
  transactional. A feature mid-pipeline is re-dispatched from the stage it is on
  and its effective configuration is **not** re-merged, so editing `adl.yml`
  cannot change a running feature's pipeline.
- **Forge operations.** Push, open a draft change request at round 1, upsert one
  sticky comment per role, and promote to ready only when every gate is green.
  **ADL never merges** — that is a build property, not a policy (FORGE-10).

Budget enforcement joined that list during M06: the per-feature budget, the
fleet-wide spend cap, stalemate detection and provider-failure backoff are all
checked here, before dispatch rather than after it.

What it still does **not** own: the reviewer agent (M07), the behaviour tester
(M08), third-party harnesses (M13), and webhook detection (M10).

Two boundaries inside the worker are worth knowing about, because both are
lint-enforced rather than conventional. A worker **never opens the database**
(`adl/worker-entry-no-db`) — everything it learns arrives on the `fork()` IPC
channel, and everything it reports leaves the same way. And a **gate** — any
module under `src/worker-entry/gates/` — additionally cannot reach the
transcript store, the prompt builder, or the assign message itself
(`adl/gate-fresh-context`), so it works from the feature's spec, the diff, and
the repository, and structurally cannot inherit the developer agent's session or
reasoning (ROLE-03).

For the end-to-end proofs: `test/scenario/concurrency-crash-restart.test.ts`
covers the queue and recovery guarantees with a scripted worker and zero AI in
the loop; `test/scenario/command-gate-loop.test.ts` drives a real send-back and
recovery through the real stage runner; `test/tracer/draft-cr-wiring.test.ts`
runs detection through to a real draft change request.

---

## The daemon config file

Location: **`.adl/daemon.json`**, relative to the directory the daemon is
started from (override with `--config <path>` on the CLI, or
`StartDaemonOptions`'s caller in code). JSON, not YAML — deliberately
different from `adl.yml`: the daemon is this file's first writer (it mints a
bearer token into it on first run), and a machine-written secret belongs in a
machine-written file format, not a hand-edited one.

**First run is zero-config.** If `.adl/daemon.json` does not exist, the
daemon creates it with a freshly minted `api.token`
(`crypto.randomBytes(32)`, hex-encoded) and owner-only permissions
(`0600`/`0700` on POSIX). An existing file's token is **never** regenerated.

**On Windows, the owner-only permissions above are a documented no-op**:
POSIX mode bits have no Windows equivalent, so the file's actual access
control there is whatever NTFS ACLs the containing directory already
grants. Do not rely on `.adl/daemon.json`'s file mode for confidentiality
on a Windows host — protect the directory itself instead.

| Key                     | Meaning                                                                                                                                                                                                                                                        | Default                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `lease_ttl_ms`          | How long a worker may go without heartbeating before the reaper reclaims its lease.                                                                                                                                                                            | `30000`                   |
| `heartbeat_interval_ms` | How often a worker heartbeats over IPC. Must satisfy `lease_ttl_ms >= 3 * heartbeat_interval_ms` — a tighter ratio produces spurious lease expiries that look exactly like worker crashes.                                                                     | `10000`                   |
| `worker_stop_grace_ms`  | How long a worker gets to react to a `soft_stop` message before the manager escalates to `SIGKILL`.                                                                                                                                                            | `10000`                   |
| `concurrency.global`    | The cap on features in flight at once, across every watched repository.                                                                                                                                                                                        | `1`                       |
| `concurrency.per_repo`  | An optional additional cap per repository, so one busy repo cannot starve the others.                                                                                                                                                                          | unset (no per-repo limit) |
| `api.host`              | The HTTP API's bind address. A non-loopback value is accepted and logged, never rejected — see the auth note below for why that is safe.                                                                                                                       | `127.0.0.1`               |
| `api.port`              | The HTTP API's port.                                                                                                                                                                                                                                           | `4173`                    |
| `api.token`             | The bearer token every non-`/health` route requires. Minted on first run if absent.                                                                                                                                                                            | minted                    |
| `gc.interval_ms`        | How often the worktree/scratch-home GC backstop sweeps. Two orders of magnitude longer than `heartbeat_interval_ms` by design — the two sweeps share a scheduling mechanism, never a cadence.                                                                  | `1800000` (30 min)        |
| `repos`                 | The watched repositories, declared here and reconciled into the database at every startup (a row present in the database but absent from this list is left alone, never deleted — a config edit is not a delete instruction).                                  | `[]`                      |
| `limits`                | A per-field **ceiling** on what a repository's own `adl.yml` may request (e.g. `max_rounds`), not a value that reaches a run directly.                                                                                                                         | daemon defaults           |
| `agents`                | The daemon's own backend/model selection per role. A repository's `adl.yml` can never set `backend` — a repo-supplied value is recorded and discarded (D-22, credential selection). It may request `model`, but only a value `repo_model_allowlist` names.     | unset                     |
| `repo_model_allowlist`  | The models a watched repository may request through `agents.<role>.model`. **Absent means none** — note this is the opposite polarity to `global_budget_usd`, where absent means no cap applies. Anything else is discarded and reported as `not_allowlisted`. | unset (nothing permitted) |

**The API bind and the bearer token.** The API binds `127.0.0.1` by default.
The bearer token exists precisely so that widening the bind later (for a
future dashboard) does not ship an unauthenticated control plane and does
not break an adopter's existing scripts — the token is required either way.
Token comparison is constant-time (`crypto.timingSafeEqual`), and the token
never appears in a URL, an argv, or a log line.

---

## Startup sequence

In order, every time the daemon starts:

1. **The schema-version gate.** The daemon reads `meta.schema_version` from
   the database before touching anything else.
   - If the stored version is **newer** than this daemon's own, the daemon
     **refuses to run** and writes nothing. This is the case that matters
     most: a database this daemon does not understand is left completely
     alone.
   - If the stored version is **older** (or the database is fresh and
     unseeded), the daemon **copies the database file** beside itself
     (`<path>.pre-<version>-<timestamp>`, kept forever — there is no delete
     path) before applying any migration. The copy is always taken, on
     every upgrade, with no configuration to disable it.
   - If the stored version already matches, this is a no-op.

   **What to do if you see a refusal:** the daemon is telling you its own
   code is older than the database it was pointed at. Upgrade the daemon to
   a version that recognizes that schema version before running it against
   this database again. Do not attempt to "fix" the database directly —
   the refusal is the safe outcome, not an error to work around.

   **These pre-migration copies are never deleted by the daemon.** This is
   deliberate: the startup sequence contains no destructive filesystem
   operations, so every prior upgrade — however old — stays recoverable.
   The cost is real: on a long-lived installation that is upgraded
   repeatedly, these copies accumulate without bound next to the database
   file, each roughly the size of the database at the time it was taken.
   An operator is responsible for periodically reviewing and removing old
   `*.pre-*` copies once confident they will not need to roll back to
   them — no `adl db prune-copies` verb or equivalent exists as of this
   phase.

2. **Repository reconciliation.** Every repository named under `repos` in
   the daemon config is upserted into the database. A repository present in
   the database but no longer in the config is left in place and logged,
   never deleted.

3. **The boot orphan kill.** Any worker process still running from a
   _previous_ daemon process — one this daemon has no `ChildProcess` handle
   for, because it did not fork it — is signalled, but only when it can be
   attributed safely. See the Windows degradation below: this is where it
   applies.

4. **Unconditional lease expiry.** Every lease still held at boot is expired
   and its feature requeued, regardless of whether step 3 could actually
   signal the process holding it. This is what makes a restart a
   deterministic clean slate: no held lease survives a restart, ever.

5. **The global pause restore (G-03-3).** The daemon reads the persisted
   `global_pause` flag and seeds the dispatch brake with it, before the API
   binds and before the first dispatch tick runs. A database that has never
   had a global pause set boots exactly as it always has — silently, with no
   flag at all. A database that was paused before the last restart boots
   paused again, and logs a `warn` line saying so. A stored flag the daemon
   cannot read (a value other than the two it ever writes itself) also boots
   the daemon paused — a daemon does not dispatch against a value it could
   not parse — and logs an `error` line carrying the raw stored value.
   **Either log line names `adl resume` as the remedy.** This restore never
   writes the row back; it only reads.

6. Dispatch, the reaper tick, and the GC schedule all start, and the HTTP
   server binds.

---

## The Windows PID-reuse degradation

The boot orphan kill (step 3 above) only signals a process when it can prove
the PID it recorded still belongs to the same process — PIDs are reused by
the OS, and a stale PID may belong to something else entirely by the time
the daemon restarts. The proof is the process's **start time**: the daemon
records `{pid, startTime}` when a worker reports ready, and only signals
that PID again if a fresh read of its start time still matches.

**Start time is read from `/proc/<pid>/stat`, which exists on Linux only.**
On Windows (and any other platform without `/proc`), reading a process's
start time this way is unavailable. The daemon treats "unavailable" as **not
attributable** — never as license to signal a PID on trust alone — so on
Windows the boot orphan kill signals nothing and logs why.

**What this means in practice:** if the manager process itself is killed or
crashes on Windows while a worker is still running, that worker is left
alone at the next daemon restart. It **may** become an orphan an operator
has to notice and clean up by hand (its feature is still correctly requeued
per step 4 above — this degradation affects only whether the _old_ worker
process itself is reclaimed, never the feature's state). This is a
deliberate, accepted trade-off: signalling a PID that turned out to belong
to an unrelated process on someone else's infrastructure is a materially
worse failure than leaving one extra process running. Linux is this
project's stated deployment target, where the full guarantee applies.

---

## The worker-stop mechanism

Stopping a worker — whether from `adl kill`, an operator pausing a feature
mid-round, or the daemon's own graceful shutdown — is always the same two
steps, implemented once (`worker-supervisor/lifecycle.ts`) and shared by
every call site so the behaviour cannot drift:

1. Send a `soft_stop` message over the worker's IPC channel and wait up to
   `worker_stop_grace_ms`.
2. If the worker has not exited by then, `SIGKILL` it unconditionally.

**Why not an OS signal (`SIGTERM`) instead of an IPC message?** A forked
Node child on Windows does not receive `SIGTERM` as a catchable signal —
`child.kill('SIGTERM')` is emulated there as immediate forceful termination,
which means a `SIGTERM`-based approach would give a worker no grace period
at all on one of the two platforms this project's CI covers. The IPC message
plus a bounded wait behaves **identically on Linux and Windows**, which is
the entire point: a worker gets a real chance to abort its current stage and
leave its worktree in a coherent state on either platform, and `SIGKILL` — the
one signal that is reliably forceful everywhere — is the backstop when it
does not take that chance.

---

## Operating the daemon

`adl daemon stop` asks a running daemon to shut down gracefully: it stops
accepting new dispatch, stops every live worker with the same
soft_stop-then-`SIGKILL` mechanism above, closes the HTTP server, and exits.
`adl daemon start` reads `.adl/daemon.json`, boots the sequence described
above, and serves the API in the foreground.

**The installed `adl` binary is this package, not `@adl/cli`** (M05 step 5.7).
`@adl/cli` structurally cannot resolve `@adl/manager` (pnpm strict `node_modules`)
and cannot spawn a subprocess either (`adl/no-direct-spawn`), so it can never
boot the daemon on its own — `packages/manager/src/bin.ts` is the real,
published `adl` executable, and it depends on `@adl/cli` as an ordinary
library (never the reverse). Every verb except `daemon start` is `@adl/cli`'s
own unmodified, HTTP-only command; `daemon start` alone gets this package's
`createProductionDaemonStartRunner` (`src/boot/cli-entry.ts`) injected into
it. The backend preflight gate above is always wired from this entry point —
a real `claude --version` probe, never skipped.

**A global pause survives a restart; a repo-scoped pause does not.**
`adl pause` (scope `all`) is written to the daemon's database as a `meta`
row before the in-memory brake is flipped — a `200` from `POST
/control/pause` is a durability claim, not a process-lifetime one — and is
restored at the next boot (see step 5 of the startup sequence above). `adl
pause --repo <id>` (scope `repo`) is **not** persisted: it lives only as
long as the process that set it, and a restart clears it. This asymmetry is
deliberate — G-03-3's ratified scope is the global flag only — and it is
stated here so an operator learns it from this document rather than from
behaviour, at the worst possible moment.

If the daemon boots and finds the stored `global_pause` value unreadable
(neither of the two values the daemon ever writes itself), it boots
**paused** rather than guessing, and logs an `error` line naming the raw
value it could not parse. One `adl resume` clears either case — a restored
pause or an unreadable one — and lets dispatch proceed.

See `packages/cli/README.md` for the full `adl` verb set, and
`packages/workspace/README.md` for what ADL's own git overrides do and do
not protect — this package adds nothing to that list.

---

## No single-instance guard (accepted for v1)

**Nothing stops two `adl daemon start` processes from being pointed at the
same database file.** There is no PID file, no advisory lock, no
single-instance check. This is a deliberate v1 decision (EXEC-01), not an
oversight: the lease fence already prevents the one outcome that would
corrupt work — two managers can never both hold a lease on the same feature,
because `acquireLease` is a fenced, atomic compare-and-swap at the database
layer.

**What the lease fence does _not_ prevent:** if two daemons are run against
the same database, both will reap, both will dispatch, and both will run the
boot orphan kill. The second daemon's boot orphan kill has no way to tell
"a worker forked by the _other live daemon_" apart from "an orphan from a
dead daemon" — it will target and kill the first daemon's live workers. This
is an operational hazard for the operator to avoid by not doing this, not a
data-safety hazard the daemon protects you from.

**Operator guidance:** run exactly one `adl daemon start` per database file.
A single-instance guard (PID file or advisory lock) would be a small,
additive change if a future phase needs one; it was consciously deferred
here because the lease fence already makes the failure mode non-corrupting.
