---
status: testing
phase: 03-manager-skeleton-state-leases-api-cli
source: [03-VERIFICATION.md]
started: 2026-08-20T06:18:24Z
updated: 2026-08-20T06:18:24Z
---

## Current Test

number: 1
name: Resolve the EXEC-01 flagged assumption — same-database double daemon start
expected: |
  A decision on whether v1 needs a single-instance guard (PID file / advisory lock)
  when two `adl daemon start` processes are started against the same database file,
  or whether the lease fence's per-row protection is accepted as sufficient for now.
  03-06-PLAN.md's own `<flagged_assumptions>` block classifies this `unclassified` —
  the code deliberately does not add a guard, so no automated test can pass/fail on it.
awaiting: user response

## Tests

### 1. Resolve the EXEC-01 flagged assumption — same-database double daemon start
expected: A decision on whether v1 needs a single-instance guard (PID file / advisory lock), or whether the lease fence's per-row protection is accepted as sufficient for now.
result: [pending]

### 2. Resolve the EXEC-02 flagged assumption — one-worker-one-lease as the intended contract
expected: Sign off that the dispatcher's acquire-then-fork ordering and the supervisor's per-feature active-worker map are the correct enforcement points (not just what happens to be implemented).
result: [pending]

### 3. Resolve the OBS-03 flagged assumption — should global pause survive a daemon restart?
expected: A decision recorded either accepting the in-memory-only behaviour (a restart silently resumes dispatch) or requiring persistence via a `meta` row.
result: [pending]

### 4. Resolve the OBS-04 flagged assumption — scope of `adl kill --all`
expected: A decision recorded on which of the two equally-consistent readings of "kill everything" is correct: stop every leased feature AND park every queued one (implemented), vs. stopping only what is in flight.
result: [pending]

### 5. adl status table readability and daemon-down error message wording
expected: Running `adl status` with >=5 features in mixed states in a <=100-column terminal renders without wrapping and with distinguishable states; `adl status` against a stopped daemon prints a message naming the address and suggesting `adl daemon start`, with a non-zero exit code.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
