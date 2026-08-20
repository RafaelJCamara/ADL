---
phase: 04-first-agent-backend-live-transcripts
plan: 10
subsystem: cost-accounting
tags: [usage-events, cost-recording, ipc, claude-code-adapter, manager, agent-claude-code]

requires:
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-07: preflightClaudeCode / claudeCodeBackend.probe(), the manager's backend startup gate"
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-09: prompt determinism, createProductionStageRunner's injectable agentBackend test seam"
provides:
  - "usageFromResult (packages/agent-claude-code/src/usage.ts) — a run's terminal result event, combined with the started event's model and the usage event's tokens, mapped into a usage_events-shaped AgentUsageRecord with honest provenance"
  - "ClaudeCodeAgentRunner / AgentRunResultWithUsage (packages/agent-claude-code/src/backend.ts) — the resolved run() value now surfaces the AgentUsageRecord it produced, and the core AgentRunResult's usage/costUsd fields are populated from real observed data instead of an always-empty stub"
  - "The worker-to-manager 'usage' IPC message (packages/manager/src/ipc/protocol.ts) — fenced like every other lease-scoped kind, carrying no featureId/roundId/stageAttemptId so a worker cannot name a feature to attribute spend to"
  - "The supervisor's recordUsage wiring (worker-supervisor/supervisor.ts, daemon.ts) — inserts through the existing usageRepository(db).record, never a second writer, with identity from the supervisor's own assignment"
  - "STATE.md's cost-accounting spike narrowed to the one thing still missing: a real, credentialed invocation of the pinned CLI"
affects: [phase-06-accountant, phase-05-loop-runner]

actuals:
  tokens: 18003
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "The terminal event's own shape is insufficient for a usage row — the adapter tracks the started event's model and the usage event's tokens as they stream past, and combines them with the terminal result event only when it arrives, rather than trying to cram everything into one event's schema"
    - "A DB-shaped record type independent of @adl/db — AgentUsageRecord lives in @adl/agent-claude-code (which depends on @adl/core and zod only) and the manager-side caller is the one that turns it into a NewUsageEvent, keeping the adapter package's dependency graph unchanged"
    - "A worker-to-manager IPC message that structurally cannot name the feature it belongs to — the identity fields are supplied by the supervisor's own assignment, never by the message, which is a stronger form of T-4-38's mitigation than a runtime check would be"
    - "A superset return type via interface extension, not a schema change — ClaudeCodeAgentRunner/AgentRunResultWithUsage extend the core AgentRunner/AgentRunResult port with one optional field, so the generic port is untouched and a caller that only knows AgentRunner still gets a fully valid value"

key-files:
  created:
    - packages/agent-claude-code/src/usage.ts
    - packages/agent-claude-code/test/usage.test.ts
    - packages/manager/test/usage/recording.test.ts
    - packages/manager/test/helpers/usage-worker-entry.ts
  modified:
    - packages/agent-claude-code/src/backend.ts
    - packages/agent-claude-code/src/index.ts
    - packages/manager/src/ipc/protocol.ts
    - packages/manager/src/worker-supervisor/supervisor.ts
    - packages/manager/src/worker-entry/stage-runner.ts
    - packages/manager/src/daemon.ts
    - packages/manager/test/ipc/assign-workspace.test.ts
    - packages/manager/test/tracer/end-to-end.test.ts
    - .planning/STATE.md

