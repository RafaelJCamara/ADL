---
phase: 04-first-agent-backend-live-transcripts
verified: 2026-08-20T22:00:00Z
status: human_needed
score: 8/9 must-haves verified
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "A real invocation of the pinned Claude Code CLI (2.1.237), driven through Workspace.exec with a real ANTHROPIC_API_KEY, produces a real commit and a live-streamed transcript (BACK-05, phase goal's 'a real agent CLI')."
    test: "Run `adl dev-run <feature-id>` against a real feature folder with the pinned `claude` CLI (2.1.237) on PATH and a real `ANTHROPIC_API_KEY` set for the daemon process; in a second terminal run `adl logs -f <stage-attempt-id>`."
    expected: "The transcript scrolls live while the run is in progress (not all at once at the end); the SSE stream terminates on its own once the stage attempt ends (CR-01 fix); `git log` on the feature's branch shows a new commit authored as `ADL (claude-code) <...>`, not the operator's own identity; the recorded `usage_events` row reconciles against the Anthropic Console's billed usage for the same call."
    why_human: "Requires a paid, credentialed invocation of a real, versioned third-party CLI — cannot be exercised by grep/static analysis, and every session that attempted this phase (04-01 through 04-10) recorded the same missing-credential/PATH-shadowing blocker rather than fabricating a substitute. This is a real external dependency, not a code defect."
---

# Phase 4: First Agent Backend & Live Transcripts Verification Report

