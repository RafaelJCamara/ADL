# Phase 4: First Agent Backend & Live Transcripts - Context

**Gathered:** 2026-08-20
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers the **first real `AgentBackend` adapter (Claude Code headless)** and wires it through the production worker/lease/workspace path Phase 3 built, so a developer agent can make a real commit inside a feature worktree and the maintainer can watch its transcript live. It also delivers a new `adl dev-run` CLI verb — the only way to exercise a developer-agent turn until Phase 5's loop exists — and closes the cost-accounting spike blocking Phase 6 planning by recording real `usage_events` from a real Claude Code invocation.

Requirements in scope: **BACK-01, BACK-05, OBS-02** (3 of 92).

**In scope:** the `AgentBackend` port (`run()`, `probe()`, `AgentCapabilities`) per `ARCHITECTURE.md` §4; the Claude Code adapter (`claude -p --output-format stream-json`); `PromptBuilder` as a separate module adapters never build prompts through; NDJSON transcript capture with byte-offset addressing; `adl logs -f` live streaming and reconnect; CLI-version preflight/pin enforcement; disabling repo-level agent-CLI config auto-discovery (`--bare` or equivalent) with ADL supplying system prompts explicitly; the `adl dev-run` CLI verb, which runs a single-stage synthetic pipeline through the real manager→worker→lease→IPC path against a real `features/<id>/` folder; and closing the cost-accounting spike (STATE.md blocker) using `adl dev-run`'s real agent turn.

