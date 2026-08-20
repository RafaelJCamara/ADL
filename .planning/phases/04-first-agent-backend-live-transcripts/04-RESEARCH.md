# Phase 4: First Agent Backend & Live Transcripts - Research

**Researched:** 2026-08-20
**Domain:** Agentic-CLI adapter (Claude Code headless), NDJSON transcript capture, SSE log streaming with byte-offset reconnect, CLI version preflight
**Confidence:** MEDIUM — the `AgentBackend` shape and the SSE/NDJSON mechanism are HIGH confidence (grounded in code already in the repo and official Claude Code docs fetched this session); per-backend *unattended* CLI behavior (exact version-check contract, exact `--bare` interaction with structured output under load) stays MEDIUM/LOW per the phase's own research flag.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The Claude Code CLI version is **pinned exactly** (not a minimum-version floor). Reversibility: reversible.
- **D-02:** A version mismatch **hard-blocks dispatch** — surfaced as "broken installation" (naming expected vs. installed version), not discovered mid-run. Reversibility: reversible.
- **D-03:** A new **`adl dev-run <feature-id>` CLI verb** is the mechanism for exercising a real developer-agent commit in this phase; it is also what Phase 5 later wires its first loop-stage call into. Reversibility: reversible.
- **D-04:** `adl dev-run` goes through the **full manager→worker→lease→IPC path** — a real lease is acquired, a real worker is forked, and the worker's stage runner calls `Workspace.exec()` — rather than calling the developer stage directly in-process. The pipeline is a synthetic one-stage pipeline (`[develop]`), not the full `[develop, review, ..., test]` shape. Reversibility: reversible.
- **D-05:** `adl dev-run` takes a **real feature id from `features/<id>/`** as input — spec loaded and normalized through Phase 1's `SpecLoader`, `PromptBuilder` rendering from the normalized spec — rather than an ad-hoc/synthetic prompt string. Reversibility: reversible.
- **D-06:** Phase 4 **closes the cost-accounting spike** blocking Phase 6 planning: recording what `claude -p --output-format json` actually returns for `total_cost_usd`/token counts into `usage_events`, verifying `costSource` classification end to end, and updating STATE.md to drop the blocker. Reversibility: reversible.
- **D-07:** `adl logs -f` streams the **full `AgentEvent` detail** — `started`, `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `result`, `error` — verbatim, both to the NDJSON transcript file and to the live view. No curation/filtering layer in this phase. Reversibility: reversible.

### Claude's Discretion

The following were not raised as gray areas and are left to the researcher and planner:

- Exact `AgentEvent`/`AgentTask`/`AgentCapabilities` field shapes beyond `ARCHITECTURE.md` §4's sketch (which is the starting point, not a locked schema).
- Whether the `artifacts` table (deliberately absent since Phase 1, D-29) needs to land in this phase's migrations to persist rendered prompts as artifacts, or whether a simpler mechanism suffices for v1 of that requirement.
- The `adl logs -f` reconnect implementation detail (SSE endpoint on the manager's existing Hono server per Phase 3 D-20, byte-offset seek-then-follow per `ARCHITECTURE.md` §9) — the shape is already specified by prior research and Phase 3 decisions; this phase implements it, not re-derives it.
- Exact `--bare`-equivalent flag and how ADL supplies the system prompt explicitly (success criterion 4) — `ARCHITECTURE.md`'s "disable discovery, let ADL be the sole source of context" guidance stands; the mechanism is the planner's to design. **Resolved by this research: `--bare` is a real, currently-shipping, documented flag — see Architecture Patterns § Pattern 2.**
- The D-2-08-1 Linux git `safe.directory` fix (agent can't run git inside its own worktree, exit 128) carried into this phase from STATE.md — a known bug blocking criterion 1 on Linux CI, not a design choice; the planner fixes it as part of making the commit happen. **This research proposes a concrete fix location — see Common Pitfalls § Pitfall 3.**
- Whether `PromptBuilder`'s per-role template is stored as a file, a DB row, or inline in `@adl/core` — `ARCHITECTURE.md` §4 only requires it be a separate module adapters never build prompts through.

### Deferred Ideas (OUT OF SCOPE)

No scope creep occurred — discussion stayed inside the phase boundary throughout.

- **The full developer→review→harness→test loop** — Phase 5. This phase's `adl dev-run` is explicitly a bridge, not a preview of the loop's dispatch logic.
- **A second agent backend and the `ModelBackend` port** — Phase 11.
- **Budget enforcement consuming the `usage_events` this phase records** — Phase 6 (LOOP-04's "checked before dispatch" gate). This phase only records accurate data; it does not enforce against it.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BACK-01 | ADL drives agentic CLIs that own their own loop and tools, through an `AgentBackend` port | Architecture Patterns § Pattern 1 (delegated-loop translation shape); Architectural Responsibility Map row 1; `Workspace.exec()` signature verified against `packages/core/src/stage/workspace.ts:266-296` |
| BACK-05 | Claude Code headless works as a backend | Standard Stack (verified npm version 2.1.237); Architecture Patterns § Pattern 1 & 2 (`--bare`, `--output-format stream-json`, `--append-system-prompt`); Common Pitfalls § Pitfall 1 (unattended-flag-combination risk) and § Pitfall 3 (D-2-08-1 fix) |
| OBS-02 | Maintainer can follow a running agent's transcript live | Architecture Patterns § Pattern 3 (NDJSON byte-offset log store + SSE reconnect); Validation Architecture (kill/reconnect test requirement) |
</phase_requirements>

## Summary

This phase gives `AgentRunner` (`packages/core/src/stage/stage.ts`, currently a forward declaration) its first real shape, and wires a Claude Code adapter through `Workspace.exec()` — the same `exec(spec, log)` method Phase 2 built and Phase 3's worker already forks into. The adapter shells `claude -p --bare --output-format stream-json --verbose --include-partial-messages`, translating Claude Code's own NDJSON event stream into ADL's `AgentEvent` union, appending every event verbatim to a per-attempt NDJSON transcript file, and reporting `usage`/`result` events into the `usage_events` table through the **already-built** `usageRepository().record()` (`packages/db/src/repository/usage.ts`) — this phase's cost-accounting spike closes by exercising code that already exists, not by writing new persistence.

The two things this research changes from the phase's own framing: first, `--bare` is a real, documented, currently-shipping flag (not a "TBD equivalent") — confirmed directly against `code.claude.com/docs/en/headless` this session — so "Claude's Discretion" item 4 in `04-CONTEXT.md` (the `--bare`-equivalent flag) is resolved, not still open. Second, the D-2-08-1 `safe.directory` bug has a concrete, code-grounded fix location: `packages/workspace/src/exec/env.ts` already points `GIT_CONFIG_GLOBAL` at `<scratchHome>/.gitconfig`, a file that does not exist until something writes it (`packages/workspace/src/exec/scratch-home.ts`'s `createScratchHome()` only `mkdtemp`s the directory). Pre-writing `[safe] directory = <worktree path>` into that file at workspace-creation time is a workspace-package change, not an adapter change, and it uses a control the adapter and `ExecSpec.env` are explicitly forbidden from touching (`namesGitExecution` in `env.ts` blocks `GIT_CONFIG_*` on `ExecSpec.env` by design) — so this is squarely the workspace backend's job, landing beside (not inside) the agent adapter this phase builds.

**Primary recommendation:** Build `@adl/agent-claude-code` as a new package implementing the `AgentBackend`/`AgentRunner` contract from `.planning/research/ARCHITECTURE.md` §4, calling `Workspace.exec()` exactly once per invocation with `--bare` always on, translating stream-json NDJSON events 1:1 into ADL's `AgentEvent` union and into the transcript file, and writing the final `usage`/`result` event into `usage_events` via the existing repository. Serve transcripts through a new `GET /v1/stages/:id/logs?follow=1&offset=<bytes>` route on the manager's existing Hono app (the seam Phase 3's D-20 already reserved), using `fs.createReadStream({ start: offsetBytes })` for history plus `fs.watch` for the follow tail. Fix D-2-08-1 in `@adl/workspace`, not in the adapter.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Claude Code CLI invocation | Worker (via `@adl/agent-claude-code`) | Workspace (`Workspace.exec`) | The adapter builds the `argv`/env/prompt; `Workspace.exec()` is the only process-launch primitive (WORK-02) — the adapter never spawns |
| Prompt rendering | Worker (`PromptBuilder` module) | — | ARCHITECTURE.md §4: adapters never build prompts; a separate module does, deterministically, from `(NormalizedSpec, EffectiveConfig, SendBackBrief, capabilities)` |
| AgentEvent translation (NDJSON → union) | Worker (adapter) | — | The adapter is the only thing that has seen the CLI's raw stream-json shape; downstream consumers (transcript store, SSE, cost ledger) must never parse Claude Code's format directly |
| Transcript persistence (NDJSON file) | Manager (log store) | Worker (writer via IPC/stream) | ARCHITECTURE.md §4/§9: `logs/<feature>/<round>/<stage>/<attempt>.ndjson`, never DB rows; the worker streams events, the manager's log store owns the file |
| `adl logs -f` live serving | Manager (HTTP/SSE route on existing Hono app) | — | D-20 reserved this seam; byte-offset `?offset=N&follow=1` is the mechanism shared by CLI and future dashboard |
| CLI version preflight | Manager (`probe()` on backend, called at startup / `adl doctor`) | — | OBS-08; must hard-block dispatch before a worker is ever forked, so it belongs to the manager's startup/health path, not the worker |
| Usage/cost recording | Worker (writes via `usageRepository().record()`) | Manager (owns the DB connection the worker reports through) | `usage_events` insert already exists in `@adl/db`; the worker-entry module cannot import `@adl/db` directly (D-01 in Phase 3), so the worker reports usage over IPC and the manager performs the insert — same shape as `stage_result` reporting already in `worker-entry/index.ts` |
| `adl dev-run` CLI verb | CLI (`@adl/cli`, HTTP client only) | Manager (new route triggering the real lease→fork→assign path) | Phase 3 D-18/D-21: every CLI verb goes through the HTTP API; `@adl/cli` never touches `@adl/db`/`@adl/manager` internals |
| D-2-08-1 `safe.directory` fix | Workspace (`@adl/workspace`, worktree backend + scratch-home) | — | The neutralized `GIT_CONFIG_GLOBAL` file is owned and created by the workspace package, not by an agent adapter; this is a workspace-layer bug even though it only manifests when an agent tries to commit |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-code` (CLI, shelled out) | **2.1.237** `[VERIFIED: npm registry, checked 2026-08-20]` | The agent backend this phase adapts | Only agentic CLI with the `--bare`, `--output-format stream-json`, `--json-schema`, `total_cost_usd` surface this phase's success criteria require; `engines: node >=22.0.0` per npm metadata, compatible with the project's Node 24 target `[VERIFIED: npm registry]` |
| `eventsource-parser` | **4.0.0** `[VERIFIED: npm registry, checked 2026-08-20]` | Parsing the SSE stream on the `adl logs -f` CLI-client side | Already named in `./.claude/CLAUDE.md`'s stack doc; `engines: node >=22.12` `[VERIFIED: npm registry]` |

