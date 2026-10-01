# `@adl/workspace` — the exec boundary and its isolation model

Every process ADL starts goes through this package. It owns the git worktree
each feature works in, the disposable `HOME` each run gets, the environment
every child receives, and — on Linux — the OS identity that child runs as.

**Read the sudoers section before you install.** ADL asks for one `NOPASSWD`
sudoers rule. That is a real thing to accept, it is stated here rather than
buried, and the rest of this document explains exactly what it grants and what
it does not.

---

## What the isolation model is for

ADL runs an AI agent against a specification that anyone who can push to your
repository can write. The agent runs real commands: your build, your tests, and
an agentic CLI that edits files. The question this package answers is not "is the
agent well-behaved" but "what is the blast radius when it is not".

Three controls, each independent of the other two:

| Control                              | Mechanism                                                                                     | Applies on     |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | -------------- |
| A disposable `HOME` per run          | `mkdtemp` under a root the worker cannot list, deleted at teardown and swept if a worker dies | every platform |
| A zero-inherit child environment     | the child's environment is built from nothing; no credential crosses unless a caller named it | every platform |
| **A dedicated unprivileged OS user** | an external launcher (`sudo -u`) that performs the full privilege drop                        | **Linux only** |

The third is what this document is about.

All three measure the blast radius **between ADL's agents and your host**. None
of them measures it between one feature and another — see
[Permission model § What is not isolated](#what-is-not-isolated-one-worker-identity-for-every-feature).

---

## What is enforced on Linux, and what is not enforced elsewhere

On **Linux**, with the worker user provisioned:

- Children run as `adl-worker` (or whatever you name it), not as the ADL daemon.
- Supplementary groups are relinquished, so the child holds no membership the
  worker user was not given. This is not automatic — see
  [Why a launcher](#why-a-launcher-and-not-a-flag).
- The child can write its scratch `HOME` and its own worktree, and can
  **commit**: that also means adding objects to the repository's shared object
  store and writing the `adl/*` branch refs and reflogs (see
  [Permission model § What a commit needs](#what-a-commit-needs-and-what-it-does-not-get)).
- The child **cannot** write your repository's `.git/config` or `.git/hooks`
  (group and world write are actively removed from both), cannot write any ref
  outside `refs/heads/adl/` (the default branch, tags, remote-tracking refs,
  `refs/replace/`), and cannot delete, replace or edit an object the daemon
  wrote.
- It **can** write every `adl/*` ref — other features' and finished ones'
  included — and add objects that every feature's git will read. Both are
  stated, accepted residuals; read the
  [permission model](#residuals-accepted-and-written-down) before you rely on
  more than the boundary between ADL's agents and your host.
- **The child can also write every _other_ running feature's worktree.** There is
  one worker identity per deployment, not per feature, so this boundary is
  between ADL's agents and your host — not between one feature and another. Read
  [Permission model § What is not isolated](#what-is-not-isolated-one-worker-identity-for-every-feature)
  before you run more than one feature at a time.

On **Windows and macOS**, and on Linux without the worker user provisioned:

- Children run with the **ADL daemon's own OS identity**. Anything the daemon can
  read — its configuration, its credential files, its home directory — is
  reachable by anything the agent runs.
- Your repository's `.git/config` is **writable by the agent**. That matters more
  than it sounds: git config names programs git executes (`core.hooksPath`,
  `core.pager`, `core.fsmonitor`, `*.sshCommand`, `credential.helper`), so a
  write there is a code-execution path into ADL's own later git operations. Git
  has stated it has no plans to change this behaviour.
- A warning naming all of the above is printed to standard error **once per
  process**, prefixed `[ADL][WORK-05]`. If you have not seen that warning, the
  drop happened. If you have, it did not, and the line says which of the three
  causes applies: the platform, a missing launcher, or an unset `ADL_WORKER_USER`.

v1 supports the drop on Linux only. That is a deliberate scope decision, not an
oversight: the daemon's deployment target is Linux, and a half-working control
on two more platforms would be worse than a documented absence.

---

## What ADL's own git overrides

The OS-level control above is one of two layers, and it is the one that only
exists on Linux. The other applies **everywhere**, including on your laptop.

A linked worktree does not have a local git configuration of its own — it shares
the main repository's. So `git config core.hooksPath …` run by an agent from
inside its worktree writes **your repository's** `.git/config`, and ADL reads
that file on every git command it runs. Reproduced against git 2.49; git has
stated it has no plans to make these directives safe, so there is no version to
upgrade to.

ADL therefore passes these overrides on **every** git invocation it makes for
itself. They are not configurable and cannot be switched off:

| Key                  | Overridden to | What an attacker gets without it                                                                                |
| -------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `core.hooksPath`     | _(empty)_     | A directory of scripts git runs around ordinary operations — verified to fire on `git status`.                  |
| `core.fsmonitor`     | `false`       | A command git runs to ask what changed, on status, diff, and every index refresh.                               |
| `core.pager`         | `cat`         | A command git pipes its output through.                                                                         |
| `core.editor`        | `false`       | A command git launches to compose a message.                                                                    |
| `core.sshCommand`    | _(empty)_     | The program git uses to reach a remote — runs on every fetch and push.                                          |
| `credential.helper`  | _(empty)_     | A program git runs to obtain credentials: execution, and a way to be handed your forge token.                   |
| `diff.external`      | _(empty)_     | A program git runs instead of computing a diff itself.                                                          |
| `protocol.ext.allow` | `never`       | `ext::<command>` URLs, which run an arbitrary command as the transport.                                         |
| `commit.gpgsign`     | `false`       | A signing program (`gpg.program`) git runs on every commit ADL makes — and a failed signature fails the commit. |

**This affects ADL's own git operations only** — not yours, and not the agent's.
Your own `git` in your own shell is untouched, and none of these keys is one ADL
itself needs. If you rely on one of them for ADL's operations specifically, that
is the trade this table exists to make visible rather than mysterious.

The list lives in `src/git/manager-git.ts` as `NEUTRALISED_CONFIG`, and the test
suite poisons each key one at a time and asserts the override wins — so removing
an entry to "clean up" removes its own proof.

---

## The daemon never needs root

ADL's manager runs as its own ordinary unprivileged user. It does not run as
root, does not need `CAP_SETUID`, and is not a setuid binary.

That single constraint is why the privilege drop is an **external launcher**
rather than a flag on the process spawn. See
[Why a launcher](#why-a-launcher-and-not-a-flag) for the mechanism; the
consequence for you is that ADL needs permission from `sudo` to become one
specific unprivileged user, which is the sudoers rule below.

---

## Install: provision the worker user once

Run these as an administrator, once per machine. The daemon never runs them —
it has no way to, by design.

```sh
# 1. The shared group. Both the daemon user and the worker user belong to it.
#    It is how the worker reaches directories the daemon created.
sudo groupadd --system adl-worker

# 2. The worker user. No login shell, no home directory of its own -- its HOME
#    is the disposable directory ADL creates per run and deletes afterwards.
sudo useradd --system --gid adl-worker \
             --no-create-home --shell /usr/sbin/nologin \
             adl-worker

# 3. The DAEMON's user joins the shared group. Without this, ADL cannot set the
#    group on the directories the worker has to write, and every run degrades
#    with a named reason instead of silently half-working.
#    Replace `adl` with whatever user your daemon runs as.
sudo usermod --append --groups adl-worker adl
```

Group membership takes effect when credentials are created. **Restart the daemon
(or log the daemon user out and back in) after step 3** — a process that was
already running does not pick up a new supplementary group.

Then tell ADL the two names:

```sh
ADL_WORKER_USER=adl-worker
ADL_WORKER_GROUP=adl-worker
```

Both are read from the daemon's own environment. They are names, never secrets.
If `ADL_WORKER_USER` is unset, ADL runs undropped and says so once per process.

---

## The sudoers rule

This is the part to read carefully. Install it as
`/etc/sudoers.d/adl-worker`, mode `0440`, owned by `root:root`:

```sudoers
# Replace `adl` with the user your ADL daemon runs as.
adl ALL=(adl-worker) NOPASSWD:SETENV: ALL
Defaults>adl-worker !secure_path
```

Install it through `visudo` so a syntax error cannot lock you out of `sudo`:

```sh
sudo visudo -c -f /path/to/the/file   # validate first
sudo install -m 0440 -o root -g root /path/to/the/file /etc/sudoers.d/adl-worker
```

### What it grants

- The `adl` user may run commands **as `adl-worker` only**. The run-as field is
  `(adl-worker)`, not `(ALL)` — this rule does not let `adl` become root, does
  not let it become any other user, and does not let it run anything with
  elevated privilege.
- It may do so without being prompted for a password. The daemon is a
  long-running service with no terminal; a prompt would be a hang, not a
  security control.
- `SETENV` lets the daemon pass the environment it constructed through to the
  command. This is required, not a convenience: `sudo` resets the environment by
  default, and the environment it would reset is the disposable `HOME` and the
  git and npm neutralisers that make agent-written configuration die with the
  run. Losing them would silently undo the other two controls in the table
  above.
- `!secure_path` stops `sudo` replacing the child's `PATH`. ADL passes each
  child an explicit `PATH` as part of its constructed environment; `secure_path`
  would override it, and the resulting "command not found" would appear only
  under the privilege drop.

### What it does not grant

- No root access, for `adl` or for `adl-worker`.
- No ability for `adl-worker` to run anything as anyone. The rule is one
  directional: `adl` → `adl-worker`.
- No new capability for the agent. The agent already runs commands; this rule
  changes **which identity** they run as, and that identity has strictly less
  access than the one they would otherwise use.

The honest summary: if the ADL daemon's user account is compromised, this rule
lets the attacker also act as `adl-worker` — an account with no login shell, no
home directory, and no group memberships beyond the shared one. That is the
whole of the additional exposure, and it is smaller than what the compromised
daemon account already has.

### If you would rather not configure sudoers

`setpriv` from `util-linux` performs the same drop:

```sh
setpriv --reuid=adl-worker --regid=adl-worker --init-groups --inh-caps=-all -- <command>
```

`--init-groups` is the load-bearing flag: it initialises the supplementary group
list from the target user's memberships instead of inheriting the caller's.

The trade-off is real and it is the reason `sudo -u` is the default:
**`setpriv` requires a root caller.** Choosing it means the ADL daemon itself
must run as root (or hold `CAP_SETUID`), which moves privilege from a narrow,
auditable sudoers rule into the long-running process that talks to the network.
That is a different security posture, not a smaller one.

`runuser -u adl-worker --` is a third option with the same root-caller
requirement.

---

## Why a launcher and not a flag

Node's child-process `uid` and `gid` options look like the obvious
implementation, and they are wrong twice over:

1. **They require the caller to already be root.** `setuid(2)` from an
   unprivileged process fails with `EPERM`. Using them means the daemon runs as
   root — the thing this whole design avoids.
2. **They do not relinquish supplementary groups.** Node's documentation is
   silent on `setgroups()`, and a parent's supplementary groups are inherited.
   The resulting child has the worker's uid and the _daemon's_ group
   memberships, so it is not actually unprivileged — and nothing in the output
   says so.

A correct drop is `setgroups()` → `setgid()` → `setuid()`, in that order, with
errors checked at each step. `sudo -u`, `setpriv --init-groups`, and `runuser`
all do it. That is why the launcher is external, and it is why this package's
test asserts against the child's **supplementary group list** rather than its
uid — a uid comparison alone passes on the broken implementation.

---

## Permission model

What the worker user can and cannot write, once the drop is active:

| Path                                                             | Worker access                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run's scratch `HOME` (`<tmp>/adl-homes/adl-home-*`)          | read, write, traverse                                                | Its `HOME`. Tool configuration the agent writes lands here and is deleted with the directory.                                                                                                                                                                                                                                                                                                                                         |
| `<tmp>/adl-homes` (the root the homes live in)                   | **traverse only** (`--x`, no read, no write)                         | The worker must be able to reach the one home it was given the name of, and must not be able to list the others. Owned by the daemon, mode `0710`.                                                                                                                                                                                                                                                                                    |
| The feature's worktree                                           | read, write, traverse                                                | The code the agent is there to change.                                                                                                                                                                                                                                                                                                                                                                                                |
| `<repo>/.git/worktrees/<feature>`                                | read, write, traverse                                                | The worktree's own index and `HEAD`. The agent must be able to commit.                                                                                                                                                                                                                                                                                                                                                                |
| `<repo>/.git/objects/<xx>` — each of the 256 fan-out directories | add entries; **cannot unlink, rename over or edit the daemon's**     | Group `adl-worker`, mode `1775` (group `rwx` plus the **sticky** bit), on the directory itself and **not** on what is in it. A commit adds loose objects here and nothing else; an entry in a sticky directory can be unlinked or renamed only by its owner or the directory's owner, so the daemon's objects are immutable to the worker. All 256 are created up front, because a directory created later takes its creator's umask. |
| **`<repo>/.git/objects`, `objects/info`, `objects/pack`**        | **read only**                                                        | Not granted. `objects/info/alternates` would point the daemon's git at an object store of the worker's choosing, and a pack is parsed by the daemon's git. A commit needs neither.                                                                                                                                                                                                                                                    |
| `<repo>/.git/refs/heads/adl`, `<repo>/.git/logs/refs/heads/adl`  | read, write, traverse — **recursively: the whole `adl/*` namespace** | The branch ref a commit moves and the reflog it appends to. That is **every** feature's branch, finished features awaiting a human included, not only the running one's. Nothing else under `refs/` or `logs/`. A link planted here is a redirect; see [the residuals](#residuals-accepted-and-written-down).                                                                                                                         |
| **`<repo>/.git/hooks`**                                          | **read only — actively clamped**                                     | A hook is a program git executes on the _daemon's_ own later operations. Group and world write are removed from the directory and every entry beneath it on every attach, **whether or not the grants succeeded**. Never granted.                                                                                                                                                                                                     |
| **Every ref outside `refs/heads/adl/`**                          | **read only**                                                        | The default branch, tags, remote-tracking refs and `refs/replace/`. A replace ref changes what the daemon's own `git diff` reads without changing what is pushed.                                                                                                                                                                                                                                                                     |
| **`<repo>/.git/config`**                                         | **read only — actively clamped**                                     | Git config names programs git executes. The agent must never be able to add one. Group and world write are removed from this file on every attach, **whether or not the grants succeeded** — not merely never granted.                                                                                                                                                                                                                |
| **Every other running feature's worktree and `HOME`**            | **read, write, traverse**                                            | **Not isolated — see below.** One worker identity serves every feature, so the grants above are grants to _all_ of ADL's agents, not to one.                                                                                                                                                                                                                                                                                          |
| Everything else                                                  | whatever the OS gives a system account with no groups                | Not granted by ADL.                                                                                                                                                                                                                                                                                                                                                                                                                   |

Access is granted through the shared group with group-only mode bits. **No world
permission is ever set** — the scratch `HOME` does not become readable by every
local user in order to be writable by the worker.

### What a commit needs, and what it does not get

A linked worktree's objects and refs are not per-worktree
(`gitrepository-layout`(5)). The first real commit from a dropped worker needs
three things outside its worktree and its administrative directory, each of which
failed on its own when it was missing: the **object store**, the **branch ref**,
and the **branch's reflog**. They are granted by group like everything else here,
and re-granted on every `attach` — idempotently, so an entry already carrying the
grant, and an entry the worker itself made, are not touched. Each grant is as
narrow as a commit allows:

- **Objects — the 256 fan-out directories, sticky, and nothing beneath them.** A
  commit creates files inside `objects/<xx>/` and nowhere else in the store.
  Those directories get group `rwx` plus the sticky bit, so the worker can add
  objects and cannot unlink, rename over or edit one the daemon wrote. The grant
  walk never descends into `objects/`, so what it costs does not grow with the
  repository's history either. `objects/` itself, `objects/info` and
  `objects/pack` are not granted.
- **Refs and reflogs — `refs/heads/adl` and `logs/refs/heads/adl`, recursively.**
  This is the whole `adl/*` namespace, not "the running feature's branch".
- **`.git/config` and `.git/hooks` — clamped, not just withheld.** Both name
  programs git runs on the daemon's behalf. Group and world write are removed
  from each (and from every entry in `hooks/`) on every attach, independently of
  whether the grants worked, so a repository created under `umask 002` in the
  shared group cannot leave either writable, and a grant that degraded half way
  cannot be the reason one was.

Every refusal above is a test in `test/exec/worker-access.test.ts`, one case per
refusal so that each is red for exactly one defect: no hook, no config (also when
they started group-writable), no default branch, no `refs/replace`, no delete /
rename-over / in-place edit of a daemon object, no `alternates`, no pack. The same
file holds the positive side — a worker commit, a worker re-add of a blob the
daemon already wrote, the daemon reading and packing what the worker wrote — run
under both a `022` and a `002` daemon umask. They need the Linux CI leg: off
Linux they skip with a visible `[ADL][SKIPPED]` line, and on Linux with no worker
provisioned they fail.

### How the grant walk treats symlinks and a changing tree

The worker can write every directory the grant walks, so the walk cannot trust a
name it has already looked at.

- **A symlink is never followed — including one swapped in mid-walk.** Each entry
  is opened with `O_NOFOLLOW`, and everything after that (`fstat`, `fchown`,
  `fchmod`, listing a directory) is done on the open descriptor, reached through
  `/proc/self/fd/<n>` for the children of a directory. A path-based
  `lstat`-then-`chown` is a time-of-check/time-of-use gap: the worker swaps a
  daemon-owned file for a link between the two calls and the daemon `chmod`s the
  target (reproduced against a repository's `pre-commit` hook before this was
  changed). The case is pinned deterministically — the test swaps the entry in the
  window itself, through a hook the walk exposes for exactly that — rather than by
  racing a second process. Linux only: the privilege drop is Linux only, and the
  walk **degrades with a named reason** rather than falling back to the racy
  path-based form when `/proc` is not mounted.
- **An entry that vanishes is skipped, not a failure.** `git` renames its
  `tmp_obj_*` files into place while a walk is under way; that used to degrade the
  whole grant with `ENOENT` and skip the `.git/config` clamp with it. A path the
  caller _named_ and that is missing still degrades.
- **Ownership decides, not "the daemon does not own it".** An entry owned by the
  worker's uid is the worker's to manage and is skipped. Anything else that does
  not already carry the grant is changed or, if it cannot be (a repository a third
  user owns), **degrades loudly** with `EPERM` — it is not reported as `applied`.
  This needs the worker user's _name_, which the backend passes from
  `ADL_WORKER_USER`.

### Residuals, accepted and written down

1. **One object store for every feature.** The worker can add objects that any
   feature's git — and the daemon's — will read, and objects _the worker_ wrote are
   mutable by any worker (they are owned by the one worker uid). It cannot touch an
   object the daemon wrote. A per-feature object store (alternates, or a clone per
   feature) is the real fix and a larger change. `DEBT.md` D-6-CI-6.
2. **The `adl/*` namespace is writable, and a link in it is a redirect.** Git
   treats a symlink ref as a symbolic ref, so a worker that replaces
   `refs/heads/adl/<id>` with a link to another ref redirects every write made
   _through_ that branch. Against the default branch, tags and `refs/replace/` the
   boundary is the OS permission: ADL's own `git commit`/`add`/`push` run through
   `Workspace.exec()` and so run as the worker, whose commit through such a link
   fails with `Permission denied` (a test); the daemon-identity writers
   (`worktree add -b`, `branch -D`) refuse the name or delete only the link (a test).
   What the worker _can_ do is point ADL's commit at another feature's branch, or
   rewrite the worktree's `HEAD` the same way, and a daemon-side writer added later
   would inherit the hole. `guardRefWrite` (called before the carry-back commit)
   refuses a repointed `HEAD` and unlinks non-regular entries in the namespace —
   a **mitigation that is not race-free**, documented as one. The structural fix is
   a detached `HEAD` per worktree with the daemon alone creating and advancing
   `refs/heads/adl/<id>`; it changes how the inventory, GC and `attach` find a
   feature's worktree and was not done here. `DEBT.md` D-6-CI-7.
3. **One worker identity for every feature** — see the next section.
4. **`gc --auto` is not neutralised for the worker, and cannot do anything.**
   `git gc` run as the worker dies on its first step —
   `Unable to create '.git/gc.pid.lock': Permission denied` — because the lock
   lives in the common git directory, which is not the worker's; a worker commit
   with auto-gc armed (800 loose objects, `gc.auto=1`) swallows that and exits 0
   (a test). `DEBT.md` D-6-CI-9.

Prerequisites that follow from two identities sharing one object store:

- The daemon's **umask must leave group read** on what it creates (`022`, `002`
  or `027`; not `077`). Git writes loose objects `0444` and applies the umask, so
  a `077` daemon writes `0400` objects, and `0600` refs, the worker cannot read —
  and, now that the walk no longer descends into `objects/`, nothing re-grants
  them. `DEBT.md` D-6-CI-10.
- The shared group must be the group of the directories the grant touches. It
  is, for everything ADL grants; a repository on a filesystem that ignores
  group ownership (some network mounts) cannot be shared this way.
- The repository's common git directory is found with `git rev-parse
--git-common-dir`, not assumed to be `<repo>/.git`. If git will not say, the
  worker is told it cannot commit (a banner naming the reason) instead of the
  workspace failing to open.

### What is not isolated: one worker identity for every feature

`ADL_WORKER_USER` and `ADL_WORKER_GROUP` name **one** user and **one** group for
the whole deployment. Every feature ADL runs — concurrently or otherwise — drops
to that same identity, and the grants in the table above are made to that same
group. So:

- Feature A's agent can read and **rewrite feature B's source**, including after
  B's reviewer stage has passed and before its pull request opens.
- It can read and write B's git index and `HEAD` under
  `<repo>/.git/worktrees/B`.
- It can enter B's scratch `HOME` — and read whatever B's agent left there: a
  `.gitconfig` credential helper, an `.npmrc` token, an agent CLI's session file.

Since ADL treats the feature specification as untrusted input written by anyone
who can push to your repository, this is a path from a hostile spec into a diff a
human is about to approve. **It is the one thing this package's isolation model
does not stop.**

Two things narrow it, and neither closes it:

- The scratch homes live inside `<tmp>/adl-homes`, which the worker group may
  traverse and may **not** list. Reaching another feature's `HOME` therefore
  means guessing an `mkdtemp` name rather than reading a directory listing. (When
  the homes sat directly in `/tmp`, `ls /tmp` was enough.)
- Worktree paths are **not** protected this way. They are predictable by design —
  `<scratchRoot>/<featureId>` — so nothing stands between one agent and another's
  code except the shared group itself.

**If your features come from more than one trust domain, run one feature at a
time** (or one daemon per domain) until this is closed. Closing it needs a _pool_
of pre-provisioned worker identities — a distinct uid per concurrent slot, since
group bits cannot separate two processes running as the same uid — plus a sudoers
entry per pool member. That work, its reproduction, and the shape it should take
are recorded in
`.planning/phases/02-workspace-the-exec-boundary/deferred-items.md` § D-2-R-1.

Two prerequisites ADL does not manage for you, because they are properties of
your machine rather than of a run:

- The worker user must be able to **traverse** to the worktree and to
  `<repo>/.git`. Ordinary `0755` directories satisfy this; a repository under a
  `0700` home directory does not.
- The shared group must exist in the **local** group database. A group that
  exists only in LDAP or SSSD is not visible to the lookup, and ADL will report
  that it degraded rather than pretend the access was granted.

---

## Verifying it works

```sh
# The identity exists and has no unexpected memberships.
getent passwd adl-worker
id adl-worker

# The daemon can become it, without a password, with its environment intact.
sudo --preserve-env --non-interactive --user adl-worker -- id

# ADL is not warning. If you see `[ADL][WORK-05]` on stderr, read the line --
# it names which of the three causes applies.
```
