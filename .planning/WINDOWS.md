---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 0
total_count: 2
last_updated: 2026-08-20T20:38:10.929Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 4 | unrun-verify | packages/workspace/test/worktree/safe-directory.test.ts |  | D-2-08-1 privilege-drop reproduction (positive + negative control) is linuxOnly-gated and did not execute this session — the executor ran on Windows; needs a Linux CI leg or provisioned host to close 04-RESEARCH.md Assumption A4. | open |  | 2026-08-20T13:44:24.299Z |  |
| 2 | 04 | deviation | packages/manager/test/api/logs-reconnect.test.ts |  | Task 3's kill/reattach proof uses createApi()+withEphemeralPort (same production route/store code, real HTTP, real on-disk transcript files) instead of a full startDaemon()+forked-worker+real-agent-CLI-double pipeline — the byte-precise adversarial cases (partial in-flight write, stale-offset reattach) need deterministic timing a real agent subprocess's output cadence cannot guarantee. The main growing-transcript kill/reattach scenario exercises the same lighter harness for consistency; 04-06's tracer already proves the full daemon/worker/agent pipeline separately. | open |  | 2026-08-20T20:38:10.929Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "4",
    "file": "packages/workspace/test/worktree/safe-directory.test.ts",
    "line": null,
    "description": "D-2-08-1 privilege-drop reproduction (positive + negative control) is linuxOnly-gated and did not execute this session — the executor ran on Windows; needs a Linux CI leg or provisioned host to close 04-RESEARCH.md Assumption A4.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T13:44:24.299Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/manager/test/api/logs-reconnect.test.ts",
    "line": null,
    "description": "Task 3's kill/reattach proof uses createApi()+withEphemeralPort (same production route/store code, real HTTP, real on-disk transcript files) instead of a full startDaemon()+forked-worker+real-agent-CLI-double pipeline — the byte-precise adversarial cases (partial in-flight write, stale-offset reattach) need deterministic timing a real agent subprocess's output cadence cannot guarantee. The main growing-transcript kill/reattach scenario exercises the same lighter harness for consistency; 04-06's tracer already proves the full daemon/worker/agent pipeline separately.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T20:38:10.929Z",
    "resolved_at": null
  }
]
````