No new runtime dependency is needed for the adapter's own NDJSON→event translation (plain `JSON.parse` per line) or for the manager's byte-offset file serving (`node:fs` + Hono's built-in `streamSSE` helper, already a transitive capability of the `hono` dependency already in the stack).

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `hono/streaming` (`streamSSE`) | bundled with `hono@4.13.2` (already a dependency, per `./.claude/CLAUDE.md`) | The `GET /v1/stages/:id/logs` SSE route | Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` automatically; `[CITED: hono.dev/docs/helpers/streaming]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `claude -p` CLI shell-out | `@anthropic-ai/claude-agent-sdk` (programmatic) | The SDK is a valid `AgentBackend` implementation per `./.claude/CLAUDE.md`, but `04-CONTEXT.md`'s domain section is explicit that this phase's adapter is "the Claude Code adapter (`claude -p --output-format stream-json`)" — the CLI shape, not the SDK. The SDK stays the natural Phase 11 second-adapter candidate if a programmatic backend is wanted alongside the CLI-shaped ones. |
| `tail-file-stream`/`fs-tail-stream` npm packages | Hand-rolled `fs.createReadStream({start}) + fs.watch` | These packages exist and solve exactly this problem `[CITED: npmjs.com, LOW]`, but ADL's need is narrow (append-only NDJSON, single writer, byte-offset semantics already specified by ARCHITECTURE.md §9) — a ~40-line hand-rolled implementation avoids an unaudited dependency in the manager's log-serving hot path. Flag for the planner's discretion, not a hard call either way. |

**Installation:**
```bash
# No new production dependency for the core adapter logic.
# eventsource-parser is the one new package, for the CLI-side SSE consumer:
pnpm --filter @adl/cli add eventsource-parser@4.0.0
```

**Version verification:** confirmed live against the npm registry this session:
```
$ npm view @anthropic-ai/claude-code version   → 2.1.237 (published 2026-08-19)
$ npm view @anthropic-ai/claude-code engines   → { node: '>=22.0.0' }
$ npm view eventsource-parser version          → 4.0.0 (published 2026-08-10)
$ npm view eventsource-parser engines          → { node: '>=22.12' }
```

## Package Legitimacy Audit

| Package | Registry | Age (last publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@anthropic-ai/claude-code` | npm | 2026-08-19 (daily release cadence) | 18,259,096/wk | none listed in npm metadata | **SUS** (heuristic: "too-new", "no-repository") | **Approved with caveat.** The "too-new"/"no-repository" signals are false positives for this specific package: it is Anthropic's own first-party CLI, published under the verified `@anthropic-ai` npm org scope, at 18M weekly downloads, and is already named explicitly in `./.claude/CLAUDE.md`'s locked stack decisions. The automated heuristic flags any package with a very recent publish date regardless of publisher reputation — daily-release CLIs from major vendors will always trip it. **Planner should still add a `checkpoint:human-verify` before the first `npm install -g @anthropic-ai/claude-code@2.1.237` in CI/deployment docs**, per protocol, but this is a low-risk formality, not a real legitimacy concern. |
| `eventsource-parser` | npm | 2026-08-10 | 54,564,968/wk | `github.com/rexxars/eventsource-parser` | **SUS** (heuristic: "too-new" only) | **Approved with caveat.** Same false-positive shape — 54M weekly downloads, real GitHub repo, already named in the project's locked stack doc. Planner should add a light `checkpoint:human-verify` before first install, per protocol; not a real concern. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `@anthropic-ai/claude-code`, `eventsource-parser` — both false positives from the "recently published" heuristic on high-download, first-party/well-known packages; planner should still gate the first install of each behind a light `checkpoint:human-verify` per protocol, but no alternative package is warranted.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ MAINTAINER                                                           │
│   `adl dev-run <feature-id>`         `adl logs -f <stage-id>`        │
└──────────────┬─────────────────────────────────┬─────────────────────┘
               │ HTTP POST                        │ HTTP GET (SSE)
               ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ MANAGER (@adl/manager) — existing Hono app (D-20 reserved this)      │
│                                                                       │
│  POST /v1/dev-run/:featureId          GET /v1/stages/:id/logs        │
│    │ 1. SpecLoader loads features/<id>/     ?offset=N&follow=1       │
│    │ 2. lease acquired (Phase 3 broker)         │                    │
│    │ 3. forkWorker() — real IPC channel          │ fs.createReadStream│
│    │ 4. assign message → worker                  │  ({start:offset}) │
│    ▼                                              │  + fs.watch tail  │
│  Worker Supervisor  ◄──── heartbeat/stage_result ─┤                  │
│    │                       (existing IPC protocol)│                  │
│    ▼                                              │                  │
│  Log Store (NDJSON, byte-offset addressable) ─────┘                  │
│    logs/<feature>/<round>/<stage>/<attempt>.ndjson                   │
│    ▲ appended live as events arrive                                  │
│    │ (worker → manager, over IPC or a reported stream)               │
├────┼──────────────────────────────────────────────────────────────────┤
│ WORKER (forked child, packages/manager/src/worker-entry)             │
│    │                                                                 │
│    ▼                                                                 │
│  productionStageRunner() → NEW: real StageRunner calling the         │
│    Claude Code AgentBackend adapter (@adl/agent-claude-code)         │
│    │                                                                 │
│    │ 1. PromptBuilder renders system prompt + instructions           │
│    │    (deterministic; persisted as an artifact)                    │
│    │ 2. AgentBackend.probe() already ran at manager startup —        │
│    │    version preflight is NOT repeated per-invocation             │
│    │ 3. Workspace.exec({argv: ['claude','-p','--bare',...]}, log)    │
│    │    — the ONLY process-launch call (WORK-02)                     │
│    ▼                                                                 │
│  claude -p --bare --output-format stream-json --verbose               │
│    --include-partial-messages --append-system-prompt <rendered>       │
│    (subprocess, inside the feature's git worktree, via execa)         │
│    │ stdout: NDJSON lines (system/init, assistant, user,             │
│    │         system/api_retry, result)                                │
│    ▼                                                                 │
│  Adapter's line-by-line translator → AgentEvent union                 │
│    │ each event: (a) appended to transcript log() callback            │
│    │             (b) `usage`/`result` events → usage_events insert    │
│    │                (via IPC report → manager → usageRepository)      │
│    ▼                                                                 │
│  Real commit lands in the feature's worktree (git via Workspace.exec) │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
packages/
├── agent-claude-code/         # NEW — @adl/agent-claude-code
│   ├── src/
│   │   ├── backend.ts         #   AgentBackend implementation: run(), probe()
│   │   ├── events.ts          #   stream-json NDJSON line → AgentEvent translator
│   │   ├── preflight.ts       #   claude --version parse + pin comparison
│   │   └── index.ts
│   └── vitest.config.ts
├── core/src/stage/
│   └── stage.ts                # AgentRunner forward decl → real shape (this phase)
├── manager/src/
│   ├── worker-entry/
│   │   └── index.ts            # productionStageRunner() → real Claude Code call
│   ├── prompt/                 # NEW — PromptBuilder (separate module; adapters never build prompts)
│   │   ├── templates/developer.md
│   │   └── build.ts
│   ├── store/                  # NEW — NDJSON log store, byte-offset addressing
│   │   └── ndjson-log-store.ts
│   └── api/routes/
│       └── logs.ts             # NEW — GET /v1/stages/:id/logs SSE route
└── workspace/src/
    ├── exec/scratch-home.ts    # createScratchHome() — D-2-08-1 fix touches this
    └── worktree/backend.ts     # writes safe.directory entry after worktree add
```

### Pattern 1: Delegated-loop adapter translates, never re-implements the loop

**What:** The Claude Code CLI owns tool use, file edits, and its own agentic loop. The adapter's only job is to invoke it correctly and translate its output — it must never try to parse `assistant`/`tool_use` content and re-drive decisions from it.
**When to use:** Every delegated-loop backend (`claude -p`, future `codex exec`, `gemini -p`).
**Example:**
```typescript
// packages/agent-claude-code/src/backend.ts
// Grounded in Workspace.exec's real signature:
//   packages/core/src/stage/workspace.ts:266-296
//   exec(spec: ExecSpec, log: (chunk: LogChunk) => void): Promise<ExecResult>
import type { Workspace, ExecSpec, LogChunk } from '@adl/core/stage';
import { translateLine } from './events.js';

export async function runClaudeCode(
  workspace: Workspace,
  systemPrompt: string,
  instructions: string,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const spec: ExecSpec = {
    argv: [
      'claude', '-p', instructions,
      '--bare',                                  // CITED: code.claude.com/docs/en/headless
      '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      '--append-system-prompt', systemPrompt,
      '--permission-mode', 'acceptEdits',
    ],
    cwd: workspace.root,
    path: process.env.PATH ?? '',
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }, // D-09: named explicitly, per-exec
    timeoutMs: /* from AgentTask.limits.maxWallClockMs */ 0,
  };

  let buffer = '';
  const log: (chunk: LogChunk) => void = (chunk) => {
    if (chunk.stream !== 'stdout') return;
    buffer += chunk.text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      onEvent(translateLine(line));   // NDJSON line -> ADL AgentEvent
    }
  };

  await workspace.exec(spec, log);
}
```
`[VERIFIED: packages/core/src/stage/workspace.ts:266-296]` — quoted method signature: `exec(spec: ExecSpec, log: (chunk: LogChunk) => void): Promise<ExecResult>`. `[CITED: code.claude.com/docs/en/headless]` for the `--bare` flag and its effect.

### Pattern 2: `--bare` for reproducibility, explicit context for anything ADL wants loaded

**What:** `--bare` skips auto-discovery of hooks, skills, plugins, MCP servers, auto-memory, and `CLAUDE.md`/`AGENTS.md`. Confirmed directly from Anthropic's own headless-mode docs, fetched this session (2026-08-20):

> "Add `--bare` to reduce startup time by skipping auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md. Without it, `claude -p` loads the same context an interactive session would... `--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." `[CITED: code.claude.com/docs/en/headless]`

**When to use:** Every `adl dev-run` / loop invocation, always — this is success criterion 4's mechanism (deterministic prompt per commit).
**Important caveat found this session:** in bare mode, "Claude Code never reads OAuth credentials or the system keychain" — `ANTHROPIC_API_KEY` must be supplied explicitly through the env allowlist mechanism `Workspace.exec` already has (D-09), which lines up exactly with what this phase needs anyway. `[CITED: code.claude.com/docs/en/headless]`

Table of what to load explicitly instead of relying on discovery, per the same doc:

| To load | Use |
|---|---|
| System prompt additions | `--append-system-prompt`, `--append-system-prompt-file` |
| Settings | `--settings <file-or-json>` |
| MCP servers | `--mcp-config <file-or-json>` |
| A repo's own `AGENTS.md` (if the maintainer wants it used) | Read explicitly as a `ContextRef` in `PromptBuilder`, per ARCHITECTURE.md §4 point 4 — never via auto-discovery |

`[CITED: code.claude.com/docs/en/headless]`

### Pattern 3: NDJSON byte-offset log store with `?offset=N&follow=1` reconnect

**What:** One file per stage attempt, one event per line, served by seeking to a byte offset then tailing.
**When to use:** `GET /v1/stages/:id/logs` — the route D-20 reserved.
**Example:**
```typescript
// packages/manager/src/api/routes/logs.ts
import { createReadStream, watch } from 'node:fs';
import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';

export function registerLogsRoute(app: Hono, deps: { resolveLogPath: (stageId: string) => string }) {
  app.get('/v1/stages/:id/logs', (c) => {
    const stageId = c.req.param('id');
    const offset = Number(c.req.query('offset') ?? '0');
    const follow = c.req.query('follow') === '1';
    const path = deps.resolveLogPath(stageId);

    return streamSSE(c, async (stream) => {
      let position = offset;

      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(path, { start: position, encoding: 'utf8' });
        rs.on('data', (chunk: string) => {
          position += Buffer.byteLength(chunk, 'utf8');
          void stream.writeSSE({ data: chunk, event: 'log' });
        });
        rs.on('end', resolve);
        rs.on('error', reject);
      });

      if (!follow) return;

      const watcher = watch(path, { persistent: true }, () => {
        const rs = createReadStream(path, { start: position, encoding: 'utf8' });
        rs.on('data', (chunk: string) => {
          position += Buffer.byteLength(chunk, 'utf8');
          void stream.writeSSE({ data: chunk, event: 'log' });
        });
      });
      stream.onAbort(() => watcher.close());
      while (!stream.closed) await stream.sleep(1000);
      watcher.close();
    });
  });
}
```
`[CITED: hono.dev/docs/helpers/streaming for streamSSE shape]` `[ASSUMED: the fs.watch + createReadStream({start}) composition — cross-checked against multiple third-party tail-stream implementations doing the same thing, but not verified against ADL's own log-store code since it does not exist yet this phase]`. Byte offset MUST be tracked in bytes written (`Buffer.byteLength`, not `chunk.length`, since UTF-8 multi-byte characters make those diverge) — this is a correctness requirement for the reconnect contract in ARCHITECTURE.md §9, not a style preference.

### Pattern 4: Cost/usage recording reuses the existing repository — do not write a new persistence path

**What:** `usageRepository().record(event: NewUsageEvent)` already exists and already inserts into `usage_events` with the exact columns this phase needs to populate (`cost_source`, `cost_category`, per-model token columns).
**When to use:** After every `result`/`usage` `AgentEvent` from the adapter.
```typescript
// packages/db/src/repository/usage.ts:53-58 (VERIFIED — already in the repo)
// export function usageRepository(db: Kysely<Database>): UsageRepository {
//   record(event: NewUsageEvent): Promise<void>
//   ...
// }
```
`[VERIFIED: packages/db/src/repository/usage.ts:20,32-33,53-57]` — quoted: `export type NewUsageEvent = UsageEventsTable;` and `record(event: NewUsageEvent): Promise<void>;` implemented as `await db.insertInto('usage_events').values(event).execute();`.

Mapping from `claude -p --output-format json`'s response to `NewUsageEvent` (schema columns per `[VERIFIED: packages/db/migrations/0002_contracts.ts:181-198]`, quoted: `model_id text not null, speed text not null check (speed in ('standard', 'fast')), input_tokens integer, output_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer, cost_usd real, cost_source text not null check (cost_source in ('reported', 'computed', 'unknown')), cost_category text not null check (cost_category in ('feature', 'overhead'))`):

| `usage_events` column | Source in `claude -p --output-format json` | Notes |
|---|---|---|
| `cost_usd` | `total_cost_usd` | `[CITED: code.claude.com/docs/en/headless — "the response payload includes total_cost_usd and a per-model cost breakdown... both figures are client-side estimates and can differ from your actual bill"]` |
| `cost_source` | `'reported'` | Per D-06/D-31 and `./.claude/CLAUDE.md`'s "prefer the backend's reported cost over your own arithmetic" — never `'computed'` for this backend |
| `input_tokens`/`output_tokens`/`cache_*_tokens` | `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` | `[ASSUMED — field names cross-checked against WebSearch summaries of the JSON schema, not fetched from a live invocation this session; the planner's Task 1 should print a real `--output-format json` response once to confirm exact field names before wiring the mapper]` |
| `cost_category` | `'feature'` for a normal dev-run invocation, `'overhead'` only for a D-13 repair reprompt | Per D-14 |
| `model_id`, `speed` | From `system/init` event's `model` field, or the adapter's own config of which model it invoked | `system/init` reports "the model, tools, MCP servers, and loaded plugins" `[CITED: code.claude.com/docs/en/headless]` |

### Anti-Patterns to Avoid
- **Re-implementing the tool loop from the adapter's own event stream.** The whole point of the delegated-loop family (ARCHITECTURE.md §4) is that Claude Code owns the loop. Do not branch on `tool_call`/`tool_result` events to make decisions in the adapter — only to translate and log them.
- **Buffering the full transcript before persisting.** Append each translated `AgentEvent` to the NDJSON file as it arrives (streamed through the same `log()` callback `Workspace.exec` already streams stdout/stderr through), not after the process exits — this is what makes `adl logs -f` "live" per success criterion 2, and what avoids losing everything on a mid-run crash.
- **Repeating the version preflight on every invocation.** OBS-08/success-criterion-3 wants a broken install caught "before running a feature through it" — check once at manager startup / via `probe()`, hard-block dispatch on mismatch, and let `adl doctor` re-run the same check on demand. A per-exec `claude --version` shell-out on every round is wasted latency and does not match the "diagnose before running" framing.
- **Using `ExecSpec.env` to set any `GIT_CONFIG_*` variable for the D-2-08-1 fix.** `packages/workspace/src/exec/env.ts`'s `namesGitExecution()` explicitly rejects this family on `ExecSpec.env` (WR-02) — the fix belongs in the workspace's own scratch-home/worktree creation code, writing directly to the `.gitconfig` file `GIT_CONFIG_GLOBAL` already points at.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Usage/cost persistence | A new insert path from the adapter | `usageRepository().record()` (`packages/db/src/repository/usage.ts`, already implemented) | Already handles the nullable-token/no-default-zero discipline (D-31) and category split (D-14) correctly; a second write path risks drifting from that discipline |
| Process launching | A second `execa` call site in the adapter | `Workspace.exec()` | `eslint.config.js`'s `adl/no-direct-spawn` rule permits exactly one exemption path (`packages/workspace/**`); an adapter that spawns directly breaks WORK-02 and the container-backend swap |
| Prompt construction | Ad-hoc string building inside the adapter | `PromptBuilder` (new, separate module per `04-CONTEXT.md` D-notes and ARCHITECTURE.md §4) | Deterministic rendering + persisted artifact is a named requirement, not an implementation detail; a second prompt-building path defeats "one reviewable place" |
| SSE reconnect semantics | A custom event-sequence-number scheme | Byte-offset addressing (`?offset=N&follow=1`), per ARCHITECTURE.md §9 | Already the specified mechanism; a second scheme (e.g. line numbers) breaks the "CLI and dashboard are the same code" property the byte-offset design buys |
| CLI JSON parsing on the `adl logs -f` client | Hand-rolled SSE line parser | `eventsource-parser@4.0.0` | Already the named stack choice (`./.claude/CLAUDE.md`); Node has `fetch` but no built-in `EventSource` |

**Key insight:** the two riskiest-looking pieces of this phase — cost recording and the process-launch boundary — are **already built** by Phase 1 and Phase 2. This phase's actual net-new surface is smaller than the success criteria suggest: one new adapter package, one new PromptBuilder module, one new NDJSON-file-plus-SSE-route pair, one preflight check, and one workspace-layer git-config fix.

## Runtime State Inventory

> This phase is not a rename/refactor/migration phase (it adds a new adapter and CLI verb). Section omitted per the "omit entirely for greenfield phases" instruction. One item worth flagging as adjacent, not in scope: the D-2-08-1 fix touches how the scratch-home's `.gitconfig` is populated, but this is a new-behavior addition (writing a file that is currently never written), not a migration of existing state — no existing scratch homes need retroactive repair since they are created fresh (`mkdtemp`) and destroyed per run.

## Common Pitfalls

### Pitfall 1: `--bare` and structured/session semantics interact in ways not fully documented for headless CI use
**What goes wrong:** The phase's own research flag calls out that "per-backend agentic-CLI behaviour under unattended conditions is under-documented." Combining `--bare` with `--output-format stream-json --verbose --include-partial-messages` and `--append-system-prompt` in one invocation, unattended, in a worktree the CLI has never seen, is not a combination the official docs show as one end-to-end example.
**Why it happens:** Anthropic's docs (fetched this session) document each flag individually and in pairs (`--bare` with `--allowedTools`; `stream-json` with `--verbose --include-partial-messages`), not the exact four-flag combination this phase needs.
**How to avoid:** The planner should include an early task that runs the exact intended `argv` by hand against a throwaway worktree and captures the real NDJSON output before wiring the translator — do not build `events.ts`'s translator purely from the documented event shapes without one real capture. `--bare` also disables OAuth/keychain reads, so the manual capture must set `ANTHROPIC_API_KEY` explicitly (matches D-09's per-exec allowlist anyway).
**Warning signs:** The translator silently drops or misclassifies an event type not seen in the manual capture (e.g., `system/plugin_install`, `hook_started` — both real event types per the docs, both irrelevant under `--bare` but worth confirming they truly don't appear).

### Pitfall 2: Version preflight has no documented machine-readable contract
**What goes wrong:** `claude --version`'s exact output format and exit-code contract on a version mismatch are not documented in the official CLI reference (confirmed by direct search this session — the reference documents `claude update`, `claude install <version>`, `claude daemon status`, and `claude doctor`, but not `--version`'s output shape).
**Why it happens:** `--version` is a convention, not a contracted API surface, for most CLIs.
**How to avoid:** Preflight should (a) run `claude --version` locally once during planning/implementation to record the actual observed format, (b) parse defensively (regex for a semver-shaped token in stdout, not an exact string match), and (c) prefer `claude doctor` if its output proves more structured — the docs describe it as printing "installation diagnostics including install health," which sounds closer to what OBS-08 wants than a bare version string comparison.
**Warning signs:** A preflight regex that works against 2.1.237's actual output today breaks silently against a future minor version's cosmetic format change — pin the regex test against a fixture captured from a real invocation, and re-capture it whenever the pinned CLI version changes.

### Pitfall 3: D-2-08-1 — `safe.directory` / dubious ownership inside the worktree
**What goes wrong:** `fatal: detected dubious ownership in repository` on Linux, exit 128, whenever the process running `git` has a different UID than the one that owns the worktree's files.
**Why it happens:** Git ≥2.35.2 refuses to operate inside a repository owned by a different UID than the current process, as a CVE-2022-24765 mitigation `[CITED: multiple sources cross-checked, MEDIUM]`. In ADL's design, the worktree is created (Phase 2's worktree backend) and the agent's `git commit` runs under the privilege-dropped worker identity (WORK-05) — if the worktree's on-disk ownership was not also transferred to that identity, or if git's ownership check simply distrusts cross-boundary provenance even under matching UIDs in some deployment shapes, this fires.
**How to avoid:** `packages/workspace/src/exec/env.ts` already points `GIT_CONFIG_GLOBAL` at `<scratchHome>/.gitconfig` — a file `createScratchHome()` (`packages/workspace/src/exec/scratch-home.ts`) never writes, it only creates the empty directory via `mkdtemp`. The fix is to have the worktree backend (`packages/workspace/src/worktree/backend.ts`, which already calls `createScratchHome()` at line 130 and `applyWorkerAccess()` at line 146) write a `[safe]\n\tdirectory = <worktree path>\n` stanza into that `.gitconfig` file once, at workspace-creation time, before any agent exec occurs. This must NOT be attempted via `ExecSpec.env`'s `GIT_CONFIG_*` variables — `env.ts`'s `namesGitExecution()` explicitly refuses that family on `ExecSpec.env` by design (WR-02), so the fix has to be a direct file write inside `@adl/workspace`, not a parameter threaded through the adapter.
**Warning signs:** `adl dev-run`'s success criterion 1 (real commit inside the worktree) fails specifically on Linux CI/deployment but works on the maintainer's Windows dev machine — exactly the "looks unchanged in the diff... platform-split failure" shape `run.ts`'s own comments warn about elsewhere in this codebase.

