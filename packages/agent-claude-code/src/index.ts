/**
 * `@adl/agent-claude-code` — the Claude Code headless `AgentBackend` adapter.
 *
 * This package translates the pinned Claude Code CLI's headless output into
 * ADL's own agent event shape; it never re-drives the agent's own tool loop,
 * and it reaches a subprocess only through a `Workspace` instance a caller
 * passes in — it constructs no `Workspace` of its own, which is what keeps
 * the `adl/no-direct-spawn` exemption count at exactly one
 * (`packages/workspace/**`; see `eslint.config.js`'s `WORKSPACE_EXEMPTION`).
 *
 * `04-06` added the `AgentRunner` implementation (`claudeCodeBackend`) and
 * the stream-json-to-event translator (`translateLine`). `04-07` (this plan)
 * adds the version preflight (`preflightClaudeCode`, `parseClaudeVersion`) —
 * the real startup-gate mechanism named in `04-01-PLAN.md`'s artifact list.
 * The reconnect contract remains a later plan's addition.
 */

// The pin this whole package is built and tested against (D-01). Exported
// because both the fixture-integrity test in this package and any later
// preflight check need the same single source of truth for "what version did
// we capture, and what version must be running".
export { PINNED_CLAUDE_CODE_VERSION } from './version.js';

// The stream-json translator (04-06). Exported so a test outside this
// package (and a future preflight/reconnect plan) can drive it directly
// without going through a full `run()`.
export {
  CLAUDE_CODE_CAPABILITIES,
  translateLine,
  type TranslateResult,
} from './events.js';

// The `AgentRunner` implementation itself — the one thing `@adl/manager`'s
// stage runner imports from this package. `ClaudeCodeAgentRunner`/
// `AgentRunResultWithUsage` (04-10) are exported alongside it so the worker
// (`packages/manager/src/worker-entry/stage-runner.ts`) can read the
// `usageRecord` this backend attaches to its resolved run result without a
// cast — "why public": that worker is the one production caller that needs
// the richer type, since it imports `claudeCodeBackend` directly rather than
// only through the generic `AgentRunner` port.
export {
  claudeCodeBackend,
  type AgentRunResultWithUsage,
  type ClaudeCodeAgentRunner,
  type ClaudeCodeBackendOptions,
} from './backend.js';

// The usage mappers (04-10, M05 step 5.18) — `usageFromResult` turns the
// run's terminal `result` event, plus what was observed earlier in the same
// run, into a `usage_events`-shaped record, and `unknownUsageRecord` is its
// counterpart for an invocation that ran but reported nothing (BACK-09's
// "degrade visibly to `cost_source: 'unknown'`, never silently"). Exported
// (not only used internally by `backend.ts`) so a test, and any future caller
// that already holds a translated `AgentEvent` stream of its own — M07's
// reviewer is the next one — can drive the same mapping directly rather than
// re-deriving it.
export {
  unknownUsageRecord,
  usageFromResult,
  type AgentUsageRecord,
  type ModelSpeed,
  type UnknownUsageInput,
  type UsageCostCategory,
  type UsageCostSource,
  type UsageFromResultEvent,
} from './usage.js';

// The version preflight (04-07, D-01/D-02, OBS-08). Exported so the
// manager's startup gate (`packages/manager/src/boot/backend-preflight.ts`)
// — the real caller, which constructs the version-check invocation through
// the ADL-owned exec boundary — and a later `adl doctor` can both call it
// directly, without going through a full `AgentRunner`.
export {
  parseClaudeVersion,
  preflightClaudeCode,
  type PreflightFailureKind,
  type PreflightResult,
  type VersionCheckResult,
} from './preflight.js';
