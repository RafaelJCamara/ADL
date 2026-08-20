---
phase: 04-first-agent-backend-live-transcripts
plan: 07
subsystem: agent-backend-preflight
tags: [claude-code-adapter, version-pin, startup-gate, boot-sequence, manager, agent-claude-code]

requires:
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-01: PINNED_CLAUDE_CODE_VERSION, @adl/agent-claude-code package scaffold (Task 3 — real CLI fixture capture — still deferred)"
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-06: claudeCodeBackend / AgentRunner.probe() placeholder, packages/manager/src/daemon.ts's fixed startup order, DEFAULT_CONFIG.agents.developer.backend"
provides:
  - "parseClaudeVersion / preflightClaudeCode (packages/agent-claude-code/src/preflight.ts) — an I/O-free, injected-runner version probe that classifies rather than throws"
  - "claudeCodeBackend.probe() now delegates to preflightClaudeCode via ClaudeCodeBackendOptions.runVersionCheck"
  - "runBackendPreflight / BackendUnavailableError / claudeVersionCheckRunner (packages/manager/src/boot/backend-preflight.ts) — the manager-side hard-block startup gate, mirroring runStartupGate's refuse/proceed shape"
  - "StartDaemonOptions.agentBackendVersionCheck — the opt-in seam that activates the gate in startDaemon"
affects: [04-08-logs-follow-loop, 04-09-prompt-persistence-and-byte-identity, future-adl-daemon-start-cli-entry-point]

actuals:
  tokens: 12600
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Classify, don't throw, at a startup gate — preflightClaudeCode and runBackendPreflight both return a discriminated outcome, never reject for an expected-but-notable failure, following StageError/runStartupGate's existing discipline"
    - "A refusal mirrors SchemaVersionRefusalError exactly: return-then-throw at the one caller (startDaemon), db.destroy() before rethrow, placed before the supervisor/API/dispatch-timer construction — one shape of 'the daemon refused to start', not two"
    - "The real subprocess invocation is a caller-supplied dependency, never constructed inside the classifying function — preflightClaudeCode takes an injected runVersionCheck (agent-claude-code, I/O-free); runBackendPreflight takes the same shape from its own caller; claudeVersionCheckRunner (the one place that actually shells out, via @adl/workspace's run() with owner: 'adl') lives in the manager, the one package in this chain allowed to touch a process"

key-files:
  created:
    - packages/agent-claude-code/src/preflight.ts
    - packages/agent-claude-code/test/preflight.test.ts
    - packages/manager/src/boot/backend-preflight.ts
    - packages/manager/test/boot/backend-preflight.test.ts
  modified:
    - packages/agent-claude-code/src/backend.ts
    - packages/agent-claude-code/src/index.ts
    - packages/agent-claude-code/test/backend.test.ts
    - packages/manager/src/daemon.ts

key-decisions:
  - "The backend preflight gate is OPT-IN in startDaemon via StartDaemonOptions.agentBackendVersionCheck, not automatically constructed from a real claude --version invocation. Absent, the gate is skipped entirely — every startDaemon() call site that predates this plan (6 test files, none in this plan's own scope) keeps starting exactly as before. Defaulting to a real subprocess call would have made every one of those tests depend on an exactly-pinned claude CLI being on the daemon's PATH, which this host does not have (04-01's own recorded PATH-shadowing: 2.1.227 resolves, not the pinned 2.1.237) — that default would have broken 209+ currently-green tests outside this plan's file list to enforce a gate none of them exercise. claudeVersionCheckRunner (the real, production constructor) is exported and documented for a future adl daemon start entry point (not yet built) to wire unconditionally."
  - "'No agent backend configured' maps to daemonConfig.agents.developer.backend resolving to anything other than SUPPORTED_BACKEND_ID ('claude-code', read off DEFAULT_CONFIG rather than a second hardcoded literal). This is a real, reachable production scenario: AgentBlockSchema.backend is a free-form daemon-only string with no enum constraint, so an operator CAN configure a backend id this build does not implement — before this plan the production stage runner ignored that entirely and hardcoded claudeCodeBackend regardless, so a misconfigured daemon would have started and silently failed every stage."
  - "preflightClaudeCode's three not-ok kinds are binary_missing, unparseable, and version_mismatch. The first two reuse @adl/core/stage's existing StageErrorKind vocabulary (per the plan's own instruction to reuse it where a name already exists); version_mismatch is this module's own name, since PreflightResult is a startup-gate concern, not a per-invocation StageError."
  - "KNOWN GAP (carried from 04-01 Task 3, still deferred, no ANTHROPIC_API_KEY in this session): no captured test/fixtures/claude-version.txt exists. Per the maintainer's explicit rejection (04-01) of fabricating fixture files from documentation or invented output, none was created here either. Tests are pinned against the one real, recorded evidence on file — 04-01-SUMMARY.md's quoted \"2.1.227 (Claude Code)\" from a real invocation of the (older, non-pinned) WinGet-installed binary — plus a documented-format stand-in for the pinned version, explicitly labelled as NOT a fixture in preflight.ts's own docblock and in the test file's own comments."