### Pitfall 4: Runaway spend / O(N²) context growth (carried from PITFALLS.md Pitfall 7, scoped down for this phase)
**What goes wrong:** Not fully in scope this phase (budget *enforcement* is Phase 6), but the *recording* half is, and getting it wrong here means Phase 6 designs against bad data.
**Why it happens:** A `dev-run`'s single agent turn is cheap in isolation, but the accounting plumbing built here — `cost_source`, `cost_category`, per-model token columns — is exactly what Phase 6's enforcement will read. If this phase records `costSource: 'computed'` or drops cache-token columns to save adapter complexity, the spike does not actually close.
**How to avoid:** Follow D-06 literally: use the CLI's own `total_cost_usd`, tag `cost_source: 'reported'`, and populate all four token columns from the `usage` object rather than collapsing them.
**Warning signs:** `usage_events.cost_source` recording `'unknown'` for every `dev-run` invocation — if that happens, the spike is not closed, whatever STATE.md says afterward.

### Pitfall 5: Agent adapters spawning processes directly (ARCHITECTURE.md Anti-Pattern 2, directly load-bearing here)
**What goes wrong:** `child_process.spawn('claude', …, { cwd: worktreePath })` inside the new `@adl/agent-claude-code` package instead of `workspace.exec(spec, log)`.
**Why it happens:** It is the more obvious thing to write when you are focused on getting `claude -p` to run correctly and haven't internalized that the workspace boundary exists precisely so a v2 container backend can intercept this call.
**How to avoid:** `eslint.config.js`'s `adl/no-direct-spawn` rule should catch this at CI time if the exemption list stays correctly scoped to `packages/workspace/**` only — the planner should verify (not assume) that adding `@adl/agent-claude-code` as a new package does not require a lint-config change, and if it does, that the change is NOT adding an exemption for the new package.
**Warning signs:** A new package importing `execa` directly; a passing test suite that never actually exercises `Workspace.exec()`'s privilege-drop/env-allowlist path for the agent's own subprocess.