key-decisions:
  - "usageFromResult takes the terminal `result` AgentEvent plus explicit context (the started event's model, the usage event's tokens, an optional cost category) rather than the raw CLI JSON payload directly — it reuses events.ts's ALREADY-verified stream-json-to-AgentEvent mapping (04-06) instead of re-deriving a second, independently-drifting mapping of the same undocumented field names. The plan's 'map against the recorded capture' instruction is honored by not re-doing that judgement call a second time with the same underlying uncertainty (no captured fixture exists in this worktree — see Known Gaps)."
  - "DELIBERATE DEVIATION, discovered and fixed during Task 1: the plan's literal 'worth an event of the error kind in the transcript' for a capability/cost-report mismatch was implemented, run against the full suite, and found to break pre-existing behavior — packages/manager/test/worker-entry/stage-runner.test.ts's 'a run producing no commit reports blocked honestly' test started failing, because EVERY kind:'error' AgentEvent folds into stage-runner.ts's firstError (P1's own prohibition), converting an otherwise-successful run into a false stage_error the moment its result line simply omitted a cost figure — true for several already-established replay doubles (fake-claude-no-commit.mjs among them). The error-event emission was removed; the honest, already-structural signal is the recorded costSource:'unknown' itself (D-31), which Task 3's STATE.md narrowing and Prohibition P5 already treat as the correctness gate. Recorded in the broken-windows ledger (entry 4)."
  - "The usage IPC message carries NO featureId/roundId/stageAttemptId — only leaseToken and the usage_events payload columns. The supervisor supplies the three join keys from the `assign` message it already holds in its own spawn() closure. This makes T-4-38's mitigation structural (there is no field to spoof) rather than a runtime check that could be forgotten."
  - "claudeCodeBackend's return type changes from AgentRunner to ClaudeCodeAgentRunner (an interface extending AgentRunner with a covariant, richer run() return type). This is additive and backward compatible: every existing AgentRunner-typed test double remains structurally assignable, verified by running the full suite rather than assumed."
  - "Default speed tier is always 'standard' — this adapter's argv never requests Claude Code's 'fast mode', and since this backend's cost is always reported (never computed), speed never actually feeds a price lookup for this backend's own rows; it is populated honestly because the column is NOT NULL."
  - "STATE.md's blocker is narrowed, not closed (Prohibition P5): no ANTHROPIC_API_KEY is available in this execution environment and the installed claude resolves to 2.1.227, not the 2.1.237 pin — the same carried-forward gap 04-01/04-06/04-07/04-09 all recorded. The recording mechanism itself is proven real and correct end to end against a scripted replay double; what remains is one real, credentialed invocation."

requirements-completed: [BACK-05]

coverage:
  - id: D1
    description: "usageFromResult maps a run's terminal event, combined with observed model/tokens, into a usage_events-shaped record with cost_source reported (never computed) or unknown-with-null-cost, and all four token counters null (never zero) when unreported"
    verification:
      - kind: unit
        ref: "packages/agent-claude-code/test/usage.test.ts#usageFromResult"
        status: pass
    human_judgment: false
  - id: D2
    description: "The run result surfaces the produced AgentUsageRecord (ClaudeCodeAgentRunner/AgentRunResultWithUsage) so the caller does not re-parse the terminal event"
    verification:
      - kind: unit
        ref: "packages/agent-claude-code/test/usage.test.ts#claudeCodeBackend — usage capability reconciliation"
        status: pass
    human_judgment: false
  - id: D3
    description: "The worker-to-manager usage IPC message is fenced like every other lease-scoped kind (required leaseToken, dropped on a stale/superseded token), and the manager inserts exactly one row per valid message through the existing usageRepository, with join keys from its own assignment"
    verification:
      - kind: unit
        ref: "packages/manager/test/usage/recording.test.ts#createSupervisor — usage message handling"
        status: pass
      - kind: unit
        ref: "packages/manager/test/usage/recording.test.ts#the usage IPC kind"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two usage messages for one attempt insert two rows (no dedup); an invocation reporting no usage inserts no row"
    verification:
      - kind: unit
        ref: "packages/manager/test/usage/recording.test.ts#createSupervisor — usage message handling"
        status: pass
    human_judgment: false
  - id: D5
    description: "A full adl dev-run against a scripted replay double produces exactly one usage_events row, joined to the round/stage-attempt the run opened, with reported cost/source and null-not-zero cache token columns"
    verification:
      - kind: integration
        ref: "packages/manager/test/usage/recording.test.ts#a full dev-run against the replay double"
        status: pass
    human_judgment: false
  - id: D6
    description: "STATE.md's cost-accounting blocker is either closed with named evidence from a real invocation, or narrowed to exactly what remains unknown"
    verification: []
    human_judgment: true
    rationale: "No ANTHROPIC_API_KEY and no confirmed pinned CLI on this host (installed claude resolves to 2.1.227, not 2.1.237) — the same gap carried since 04-01. The blocker was narrowed per Prohibition P5, not closed; a human (or a future session with a real credential) should perform the one real adl dev-run STATE.md's entry names and verify the resulting row against the Anthropic Console's billed usage before considering the spike fully closed."