requirements-completed: [BACK-05]

coverage:
  - id: D1
    description: "parseClaudeVersion finds a version-shaped token defensively (not a whole-string match), tolerating surrounding text and the CLI's real observed suffix format"
    verification:
      - kind: unit
        ref: "packages/agent-claude-code/test/preflight.test.ts#parseClaudeVersion"
        status: pass
    human_judgment: false
  - id: D2
    description: "preflightClaudeCode never throws and distinguishes binary_missing, unparseable, and version_mismatch, each with a detail naming expected, found, and 'broken installation'"
    verification:
      - kind: unit
        ref: "packages/agent-claude-code/test/preflight.test.ts#preflightClaudeCode"
        status: pass
      - kind: unit
        ref: "packages/agent-claude-code/test/backend.test.ts#claudeCodeBackend probe()"
        status: pass
    human_judgment: false
  - id: D3
    description: "run() performs exactly one exec — the version check is never invoked from the run path"
    verification:
      - kind: unit
        ref: "packages/agent-claude-code/test/backend.test.ts#run() performs exactly one exec"
        status: pass
    human_judgment: false
  - id: D4
    description: "startDaemon refuses (BackendUnavailableError) on a version mismatch, a missing binary, or unreadable output, naming expected/found/broken, before any feature is leased and before the API server binds"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/backend-preflight.test.ts#startDaemon — backend preflight gate (04-07)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A daemon configured with an unsupported/absent backend id refuses with a named 'no-backend-configured' error"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/backend-preflight.test.ts#a daemon configured with no agent backend refuses to start with a named error"
        status: pass
    human_judgment: false
  - id: D6
    description: "The gate runs exactly once per daemon start, regardless of how many features are subsequently dispatched, and the schema gate is evaluated before the backend gate"
    verification:
      - kind: unit
        ref: "packages/manager/test/boot/backend-preflight.test.ts#runs once per daemon start"
        status: pass
      - kind: unit
        ref: "packages/manager/test/boot/backend-preflight.test.ts#the schema gate is evaluated before the backend gate"
        status: pass
    human_judgment: false
  - id: D7
    description: "The real, production version-check invocation (claude --version through the ADL-owned exec boundary) exists and is wired for a future adl daemon start entry point, but was never exercised against a real, pinned CLI in this session (04-01 Task 3 gap)"
    verification: []
    human_judgment: true
    rationale: "No ANTHROPIC_API_KEY and no confirmed pinned CLI on this host's PATH (04-01's own recorded PATH-shadowing). claudeVersionCheckRunner's exec-boundary wiring is code-reviewed and typechecked but not run against a real claude binary — a human (or a future plan once 04-01 Task 3 lands) should verify it against the real, pinned CLI before an operator relies on the hard-block in production."

duration: ~2h (across two auto-mode sessions)
completed: "2026-08-20"
status: complete
---

# Phase 04 Plan 07: The Version Preflight — Probe, Startup Gate, and a Named "No Backend" Refusal Summary

**`preflightClaudeCode`/`parseClaudeVersion` (I/O-free, injected-runner classification) plus `runBackendPreflight` (the manager's startup gate, mirroring `runStartupGate`'s refuse/proceed shape) — a broken Claude Code CLI install or an unsupported configured backend now hard-blocks `startDaemon` before a single feature is leased, opt-in via `StartDaemonOptions.agentBackendVersionCheck` so no pre-existing test depends on a real, pinned CLI.**

## Performance

