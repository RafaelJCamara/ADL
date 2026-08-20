---
phase: 04-first-agent-backend-live-transcripts
plan: 03
subsystem: api
tags: [zod, agent-backend, typescript, contracts]

# Dependency graph
requires:
  - phase: 01-core-contracts
    provides: StageErrorKind/StageErrorKindSchema (D-12 classification), the frozen-tuple + Exclude<> exhaustiveness pattern (FEATURE_EVENT_KINDS), RepoRelativePathSchema
  - phase: 02-workspace-the-exec-boundary
    provides: Workspace, ExecSpec, LogChunk — AgentRunContext.workspace and the "adapter launches through workspace.exec()" contract
provides:
  - "AgentRunner: a real, callable interface (run/probe) replacing the Phase-1 forward declaration in packages/core/src/stage/stage.ts"
  - "AgentEvent: an 8-kind discriminated union (started, text, thinking, tool_call, tool_result, usage, result, error) — the vendor-neutral spine every backend family translates into"
  - "AgentTask, AgentCapabilities, AgentRunResult, AgentProbe — the rest of the port's vocabulary"
  - "TranscriptRecordSchema — the on-disk transcript envelope (option-c: translated event + scoped raw line)"
  - "The whole surface re-exported through @adl/plugin-sdk by reference identity"
affects: [04-01-claude-code-adapter, 04-05-claude-code-adapter-wiring, 04-06-ndjson-transcript-store, 04-07-logs-sse-route, 04-10-cost-mapper, phase-09-pr-rollup, phase-11-second-agent-backend, phase-17-dashboard]

# Actuals (#2632)
actuals:
  tokens: 12243
  tasks: 1
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Forward-declaration replacement: real interfaces live in their own module (agent.ts), stage.ts imports and re-exports so @adl/core/stage stays the single import path — the exact pattern Workspace already established"
    - "Frozen-tuple + Exclude<> compile-time exhaustiveness assertion (AGENT_EVENT_KINDS vs AgentEventKind), mirroring FEATURE_EVENT_KINDS"
    - "Four separately-nullable usage fields, never defaulted to zero (D-31): 'unreported' and 'reported zero' must stay distinguishable"
    - "Classify-don't-throw: a malformed backend payload becomes an error-kind AgentEvent, never a thrown exception"
    - ".test-d.ts companion file for a compile-time-only assertion that no runtime test can express, mirroring type-boundary.test-d.ts"

key-files:
  created:
    - packages/core/src/stage/agent.ts
    - packages/core/test/stage/agent.test.ts
    - packages/core/test/stage/agent-runner.test-d.ts
  modified:
    - packages/core/src/stage/stage.ts
    - packages/core/src/stage/index.ts
    - packages/plugin-sdk/src/index.ts
    - packages/plugin-sdk/test/reexport-identity.test.ts

key-decisions:
  - "Task 1 (transcript record shape): option-c selected by the orchestrator's human on the prior attempt — translated AgentEvent plus the backend's raw line in the same record, with the raw field readable only inside packages/agent-claude-code/**, encoded in TranscriptRecordSchema's docblock. Not re-asked this run."
  - "AgentTask carries model?: string (ADL selects it per adl.yml's agents.<role>.model, D-22) rather than leaving model selection to the backend — the 04-01 CAPTURE.md fixture that would normally cross-check this against a real started event's reported model does not exist in this worktree (04-01 runs in parallel, same wave); the decision is grounded in adl-yml.ts's AgentsConfigSchema instead and documented as such in the schema's docblock."
  - "No tool-allowlist or toolPolicy field on AgentTask/AgentCapabilities — 04-CONTEXT.md's flagged BACK-01 edge probe explicitly assigns containment to the workspace boundary (WORK-02/WORK-08), not this port, for this phase."
  - "sessionRef modelled as an opaque, optional, backend-owned string on AgentTask/started/AgentRunResult per the vocabulary rule's own worked example — ADL never interprets it, and every run must succeed with it omitted."

patterns-established:
  - "AgentEventSchema per-kind member schemas exported individually (StartedEventSchema, TextEventSchema, ...) and re-exported through @adl/plugin-sdk, mirroring verdict.ts's PassVerdictSchema/SendBackVerdictSchema convention"

requirements-completed: [BACK-01]

coverage:
  - id: D1
    description: "AgentRunner is a real, callable interface — assigning a number where one is required is a type error, not a structural pass"
    requirement: BACK-01
    verification:
      - kind: unit
        ref: "packages/core/test/stage/agent-runner.test-d.ts#AgentRunner is a real, callable interface (BACK-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "AgentEvent carries all eight D-07 kinds, rejects unmodelled fields, and classifies a malformed payload to the error kind rather than throwing"
    requirement: BACK-01
    verification:
      - kind: unit
        ref: "packages/core/test/stage/agent.test.ts#AgentEventSchema"
        status: pass
    human_judgment: false
  - id: D3
    description: "TranscriptRecordSchema round-trips every event kind and serialises to a single line, with the raw field scoped per Task 1's option-c decision"
    requirement: BACK-01
    verification:
      - kind: unit
        ref: "packages/core/test/stage/agent.test.ts#TranscriptRecordSchema (Task 1: option-c, translated event + scoped raw)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every newly re-exported runtime value in @adl/plugin-sdk is reference-identical to its @adl/core/stage export"
    requirement: BACK-01
    verification:
      - kind: unit
        ref: "packages/plugin-sdk/test/reexport-identity.test.ts#@adl/plugin-sdk re-exports @adl/core by reference"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-20