## Code Examples

### Version preflight, hard-block shape (D-01/D-02)
```typescript
// packages/agent-claude-code/src/preflight.ts
// D-01: pinned exactly, not a floor. D-02: mismatch hard-blocks dispatch.
export const PINNED_CLAUDE_CODE_VERSION = '2.1.237'; // [VERIFIED: npm registry, checked 2026-08-20]

export interface PreflightResult {
  readonly ok: boolean;
  readonly installedVersion: string | null;
  readonly expectedVersion: string;
  readonly detail?: string;
}

export async function preflightClaudeCode(
  runVersionCheck: () => Promise<{ stdout: string; exitCode: number | null }>,
): Promise<PreflightResult> {
  const { stdout, exitCode } = await runVersionCheck();
  if (exitCode !== 0) {
    return {
      ok: false,
      installedVersion: null,
      expectedVersion: PINNED_CLAUDE_CODE_VERSION,
      detail: `claude --version exited ${exitCode ?? 'null'} — broken installation`,
    };
  }
  // Defensive parse — [ASSUMED] output format, not contracted by Anthropic's
  // docs; capture a real fixture before finalizing this regex (Pitfall 2).
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  const installed = match?.[1] ?? null;
  return {
    ok: installed === PINNED_CLAUDE_CODE_VERSION,
    installedVersion: installed,
    expectedVersion: PINNED_CLAUDE_CODE_VERSION,
    detail:
      installed === PINNED_CLAUDE_CODE_VERSION
        ? undefined
        : `expected ${PINNED_CLAUDE_CODE_VERSION}, found ${installed ?? 'unparseable output'} — broken installation (OBS-08)`,
  };
}
```
This call must run through `Workspace.exec` / the same subprocess boundary as everything else (it is still an external CLI invocation), or through a manager-owned equivalent for the ADL-owned (`owner: 'adl'`) case documented in `packages/workspace/src/exec/run.ts:31-57` — `[VERIFIED: packages/workspace/src/exec/run.ts:58]`, quoted: `export type ExecOwner = 'agent' | 'adl';`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Interactive `claude` session for scripted use | `claude -p --bare` headless | `--bare` is documented as "the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release" `[CITED: code.claude.com/docs/en/headless]` | ADL should treat `--bare` as a permanent requirement, not a workaround — it is the vendor's own stated direction of travel, reducing future drift risk |
| `--output-format stream-json` alone for streaming | `stream-json` + `--verbose --include-partial-messages` for token-level deltas | Confirmed this session: without `--include-partial-messages`, stream-json still emits message-level events but not incremental text deltas `[CITED: code.claude.com/docs/en/headless]` | Since D-07 in `04-CONTEXT.md` wants full `AgentEvent` detail (including `text`/`thinking` deltas) in the transcript, `--include-partial-messages` is required, not optional |
| Subagent messages silently absent from the stream | `--forward-subagent-text` (requires CLI ≥2.1.211) to also emit subagent text/thinking | Recent CLI addition per the fetched docs | Not needed for this phase (developer role has no subagents defined yet), but worth knowing the flag exists if the developer prompt later delegates to subagents |