**Out of scope:** the full developer→review→harness→test loop (Phase 5); any agent role other than developer (reviewer/tester are Phase 7/8); the `ModelBackend` port and any raw-API backend (Phase 11); a second agent backend (also Phase 11 — BACK-05 is the only backend requirement mapped to this phase); forge/PR operations (Phase 5/9); budget enforcement consuming the recorded usage (Phase 6 — this phase only records, per LOOP-04's "checked before dispatch" rule belonging to the loop, not the adapter); the dashboard (Phase 17).

</domain>

<decisions>
## Implementation Decisions

### Preflight & Version Pin

- **D-01:** The Claude Code CLI version is **pinned exactly** (not a minimum-version floor). ADL declares one tested version; anything else is a mismatch. Chosen over a floor because it keeps "same feature on the same commit receives the same prompt twice" (success criterion 4) fully deterministic against a CLI whose own behavior is not itself pinned, and matches the stack doc's "pin exact and read release notes" guidance for pre-1.0 Claude tooling. — **Reversibility:** reversible — the pin is a config value, loosening to a range later is additive.

- **D-02:** A version mismatch **hard-blocks dispatch** — ADL refuses to run any feature through the backend, and the failure is surfaced as "broken installation" (naming expected vs. installed version), not discovered mid-run. This is success criterion 3's own wording taken literally, and it is what OBS-08 ("diagnose a broken installation before running a feature through it") exists for. Rejected: warn-and-continue, because an unattended loop running against an untested CLI version is exactly the kind of silent risk this project is designed against. — **Reversibility:** reversible — the check is a gate, not a schema; relaxing it to a warning later is a one-line change.

### Demonstrating This Phase (no loop exists yet)

- **D-03:** A new **`adl dev-run <feature-id>` CLI verb** is the mechanism for exercising a real developer-agent commit in this phase. Phase 5's loop doesn't exist yet, so there is no feature pipeline to trigger the developer stage from; `adl dev-run` fills that gap and gives the maintainer something to actually run and watch, consistent with this phase's "watch it happen" framing. It is also what Phase 5 later wires its first loop-stage call into, rather than being throwaway scaffolding. — **Reversibility:** reversible — the verb's internals get replaced by loop dispatch in Phase 5, but the CLI surface can stay or be deprecated without a migration.

- **D-04:** `adl dev-run` goes through the **full manager→worker→lease→IPC path** Phase 3 built — a real lease is acquired, a real worker is forked, and the worker's stage runner calls `Workspace.exec()` — rather than calling the developer stage directly in-process. This is what makes success criterion 1's "launched through the workspace exec path rather than a direct spawn" true against the real infrastructure, not a shortcut around it, and it exercises Phase 3's worker/lease machinery now instead of leaving that gap untested until Phase 5. The pipeline it runs is a synthetic one-stage pipeline (`[develop]`), not the full `[develop, review, ..., test]` shape. — **Reversibility:** reversible — Phase 5 generalizes this to arbitrary pipelines; the single-stage case is a subset, not a divergent path.

- **D-05:** `adl dev-run` takes a **real feature id from `features/<id>/`** as input — spec loaded and normalized through Phase 1's `SpecLoader`, `PromptBuilder` rendering from the normalized spec — rather than an ad-hoc/synthetic prompt string. This exercises the real intake path (SPEC-01…05) as part of criterion 1's proof, and gives the maintainer a real dogfood-shaped rehearsal rather than a toy. — **Reversibility:** reversible — a `--prompt` escape hatch for quick manual iteration can be added later without breaking the feature-folder path.

### Cost-Accounting Spike

- **D-06:** Phase 4 **closes the cost-accounting spike** that STATE.md flags as blocking Phase 6 planning ("cross-backend usage reporting reliability is unverified... run it during Phase 4/5 against a real agent turn"). `adl dev-run`'s real Claude Code invocation already produces a real agent turn for criterion 1, so recording what `claude -p --output-format json` actually returns for `total_cost_usd`/token counts into `usage_events`, verifying `costSource` classification end to end, and updating STATE.md to drop the blocker costs little beyond what this phase must build anyway. Rejected: deferring verification to Phase 5, since the real call already has to happen here and Phase 5's budget enforcement (LOOP-04) would otherwise start planning against unverified data. — **Reversibility:** reversible — closing the spike is a verification exercise, not a schema change; `usage_events`/`model_prices` already exist (Phase 1, D-29/D-31).

### Live Transcript Content

- **D-07:** `adl logs -f` streams the **full `AgentEvent` detail** — `started`, `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `result`, `error` — verbatim, both to the NDJSON transcript file and to the live view. No curation/filtering layer in this phase. This matches PROJECT.md's core value ("the whole loop's reasoning visible") and `ARCHITECTURE.md`'s transcript-capture design, which already assumes full-detail capture; it also keeps every event available for later PR-comment summarisation (Phase 9) to draw from, rather than having summarisation work from an already-lossy stream. Rejected: a curated default (hiding `thinking` deltas behind `--verbose`), which adds a filtering layer this phase would need to design and maintain for no criterion-2 benefit. — **Reversibility:** reversible — a `--verbose`/curated toggle can be layered on top of the full-detail NDJSON file later without touching what gets captured.

### Claude's Discretion

The following were not raised as gray areas and are left to the researcher and planner:

- Exact `AgentEvent`/`AgentTask`/`AgentCapabilities` field shapes beyond `ARCHITECTURE.md` §4's sketch (which is the starting point, not a locked schema).
- Whether the `artifacts` table (deliberately absent since Phase 1, D-29) needs to land in this phase's migrations to persist rendered prompts as artifacts, or whether a simpler mechanism suffices for v1 of that requirement.
- The `adl logs -f` reconnect implementation detail (SSE endpoint on the manager's existing Hono server per Phase 3 D-20, byte-offset seek-then-follow per `ARCHITECTURE.md` §9) — the shape is already specified by prior research and Phase 3 decisions; this phase implements it, not re-derives it.
- Exact `--bare`-equivalent flag and how ADL supplies the system prompt explicitly (success criterion 4) — `ARCHITECTURE.md`'s "disable discovery, let ADL be the sole source of context" guidance stands; the mechanism is the planner's to design.
- The D-2-08-1 Linux git `safe.directory` fix (agent can't run git inside its own worktree, exit 128) carried into this phase from STATE.md — a known bug blocking criterion 1 on Linux CI, not a design choice; the planner fixes it as part of making the commit happen.
- Whether `PromptBuilder`'s per-role template is stored as a file, a DB row, or inline in `@adl/core` — `ARCHITECTURE.md` §4 only requires it be a separate module adapters never build prompts through.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition and requirements
- `.planning/ROADMAP.md` § "Phase 4: First Agent Backend & Live Transcripts" — goal, the four success criteria, and the Notes paragraph fixing `PromptBuilder` as a separate module and NDJSON-with-byte-offset transcripts
- `.planning/REQUIREMENTS.md` § Model Backends, § Observability & Control — BACK-01, BACK-05, OBS-02 (this phase's three requirement IDs); note BACK-02…04/06…09 are Phase 11/5, not this phase

### Architecture — the primary source for this phase's design
- `.planning/research/ARCHITECTURE.md` §4 "Agent Backend Adapters" — the `AgentBackend`/`AgentCapabilities`/`AgentTask`/`AgentEvent` interface sketch, the six places the abstraction leaks (cost, tool permissioning, session resume, repo-local config auto-discovery, structured output, filesystem reality) and their mitigations, and the "Prompt assembly and transcript capture" subsection (`PromptBuilder` separation, deterministic rendering, persisted rendered-prompt artifacts, NDJSON transcript capture with byte-offset addressing, "never put transcripts in DB rows")
- `.planning/research/ARCHITECTURE.md` §9 (SSE / log serving section referenced at line 805) — byte-offset log addressing (`?offset=N&follow=1`) as the mechanism that makes `adl logs -f` and a future dashboard the same code
- `.planning/research/ARCHITECTURE.md` line 1006 — the milestone table's own description of this phase: "First adapter. Done-when: a developer agent, invoked through `workspace.exec`, makes a real commit in a worktree and its NDJSON transcript is streamable via `adl logs -f`."
- `.planning/research/PITFALLS.md` Pitfall 7 "Runaway spend, context bloat, and transcript growth across rounds" — curated round context vs. accumulated transcript; full transcripts live in the DB/log store for audit but are not resent as model input (relevant to how `PromptBuilder` assembles context, even though the round-context-curation *policy* itself is Phase 5+)
- `.planning/research/PITFALLS.md` line 375 — the named failure mode this phase's adapter interface must avoid: an interface secretly shaped around Claude Code's delegated-loop assumptions that later backends can't fit without `if (backend === 'x')` branches

### Phase 1 contracts this phase must satisfy (do not re-derive)
- `packages/core/src/stage/stage.ts` — `AgentRunner` (currently an empty forward-declaration placeholder this phase gives a real shape), `LogChunk` (its `stream` field already includes `'agent'`, anticipating this phase), `StageContext.agents`, `CostClass`
- `packages/plugin-sdk/src/index.ts` — re-exports `AgentRunner` from `@adl/core/stage` alongside `Workspace`/`ExecSpec`; this phase's real `AgentRunner` shape becomes what a third-party harness can also depend on
- `packages/core/src/config/adl-yml.ts` line ~328 — the `context.files`/`ContextConfigSchema` comment naming this phase's `PromptBuilder` as the implementer of head-and-tail truncation
- `packages/db/migrations/0002_contracts.ts` — `rounds`, `stage_attempts`, `usage_events` tables already exist (Phase 1, D-29); `error_raw_ref` is an artifact pointer, never a blob; `artifacts` table is deliberately still absent (see Claude's Discretion)
- `.planning/phases/01-core-contracts/01-CONTEXT.md` § D-14 (repair-retry spend recorded as `costCategory: 'overhead'`), § D-31 (`model_prices` seeded by migration, `costSource: 'unknown'` rather than pricing at zero — the classification D-06 above verifies), § Deferred (cost-accounting spike explicitly earmarked for Phase 4/5)

### Phase 2 contracts this phase must satisfy
- `packages/workspace/src/exec/run.ts` — the only sanctioned process launch (`run()`); the Claude Code adapter's subprocess call goes through this, not a second `execa` call site; note `LogChunk`'s `'agent'` stream tag and the `ExecOwner: 'agent'` default are already shaped for this phase's use
- `.planning/phases/02-workspace-the-exec-boundary/02-CONTEXT.md` § D-01 (`Workspace.exec()` streams via the `LogChunk` sink — the shape OBS-02 needs), § D-09/D-10 (env-allowlist + zero-inherited-env — how the model API key reaches the Claude Code subprocess), § Integration Points ("Phase 4 (agent backends) is the first real consumer of `Workspace.exec()`'s env-allowlist and streaming behavior")

### Phase 3 contracts this phase must satisfy
- `.planning/phases/03-manager-skeleton-state-leases-api-cli/03-CONTEXT.md` § D-20 ("Phase 4's `adl logs -f` slots into the same Hono server with no new transport" — SSE is reserved, not built, precisely for this phase), § D-18 (every CLI verb goes through the HTTP API — `adl dev-run` follows this too), § D-21 (`@adl/cli` speaks HTTP only), § D-30 (fake-worker double is the real worker entry point with only the stage-call swapped — this phase replaces that one injected module with the real Claude Code adapter rather than deleting the test harness)
- `packages/workspace/src/exec/fork.ts` line ~135 — the comment naming the manager's pino child-logger attachment to worker stdout/stderr pipes as "what a later phase's transcript streaming reads from"

### Carried-forward bug this phase must fix
- `.planning/STATE.md` § "Carry into Phase 3/4" — `D-2-08-1`: on a provisioned Linux deployment the agent cannot run git inside its own worktree (`safe.directory`, exit 128). Blocks nothing in WORK-01..07 but lands squarely on this phase's "makes a real commit through the workspace" (success criterion 1).

### Stack constraints
- `./.claude/CLAUDE.md` § Technology Stack — `@anthropic-ai/claude-agent-sdk@0.3.233` and/or `claude -p` CLI shell-out (both valid per the stack doc's "keep the CLI as a second implementation of the same port" guidance), cost-accounting section ("prefer the backend's reported cost over your own arithmetic," `cost_source ∈ {reported, computed}`, do NOT use tiktoken/gpt-tokenizer for Anthropic), `eventsource-parser@4.0.0` for SSE consumption in the CLI

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/workspace/src/exec/run.ts` → `run()` — the only process-launch path; the Claude Code adapter's subprocess invocation must go through this (WORK-02, `adl/no-direct-spawn` lint rule).
- `packages/core/src/stage/stage.ts` → `AgentRunner`, `LogChunk` — `AgentRunner` is currently `{ readonly __adlForwardDeclaration?: never }`; this phase gives it a real shape. `LogChunk.stream` already accepts `'agent'` as a discriminant, anticipating agent-event streaming through the same sink `Workspace.exec()` uses.
- `packages/db/migrations/0002_contracts.ts` — `usage_events` (with `cost_source`, `cost_category`, per-model token columns) and `stage_attempts` (with `error_raw_ref` as an artifact pointer) already exist; this phase is likely the first real writer of `usage_events` rows.
- `packages/workspace/src/exec/fork.ts` — `forkWorker()` already pipes worker stdout/stderr for exactly this phase's transcript streaming to read from.

### Established Patterns
- Forward-declared types replaced wholesale by the phase that owns them (`AgentRunner`, `ArtifactSink` in `stage.ts` explicitly comment which phase supplies each).
- Zod as the source of truth, types via `z.infer` — any new `AgentTask`/`AgentEvent`/`AgentCapabilities` schemas should follow this.
- Return-or-classify rather than throw for expected-but-notable outcomes (`StageError`, `compareAndSwapState`) — the Claude Code adapter's version-mismatch preflight (D-02) and parse-failure handling should follow the same shape established by Phase 1's `StageError` union.

### Integration Points
- `@adl/manager` — owns the reaper, GC, dispatcher, worker supervision, and the Hono HTTP server (Phase 3). This phase adds the SSE log-serving route to that same server (D-20) and the `adl dev-run` request handler.
- Worker entry point (Phase 3) — currently runs a scripted no-op stage runner (D-30). This phase swaps in the real Claude Code `AgentBackend` call as the injected module.
- `@adl/cli` — speaks HTTP only, no `@adl/db`/`@adl/manager` internals (Phase 3, D-18/D-21). `adl dev-run` and the `adl logs -f` follow both need new HTTP/SSE client code here.

</code_context>

<specifics>
## Specific Ideas

- `adl dev-run <feature-id>` is the concrete CLI verb name settled on during discussion — a one-off developer-stage invocation against a real `features/<id>/` folder, through the real manager/worker/lease path, producing a real commit and a live-streamable transcript.
- The version-mismatch error should name both the expected (pinned) and installed CLI version explicitly, per OBS-08 and success criterion 3's own wording ("reported as a broken installation").
- `adl dev-run`'s real invocation is explicitly the vehicle for closing the STATE.md cost-accounting spike — no separate throwaway spike script is wanted; the recorded `usage_events` row from this real run IS the spike's evidence.

</specifics>

<deferred>
## Deferred Ideas

No scope creep occurred — discussion stayed inside the phase boundary throughout.

- **The full developer→review→harness→test loop** — Phase 5. This phase's `adl dev-run` is explicitly a bridge, not a preview of the loop's dispatch logic.
- **A second agent backend and the `ModelBackend` port** — Phase 11, per PROJECT.md's dogfood-gate sequencing (second backend precedes the gate; `ModelBackend`/raw-API backends come after).
- **Budget enforcement consuming the `usage_events` this phase records** — Phase 6 (LOOP-04's "checked before dispatch" gate). This phase only records accurate data; it does not enforce against it.

### Reviewed Todos (not folded)
- **`reproduce-d-2-r-1-on-linux.md`** — matched by keyword overlap ("workspace", "exec") but is about D-2-R-1 cross-feature isolation reproduction, unrelated to this phase's agent-backend/transcript scope. Blocked on a provisioned Linux host, not on this phase. Not folded.
- **`revisit-cross-feature-isolation.md`** — the standing uid-pool fix for D-2-R-1. Worth flagging: its first revisit trigger ("Phase 3 introduces manager-owned lease state") already fired when Phase 3 shipped. Still not this phase's scope (no isolation work is named in Phase 4's success criteria) — noted here so a future phase doesn't miss that the trigger condition is now true.
- **`phase-15-needs-config-neutralisation-criterion.md`** — explicitly `resolves_phase: 15`, unrelated to this phase. Not folded.

</deferred>

---

*Phase: 4-First Agent Backend & Live Transcripts*
*Context gathered: 2026-08-20*
