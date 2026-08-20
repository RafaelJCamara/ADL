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
 * At this point the barrel exports only the pinned-version constant. `04-06`
 * adds the `AgentBackend` implementation (`run`, `probe`) and the
 * stream-json-to-event translator; `04-07` and `04-09` add the parts of that
 * translator and the preflight check named in `04-01-PLAN.md`'s artifact
 * list. Nothing here is a stub for those — there is deliberately no
 * `src/backend.ts`, `src/events.ts`, or `src/preflight.ts` yet, so a later
 * plan has one file to write rather than one to reconcile.
 */

// The pin this whole package is built and tested against (D-01). Exported
// because both the fixture-integrity test in this package and any later
// preflight check need the same single source of truth for "what version did
// we capture, and what version must be running".
export { PINNED_CLAUDE_CODE_VERSION } from './version.js';
