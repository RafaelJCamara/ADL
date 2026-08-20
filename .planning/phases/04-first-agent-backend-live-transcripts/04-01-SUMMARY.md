---
phase: 04-first-agent-backend-live-transcripts
plan: 01
subsystem: agent-backend-scaffolding
tags: [claude-code-adapter, spawn-ban, eslint, package-scaffold, blocked]
status: incomplete
dependency-graph:
  requires: []
  provides:
    - "@adl/agent-claude-code package (barrel, PINNED_CLAUDE_CODE_VERSION)"
    - "eventsource-parser dependency in @adl/cli"
    - "spawn-ban proof for the new package (deliberate-violation fixture + resolved-config assertions)"
  affects:
    - "04-06 (TRACER, Wave 3) — depends on 04-01 completing; blocked on Task 3"
    - "04-07, 04-09 — own src/events.ts and src/preflight.ts respectively; not started here by design"
tech-stack:
  added:
    - "@adl/agent-claude-code (new package, workspace)"
    - "eventsource-parser@4.0.0 (@adl/cli dependency)"
  patterns:
    - "Package split: node types live in tsconfig.test.json, not tsconfig.json, when src/ is I/O-free but the test suite reads fixtures from disk (inverse of @adl/manager's and @adl/core's split)"
key-files:
  created:
    - packages/agent-claude-code/package.json
    - packages/agent-claude-code/tsconfig.json
    - packages/agent-claude-code/tsconfig.test.json
    - packages/agent-claude-code/vitest.config.ts
    - packages/agent-claude-code/src/index.ts
    - packages/agent-claude-code/src/version.ts
    - packages/agent-claude-code/test/smoke.test.ts
    - test/lint/fixtures/spawn-agent-backend.ts
  modified:
    - packages/cli/package.json
    - pnpm-lock.yaml
    - test/lint/no-restricted-imports.test.ts
decisions:
  - "Task 1's package-legitimacy checkpoint was approved by the orchestrator's human before this worktree existed (per the retry note this execution started from); no re-ask was performed."
  - "Task 3 is deliberately left incomplete rather than faked. The maintainer explicitly rejected fabricating stream-json-develop.ndjson / stream-json-max-turns.ndjson / result-json.json / claude-version.txt from documentation or invented output — 04-RESEARCH.md Pitfall 1 exists precisely because those shapes must come from a real invocation, and a synthetic fixture would silently defeat that."
  - "The pinned version (2.1.237, D-01) is confirmed correct and does NOT need to be revisited: /c/Users/rafae/AppData/Roaming/npm/claude reports 2.1.237 by direct path invocation. The earlier assessment that the pin itself might be wrong was superseded once the npm-installed binary was checked directly instead of relying on PATH resolution."
metrics:
  duration: "~35 minutes (Task 2 scaffold + verification; Task 3 not attempted)"
  completed: "2026-08-20"
actuals:
  tokens: 9500
  tasks: 2
  commits: 1
---

# Phase 04 Plan 01: First Agent Backend Scaffolding & Spawn-Ban Proof Summary

Stood up `@adl/agent-claude-code` as a real, enrolled, lint-covered package with a pinned-version
constant and a proof that the `adl/no-direct-spawn` ban reaches it without widening the exemption;
the real-CLI fixture capture (Task 3) is blocked on environment issues and left genuinely
incomplete rather than faked.

## What Was Built

### Task 1 — Package legitimacy gate (checkpoint, approved)

`@anthropic-ai/claude-code@2.1.237` and `eventsource-parser@4.0.0` were verified and approved by
the orchestrator's human in a prior attempt at this plan. That attempt's worktree vanished before
any file was written or any commit was made (zero work lost) — the approval itself carries
forward, and per the orchestrator's retry note this execution proceeded directly to Task 2 without
re-asking.

### Task 2 — Scaffold `@adl/agent-claude-code`, add `eventsource-parser`, prove the spawn ban reaches it

**Commit:** `529abd1`

- Created `@adl/agent-claude-code` as a real, installable, enrolled package: `package.json` (deps
  `@adl/core` + `zod`, no `execa`, no `@adl/workspace`), `tsconfig.json` + `tsconfig.test.json`
  (see the tsconfig split decision below), `vitest.config.ts` (project name
  `agent-claude-code`, auto-enrolled via `packages/*/vitest.config.ts` — no root-file edit).
- `src/version.ts` exports `PINNED_CLAUDE_CODE_VERSION = '2.1.237'` with a docblock explaining
  D-01's exact-pin rationale.
- `src/index.ts` is the barrel, exporting only the pinned-version constant at this point, with a
  header naming which later plans (`04-06`, `04-07`, `04-09`) add `run`/`probe`/the event
  translator — deliberately no stub files for those.
- `test/smoke.test.ts` asserts the exported version is a three-part dotted string.
- Added `eventsource-parser@4.0.0` to `@adl/cli`'s dependencies and ran `pnpm install`,
  updating `pnpm-lock.yaml`.
- Added `test/lint/fixtures/spawn-agent-backend.ts` — a deliberate direct `execa` import — and
  extended `test/lint/no-restricted-imports.test.ts` with:
  - a `FIXTURES` row asserting the new fixture is reported by `no-restricted-imports` naming `execa`;
  - a dedicated test asserting the **resolved** `no-restricted-imports` options for the real path
    `packages/agent-claude-code/src/index.ts` contain `execa` (i.e. the package is governed by
    the ban, not exempt from it);
  - the same test asserting `WORKSPACE_EXEMPTION` still has exactly length 1, so a future second
    exemption entry turns the suite red rather than passing silently.