**Phase Goal:** A real agent CLI, driven through the workspace, produces a commit and a transcript the maintainer can watch as it happens.
**Verified:** 2026-08-20T22:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `AgentRunner` is a real, callable port (BACK-01) — `run`/`probe`, an 8-kind vendor-neutral `AgentEvent` union, no vendor-specific vocabulary | ✓ VERIFIED | `packages/core/src/stage/agent.ts:451` defines `AgentRunner`; `AGENT_EVENT_KINDS` (lines 298-306) has exactly 8 entries matching D-07; `packages/core/test/stage/agent-runner.test-d.ts` proves a `number` is not assignable; re-exported by reference identity through `@adl/plugin-sdk` (`test/reexport-identity.test.ts`). `pnpm --filter @adl/core test` 446/446, `pnpm --filter @adl/plugin-sdk test` 28/28. |
| 2 | The Claude Code adapter (`@adl/agent-claude-code`) exists, is spawn-ban-covered, and translates the CLI's documented event shapes without loss (BACK-05, code-level) | ✓ VERIFIED | `packages/agent-claude-code/src/backend.ts` (`claudeCodeBackend`), `src/events.ts` (`translateLine`), `src/preflight.ts`, `src/usage.ts` all exist and are real implementations (not stubs). Spawn-ban proof: `test/lint/no-restricted-imports.test.ts` asserts the package is governed by `adl/no-direct-spawn`, exemption list length 1. `pnpm --filter @adl/agent-claude-code test` 59/59. |
| 3 | A real, credentialed invocation of the pinned Claude Code CLI (2.1.237) through `Workspace.exec` produces a real commit and a live transcript (BACK-05, the phase goal's literal "a real agent CLI") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Never exercised in any session across this phase (04-01 through 04-10). Every plan's SUMMARY records the identical blocker: no `ANTHROPIC_API_KEY` available, and the host's `claude` on PATH resolves to `2.1.227`, not the pinned `2.1.237` (PATH-shadowed by an older WinGet install; the npm-installed 2.1.237 binary was confirmed correct by direct path invocation but never used for a capture). `04-01` Task 3's real-CLI fixture capture (the "capture what the pinned CLI actually emits" task) is genuinely incomplete — `packages/agent-claude-code/test/fixtures/` does not exist on disk. `04-06`'s Task 1 `<human-check>` (start a daemon with the real CLI+credential, watch `adl logs -f` scroll live, confirm the commit) was explicitly not performed, per that plan's own SUMMARY. `04-10`'s human-check (reconcile a real `usage_events` row against the Anthropic Console) likewise did not run. All of this is proactively logged in `.planning/WINDOWS.md` (entries 2 and 5, kind `unrun-verify`) and `.planning/STATE.md`'s Blockers/Concerns section — not silently dropped. Routed to human verification below. |
| 4 | `adl dev-run <feature-id>` travels the real manager→worker path (real lease, real forked child, real worktree) and produces a real commit, proven against a scripted replay double standing in for the CLI | ✓ VERIFIED | `packages/manager/test/tracer/dev-run-end-to-end.test.ts` — real forked worker (pid read from its own `ready` message), real git worktree, transcript file byte length asserted to grow strictly between two reads taken while the stage is running, commit read via `git rev-parse HEAD` before teardown, commit author `ADL (claude-code)`. `pnpm --filter @adl/manager test` 263/263 (includes this test). |
| 5 | `adl logs -f` streams the transcript live and terminates on its own once the run ends (OBS-02) | ✓ VERIFIED (with a fixed critical defect) | `04-REVIEW.md` CR-01 found `closeAttempt` was never called from production code, so `ended_at` stayed null forever and the SSE follow route could never emit `ended` — `adl logs -f` would hang indefinitely after a real run finished. Fixed in commit `aa29fd3`, wiring `closeAttempt` into `createSupervisor`'s `stage_result`/`fatal` handling; new regression tests in `packages/manager/test/usage/recording.test.ts` ("closeAttempt wiring (CR-01)") include a negative control proving the bug reproduces without the wiring. Follow loop (`GET /stages/:id/logs?follow=1`), four wire states, and the kill-and-reattach reconnect proof are in `packages/manager/test/api/logs-reconnect.test.ts` (13/13 passing). |
| 6 | Transcript integrity: concurrent event writes cannot corrupt or reorder the NDJSON file | ✓ VERIFIED (with a fixed critical defect) | `04-REVIEW.md` CR-02 found `createProductionStageRunner`'s `onEvent` pushed unawaited `appendRecord` calls against one shared `FileHandle` — Node documents this as order-unsafe. Fixed in commit `aa29fd3` by serializing appends through an internal write queue in `openTranscriptWriter` (`packages/manager/src/store/ndjson-log-store.ts:140-172`); new tests prove ordering under concurrent unawaited calls and that a rejected append doesn't poison later ones. |
| 7 | A missing/broken agent backend is reported as an infrastructure failure, never a passing verdict (prohibition P1) | ✓ VERIFIED | `packages/manager/test/worker-entry/stage-runner.test.ts` and `04-06` Task 2's tests cover missing binary, auth failure, non-zero exit with no terminal event, and unclassifiable result — each asserted as `stage_error`, never a pass. `packages/manager/src/boot/backend-preflight.ts` additionally hard-blocks `startDaemon` on a version mismatch/missing binary/unsupported backend id (opt-in via `StartDaemonOptions.agentBackendVersionCheck`), tested in `packages/manager/test/boot/backend-preflight.test.ts`. |
| 8 | An agent-authored commit names ADL and the backend, never a human, in `git log` (prohibition P2) | ✓ VERIFIED | `packages/manager/src/worker-entry/stage-runner.ts:89-107` sets `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` to `ADL (claude-code)` as ordinary exec-spec environment data (not through the refused git-config channel); the tracer test reads the commit object's recorded author directly, asserted stable across runs and different from the host's git identity. |
| 9 | The transcript record's on-disk shape is decided and documented, and the vendor-neutral port survives contact with a second, non-Claude concept boundary (prohibition P3) | ✓ VERIFIED | `TranscriptRecordSchema` (option-c: translated `AgentEvent` + scoped raw backend line) documented in `agent.ts`; no member of `AgentRunner`/`AgentEvent`/`AgentTask`/`AgentCapabilities` names a Claude-Code-specific concept (`session_id`, `stream-json`, `total_cost_usd` are absent; the one genuinely backend-owned concept, a resumable session, is modelled as an opaque `sessionRef`). Flagged, honestly, as unfalsifiable with only one implementation (04-03's own `<flagged_assumptions>`) — Phase 11 is where a second family tests this claim for real. |