**Deprecated/outdated:**
- Relying on interactive-session auto-discovery (`CLAUDE.md`/hooks/MCP) for a scripted `-p` call is explicitly called out by Anthropic's own docs as risky even outside ADL's threat model: "Without `--bare`, Claude Code runs the hooks in a project's `.claude/settings.json` even in a folder you've never trusted, because a `-p` session shows no workspace trust dialog." This independently corroborates ARCHITECTURE.md's Anti-Pattern 7 reasoning from the vendor's own side.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Exact field names inside the `usage` object of `claude -p --output-format json` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) match `usage_events`' column names 1:1 | Pattern 4 / Code Examples | If field names differ even slightly (e.g. nested under a per-model breakdown rather than flat), the cost mapper silently writes `undefined`/`null` into columns that should be populated, and the cost-accounting spike appears closed when it is not. Mitigation already recommended: capture one real invocation before wiring the mapper. |
| A2 | `fs.watch` + `fs.createReadStream({start})` is sufficient for the NDJSON tail-follow without a dedicated npm package | Pattern 3 | If `fs.watch`'s platform inconsistencies (well-known cross-platform quirks — different behavior on Linux inotify vs. Windows ReadDirectoryChangesW vs. macOS FSEvents) cause missed-append events under load, `adl logs -f` could silently stall rather than duplicate/lose data — a correctness gap the planner should design an explicit test for (kill/reconnect mid-stream, per success criterion 2's own wording) |
| A3 | `--bare` combined with `--append-system-prompt` and `--permission-mode acceptEdits` is a valid, working combination for an unattended developer-role invocation | Pattern 1 / Pitfall 1 | Untested combination per the phase's own research flag; if `acceptEdits` under `--bare` behaves differently than under a normal session (e.g. still prompts for something bare mode doesn't pre-approve), the "real commit" success criterion could stall waiting on a permission prompt that never resolves in a headless context |
| A4 | The `safe.directory` fix belongs in the worktree backend writing to the scratch-home `.gitconfig`, rather than in the underlying worktree's on-disk ownership (`chown`) | Pitfall 3 | If the true root cause on the target deployment is worker-UID/worktree-owner-UID mismatch rather than git's "different UID than current process" check being overly conservative even under a match, the `safe.directory` config-file fix would mask the symptom but leave a real ownership mismatch (with its own WORK-05/permission implications) unaddressed — the planner should reproduce the exact failure on a provisioned Linux host (per the deferred `reproduce-d-2-r-1-on-linux.md` pattern already in this project) before assuming the config fix alone suffices |