- **Duration:** ~2h across two auto-mode sessions (interrupted once by a rate-limit reset, resumed per coordinator instruction)
- **Tasks:** 2/2
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- `packages/agent-claude-code/src/preflight.ts` — `parseClaudeVersion` (defensive version-token regex, not a whole-string match) and `preflightClaudeCode` (I/O-free, takes an injected version-check runner, never throws, returns one of `ok` or three distinguishable not-ok kinds: `binary_missing`, `unparseable`, `version_mismatch`).
- `claudeCodeBackend.probe()` now delegates to `preflightClaudeCode` via an optional `ClaudeCodeBackendOptions.runVersionCheck`, replacing the tracer's inline placeholder. `run()` still performs exactly one exec — the version check is never invoked from the run path (asserted by a dedicated test).
- `packages/manager/src/boot/backend-preflight.ts` — `runBackendPreflight(deps)`, the manager-side startup gate. Returns a discriminated `passed | refused` outcome; `startDaemon` turns a refusal into a thrown `BackendUnavailableError`, exactly mirroring `SchemaVersionRefusalError`'s existing shape. `SUPPORTED_BACKEND_ID` is read off `DEFAULT_CONFIG.agents.developer.backend` rather than a second hardcoded literal. `claudeVersionCheckRunner` is the real, production version-check constructor — `claude --version` through `@adl/workspace`'s `run()` with `owner: 'adl'`.
- Wired into `daemon.ts`'s fixed startup order: after the schema gate, repo reconciliation, and boot orphan kill; strictly before the supervisor is created, the API binds, or the dispatch timer starts. A refusal closes the database handle and rethrows, same as the schema refusal path.
- A daemon configured for a backend id this build does not implement (`agents.developer.backend` resolving to anything other than `"claude-code"`) is a named `no-backend-configured` refusal, not a silent start that later reports every stage as an unexplained failure.
- 22 new unit/integration tests across both packages, all passing, plus the full existing suite (`pnpm -r test`: 1116 passing / 6 skipped) unmodified and green.

## Task Commits

1. **Task 1: The probe — pinned exactly, classified rather than thrown, parsed against a recorded fixture** - `c694252` (feat)
2. **Task 2: A broken installation stops the daemon before it leases anything** - `b365c09` (feat)

## Files Created/Modified

- `packages/agent-claude-code/src/preflight.ts` - `parseClaudeVersion`, `preflightClaudeCode`, `PreflightResult`, `PreflightFailureKind`, `VersionCheckResult`
- `packages/agent-claude-code/test/preflight.test.ts` - parser + preflight behavior tests, pinned against documented evidence (no real fixture — see Known Gaps)
- `packages/agent-claude-code/src/backend.ts` - `probe()` delegates to `preflightClaudeCode`; `ClaudeCodeBackendOptions.runVersionCheck` added
- `packages/agent-claude-code/src/index.ts` - exports the preflight surface
- `packages/agent-claude-code/test/backend.test.ts` - `probe()` delegation tests, "exactly one exec" test
- `packages/manager/src/boot/backend-preflight.ts` - `runBackendPreflight`, `BackendUnavailableError`, `SUPPORTED_BACKEND_ID`, `claudeVersionCheckRunner`
- `packages/manager/test/boot/backend-preflight.test.ts` - 13 tests: `runBackendPreflight` unit coverage + `startDaemon`-level gate proof
- `packages/manager/src/daemon.ts` - `StartDaemonOptions.agentBackendVersionCheck`, gate wired into the fixed startup order, docblock updated

## Decisions Made

See `key-decisions` in frontmatter for full rationale. Summary:

