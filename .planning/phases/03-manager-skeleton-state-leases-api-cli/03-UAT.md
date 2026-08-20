---
status: complete
phase: 03-manager-skeleton-state-leases-api-cli
source: [03-VERIFICATION.md]
started: 2026-08-20T06:18:24Z
updated: 2026-08-20T07:20:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Resolve the EXEC-01 flagged assumption — same-database double daemon start
expected: A decision on whether v1 needs a single-instance guard (PID file / advisory lock), or whether the lease fence's per-row protection is accepted as sufficient for now.
result: pass
decision: "Accept the lease fence as sufficient for v1 — no single-instance guard. Documented in packages/manager/README.md ('No single-instance guard (accepted for v1)') including the boot-orphan-kill cross-targeting hazard. REQUIREMENTS.md EXEC-01 marked Complete."

### 2. Resolve the EXEC-02 flagged assumption — one-worker-one-lease as the intended contract
expected: Sign off that the dispatcher's acquire-then-fork ordering and the supervisor's per-feature active-worker map are the correct enforcement points (not just what happens to be implemented).
result: pass
decision: "Ratified: acquire-then-fork ordering (dispatcher) and the per-feature active-worker map (supervisor) are the correct, intended enforcement points for one-worker-one-lease, not incidental to the implementation."

### 3. Resolve the OBS-03 flagged assumption — should global pause survive a daemon restart?
expected: A decision recorded either accepting the in-memory-only behaviour (a restart silently resumes dispatch) or requiring persistence via a `meta` row.
result: issue
reported: "require persistence via a meta row"
severity: major

### 4. Resolve the OBS-04 flagged assumption — scope of `adl kill --all`
expected: A decision recorded on which of the two equally-consistent readings of "kill everything" is correct: stop every leased feature AND park every queued one (implemented), vs. stopping only what is in flight.
result: pass
decision: "Ratified: adl kill --all stopping every leased feature AND parking every queued one is the correct reading, as implemented."

### 5. adl status table readability and daemon-down error message wording
expected: Running `adl status` with >=5 features in mixed states in a <=100-column terminal renders without wrapping and with distinguishable states; `adl status` against a stopped daemon prints a message naming the address and suggesting `adl daemon start`, with a non-zero exit code.
result: pass
decision: "Daemon-down message verified correct as-is (live run against a stopped daemon with a real config: 'Cannot reach the ADL daemon at 127.0.0.1:4173. Is it running? Try: adl daemon start', exit 1). Found and fixed two readability defects: truncateId kept a ULID's first 10 chars (exactly the timestamp segment), collapsing near-simultaneous features to identical-looking IDs; and columns were not padded/aligned. Fixed in commit 048ad85 (truncateId now keeps the last 10 chars; columns now pad to their widest cell). Re-verified: no wrapping (74 cols for the 5-feature sample, well under 100), all 5 rows now show distinguishable IDs. Separately found (not fixed, out of scope for this item): adl status crashes with a raw Node stack trace if .adl/daemon.json has never been created, instead of a friendly message — flagged for a future fix, not blocking this UAT item since it verified the in-scope 'daemon down but config exists' case."

## Summary

total: 5
passed: 4
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-03-3
  truth: "A decision recorded either accepting the in-memory-only behaviour (a restart silently resumes dispatch) or requiring persistence via a `meta` row."
  status: failed
  reason: "User reported: require persistence via a meta row"
  severity: major
  test: 3
  root_cause: "03-07-PLAN.md's own flagged_assumptions block already named this: 'This plan holds the global pause flag in memory only, so a restart resumes dispatch... A persisted pause would be a `meta` row and a boot-time read.' control/state.ts's createControlState() never touches the database; the global pause flag lives only in a JS closure. No investigation needed — the fix direction was already specified by the plan author, just never implemented."
  artifacts: [packages/manager/src/control/state.ts, packages/manager/src/boot/startup.ts, packages/db/src/repository/meta.ts]
  missing: [persisted global-pause meta row, boot-time read/restore of that row, write-through on pause/resume]
