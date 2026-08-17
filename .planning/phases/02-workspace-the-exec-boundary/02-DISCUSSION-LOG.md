# Phase 2: Workspace & the Exec Boundary - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-17
**Phase:** 2-Workspace & the Exec Boundary
**Areas discussed:** Workspace interface surface, OS user & scratch HOME isolation, Credential boundary mechanism, Worktree lifecycle & GC

---

## Workspace interface surface

| Option | Description | Selected |
|--------|-------------|----------|
| Stream via LogChunk callback | exec() takes a log(chunk) sink, matching StageContext.log | ✓ |
| Buffered result only | exec() returns { stdout, stderr, exitCode } after exit | |

**User's choice:** Stream via LogChunk callback
**Notes:** Reuses Phase 1's LogChunk shape; supports OBS-02 live transcripts.

| Option | Description | Selected |
|--------|-------------|----------|
| Worktree root only | Paths outside the worktree rejected at the interface | ✓ |
| Worktree + scratch HOME | Workspace also exposes scratch HOME as a second root | |

**User's choice:** Worktree root only
**Notes:** Scratch HOME handled via process env at exec() time, not Workspace.read/write.

| Option | Description | Selected |
|--------|-------------|----------|
| Define snapshot() now, no real implementation | Real signature lands now; no backend needs concurrency yet | ✓ |
| Omit snapshot() entirely from Phase 2 | Add only when v2 group: syntax needs it | |

**User's choice:** Define the method now, no real implementation
**Notes:** Avoids a breaking interface change when v2 group: lands.

| Option | Description | Selected |
|--------|-------------|----------|
| Registry pattern, mirroring D-23's harness registry | Named registry resolved at manager startup from daemon config | ✓ |
| Constructor injection only | Backend passed in at construction time by the app wiring | |

**User's choice:** Registry pattern, mirroring D-23's harness registry
**Notes:** Consistent with how adl.yml resolves harness: ids.

---

## OS user & scratch HOME isolation

| Option | Description | Selected |
|--------|-------------|----------|
| Linux-only in v1, no-op elsewhere | Privilege drop only on Linux; warning banner elsewhere | ✓ |
| Abstracted isolation strategy per-OS | Isolation capability is backend-specific from day one | |

**User's choice:** Linux-only in v1, no-op elsewhere
**Notes:** Matches WORK-05 literally without blocking local dev on Windows.

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-provisioned by install docs | Maintainer/install script creates the user once | ✓ |
| Daemon creates it at first run | Manager provisions the user itself, needs elevated perms | |

**User's choice:** Pre-provisioned by install docs
**Notes:** Keeps the daemon from ever needing root beyond the drop-privilege helper.

| Option | Description | Selected |
|--------|-------------|----------|
| Fresh temp dir per run, deleted after | New scratch HOME per run, deleted on teardown | ✓ |
| One persistent scratch HOME, wiped between runs | Single reusable dir, cleared between runs | |

**User's choice:** Fresh temp dir per run, deleted after
**Notes:** Guarantees WORK-07's "does not survive the run" literally.

| Option | Description | Selected |
|--------|-------------|----------|
| ADL's own git ops never read worker HOME | Structural separation via explicit GIT_CONFIG_GLOBAL/HOME | ✓ |
| Verify + clean scratch HOME after each run | Detection + cleanup step after each run | |

**User's choice:** ADL's own git ops never read worker HOME
**Notes:** Structural rather than a cleanup step that could be skipped.

---

## Credential boundary mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit env allowlist at spawn time | Model keys passed only into the specific agent-CLI spawn | ✓ |
| Credential broker / short-lived token | Broker hands subprocess a short-lived credential | |

**User's choice:** Explicit env allowlist at spawn time
**Notes:** Simpler for v1; broker considered for later if insufficient.

| Option | Description | Selected |
|--------|-------------|----------|
| Zero inherited env by default | exec() starts children with explicit, minimal env | ✓ |
| Inherit worker env, minus a denylist | Strip known-sensitive vars from inherited env | |

**User's choice:** Zero inherited env by default
**Notes:** Makes "credentials absent from ambient environment" true by construction.

| Option | Description | Selected |
|--------|-------------|----------|
| Spawn a real child that dumps env, assert absence | Integration test against the actual spawned process | ✓ |
| Unit test the env-building function only | Test the pure function that constructs the env map | |

**User's choice:** Spawn a real child that dumps env, assert keys/tokens absent
**Notes:** Tests the actual boundary, not just the code path.

| Option | Description | Selected |
|--------|-------------|----------|
| Manager-side git calls, separate from Workspace.exec() | Forge-credentialed git ops run outside the worker's exec path | ✓ |
| Workspace.exec() with a separate credential channel | Git ops still go through Workspace.exec() with a distinct credential mechanism | |

**User's choice:** Manager-side git calls, separate from Workspace.exec()
**Notes:** Worker's Workspace never has forge-token-bearing exec calls to begin with.

---

## Worktree lifecycle & GC

| Option | Description | Selected |
|--------|-------------|----------|
| adl/<feature-id> branch, sibling worktree dir | Matches D-16's folder-name-is-branch-suffix convention | ✓ |
| Timestamped worktree dirs | Includes run timestamp/attempt number | |

**User's choice:** adl/<feature-id> branch, sibling worktree dir
**Notes:** Predictable, greppable, collision-safe.

| Option | Description | Selected |
|--------|-------------|----------|
| Immediate teardown on terminal state | Worker removes its own worktree/branch as soon as terminal | ✓ |
| Periodic sweep only | Cleanup only via scheduled GC pass | |

**User's choice:** Immediate teardown on terminal state
**Notes:** Keeps success criterion 1 continuously true, not just after a sweep.

| Option | Description | Selected |
|--------|-------------|----------|
| Periodic backstop sweep + manual CLI trigger | Scheduled sweep plus explicit CLI command | ✓ |
| Manual CLI trigger only | No background scheduler | |

**User's choice:** Periodic backstop sweep + manual CLI trigger
**Notes:** Sweep catches crash orphans; CLI trigger gives the success-criterion test a deterministic hook.

| Option | Description | Selected |
|--------|-------------|----------|
| Cross-check against DB feature state | GC looks up each worktree by feature id in the DB | ✓ |
| Filesystem age/staleness heuristic | Remove worktrees untouched past an age threshold | |

**User's choice:** Cross-check against DB feature state
**Notes:** Reuses the DB as the single source of truth (EXEC-06) rather than a second signal.

---

## Claude's Discretion

- `LogChunk` buffering/backpressure behavior when a consumer reads slowly.
- Precise Linux privilege-drop mechanism (setuid-root helper vs `sudo -u` vs `su`).
- Scratch root directory location/naming convention.
- Exact shape of the `snapshot()` restore handle.
- Registry key naming conventions beyond `'worktree'`/`'stub'`.

## Deferred Ideas

- Container/sandbox workspace backend (v2, SCALE-02).
- Windows/macOS real OS-user isolation (only a warning banner ships in v1).
- Credential broker / short-lived tokens (passed over for the simpler env-allowlist in v1).
- `group:` parallel pipeline stages (v2, per Phase 1's deferred list).
