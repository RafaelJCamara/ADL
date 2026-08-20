---
schema_version: 1
open_count: 5
waived_count: 0
fixed_count: 0
total_count: 5
last_updated: 2026-08-20T21:11:50.520Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 4 | unrun-verify | packages/workspace/test/worktree/safe-directory.test.ts |  | D-2-08-1 privilege-drop reproduction (positive + negative control) is linuxOnly-gated and did not execute this session — the executor ran on Windows; needs a Linux CI leg or provisioned host to close 04-RESEARCH.md Assumption A4. | open |  | 2026-08-20T13:44:24.299Z |  |
| 2 | 04 | unrun-verify | packages/manager/src/boot/backend-preflight.ts |  | claudeVersionCheckRunner (real claude --version via ADL-owned exec boundary) never exercised against a real, pinned CLI — 04-01 Task 3 fixture capture still deferred | open |  | 2026-08-20T20:23:14.681Z |  |
| 3 | 04 | deviation | packages/manager/test/api/logs-reconnect.test.ts |  | Task 3's kill/reattach proof uses createApi()+withEphemeralPort (same production route/store code, real HTTP, real on-disk transcript files) instead of a full startDaemon()+forked-worker+real-agent-CLI-double pipeline — the byte-precise adversarial cases (partial in-flight write, stale-offset reattach) need deterministic timing a real agent subprocess's output cadence cannot guarantee. The main growing-transcript kill/reattach scenario exercises the same lighter harness for consistency; 04-06's tracer already proves the full daemon/worker/agent pipeline separately. | open |  | 2026-08-20T20:38:10.929Z |  |
| 4 | 04 | deviation | packages/agent-claude-code/src/backend.ts |  | Capability-reconciliation error event for missing reportsCost dropped (not the plan's literal wording) — it hijacked unrelated developer_outcome:blocked runs into stage_error via stage-runner.ts's firstError; the honest costSource:'unknown' on the row is the surfaced signal instead. See backend.ts's DELIBERATE DEVIATION comment. | open |  | 2026-08-20T21:11:41.135Z |  |
| 5 | 04 | unrun-verify | .planning/phases/04-first-agent-backend-live-transcripts/04-10-PLAN.md |  | 04-10 Task 3's human-check (run one real adl dev-run against the pinned CLI with a real credential, read the usage_events row back, confirm cost_source=reported/populated tokens/plausible cost) did not run — no ANTHROPIC_API_KEY in this session and installed claude resolves to 2.1.227, not the 2.1.237 pin. STATE.md's Blockers/Concerns entry is narrowed, not closed. | open |  | 2026-08-20T21:11:50.520Z |  |

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
    "kind": "unrun-verify",
    "phase": "04",
    "file": "packages/manager/src/boot/backend-preflight.ts",
    "line": null,
    "description": "claudeVersionCheckRunner (real claude --version via ADL-owned exec boundary) never exercised against a real, pinned CLI — 04-01 Task 3 fixture capture still deferred",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T20:23:14.681Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/manager/test/api/logs-reconnect.test.ts",
    "line": null,
    "description": "Task 3's kill/reattach proof uses createApi()+withEphemeralPort (same production route/store code, real HTTP, real on-disk transcript files) instead of a full startDaemon()+forked-worker+real-agent-CLI-double pipeline — the byte-precise adversarial cases (partial in-flight write, stale-offset reattach) need deterministic timing a real agent subprocess's output cadence cannot guarantee. The main growing-transcript kill/reattach scenario exercises the same lighter harness for consistency; 04-06's tracer already proves the full daemon/worker/agent pipeline separately.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T20:38:10.929Z",
    "resolved_at": null
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/agent-claude-code/src/backend.ts",
    "line": null,
    "description": "Capability-reconciliation error event for missing reportsCost dropped (not the plan's literal wording) — it hijacked unrelated developer_outcome:blocked runs into stage_error via stage-runner.ts's firstError; the honest costSource:'unknown' on the row is the surfaced signal instead. See backend.ts's DELIBERATE DEVIATION comment.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T21:11:41.135Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "unrun-verify",
    "phase": "04",
    "file": ".planning/phases/04-first-agent-backend-live-transcripts/04-10-PLAN.md",
    "line": null,
    "description": "04-10 Task 3's human-check (run one real adl dev-run against the pinned CLI with a real credential, read the usage_events row back, confirm cost_source=reported/populated tokens/plausible cost) did not run — no ANTHROPIC_API_KEY in this session and installed claude resolves to 2.1.227, not the 2.1.237 pin. STATE.md's Blockers/Concerns entry is narrowed, not closed.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-20T21:11:50.520Z",
    "resolved_at": null
  }
]
````