**Score:** 8/9 truths verified (1 present + wired, real-CLI behavior not exercised — see human verification)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/core/src/stage/agent.ts` | `AgentRunner`, `AgentEvent`, `AGENT_EVENT_KINDS`, `TranscriptRecord` | ✓ VERIFIED | Present, real, exported, tested (446/446 core tests). |
| `packages/agent-claude-code/src/backend.ts` | `claudeCodeBackend` — the `AgentRunner` implementation | ✓ VERIFIED | Present, calls `workspace.exec` exactly once per `run` (asserted by test), no direct process import. |
| `packages/agent-claude-code/src/events.ts` | `translateLine` | ✓ VERIFIED | Present; classify-don't-throw on malformed lines (tested). Built against *documented* real shapes plus 04-06's own inline representative fixtures — **not** against a captured real-CLI fixture (see truth #3). |
| `packages/agent-claude-code/src/preflight.ts` | Version probe, classify-don't-throw | ✓ VERIFIED | Present, wired into `backend.probe()` and the manager's startup gate. |
| `packages/agent-claude-code/src/usage.ts` | `usageFromResult` — terminal event → usage row | ✓ VERIFIED | Present, honest `costSource` provenance (`reported`/`unknown`, never `computed`), wired end to end via a new fenced `usage` IPC message. |
| `packages/agent-claude-code/test/fixtures/` (CAPTURE.md, stream-json-*.ndjson, result-json.json, fake-claude.mjs) | Real captured CLI output + replay double, per 04-01's own `must_haves.artifacts` | ✗ MISSING | Directory does not exist on disk. 04-01 Task 3 was never completed in any session across this phase — recorded honestly in every downstream SUMMARY (04-03, 04-06, 04-07, 04-09, 04-10) as a carried "Known Gap," never fabricated. This is the artifact-level root cause of truth #3's PRESENT_BEHAVIOR_UNVERIFIED status. |
| `packages/manager/src/api/routes/dev-run.ts`, `logs.ts` | `POST /dev-run/:featureId`, `GET /stages/:id/logs` | ✓ VERIFIED | Present, tested (401/404 cases, follow loop, reconnect). |
| `packages/cli/src/commands/dev-run.ts`, `logs.ts` | `adl dev-run`, `adl logs -f` | ✓ VERIFIED | Present, registered in `packages/cli/src/index.ts`, tested. |
| `packages/manager/src/bookkeeping/attempt.ts` | `openAttempt`/`closeAttempt`/`findAttempt` | ✓ VERIFIED | Present; `closeAttempt` now actually called from production (post-review fix), not just defined. |
| `packages/manager/src/store/ndjson-log-store.ts`, `transcript-path.ts` | Byte-offset append/read primitive | ✓ VERIFIED | Present; writes now serialized (post-review fix). |
| `packages/manager/src/prompt/build.ts`, `artifact.ts` | Deterministic prompt rendering + persisted artifact | ✓ VERIFIED | Byte-identical across two real processes (`determinism.test.ts`, including a cross-process leg and a negative control). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `packages/agent-claude-code/src/backend.ts` | `packages/core/src/stage/workspace.ts` | `workspace.exec(spec, log)` | ✓ WIRED | Adapter imports no process library; asserted by dedicated "exactly one exec" test and the lint suite. |
| `packages/manager/src/worker-entry/stage-runner.ts` | `packages/manager/src/store/ndjson-log-store.ts` | Append-as-events-arrive | ✓ WIRED | Confirmed by the tracer test's transcript-growth assertion (byte length grows strictly between two in-flight reads). |
| `packages/manager/src/api/routes/logs.ts` | `packages/manager/src/bookkeeping/attempt.ts` | `findAttempt` resolves `:id` before any path is built | ✓ WIRED | T-4-07 traversal guard; test asserts unresolvable id → 404, no filesystem read. |
| `packages/manager/src/worker-supervisor/supervisor.ts` | `packages/manager/src/bookkeeping/attempt.ts` | `closeAttempt` called on `stage_result`/`fatal` | ✓ WIRED (post-review fix) | Was NOT wired at first review pass (CR-01); fixed and regression-tested in commit `aa29fd3`. |
| `packages/cli/src/commands/logs.ts` | `packages/cli/src/http-client.ts` | `DaemonClient.streamStageLogs` | ✓ WIRED | One client, one bearer-header path; resumable on the offset actually written to the sink. |

### Data-Flow Trace (Level 4)

Not applicable in the UI-rendering sense — this phase has no dashboard. The equivalent trace (event → transcript file → SSE wire → CLI stdout) is covered by the tracer and reconnect tests above and confirmed wired, not stubbed.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full monorepo test suite | `pnpm -r test` | cli 33/33, core 446/446, plugin-sdk 28/28, agent-claude-code 59/59, db 75/75, workspace 222/228 (6 platform-gated skips), manager 263/263 | ✓ PASS |
| Root architecture/spawn-ban suite | `npx vitest run --project root` | 65/65 | ✓ PASS |
| Lint | `pnpm lint` | clean | ✓ PASS |
| Typecheck | `pnpm -r typecheck` | 7/7 packages clean | ✓ PASS |
| `closeAttempt` wiring (CR-01) fix present | grep + read | Wired into `supervisor.ts`'s `stage_result`/`fatal` handling, `daemon.ts` supplies the write | ✓ PASS |
| `ndjson-log-store.ts` write queue (CR-02) fix present | grep + read | `writeQueue` serialization present, lines 140-172 | ✓ PASS |
| Real Claude Code CLI invocation | n/a | Never run in any session | ? SKIP — routed to human verification |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| BACK-01 | 04-03 | `AgentRunner` port, real and vendor-neutral | ✓ SATISFIED | Truth #1, #9 above. |
| BACK-05 | 04-01, 04-06, 04-07, 04-09, 04-10 | Claude Code headless works as a backend | ? NEEDS HUMAN | Code-level: SATISFIED (truth #2, #4, #7). Real-CLI behavior: unverified (truth #3) — the phase's own literal wording ("Claude Code headless *works*") is unproven against a real invocation in every session to date. |
| OBS-02 | 04-04, 04-06, 04-08 | Maintainer can follow a running agent's transcript live | ✓ SATISFIED | Truths #4, #5, #6 — including two critical defects (CR-01, CR-02) found by code review and fixed with regression tests before this verification pass. |

No orphaned requirements — REQUIREMENTS.md maps exactly BACK-01, BACK-05, OBS-02 to Phase 4, all three appear in plan frontmatter `requirements` fields (04-01, 04-03, 04-04, 04-06, 04-07, 04-09, 04-10).

### Anti-Patterns Found

None blocking. Scanned modified files for `TODO`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER` and hardcoded-empty-data patterns; the only "placeholder" language found is intentional and documented (e.g. `stage_result`'s `roundId: 0, stageIndex: 0` placeholder, IN-01 in `04-REVIEW.md`, explicitly scoped to a later phase and not reachable by anything in this phase). The 3 Warnings and 3 Info findings from `04-REVIEW.md` (WR-01 hardcoded 10-min timeout, WR-02 unguarded `join()` in `loadSpecFromWorktree`, WR-03 no `--` argv separator, IN-01/02/03) remain open as documented follow-ups — none are currently exploitable or block a success criterion, per the review's own severity classification, and none are debt markers requiring the debt-marker gate.

## Human Verification Required

### 1. A real, credentialed Claude Code CLI invocation, end to end

**Test:** With the pinned Claude Code CLI (`@anthropic-ai/claude-code@2.1.237`) resolving on the daemon's PATH and a real `ANTHROPIC_API_KEY` set, start the daemon against a repository containing one real `features/<id>/` folder. In one terminal run `adl dev-run <feature-id>`; in another run `adl logs -f <stage-attempt-id>`.

**Expected:** The transcript scrolls live while the run is still going (not all at once at the end); the `adl logs -f` process exits on its own once the run finishes (does not need Ctrl-C); `git log` on the feature's branch shows a new commit authored as `ADL (claude-code) <...>`, never the operator's own git identity; the resulting `usage_events` row (`usageRepository(db).listForFeature`) has `cost_source: 'reported'` and a plausible cost that reconciles against the Anthropic Console's billed usage for the same window.

**Why human:** Requires a paid, credentialed invocation of a real third-party CLI binary — this cannot be exercised through static analysis or a scripted double, and is a genuine external dependency (API key + correctly-resolved pinned binary), not a code defect. Every execution session across this entire phase (04-01 through 04-10) hit the identical missing-credential / PATH-shadowing blocker and documented it rather than fabricating a substitute (`.planning/WINDOWS.md` entries 2 and 5; `.planning/STATE.md` Blockers/Concerns).

**If this fails:** The most likely failure points, per the phase's own recorded uncertainty, are (a) `translateLine`'s mapping of the real `stream-json` output — built from documented shapes, not a captured fixture, so an undocumented real field name could produce unexpected `error`-kind events; (b) the auth-failure keyword classifier (`/auth|unauthorized|401|api[_-]?key/i`) in `backend.ts`, a best-effort stand-in with no real fixture to validate against; (c) the `usage` object's real field names/nesting (04-RESEARCH.md Assumption A1), which `usage.ts` maps from the same unverified assumption.

## Gaps Summary

No gaps that block the phase goal at the code level — the architecture, wiring, and defensive discipline (path traversal, classify-don't-throw, byte-offset addressing, commit attribution, infrastructure-failure handling) are all real and tested, and two critical defects a code review found (CR-01: `adl logs -f` could never terminate on its own; CR-02: concurrent transcript writes could corrupt the file) were fixed with regression tests before this verification pass.

What remains open is a single, honestly-and-repeatedly-documented external dependency: no session across this entire phase has run the pinned Claude Code CLI against a real credential. The phase goal's literal wording — "**a real** agent CLI... produces a commit and a transcript" — is therefore proven at the code/wiring level and via a scripted replay double standing in for the CLI, but not yet proven against the actual external binary the phase is about. This is exactly the class of item the escalation-gate pattern exists for: routed to human verification rather than silently marked passed or falsely marked failed.

---

_Verified: 2026-08-20T22:00:00Z_
_Verifier: Claude (gsd-verifier)_
