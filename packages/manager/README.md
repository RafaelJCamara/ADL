# `@adl/manager`

The control plane: the lease queue, worker supervision, the HTTP API, config,
credentials, and round/budget accounting. The only package that writes to
`@adl/db`.

## Daemon config — `.adl/daemon.json`

The daemon reads (and, on first run, creates) a JSON config file at
`.adl/daemon.json`, relative to the daemon's working directory (override with
`--config <path>`). First run is zero-config: if the file does not exist yet,
the daemon mints a bearer token with `crypto.randomBytes(32)` and writes it
there, so there is nothing to pre-supply before starting the daemon for the
first time.

That file is written with owner-only permissions (`0o600` for the file,
`0o700` for its containing directory) — it holds the bearer token that
authenticates every control-plane route except `GET /health`. **On Windows,
this is a documented no-op**: POSIX mode bits have no Windows equivalent, so
the file's actual access control there is whatever NTFS ACLs the containing
directory already grants. Do not rely on `.adl/daemon.json`'s file mode for
confidentiality on a Windows host — protect the directory itself instead.

## Startup — schema gate, pre-migration copies, and disk growth

On every start, the daemon compares the database's stored `meta.schema_version`
against its own — derived automatically from the migrations shipped with
`@adl/db`, never a hand-maintained number — and:

- **refuses to run** (writing nothing) if the stored version is newer than
  the daemon's own, or is not a valid integer;
- **copies the database file** beside itself, as
  `<db-file>.pre-<version>-<timestamp>`, before applying any pending
  migration, if the stored version is older or has never been seeded.

**These copies are never deleted by the daemon.** This is a deliberate
safety property, not an oversight: the startup sequence contains no
destructive filesystem operations, so every prior upgrade — however old —
stays recoverable. The cost is real: on a long-lived installation that is
upgraded repeatedly, these copies accumulate without bound next to the
database file, each roughly the size of the database at the time it was
taken. **An operator is responsible for periodically reviewing and removing
old `*.pre-*` copies once they are confident they will not need to roll
back to them.** A future release may add an explicit `adl db prune-copies`
verb or similar; none exists as of this phase.

## Boot-time orphan handling (D-13, D-14)

On Linux, the daemon verifies a recorded worker's _process start time_
(`/proc/<pid>/stat`) before signalling it at boot, so a reused PID from an
unrelated process is never killed. **On Windows there is no `/proc`, so this
verification is not performed there.** The daemon still checks whether the
recorded PID is currently alive, but cannot confirm it is the _same_ process
that held the lease — a boot-time orphan kill is therefore skipped entirely
on Windows whenever a lease was left dangling by a previous daemon process,
logging why, rather than risk signalling a PID that has since been reused by
something else. This is the same "documented degradation, never a silent
weaker guarantee" posture Phase 2 established for privilege dropping.

## What ADL's own git overrides

See `@adl/workspace`'s own `README.md` — this package does not add to that
list.