**Verification run and passing:** `pnpm install`; `pnpm --filter @adl/agent-claude-code test`
(1/1); `pnpm vitest run --project root` (65/65, including the two new spawn-ban assertions);
`pnpm vitest run --project agent-claude-code` (1/1); `pnpm -r typecheck` (all 7 typechecked
packages green, agent-claude-code included); `pnpm lint`; `pnpm format --check`.

### Task 3 — Real-CLI fixture capture — NOT DONE, blocked

**Status: genuinely incomplete.** No fixture files exist under
`packages/agent-claude-code/test/fixtures/`, no `CAPTURE.md`, no `test/helpers/fake-claude.mjs`.
Nothing was fabricated to fake this task complete — the maintainer was explicit that synthetic or
documentation-derived stream-json output is not an acceptable substitute for a real, captured
invocation (04-RESEARCH.md Pitfall 1 exists precisely because the real shape is unknown until
captured).

**Two blockers, both environmental, neither architectural:**

1. **PATH shadowing, not a version mismatch.** `claude --version` resolved from PATH on this host
   reports `2.1.227 (Claude Code)` — an older WinGet-installed binary
   (`AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_...`) shadows the npm-installed
   one earlier in PATH. Direct invocation of the npm-installed binary,
   `/c/Users/rafae/AppData/Roaming/npm/claude --version`, correctly reports `2.1.237` — the exact
   pin `PINNED_CLAUDE_CODE_VERSION` names. **The pin itself is correct and needs no revisiting.**
   Task 3 only needs to invoke the npm-installed binary by its full path (or fix PATH ordering)
   rather than relying on bare `claude` resolution.
2. **No `ANTHROPIC_API_KEY`.** Not present in this session's environment. A placeholder value was
   tried and correctly produced a 401 — confirming this is a genuine auth gate rather than a code
   defect, per the `<authentication_gates>` protocol. `--bare` disables OAuth/keychain reads, so an
   implicit credential will not be found; the key must be supplied explicitly.

Neither blocker required or received a workaround. Auth gates and unmet preconditions are not
auto-fixable, and inventing capture output to close the task out would defeat the entire purpose
of Task 3.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking] `tsconfig.test.json` rootDir mismatch**
- **Found during:** Task 2, `pnpm -r typecheck`
- **Issue:** `tsconfig.test.json` inherited `rootDir: "src"` from `tsconfig.json`, but its own
  `include` also pulls in `test/**/*.ts`, which TS6059 rejects ("rootDir is expected to contain
  all source files").
- **Fix:** Set `rootDir: "."` explicitly in `tsconfig.test.json`, with a comment explaining this
  package's tests never reach outside the package (unlike `@adl/manager`'s pair, which needs
  `rootDir: ".."`), so the package root is the narrowest containing root.
- **Files modified:** `packages/agent-claude-code/tsconfig.test.json`
- **Commit:** `529abd1`

No other deviations. Task 2 executed as planned.

## Known Stubs

None — Task 2 introduced no placeholder data or empty-rendering code paths. Task 3 is simply
undone; there is nothing stubbed in its place.

## Auth Gates

Task 3 hit an authentication gate (`ANTHROPIC_API_KEY` absent; placeholder correctly 401'd). Per
protocol this is normal flow, not a bug, and is not auto-fixable — it is documented here as the
reason Task 3 did not run, not as a deviation requiring a workaround.

## Threat Flags

None beyond what `04-01-PLAN.md`'s own threat model already covers (T-4-SC, T-4-01, T-4-02,
T-4-03) — no new surface was introduced by Task 2 beyond what the plan anticipated.

## Impact on the Rest of Phase 4

- **Plan status: 2/3 tasks complete.** `BACK-05` (the requirement this plan's `must_haves` and
  Task 3's capture serve) remains unsatisfied — the three recorded fixtures and the provenance
  file that Task 3 exists to produce are the artifact this requirement is measured against.
- **`04-06` (Wave 3, TRACER) depends on `04-01` completing** — it needs the real captured
  `stream-json` fixtures and the replay double (`fake-claude.mjs`) to build and test its event
  translator against. It should not proceed until Task 3 lands.
- **Nothing else in this plan's `artifacts_produced` is missing** apart from the Task-3-owned
  files (`test/fixtures/CAPTURE.md`, `claude-version.txt`, `stream-json-develop.ndjson`,
  `stream-json-max-turns.ndjson`, `result-json.json`, `test/helpers/fake-claude.mjs`).

## To Resume Task 3

1. Set `ANTHROPIC_API_KEY` in the environment the execution agent runs in (per `user_setup`,
   sourced from console.anthropic.com → API keys).
2. Either fix PATH ordering so bare `claude` resolves to the npm-installed `2.1.237`, or have
   Task 3's capture invoke the npm-installed binary by its full path directly
   (`/c/Users/rafae/AppData/Roaming/npm/claude` on this host — a portable equivalent should be
   resolved fresh on whatever host actually runs the capture, since this is a per-machine PATH
   fact, not a repository fact).
3. Re-run Task 3 exactly as specified in `04-01-PLAN.md` — the four captures against a throwaway
   git repository, the redaction pass, `CAPTURE.md`, and `fake-claude.mjs`.

## Self-Check: PASSED

- `packages/agent-claude-code/package.json` — FOUND
- `packages/agent-claude-code/src/version.ts` — FOUND
- `packages/agent-claude-code/src/index.ts` — FOUND
- `packages/agent-claude-code/test/smoke.test.ts` — FOUND
- `test/lint/fixtures/spawn-agent-backend.ts` — FOUND
- Commit `529abd1` — FOUND in `git log --oneline --all`