status: complete
---

# Phase 4 Plan 3: AgentRunner Port Summary

**`AgentRunner` gets a real, published shape — an 8-kind vendor-neutral `AgentEvent` union, `AgentTask`/`AgentCapabilities`/`AgentRunResult`/`AgentProbe`, and an on-disk `TranscriptRecord` envelope carrying both the translated event and a scoped raw backend line — replacing the Phase-1 forward declaration.**

## Performance

- **Duration:** 45 min
- **Completed:** 2026-08-20T17:26:01+02:00
- **Tasks:** 2 (Task 1 checkpoint:decision — resolved by the orchestrator's human on a prior attempt, no code; Task 2 — the schema/interface build)
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- `packages/core/src/stage/agent.ts`: `AgentRunner` is now a real interface (`run`, `probe`) instead of `{ readonly __adlForwardDeclaration?: never }` — a number is no longer assignable to it, enforced at compile time
- `AgentEventSchema`: an 8-kind Zod discriminated union (`started`, `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `result`, `error`) — every member is `.strictObject`, so a backend translator smuggling an unmodelled field is a parse failure, not a silent carry
- `TranscriptRecordSchema`: the on-disk envelope implementing Task 1's option-c decision — the translated `AgentEvent` plus the producing backend's raw line, with the raw field's read access scoped to `packages/agent-claude-code/**` by the schema's own docblock (per the human decision)
- The whole surface (`AgentTaskSchema`, `AgentCapabilitiesSchema`, `AgentRunResultSchema`, `AgentProbeSchema`, and all eight per-kind event schemas) is re-exported through `@adl/plugin-sdk` by reference identity, verified by an extended `reexport-identity.test.ts`
- No name in the port belongs to one vendor — no `session_id`, no `stream-json`, no `total_cost_usd`; the one genuinely backend-owned concept (a resumable session) is modelled as an opaque, optional `sessionRef` string ADL never interprets

## Task Commits

1. **Task 1: What one line of an agent transcript file contains** — decision only (checkpoint:decision), resolved as **option-c** by the orchestrator's human on the prior attempt per this run's retry instructions. No code, no commit.
2. **Task 2: The AgentRunner port — task in, events out, capabilities declared** - `6e5ff32` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/core/src/stage/agent.ts` - `AgentCapabilities`, the 8-kind `AgentEvent` union and its per-kind schemas, `AgentTask`, `AgentRunResult`, `AgentProbe`, `AgentRunContext`, `AgentRunner`, `TranscriptRecord`
- `packages/core/src/stage/stage.ts` - Removed the `AgentRunner` forward declaration; imports and re-exports the real interface from `./agent.ts`, mirroring the `Workspace` precedent
- `packages/core/src/stage/index.ts` - Exports the new `agent.ts` surface in the barrel's established grouped style
- `packages/plugin-sdk/src/index.ts` - Moved `AgentRunner` out of the "still forward declarations" group into a real group with the rest of the agent surface
- `packages/plugin-sdk/test/reexport-identity.test.ts` - Extended with reference-identity assertions for every newly re-exported runtime value
- `packages/core/test/stage/agent.test.ts` - The union, exhaustiveness (via the compile-time `Exclude<>` assertion in `agent.ts` itself), round-trip, and classify-don't-throw proofs
- `packages/core/test/stage/agent-runner.test-d.ts` - **New, not in the plan's `files_modified` list** — the compile-time `@ts-expect-error` proof that `AgentRunner` rejects a number (see Deviations)

## Decisions Made

- **Task 1's decision (option-c) applied as instructed.** The retry context stated this decision was already made by the orchestrator's human on a prior attempt (whose worktree vanished before any code landed) and directed proceeding straight to Task 2. No re-ask occurred.
- **`AgentTask.model` is present, ADL-selected.** `packages/core/src/config/adl-yml.ts`'s `AgentsConfigSchema.developer.model` establishes that ADL, not the backend, selects the model per role (D-22). The plan's own instruction was to "read `CAPTURE.md`'s record of what the CLI reports at `started`" to decide this — that fixture (built by `04-01`, running in the same wave in a separate worktree) does not exist here. The decision is grounded in the `adl-yml.ts` evidence instead and stated as such in `AgentTaskSchema`'s docblock, so a later reconciliation against the real `CAPTURE.md` (once `04-01` merges) has something explicit to check against.
- **No tool-allowlist field.** `04-CONTEXT.md`'s flagged BACK-01 edge probe explicitly assigns "what happens when the delegated loop does something ADL did not ask for" to the workspace's containment job, not this port — so `AgentCapabilities` carries no tool-permission surface, matching the flagged assumption's own stated answer.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking issue, cross-plan fixture unavailable in a parallel wave] Substituted a representative fixture for `packages/agent-claude-code/test/fixtures/stream-json-develop.ndjson`**
- **Found during:** Task 2, writing `agent.test.ts`'s fixture-driven parse test
- **Issue:** The plan's `<read_first>` and acceptance criteria require parsing `packages/agent-claude-code/test/fixtures/stream-json-develop.ndjson` (built by plan `04-01`). `04-01` is wave-1, `depends_on: []`, and runs in a separate parallel worktree — it had not merged into this worktree, so the file does not exist here.
- **Fix:** `agent.test.ts` builds a representative sample of the *documented* real event shapes instead (`system/init`, an `assistant` message with `text`/`tool_use` content blocks, a `user` message carrying `tool_result`, and a terminal `result` reporting `total_cost_usd` — all cited in `04-RESEARCH.md`'s Architecture Patterns and `ARCHITECTURE.md` §4's verified surface), translated through a small test-local mapping function that stands in for the real adapter's `translateLine` (out of this plan's scope — owned by `packages/agent-claude-code/src/events.ts`). This proves the same property the fixture-driven test would: every documented real shape maps onto `AgentEvent` without loss, and the classify-don't-throw discipline holds for a malformed payload.
- **Files modified:** `packages/core/test/stage/agent.test.ts` (the `representative backend-shaped lines` describe block documents this substitution inline)
- **Verification:** `pnpm --filter @adl/core test` — all 446 tests pass, including this substitute suite
- **Committed in:** `6e5ff32`
- **Follow-up:** Once `04-01` merges, reconciling this substitute against the real `stream-json-develop.ndjson` fixture is a natural (not urgent) follow-up — the schema contract this plan ships does not depend on it, but the fixture would strengthen the proof.

**2. [Rule 2 — auto-add missing critical functionality] Added `agent-runner.test-d.ts`, not listed in the plan's `files_modified`**
- **Found during:** Task 2, implementing the acceptance criterion "a test asserts that assigning a number to a variable typed as `AgentRunner` is a type error, via a `@ts-expect-error` assertion that fails the build if it stops erroring"
- **Issue:** This repo's `tsconfig.json` (build) includes only `src/**`, and `pnpm --filter @adl/core typecheck` therefore never typechecks test files. Vitest's own typecheck stage is scoped to `test/**/*.test-d.ts` only (`vitest.config.ts`). A `@ts-expect-error` placed inside the plain `agent.test.ts` would never actually be typechecked by anything in this repo's CI — the "fails the build if it stops erroring" guarantee the acceptance criterion demands would not exist.
- **Fix:** Added `packages/core/test/stage/agent-runner.test-d.ts`, mirroring the exact precedent already in the same directory (`type-boundary.test-d.ts`), which the existing `vitest.config.ts` glob (`test/**/*.test-d.ts`) picks up with no config change.
- **Files modified:** `packages/core/test/stage/agent-runner.test-d.ts` (new)
- **Verification:** `pnpm --filter @adl/core test` reports `Type Errors: no errors` with the new file included in the typecheck run
- **Committed in:** `6e5ff32`

---

**Total deviations:** 2 auto-fixed (1 Rule 3 — cross-plan fixture unavailable in parallel wave, 1 Rule 2 — missing critical compile-time enforcement)
**Impact on plan:** Both are scoped, low-risk additions that keep the plan's own acceptance criteria literally true rather than nominally true. No scope creep into adapter/translator code, which stays out of this plan's files.

## Issues Encountered

None beyond the fixture-availability deviation documented above.

## User Setup Required

None - no external service configuration required.

## Self-Check: PASSED

- FOUND: `packages/core/src/stage/agent.ts`
- FOUND: `packages/core/src/stage/stage.ts`
- FOUND: `packages/core/src/stage/index.ts`
- FOUND: `packages/plugin-sdk/src/index.ts`
- FOUND: `packages/plugin-sdk/test/reexport-identity.test.ts`
- FOUND: `packages/core/test/stage/agent.test.ts`
- FOUND: `packages/core/test/stage/agent-runner.test-d.ts`
- FOUND commit `6e5ff32` in `git log --oneline`

## Next Phase Readiness

- `AgentRunner`, `AgentEvent`, `AgentTask`, `AgentCapabilities`, `TranscriptRecord` are published and stable — `04-01` (Claude Code adapter package), `04-05` (adapter wiring), `04-06` (NDJSON transcript store), `04-07` (SSE logs route), and `04-10` (cost mapper) can all be written against this shape now
- `pnpm --filter @adl/core test`, `pnpm --filter @adl/plugin-sdk test`, `pnpm -r typecheck`, `pnpm lint`, and `pnpm format` all exit 0
- **Open follow-up (not blocking):** reconcile the representative fixture in `agent.test.ts` against the real `packages/agent-claude-code/test/fixtures/stream-json-develop.ndjson` once `04-01` merges into this branch
- **Open follow-up (not blocking):** `AgentTask.model`'s "ADL selects it" framing should be cross-checked against `04-01`'s `CAPTURE.md` once available, per the docblock note

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