1. The gate is **opt-in** in `startDaemon` (`agentBackendVersionCheck` absent ⇒ skipped) rather than defaulting to a real subprocess invocation — protects the 209+ pre-existing, currently-green manager tests (6 `startDaemon()` call sites outside this plan's scope) from depending on an exactly-pinned `claude` CLI this host does not have.
2. "No agent backend configured" is implemented as "the resolved backend id is not one this build implements" (`SUPPORTED_BACKEND_ID`), since `agents.developer.backend` is a free-form, daemon-only string with no enum constraint.
3. Three not-ok kinds (`binary_missing`, `unparseable`, `version_mismatch`) — the first two reuse `@adl/core/stage`'s `StageErrorKind` vocabulary where it already names the condition; the third is preflight's own, since a startup-gate refusal is not itself a `StageError`.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing critical functionality, or blocking issues were found beyond the design decisions above (which are documented as decisions, not deviations, since they were architectural choices made within the plan's own stated flexibility, not corrections of broken code).

### Scope Note (not a Rule 1-3 deviation — documented for transparency)

**The acceptance criterion "A test reads `test/fixtures/claude-version.txt` from disk" was not met literally.** No such fixture exists (04-01 Task 3, deferred, no `ANTHROPIC_API_KEY` in any session to date). Per this execution's own objective note — "work from the documented pinned constant instead and note the gap in SUMMARY.md rather than blocking" — and per the maintainer's explicit prior rejection (04-01) of fabricating CLI fixture files from documentation, `preflight.test.ts` instead pins its assertions against the one real, recorded evidence on file (04-01-SUMMARY.md's quoted real WinGet-CLI output) plus an explicitly-labelled documented-format stand-in for the pinned version. This is not a fabricated fixture — it is real evidence, just not a formal, re-capturable file. See `preflight.ts`'s own module docblock and the test file's own comments for the full note.

**`StartDaemonOptions.agentBackendVersionCheck` being opt-in is a deviation from a naive "the gate is always on" reading of D-02**, but was necessary to avoid breaking the 6 pre-existing `startDaemon()` test call sites (none in this plan's `files_modified` list) that would otherwise have started depending on a real, pinned CLI on the daemon's `PATH` — which this host (and likely CI) does not have. This trade-off is documented at length in `daemon.ts`'s own option docblock and in the `key-decisions` above, rather than silently made.

No deviation required a checkpoint (Rule 4) — both notes above are transparency about a scope trade-off within the plan's own stated flexibility ("work from the documented pinned constant... note the gap"), not corrections of a bug in this plan's own new code.

## Known Stubs

None. Every code path this plan added is real: `preflightClaudeCode` and `runBackendPreflight` are the actual classification logic, `claudeVersionCheckRunner` is a real exec-boundary invocation (just not yet exercised against a real, pinned CLI — see Coverage D7 and Known Gaps below).

## Known Gaps

- **`04-01`'s Task 3 real-CLI fixture capture is still outstanding.** Same gap 04-03 and 04-06 both recorded for the same reason (no `ANTHROPIC_API_KEY`, and a PATH-shadowing issue resolving an older, non-pinned `claude` install on this host). `preflight.ts`'s parser and its tests are built against the one real, recorded evidence on file plus a documented-format stand-in, not a captured fixture.
- **`claudeVersionCheckRunner` (the real production version-check constructor) has never been run against a real, pinned `claude` CLI.** It is typechecked, lint-clean, and its exec-boundary wiring follows the exact pattern `adl-git.ts`'s `owner: 'adl'` invocations already use — but it has zero test coverage against a real binary, only against injected fakes. Recorded as coverage item D7 (`human_judgment: true`).
- **No `adl daemon start` CLI entry point exists yet to wire `agentBackendVersionCheck` unconditionally for a real production daemon.** `claudeVersionCheckRunner` is exported and documented for that future caller; until it exists, the hard-block gate is exercised only by this plan's own tests and by any future caller that opts in explicitly.

## Self-Check: PASSED

- FOUND: `packages/agent-claude-code/src/preflight.ts`
- FOUND: `packages/agent-claude-code/src/backend.ts`
- FOUND: `packages/agent-claude-code/src/index.ts`
- FOUND: `packages/agent-claude-code/test/preflight.test.ts`
- FOUND: `packages/manager/src/boot/backend-preflight.ts`
- FOUND: `packages/manager/src/daemon.ts`
- FOUND: `packages/manager/test/boot/backend-preflight.test.ts`
- FOUND commit `c694252` in `git log --oneline --all`
- FOUND commit `b365c09` in `git log --oneline --all`

## Verification

- `pnpm --filter @adl/agent-claude-code test`: 44/44 passed (4 files).
- `pnpm --filter @adl/manager test`: 222/222 passed (27 files), including 13 new backend-preflight tests.
- `pnpm -r test` (whole workspace): cli 24/24, core 446/446, plugin-sdk 28/28, agent-claude-code 44/44, db 75/75, workspace 222/222 (+6 platform-gated skips), manager 222/222 — all green, no regressions.
- `pnpm exec vitest run --project root` (architecture/spawn-ban suite): 65/65 passed.
- `pnpm -r typecheck`: all 7 typechecked packages green.
- `pnpm lint`: clean.
- `pnpm format`: clean (all matched files use Prettier code style).
- The Phase 3 startup, recovery, and shutdown suites are unchanged in behaviour and still green — this plan inserted one step into a fixed order and reordered nothing.

## Next Phase Readiness

- `preflightClaudeCode`/`runBackendPreflight` are real, tested, and wired — `04-08` (logs follow loop) and `04-09` (prompt persistence/byte-identity) build on this plan's shapes with no redesign expected.
- The one open item for whoever builds `adl daemon start`: wire `StartDaemonOptions.agentBackendVersionCheck` to `claudeVersionCheckRunner(...)` unconditionally so a real production daemon gets D-02's hard-block by default — this plan deliberately left that unconditional wiring for that future entry point rather than breaking today's test suite to force it now.
- `04-01`'s Task 3 (real CLI fixture capture) remains the one recurring gap across 04-03, 04-06, and this plan. Landing it lets a future pass reconcile `preflight.ts`'s parser and `events.ts`'s translator against real captured output in one sweep.

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