duration: single session, 3 tasks
completed: "2026-08-20"
status: complete
---

# Phase 04 Plan 10: Cost Accounting — Terminal Event to Usage Row, Recorded With Honest Provenance Summary

**`usageFromResult` maps a Claude Code run's terminal event into a `usage_events` row with `cost_source: 'reported'` (never fabricated) and null-not-zero token counters; the worker reports it over a new fenced `usage` IPC message the manager writes through the existing repository — proven end to end against a scripted replay double — and STATE.md's cost-accounting blocker is narrowed to the one thing still missing: a real, credentialed invocation of the pinned CLI.**

## Performance

- **Duration:** single session, 3 tasks
- **Tasks:** 3/3 completed
- **Files modified:** 13 (4 created, 9 modified)

## Accomplishments

- `packages/agent-claude-code/src/usage.ts` — `usageFromResult` combines a run's `started` (model), `usage` (four token counters), and terminal `result` (cost, outcome) events into one `AgentUsageRecord`: cost is `reported` from the CLI's own figure or `unknown` with a null cost (never `computed`, never zero); every token counter stays null, never defaulted, when the backend did not report it.
- `packages/agent-claude-code/src/backend.ts` — `run()` now tracks the run's own event stream and surfaces the produced `AgentUsageRecord` on the resolved run result (`ClaudeCodeAgentRunner`/`AgentRunResultWithUsage`, additive over the core `AgentRunner` port). The core `AgentRunResult`'s `usage`/`costUsd` fields are now populated from real observed data — previously always `EMPTY_USAGE`.
- `packages/manager/src/ipc/protocol.ts` — a new `usage` worker-to-manager message (`IPC_MESSAGE_KINDS` now 8 entries), fenced like every other lease-scoped kind, carrying only the lease token and the payload columns — deliberately no feature/round/attempt identity, so a worker cannot even name a feature to attribute spend to.
- `packages/manager/src/worker-supervisor/supervisor.ts` / `daemon.ts` — the supervisor validates and fences a `usage` message exactly like `heartbeat`/`stage_result`/`fatal`, then calls a new `recordUsage` dep (wired to the existing `usageRepository(db).record`, never a second insert path) with the feature/round/stage-attempt identity from its own `spawn()` assignment.
- `packages/manager/src/worker-entry/stage-runner.ts` — sends the `usage` message (when the run produced one) before returning its stage result, so spend from a run killed mid-attempt still lands on the ledger. Still imports no `@adl/db`.
- `packages/manager/test/usage/recording.test.ts` — the fence (a stale lease token is dropped, no row inserted), no dedup (two messages insert two rows), no row for no usage, and a full `adl dev-run` → dispatch → forked worker → manager write against a scripted replay double, producing exactly one row with the correct join keys and null-not-zero cache-token columns.
- `.planning/STATE.md` — the cost-accounting blocker is rewritten to name what this plan actually proved (a real, tested, end-to-end recording path) and narrows the remaining unknown to one real, credentialed CLI invocation, per Prohibition P5.

## Task Commits

1. **Task 1: The backend's terminal event becomes a usage record with honest provenance** - `5dee65f` (feat)
2. **Task 2: The worker reports, the manager writes — one row per invocation** - `387d177` (feat)
3. **Task 3: Close the spike with evidence, or say plainly that it is still open** - `b1a4b5d` (docs)

**Plan metadata:** this SUMMARY's own commit (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave merges, except this plan's own Task 3 commit above, which the plan's own instructions name as the one exception)

## Files Created/Modified