## Open Questions

1. **Does `PromptBuilder`'s per-role template live as a file, DB row, or inline TS?**
   - What we know: ARCHITECTURE.md §4 only requires it be overridable per repo (`adl.yml: agents.developer.prompt_template`) and per-stage for harnesses.
   - What's unclear: `04-CONTEXT.md` explicitly leaves this to the planner's discretion.
   - Recommendation: a markdown template file under `packages/manager/src/prompt/templates/` (matching the `Recommended Project Structure` above), loaded and rendered by `build.ts` — files are the most diffable, most reviewable-in-a-PR option, matching PROJECT.md's "reasoning visible" value, and matching this phase's own D-07 emphasis on full-detail visibility.

2. **Should the `artifacts` table land in this phase's migrations to persist rendered prompts?**
   - What we know: it is "deliberately absent since Phase 1, D-29" and `04-CONTEXT.md` leaves it to discretion.
   - What's unclear: whether a simpler mechanism (writing the rendered prompt to the same NDJSON-adjacent log store, as a sibling file, e.g. `logs/<feature>/<round>/<stage>/<attempt>.prompt.txt`) satisfies "persist the rendered prompt as an artifact per stage attempt" (ARCHITECTURE.md §4) without a new migration.
   - Recommendation: use the log-store sibling-file approach for this phase (no new migration), since `stage_attempts.error_raw_ref` already establishes the pattern of "artifact pointer, not a blob, and not necessarily a DB-tracked artifacts table" — a full `artifacts` table with content-addressing can be introduced later without breaking this file-based convention, whereas introducing it now is schema surface this phase's success criteria do not require.

