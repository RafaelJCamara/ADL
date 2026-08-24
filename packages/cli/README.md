# `@adl/cli` — the `adl` command

`@adl/cli` builds every `adl` verb below — the command that talks to a running
manager daemon. It never touches the database and never imports
`@adl/manager` — every verb reaches the daemon over HTTP only, the same
surface a future dashboard would use.

**This package is a library, not the installed `adl` binary itself** (M05
step 5.7). `@adl/cli` structurally cannot resolve `@adl/manager`, so it
cannot boot the daemon on its own — the real, published `adl` executable is
`@adl/manager`'s `bin.ts`, which depends on this package and reuses its
`buildProgram` unchanged for six of the seven verbs. `daemon start` is the
one exception: `@adl/manager` injects its own real boot sequence into it
(`BuildProgramDeps.startDaemon`) — see `packages/manager/README.md`.

---

## Where `adl` reads the daemon's address and token from

By default, `.adl/daemon.json` (relative to the current directory) —
override the path with `--config <path>` on any invocation. That file is
the manager's own daemon config; `adl` reads exactly three keys from it:

| Key         | Used for                                            |
| ----------- | --------------------------------------------------- |
| `api.host`  | The address `adl` connects to (default `127.0.0.1`) |
| `api.port`  | The port `adl` connects to (default `4173`)         |
| `api.token` | The bearer token sent on every request              |

There is nothing to pre-supply: the manager mints `.adl/daemon.json` itself
on its own first run (see `packages/manager/README.md`), so pointing `adl`
at a freshly started daemon on the same machine works immediately.

**If the daemon is unreachable**, every verb fails the same way:

```
Cannot reach the ADL daemon at 127.0.0.1:4173. Is it running? Try: adl daemon start
```

— exit code `1`. `adl` never falls back to a stale answer or a direct
database read; a daemon-less response would be a snapshot presented as
current, which is worse than an honest failure.

---

## The six verbs

| Verb                                              | Does                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adl status`                                      | Shows every feature the daemon knows about: id, repo, state, stage, round, age, and the worker holding it, if any. `--json` prints the same data as a machine-readable array instead of a table. |
| `adl pause [feature-id \| --repo <id> \| --all]`  | Stops dispatch for the given scope. A feature already in flight finishes its current round before parking — nothing paid-for is discarded.                                                       |
| `adl resume [feature-id \| --repo <id> \| --all]` | The inverse of `pause`: resumes dispatch for the given scope.                                                                                                                                    |
| `adl kill [feature-id \| --repo <id> \| --all]`   | Stops in-flight work now, rather than waiting for a round boundary. A killed feature lands in `paused`, never `escalated` — kill stops the process, it does not judge the feature.               |
| `adl gc`                                          | Runs the orphan-worktree and scratch-home sweeps on demand, and prints what was reclaimed. The same sweeps also run on a schedule inside the daemon; this is the manual trigger.                 |
| `adl daemon start` / `adl daemon stop`            | Start the manager daemon in the foreground, or ask a running one to shut down gracefully.                                                                                                        |

---

## The three blast radii, and the confirmation rule

`pause`, `resume`, and `kill` all accept exactly one of three, mutually
exclusive, scopes:

1. **A positional feature id** — `adl kill feat-042` — the common case, no
   confirmation.
2. **`--repo <id>`** — every feature in one repository — no confirmation.
3. **`--all`** — every feature on the host — **requires confirmation**.

Giving zero of the three, or more than one, is a usage error and nothing is
sent to the daemon.

**`--all`'s confirmation is proportionate to its blast radius**: it can stop
or park every in-flight run on the host, so it is the one scope that asks
first.

- In an **interactive** terminal, you are asked `Proceed? [y/N]` and only an
  explicit `y`/`yes` (case-insensitive) proceeds — anything else, including
  a bare newline, declines and posts nothing.
- **Pass `--yes`** to skip the prompt — the escape hatch for scripts.
- In a **non-interactive** context (no TTY) without `--yes`, the command
  **refuses outright** rather than silently proceeding. There is no one to
  ask, and silently proceeding on `--all` is exactly how an unattended
  script stops a production host by accident.

---

## Exit codes

Every verb exits `0` on success. A daemon-unreachable error, a rejected
request, or a scope usage error (see above) all exit `1` with a message on
stderr — never a stack trace for an expected failure.