- `packages/agent-claude-code/src/usage.ts` - `usageFromResult`, `AgentUsageRecord`, `UsageFromResultEvent`, `ModelSpeed`/`UsageCostSource`/`UsageCostCategory`
- `packages/agent-claude-code/test/usage.test.ts` - the mapping proofs, plus `claudeCodeBackend`'s usage-surfacing/reconciliation tests
- `packages/agent-claude-code/src/backend.ts` - `run()` tracks started/usage/result events, surfaces `usageRecord`, populates `usage`/`costUsd` on the core result
- `packages/agent-claude-code/src/index.ts` - exports the new usage surface (`usageFromResult`, `AgentUsageRecord`, `ClaudeCodeAgentRunner`, `AgentRunResultWithUsage`)
- `packages/manager/src/ipc/protocol.ts` - `UsageMessageSchema`, `IPC_MESSAGE_KINDS` grows to 8
- `packages/manager/src/worker-supervisor/supervisor.ts` - `recordUsage`/`RecordUsageInput` dep, `usage` message handling with the same fence discipline
- `packages/manager/src/worker-entry/stage-runner.ts` - `sendUsage`, sent before the stage result is reported
- `packages/manager/src/daemon.ts` - wires `recordUsage` to `usageRepository(db).record`
- `packages/manager/test/usage/recording.test.ts` - the fence, no-dedup, no-row-for-no-usage, and full dev-run proofs
- `packages/manager/test/helpers/usage-worker-entry.ts` - scripted worker double for exercising the supervisor's usage handling directly
- `packages/manager/test/ipc/assign-workspace.test.ts` - `IPC_MESSAGE_KINDS` length assertion updated 7 → 8 (Rule 1)
- `packages/manager/test/tracer/end-to-end.test.ts` - `IPC_MESSAGE_KINDS` sorted-list assertion updated to include `usage` (Rule 1)
- `.planning/STATE.md` - the cost-accounting blocker entry, scoped replacement

## Decisions Made

See `key-decisions` in frontmatter for full rationale. Summary:

1. `usageFromResult` reuses `events.ts`'s already-verified stream-json translation rather than re-deriving a second raw-JSON mapping of the same undocumented field names.
2. The capability-reconciliation "error-kind transcript event" from the plan's literal wording was implemented, found to break pre-existing behavior when run against the full suite, and removed — the honest `costSource: 'unknown'` on the recorded row is the real signal.
3. The `usage` IPC message carries no feature/round/attempt identity at all — structurally, not just by convention, closing T-4-38.
4. `claudeCodeBackend`'s return type widens additively (`ClaudeCodeAgentRunner`), verified backward-compatible against every existing test double by running the full suite.
5. STATE.md's blocker is narrowed rather than closed, per Prohibition P5 — no real credential or pinned-version CLI is available in this execution environment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Capability-reconciliation error event broke pre-existing "reports blocked honestly" behavior**
- **Found during:** Task 1, running the full `@adl/manager` suite after wiring the reconciliation logic the plan's action text describes ("a backend declaring it reports cost but the payload carried none... is worth an event of the error kind in the transcript").
- **Issue:** `worker-entry/stage-runner.ts`'s existing, load-bearing `firstError` tracking folds EVERY `kind: 'error'` `AgentEvent` into an infrastructure-failure `stage_error` outcome (P1's own prohibition). Emitting an error event whenever a result line simply omits a cost figure fires on every existing replay double that does so (`fake-claude-no-commit.mjs` among them), which broke `stage-runner.test.ts`'s pre-existing "a run producing no commit reports blocked honestly, never a pass" test — an otherwise-correct `developer_outcome: blocked` became a false `stage_error`.
- **Fix:** Removed the error-event emission. The honest, already-structural signal (`usageRecord.costSource === 'unknown'`, D-31) remains and is what Task 3's STATE.md narrowing and Prohibition P5 treat as the correctness gate — a second, transcript-level signal for the identical fact would either duplicate it or corrupt an unrelated stage's outcome, as observed.
- **Files:** `packages/agent-claude-code/src/backend.ts`, `packages/agent-claude-code/test/usage.test.ts`.
- **Verification:** `pnpm --filter @adl/manager test` (258/258) and `pnpm --filter @adl/agent-claude-code test` (59/59), both green; `pnpm test` (whole workspace) green.