3. **Exact behavior of `--max-turns` / `AgentTask.limits.maxTurns` interaction with `--bare`**
   - What we know: `--max-turns` exists and is documented as "print mode only."
   - What's unclear: whether a turn-cap hit surfaces as a distinct `result` subtype the adapter must recognize (vs. looking identical to a normal completion), which matters for correctly classifying `StageError` vs. a legitimate `pass`/`send_back`.
   - Recommendation: capture this in the same manual real-invocation exercise recommended in Pitfall 1, deliberately forcing a turn-cap hit once, before finalizing the `events.ts` translator's `result` handling.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `@anthropic-ai/claude-code` CLI binary on PATH | The whole phase — `Workspace.exec` resolves `claude` from `spec.path`/`env.PATH` | Not verified on this machine this session (research-only pass; no `claude --version` was run against a live install) | Pinned target: 2.1.237 | None — this is the phase's core dependency; `probe()`/preflight is the mechanism that turns "not installed" into a clear OBS-08 diagnosis rather than a mysterious failure |
| `ANTHROPIC_API_KEY` (or Bedrock/Vertex/Foundry provider credentials) | Any real `claude -p --bare` invocation | Not checked (credential, out of scope for research to probe) | — | None for a real dev-run; `adl doctor` should surface a clear "no credential configured" diagnosis distinct from "binary missing" |
| Node.js ≥22 | `@anthropic-ai/claude-code` npm engines field, `eventsource-parser` engines field | Project already targets Node 24 LTS per `./.claude/CLAUDE.md` | — | — |
| A Linux host for reproducing D-2-08-1 | Verifying the `safe.directory` fix actually resolves the bug | Not available from the maintainer's Windows machine (same constraint noted in `STATE.md` for the related `reproduce-d-2-r-1-on-linux.md` item) | — | The fix can be implemented and unit-tested for the config-write logic on any platform, but end-to-end verification of "the real commit succeeds on Linux" needs a Linux CI leg or provisioned host, per the same pattern Phase 2/3 already used |

**Missing dependencies with no fallback:**
- The `claude` CLI binary itself, at the pinned version, on whatever host runs the manager/worker. This phase's own success criterion 3 exists to turn this into a loud diagnosis rather than a silent gap.

**Missing dependencies with fallback:**
- None identified beyond the CLI binary and credentials, both of which are hard requirements with no fallback by design (an unattended loop cannot "degrade" its way to a commit without a working backend).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4 (confirmed: `[VERIFIED: vitest.config.ts]`, workspace-projects mode — `pnpm vitest run --project <package>` per package) |
| Config file | `vitest.config.ts` (root) + one `packages/*/vitest.config.ts` per package; a new `packages/agent-claude-code/vitest.config.ts` is needed for the new package |
| Quick run command | `pnpm vitest run --project agent-claude-code` (once the package exists) |
| Full suite command | `pnpm test` (per `.planning/config.json`'s `workflow.test_command`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BACK-01 | Adapter invokes `claude -p` through `Workspace.exec`, never a direct spawn | unit | `pnpm vitest run --project agent-claude-code -t "workspace.exec"` | ❌ Wave 0 |
| BACK-01 | `adl/no-direct-spawn` lint exemption count stays at one after adding `agent-claude-code` | lint/CI | existing `test/lint/no-restricted-imports.test.ts` pattern, extended | ⚠️ existing mechanism, needs the new package added to its assertions — Wave 0 |
| BACK-05 | Claude Code adapter produces a real commit in a real worktree | integration (requires a real `claude` binary + credential; likely `checkpoint:human-verify` or CI-gated) | manual/CI-gated `adl dev-run` against a fixture feature | ❌ Wave 0 |
| OBS-02 | `adl logs -f` reconnects mid-stream without losing/duplicating output | integration | new test exercising the SSE route with a kill-and-reconnect sequence against a growing NDJSON file | ❌ Wave 0 |
| (success criterion 3) | Version mismatch hard-blocks dispatch with a named expected-vs-installed message | unit | `pnpm vitest run --project agent-claude-code -t "preflight"` | ❌ Wave 0 |
| (success criterion 4) | Same feature + same commit → byte-identical rendered prompt across two `dev-run` invocations | unit | `pnpm vitest run --project manager -t "PromptBuilder deterministic"` | ❌ Wave 0 |
| (D-06) | `usage_events` row from a real `dev-run` has `cost_source: 'reported'` and populated token columns | integration (real CLI call, likely `checkpoint:human-verify`-adjacent) | manual verification against a real `dev-run`, asserted via `usageRepository().listForFeature()` | ❌ Wave 0 — this IS the spike-closing evidence D-06 asks for |

### Sampling Rate
- **Per task commit:** `pnpm vitest run --project agent-claude-code` (or whichever package the task touched)
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus the manual `adl dev-run` real-invocation evidence for BACK-05/D-06 (these cannot be meaningfully faked by a unit test — a real agent turn is the deliverable)

### Wave 0 Gaps
- [ ] `packages/agent-claude-code/vitest.config.ts` + package scaffold — new package, no existing test infra
- [ ] `packages/manager/src/prompt/` test scaffold for `PromptBuilder` determinism tests
- [ ] `packages/manager/src/store/` test scaffold for the NDJSON log store / SSE route
- [ ] A fixture `claude` binary double (a small script mimicking `stream-json` output) for adapter unit tests that must not shell out to a real, billed CLI invocation on every test run — the real-CLI tests are the checkpoint-gated exception, not the default
- [ ] `test/lint/no-restricted-imports.test.ts` extended to cover `agent-claude-code`'s exemption-free status

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (new surface) | existing bearer-token middleware in `packages/manager/src/api/app.ts` already covers the new `/v1/stages/:id/logs` and `/v1/dev-run/:featureId` routes — no new auth mechanism needed, just registering the routes inside the existing `createApi()` |
| V5 Input Validation | yes | `offset` query param on the logs route must be validated as a non-negative integer before being passed to `fs.createReadStream({start})` — an unvalidated negative or non-numeric value should 400, not throw an unhandled error inside the stream |
| V6 Cryptography | no | not applicable — no new crypto surface this phase |
| V7 Error Handling / Logging | yes | `env.ts`'s existing discipline ("this function must never log, and must never put a value in an error message" for anything touching credentials) extends directly to the new adapter: `ANTHROPIC_API_KEY`'s value must never appear in a transcript, a log line, or an error message the adapter produces — the CLI's own stdout/stderr could theoretically echo it back if the agent were tricked into printing it, which is a prompt-injection-adjacent concern (PITFALLS.md Pitfall 11) worth a specific negative test |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via the feature spec instructing the agent to print/exfiltrate its own environment or the model API key | Information Disclosure | Already covered structurally by D-09/D-10 (zero-inherit env, explicit allowlist) — the key only ever reaches the one `claude` subprocess exec, never the worker's ambient environment; PITFALLS.md Pitfall 11's untrusted-input-marker mitigation applies to how `PromptBuilder` wraps spec content |
| A malicious or malformed `--json-schema` / structured-output request causing the CLI to error in a way the adapter misclassifies as a gate failure rather than an infrastructure error | Denial of Service (of the loop's round budget) | Follow D-12/D-15's existing `StageError` taxonomy — an unparseable/invalid-schema response from the CLI must map to a `StageError`, never silently to a `fail` verdict that costs the developer a round |
| Log/transcript file path traversal via a crafted `:id` param on `/v1/stages/:id/logs` | Tampering / Information Disclosure | The route must resolve `stageId` through the existing DB-backed `stage_attempts` lookup (never build a filesystem path directly from the untrusted `:id` path param) — mirrors the workspace-relative-path-only discipline ARCHITECTURE.md §5 already establishes for findings/evidence |

## Sources

### Primary (HIGH confidence)
- `packages/core/src/stage/stage.ts` (this repo) — `AgentRunner` forward declaration, `LogChunk`, `StageContext`
- `packages/core/src/stage/workspace.ts` (this repo) — `Workspace`, `ExecSpec`, `ExecResult` real interfaces
- `packages/workspace/src/exec/run.ts`, `env.ts`, `scratch-home.ts` (this repo) — the exec boundary, env-allowlist, and scratch-home mechanics the D-2-08-1 fix and the adapter both depend on
- `packages/workspace/src/worktree/backend.ts` (this repo) — worktree creation call sites
- `packages/db/src/repository/usage.ts`, `packages/db/migrations/0002_contracts.ts` (this repo) — the existing `usage_events` write path and schema
- `packages/manager/src/worker-entry/index.ts`, `packages/manager/src/api/app.ts` (this repo) — the exact integration points this phase's code lands in
- npm registry (`npm view`, checked 2026-08-20) — `@anthropic-ai/claude-code@2.1.237`, `eventsource-parser@4.0.0`, engines fields
- `code.claude.com/docs/en/headless` (fetched live, 2026-08-20) — `--bare`, `--output-format`, `--append-system-prompt`, `--resume`/`--continue`, `stream-json` event shapes (`system/init`, `system/api_retry`), `total_cost_usd`/`usage` fields, exit codes

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` §4, §5, §9 (this project's own prior research pass) — `AgentBackend`/`AgentEvent` interface sketch, workspace-leak analysis, SSE/byte-offset design
- `.planning/research/PITFALLS.md` Pitfall 7, Pitfall 12 (this project's own prior research pass) — runaway spend and LCD-trap patterns
- A third-party CLI-flags reference page aggregating Anthropic's docs (WebFetch, cross-checked against the primary docs fetch above for every flag actually used in this research — `--print`, `--continue`, `--resume`, `--append-system-prompt`, `--permission-mode`, `--settings`, `--strict-mcp-config`, `--mcp-config`, `--json-schema`, `--version`)

### Tertiary (LOW confidence)
- WebSearch results on `git safe.directory`/dubious-ownership fixes (multiple independent sources converging on the same `git config --global --add safe.directory <path>` mechanism, but no source specific to ADL's exact worktree + scratch-home + privilege-drop combination — this session's own code reading of `env.ts`/`scratch-home.ts` is what grounds the specific fix location, not the web search itself)
- WebSearch results on Node.js tail-file/fs.watch patterns (npm package descriptions, not a fetched implementation)
- WebSearch result on exact `usage` object field names inside `claude -p --output-format json` (not independently fetched from an official schema reference this session — flagged as Assumption A1)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified live against the npm registry this session
- Architecture: HIGH — grounded directly in code already in the repository (`Workspace`, `usageRepository`, `worker-entry`, `env.ts`) plus this project's own prior ARCHITECTURE.md research pass
- Pitfalls: MEDIUM — the `--bare`/headless-flag pitfalls are grounded in official docs fetched live; the D-2-08-1 fix location is grounded in code but the fix's *sufficiency* is unverified without a Linux host (see Assumption A4); the exact `usage` JSON field names are the weakest link (Assumption A1) and should be confirmed by one real invocation before implementation finalizes the cost mapper

**Research date:** 2026-08-20
**Valid until:** ~14 days (Claude Code CLI ships on a near-daily cadence per its npm publish history observed this session — re-verify the pinned version and re-check `--bare`'s documented behavior if planning slips more than two weeks past this research date)