**2. [Rule 1 - Bug] Two pre-existing tests asserted the IPC kind list stayed at exactly 7 entries**
- **Found during:** Task 2, adding the `usage` kind to `IPC_MESSAGE_KINDS`.
- **Issue:** `test/ipc/assign-workspace.test.ts` and `test/tracer/end-to-end.test.ts` both hard-asserted the frozen kind list's exact membership/length from Phase 3 — correct then, factually wrong once this plan's own change lands.
- **Fix:** Updated both to expect 8 entries including `usage`.
- **Files:** `packages/manager/test/ipc/assign-workspace.test.ts`, `packages/manager/test/tracer/end-to-end.test.ts`.
- **Verification:** `pnpm --filter @adl/manager test`, 258/258 passing.

---

**Total deviations:** 2 auto-fixed (both Rule 1 bug fixes — one in this plan's own new code found via full-suite verification, one an assertion made stale by this plan's own intentional schema change).
**Impact on plan:** No scope creep. The first fix removed behavior the plan's action text literally described but that conflicted with an existing, load-bearing prohibition elsewhere in the codebase — documented at length in `backend.ts`'s own "DELIBERATE DEVIATION" comment and recorded in `.planning/WINDOWS.md` (entry 4) for visibility at ship time.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None for this plan's own code. **Closing the cost-accounting spike fully** (STATE.md's narrowed blocker) requires a session with `ANTHROPIC_API_KEY` set and the pinned Claude Code CLI (2.1.237) on `PATH` — see STATE.md's Blockers/Concerns entry for the exact steps. Recorded in `.planning/WINDOWS.md` (entry 5).

## Next Phase Readiness

- The usage-recording path is real, tested, and wired end to end — Phase 6's budget enforcement can design against `usage_events` rows this phase actually produces (reported cost, null-not-zero tokens, fenced feature/round/attempt identity), rather than an assumption.
- The one still-open item, unchanged in kind from 04-01/04-06/04-07/04-09: no session to date has run the pinned CLI against a real credential. `packages/agent-claude-code/test/fixtures/` still does not exist. A future session with `ANTHROPIC_API_KEY` should run `adl dev-run` once, read the resulting `usage_events` row, and reconcile it against the Anthropic Console's billed usage — that single call would let a future pass capture the deferred fixtures AND perform this plan's own outstanding human-check AND 04-07's `claudeVersionCheckRunner` gap in one sweep.
- `AgentUsageRecord`'s `speed` field is always `'standard'` today (this adapter never requests Claude Code's fast mode) — a real, defensible default, but worth knowing if a future backend or configuration surface introduces a fast-mode request.

## Known Stubs

None. Every code path this plan added is real: `usageFromResult`, the IPC message, the supervisor's fence-and-insert handling, and the manager's write are all the actual implementation, exercised end to end against a scripted replay double in `recording.test.ts`. The one thing not yet exercised is a real, billed CLI invocation — a known, named gap (see Next Phase Readiness), not a stub in the shipped code.

## Self-Check: PASSED

- FOUND: `packages/agent-claude-code/src/usage.ts`
- FOUND: `packages/agent-claude-code/test/usage.test.ts`
- FOUND: `packages/manager/test/usage/recording.test.ts`
- FOUND: `packages/manager/test/helpers/usage-worker-entry.ts`
- FOUND commit `5dee65f` in `git log --oneline`
- FOUND commit `387d177` in `git log --oneline`
- FOUND commit `b1a4b5d` in `git log --oneline`

## Verification

- `pnpm --filter @adl/agent-claude-code test`: 59/59 passed (6 files).
- `pnpm --filter @adl/manager test`: 258/258 passed (30 files), including 12 new usage-recording tests.
- `pnpm test` (whole workspace): cli 33/33, core 446/446, plugin-sdk 28/28, agent-claude-code 59/59, db 75/75, workspace 222/228 (6 skipped, Windows-gated), manager 258/258, root architecture/spawn-ban suite 65/65 — all green, no regressions.
- `pnpm lint`: clean.
- `pnpm -r typecheck`: all 7 typechecked packages green.
- `pnpm format` (`prettier --check .`): clean.
- The human-check (a real `adl dev-run` against the pinned CLI with a real credential) did NOT run this session — see `## Next Phase Readiness` and STATE.md's narrowed blocker.

---

*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
