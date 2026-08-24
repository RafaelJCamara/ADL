# ▶ Start here

**The live plan is [`docs/plan/STATUS.md`](../docs/plan/STATUS.md).** Read it before doing
anything — it says where the project is, what the next step is, and how to build and run.

| | |
|---|---|
| Where we are, what's next | [`docs/plan/STATUS.md`](../docs/plan/STATUS.md) |
| All 18 milestones | [`docs/plan/ROADMAP.md`](../docs/plan/ROADMAP.md) |
| The active milestone's steps | [`docs/plan/milestones/`](../docs/plan/milestones/) |
| Settled decisions — read before proposing an architecture change | [`docs/plan/DECISIONS.md`](../docs/plan/DECISIONS.md) |
| Known debt and accepted risks | [`docs/plan/DEBT.md`](../docs/plan/DEBT.md) |

**Working rules:** one milestone at a time, in order · one step, one commit · anything found
and not fixed goes in `DEBT.md` with an owner milestone · update `STATUS.md` when you stop.

`.planning/` is an **archived** GSD corpus — historical reference only, never update it.

---

## Project

**ADL — Autonomous Delivery Loop**

ADL is a self-hosted, open-source delivery framework that turns a written feature description into a reviewed, tested, human-approvable pull request without a human driving the handoffs. A team drops a new subfolder into their repository's `/features` directory; ADL detects that the feature hasn't been built yet, and runs it through a closed loop of AI agents — developer → code reviewer → pluggable harnesses → behaviour tester — sending work back to the developer whenever a gate fails, and opening a PR when every gate passes. It is aimed at engineering teams whose delivery is bottlenecked by code review and QA queues.

**Core Value:** A feature folder goes in, and a green, human-approvable PR comes out — with the whole loop's reasoning visible in the PR — without a human orchestrating any of the handoffs.

### Constraints

- **Tech stack**: TypeScript / Node — best agent-SDK ecosystem, easiest for open-source contributors, trivial to shell out to CLI-based agent backends
- **Architecture**: Manager (control plane) + separate-process workers (execution plane) — crash isolation, and the seam for future sandboxed execution
- **Deployment**: Self-hosted long-running daemon — teams keep their code and credentials on their own infrastructure
- **Distribution**: Open source, installed into someone else's repository — extension points, configuration surface, and documentation are v1 concerns, not afterthoughts
- **Vendor neutrality**: No backend may be privileged in the core loop — the adapter layer must survive contact with Claude, OpenAI, and Gemini simultaneously
- **Safety**: Human approval is mandatory before merge — an unattended loop that can write to the target branch is not acceptable in v1
- **Timeline**: Solo, nights and weekends, no hard deadline — favours thoroughness over speed, but makes finishing the vertical slice early important for motivation and validation

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## How to read the confidence tags

| Tag | Meaning |
|-----|---------|
| **HIGH** | Verified against the npm registry API or official first-party docs during this research pass |
| **MEDIUM** | Web search cross-checked against a second independent signal (usually registry metadata) |
| **LOW** | Single uncorroborated web-search result — treat as a lead, not a decision |

## The three findings that should change your plan

### 1. Do NOT start on TypeScript 7. Start on TypeScript 6.0.3.

### 2. Your "model-agnostic adapter" is two ports, not one — and conflating them will cost you the project.

- **`AgentBackend`** — the developer/reviewer/tester roles. Agentic CLIs only, in v1.
- **`ModelBackend`** — cheap, deterministic, non-file-editing work: harness verdict extraction, PR comment summarisation, spec parsing. Raw APIs, with structured output.

### 3. No Redis. No Postgres. The queue is a SQLite table and ~150 lines.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | **24 LTS** (dev target), `engines: ">=22.12.0"` | Runtime | Node 24 is Active LTS to 2028-04-30. The floor is set by your own deps, not preference: `commander@15` requires `>=22.12.0`, and `execa@10`, `better-sqlite3@13`, `kysely@0.29`, `ai@7` all require `>=22`. Node 26 becomes Active LTS 2026-10-28; from Node 27 the project moves to one calendar-aligned major per year, all LTS. Plan the 26 bump as a routine chore, not a migration. **HIGH.** |
| TypeScript | **6.0.3** (exact pin) | Language | See finding #1. TS 7 breaks typescript-eslint. **HIGH.** |
| pnpm | **11.22.0** | Package manager + workspaces | Strict `node_modules` catches phantom dependencies (critical when you have five internal packages); workspaces built in; `catalog:` keeps versions aligned across packages without a syncing tool. **HIGH.** |
| better-sqlite3 | **13.0.3** | Embedded database (source of truth) | Synchronous prepared-statement API, `.transaction()` wrapper, safe-integer control, years of production hardening. Zero server for the user to run. **HIGH.** |
| Drizzle ORM | **0.45.2** (exact pin) + drizzle-kit **0.31.10** | Schema + queries + migration generation | See the caveat in §Version Compatibility — `1.0.0-rc.5` is on the `rc` tag and a v1 bump is coming. Migration *generation* is the reason to accept that: you ship schema upgrades into other people's installations, and hand-writing every DDL for a 12-table schema is real solo-maintainer tax. Contain the blast radius behind a repository layer. **HIGH** on versions, **MEDIUM** on the recommendation. |
| Hono | **4.13.2** + `@hono/node-server` **2.1.1** | HTTP API server | Web-standard `Request`/`Response` makes raw-body access for webhook HMAC verification trivial (`await c.req.arrayBuffer()`) — the #1 webhook security footgun, solved by the framework choice. `streamSSE` is built in. Small enough for one person to hold in their head. **HIGH.** |
| commander | **15.0.0** | CLI framework | Lowest-friction framework for outside contributors. A new subcommand is ~10 lines. No plugin runtime, no manifest generation, no build step. **HIGH.** |
| pino | **10.3.1** | Structured logging | Fastest Node logger, JSON-first, child loggers give you `{ featureId, round, agent }` context for free, built-in `redact` for credentials. **HIGH.** |
| Vitest | **4.1.10** | Test runner | Worker-process isolation (matters when you're testing process supervision), first-class TS, mocking, v8 coverage. Peers `vite ^6 \|\| ^7 \|\| ^8`, so the dashboard's Vite 8 is compatible — no dual-Vite friction. **HIGH.** |
| Zod | **4.4.3** | Runtime schema validation | `adl.yml` parsing, agent JSON output, harness verdicts, HTTP API bodies. Also the peer that `ai@7` and `@ai-sdk/*` require (`^3.25.76 \|\| ^4.1.8`). **HIGH.** |

### Agent & model backends

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@anthropic-ai/claude-agent-sdk` | **0.3.233** | Claude Code backend, programmatic | Primary `AgentBackend` for v1. Ships per-platform binaries as optional deps (`-linux-x64`, `-darwin-arm64`, `-win32-x64`, + musl variants) — **users do not need to install Claude Code separately**. `engines: node >=18`. `query()` returns a typed async iterable with permission gating, hooks, and subagents. **HIGH.** |
| Claude Code CLI (`claude -p`) | n/a — shell-out | Claude Code backend, subprocess | Keep as a *second implementation of the same port*. It proves the abstraction isn't Claude-SDK-shaped, and it's the exact shape the other two backends must use. `--output-format json` returns `session_id` and `total_cost_usd`; `--output-format stream-json` emits JSONL; `--resume <id>` continues; `--max-turns N` caps agentic turns. **MEDIUM.** |
| OpenAI Codex CLI (`codex exec`) | n/a — shell-out | OpenAI agentic backend | `codex exec "<prompt>"` runs headless (progress → stderr, final message → stdout). `--json` = JSONL events, `--output-schema <file>` = JSON-Schema-constrained final message, `--sandbox` = safety control (no prompting in exec mode), `codex exec resume <SESSION_ID>` continues. Maps cleanly onto the same port as `claude -p`. **MEDIUM.** |
| Gemini CLI (`gemini -p`) | n/a — shell-out | Gemini agentic backend | `-p/--prompt` triggers headless (also auto-triggers in non-TTY); `--output-format json`; `--non-interactive`; auth via `GOOGLE_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`. **Asymmetry to design for:** Gemini returns *one JSON object at completion*, not a JSONL event stream. Your `AgentEvent` type must tolerate a backend with no incremental progress. **MEDIUM.** |
| `@anthropic-ai/sdk` | **0.117.1** | Anthropic Messages API direct | `ModelBackend` — harness verdicts, summarisation, spec parsing. Use `output_config.format` for schema-constrained JSON. `messages.countTokens()` for pre-flight cost estimation. **HIGH.** |
| `openai` | **7.4.0** | OpenAI API direct | Same role. Strict tools / structured outputs for verdicts. **HIGH.** |
| `@google/genai` | **2.17.1** | Gemini API direct | Same role. `responseSchema` for verdicts. **HIGH.** |
| `ai` (Vercel AI SDK) | **7.0.66** + `@ai-sdk/anthropic` **4.0.39** | *Optional* unifying layer for `ModelBackend` only | Conditional — see "Stack Patterns by Variant". Never for `AgentBackend`. **HIGH** on version, **MEDIUM** on the analysis in §4. |

### Git, forge, and workspace

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `simple-git` | **3.36.0** | Git operations incl. worktrees | Shells out to the real `git` binary, so worktree semantics are exactly git's. No dedicated `.worktree()` helper — use `git.raw(['worktree','add','--detach', path, ref])`. CJS, but `import simpleGit from 'simple-git'` works from ESM. **HIGH.** |
| `octokit` | **5.0.5** | GitHub API | The batteries-included wrapper (REST + GraphQL + paginate + throttling). Use `@octokit/rest@22.0.1` alone if you want a smaller surface. **HIGH.** |
| `@octokit/auth-app` | **8.3.0** | GitHub App authentication | Strongly recommended over PATs for a team tool: scoped, revocable, per-installation, higher rate limits. Actively maintained (last publish 2026-08-02). **HIGH.** |
| `@octokit/webhooks` | **14.2.0** | GitHub webhook verification + typed payloads | `verify()` does constant-time HMAC-SHA256 for you, plus fully typed event payloads. **HIGH.** |
| `@gitbeaker/rest` | **43.8.0** | GitLab API | The de-facto Node GitLab client. Caveat: last publish 2025-11-01 — maintained, but slower cadence than Octokit. CJS. **HIGH** on version, **MEDIUM** on health. |
| *(hand-rolled)* | ~200 LOC | Gitea/Forgejo API | `gitea-js@1.23.0` exists but was last published 2025-01-13 — stale, and swagger-generated. Gitea's REST surface for ADL's ~8 operations (create branch, open PR, comment, list PRs, get file, get diff) is small and stable. A thin `fetch` client is lower risk than a stale generated SDK. **MEDIUM.** |
| `croner` | **10.0.1** | Polling-fallback schedule | Better DST/timezone correctness and maintenance than `node-cron@4.6.0`. **HIGH.** |
| `ulid` | **3.0.2** | Primary keys and run IDs | Lexicographically sortable (great as a SQLite PK and in `ORDER BY`), URL-safe, human-scannable in CLI output. Beats `nanoid` (unsorted) and UUIDv4 (unsorted, ugly). **HIGH.** |

### Process, config, and HTTP support

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:child_process` `fork()` | built-in | Manager → worker spawn | Built-in IPC channel (`child.send` / `process.on('message')`) for Node↔Node control messages. This is the right primitive for the manager/worker seam. |
| `execa` | **10.0.1** | External command execution | For everything the *worker* shells out to: `git`, `claude`/`codex`/`gemini`, and the `adl.yml` build/start/test/teardown commands. Gives `cancelSignal`, `forceKillAfterDelay`, typed errors with `exitCode`/`signal`, proper cross-platform cleanup, and stream piping. ESM-only, `engines: node >=22`. **HIGH.** |
| `yaml` | **2.9.0** | `adl.yml` parsing | Preserves comments and supports YAML 1.2 properly. Prefer over `js-yaml@5.3.0` (which is fine, but `yaml` has better error positions — you'll be showing config errors to users). **HIGH.** |
| `eventsource-parser` | **4.0.0** | SSE consumption in the CLI | Node has `fetch` but no `EventSource`. This parses the stream for `adl logs --follow`. **HIGH.** |
| `@clack/prompts` | **1.7.0** | Interactive `adl init` | Small, good-looking, no React. **HIGH.** |
| `dotenv` | **17.4.2** | Local credential loading | Only for dev. Production credentials come from the manager's config file or the environment. **HIGH.** |

### Dashboard (defer to the last phase of v1)

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| Vite | **8.2.1** | Build | Static SPA bundled into the npm package. Compatible with `vitest@4`'s vite peer range. **HIGH.** |
| React | **19.2.8** | UI | Chosen for contributor familiarity, not technical superiority. **HIGH.** |
| Tailwind CSS | **4.3.3** | Styling | No design system to maintain. **HIGH.** |
| `@tanstack/react-query` | **5.101.4** | Server state | Polling + cache invalidation for the feature list; SSE for live logs. **HIGH.** |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `tsx` **4.23.12** | Dev runner | `tsx watch src/manager/index.ts`. No build step in the dev loop. |
| `tsc` (from typescript 6.0.3) | Build | **Do not add a bundler.** Node ESM + `"module": "nodenext"` means `tsc` output runs directly. `tsup@8.5.1` / `tsdown@0.22.14` / `esbuild@0.28.2` solve a problem (bundle size, browser targets, dual CJS/ESM) that a server-side daemon does not have. The dashboard's Vite build is the only bundling in the project. |
| ESLint **10.8.1** + typescript-eslint **8.67.0** | Linting | Requires TS `<6.1.0` — see finding #1. |
| Prettier **3.9.6** | Formatting | Contributor-standard. `@biomejs/biome@2.5.8` is the defensible one-binary alternative (formats + lints + type-aware rules, one dep instead of ~15) if you value maintenance burden over contributor familiarity. |
| `@changesets/cli` **3.0.0** | Release notes + versioning | Add once you publish more than one package. Not before. |
| `lefthook` **2.1.10** | Git hooks | Faster and simpler config than `husky@9.1.7` (which hasn't shipped since 2024-11). |

## Installation

# Workspace root

# packages/core — daemon runtime

# packages/core — forge adapters

# packages/core — agent backends

# packages/api — HTTP surface

# packages/cli

# apps/dashboard (last phase)

## §1 — Runtime & language tooling (detail)

## §2 — Daemon & process supervision (detail)

## §3 — Job queue & persistence (detail)

### SQLite vs Postgres

| | SQLite (`better-sqlite3`) | Postgres |
|---|---|---|
| User install burden | none — a file | a server, a user, a password, a backup story |
| Fits "installed into someone else's repo" | ✅ | ❌ |
| Concurrent writers | one (fine — manager is the only writer) | many |
| Multi-repo fleet / HA | ❌ | ✅ |
| Debuggable by the user | `sqlite3 .adl/adl.db` | needs credentials |

### better-sqlite3 vs `node:sqlite` vs libsql

- **`better-sqlite3@13.0.3`** — recommended. Hardened, has `.transaction()`, UDFs, and safe-integer control; both Drizzle and Kysely have mature drivers. Cost: a native module. Prebuilds cover common platforms; the `node-gyp` fallback is the one install-failure mode you will actually field support for.
- **`node:sqlite`** — Release Candidate (Stability 1.2) on Node 24+, compiled into the binary, **zero install risk**, and its API is deliberately modelled on better-sqlite3. Genuinely tempting for an OSS tool. Reason to wait: the API is still officially moving, and Drizzle's `node-sqlite` driver support was on branch tags (`node-sqlite`, `kit/node-sqlite`) rather than `latest` as of this research. **Keep it as a planned escape hatch** — the repository layer makes the swap a one-file change.
- **`@libsql/client@0.17.4`** — only if you want Turso remote replication. Adds a SQLite fork. Not needed.

### Drizzle vs Kysely vs Prisma

| | Drizzle 0.45.2 | Kysely 0.29.5 | Prisma 7.9.1 |
|---|---|---|---|
| Schema source | TypeScript | hand-written `Database` interface (or codegen) | `.prisma` DSL |
| Migrations | **generated** by drizzle-kit, SQL output editable | runner only — you write the SQL | generated, own CLI |
| API stability risk | ⚠️ `1.0.0-rc.5` on the `rc` tag; breaking v1 is coming | very low — mature, small surface | low, but v7 is recent |
| Contributor familiarity | high | medium | high |
| Runtime weight | light | very light | engine/WASM + generated client |
| Escape to raw SQL | easy | trivial (it *is* SQL) | awkward |

### Queue

- **`bullmq@6.1.2` + Redis** — only if you later run workers on separate hosts. That is explicitly out of v1 scope.
- **`pg-boss@12.27.0`** — the right answer *if and when* you move to Postgres. Don't adopt Postgres to get it.
- **`graphile-worker@0.17.3`** — same, Postgres-only.
- **Bunqueue** — Bun-only. Not applicable.

## §4 — AI/agent backends (detail)

### The two ports

### Which have official Node SDKs vs CLI-only

| Backend | Official Node SDK | Agentic CLI | Notes |
|---------|-------------------|-------------|-------|
| Claude Code | ✅ `@anthropic-ai/claude-agent-sdk@0.3.233` | ✅ `claude -p` | **The only agentic harness with a real Node SDK.** Ships its own per-platform binaries via optional deps — no separate install step for your users. |
| Anthropic Messages API | ✅ `@anthropic-ai/sdk@0.117.1` | n/a | Raw API. |
| OpenAI Codex | ❌ — CLI only | ✅ `codex exec` | Shell out. `--json`, `--output-schema`, `--sandbox`, `resume`. |
| OpenAI API | ✅ `openai@7.4.0` | n/a | Raw API. |
| Gemini CLI | ❌ — CLI only | ✅ `gemini -p` | Shell out. `--output-format json`, `--non-interactive`. |
| Gemini API | ✅ `@google/genai@2.17.1` | n/a | Raw API. |

### What a realistic common abstraction looks like

| | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Headless invoke | `claude -p "<task>"` | `codex exec "<task>"` | `gemini -p "<task>"` |
| Event stream | `--output-format stream-json` (JSONL) | `--json` (JSONL) | ❌ single JSON at end |
| Structured result | `--output-format json` | `--output-schema <file>` | `--output-format json` |
| Resume | `--resume <session_id>` | `codex exec resume <id>` / `--last` | ❌ |
| Turn cap | `--max-turns N` | — (use budget + timeout) | — |
| Cost reported | `total_cost_usd` | usage in JSONL | usage stats in JSON |
| Sandbox | permission modes / SDK hooks | `--sandbox` | — |
| Auth | subscription or `ANTHROPIC_API_KEY` | OpenAI auth | `GOOGLE_API_KEY` / ADC |

### Vercel AI SDK: honest assessment

### Cost accounting (this is a product requirement, not telemetry)

- **Prefer the backend's reported cost over your own arithmetic.** `claude -p --output-format json` returns `total_cost_usd`. Codex reports usage in its JSONL. Record `cost_source ∈ { reported, computed }` so you can tell later which numbers you trust.
- **Model prices live in a versioned data table with `effective_from`, not in code.** Otherwise a price change silently rewrites historical spend. Current Anthropic list prices per MTok (from the Claude API reference, cached 2026-06-24 — **HIGH**): `claude-opus-5` $5 / $25, `claude-sonnet-5` $3 / $15 (introductory $2 / $10 through 2026-08-31), `claude-haiku-4-5` $1 / $5, `claude-fable-5` $10 / $50. Model IDs are bare with **no date suffixes**.
- **Check the budget *before* dispatching the next agent turn, never after.** A check-after design overshoots by one full agent run; at Opus rates on a long turn that is real money and it will be the first bug a user reports.
- Emit a `budget.warn` at 80% so the escalation isn't a surprise.
- **Do NOT use `tiktoken@1.0.22` or `gpt-tokenizer@4.0.0` to estimate Anthropic tokens.** Wrong tokenizer — undercounts Claude tokens by ~15–20% on prose and far more on code. Use the backend's reported usage, or `client.messages.countTokens()` for pre-flight estimates. **HIGH.**

## §5 — Git & forge integration (detail)

| Forge | Header | Scheme |
|-------|--------|--------|
| GitHub | `X-Hub-Signature-256` | `sha256=` + HMAC-SHA256 hex of the raw body |
| Gitea / Forgejo | `X-Gitea-Signature` (also sends GitHub-compatible `X-Hub-Signature-256`) | lowercase hex HMAC-SHA256 of the raw body, **no prefix** |
| GitLab | `X-Gitlab-Token` | **plain shared secret, compared verbatim — not an HMAC** |

## §6 — HTTP API, CLI, dashboard (detail)

### Server: Hono

### Streaming logs: SSE, not WebSocket

| | SSE | WebSocket |
|---|---|---|
| Direction needed | server → client only ✅ | bidirectional (unused) |
| Corporate proxies / TLS terminators | plain HTTP, works | upgrade often blocked |
| CLI consumption | `fetch` + `eventsource-parser@4.0.0`, `Authorization` header just works | needs a WS client lib and header plumbing |
| Reconnect | in the spec (`Last-Event-ID`) | hand-rolled |
| `curl`-able | ✅ | ❌ |

### CLI: commander

| | commander 15.0.0 | clipanion 4.0.0-rc.4 | oclif 4.23.30 | citty 0.2.2 |
|---|---|---|---|---|
| Stability | stable, `engines >=22.12.0` | **still RC** after years | stable | 0.x |
| Weight | tiny | medium | a framework (plugins, auto-update, manifests, hooks) | tiny |
| Contributor familiarity | highest | low | medium | low |
| Right for `adl status\|logs\|pause\|kill` | ✅ | — | overweight | — |

### Dashboard: the scope-control answer

## §7 — Observability (detail)

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| TypeScript 6.0.3 | TypeScript 7.0.2 + oxlint + tsgolint | You value 10× compile speed over typescript-eslint's plugin ecosystem, or after TS 7.1 ships the stable API (autumn 2026) |
| Drizzle 0.45.2 | Kysely 0.29.5 + hand-written SQL migrations | You'd rather never do a breaking ORM upgrade, and you're comfortable writing DDL by hand |
| better-sqlite3 | `node:sqlite` (built-in) | Install failures from `node-gyp` become a real support burden; the API has since stabilised |
| SQLite | Postgres (`pg@8.23.0` or `postgres@3.4.9`) + pg-boss | Multi-repo fleet management, HA, or many concurrent workers across hosts — all v2 concerns |
| DB lease table | BullMQ 6.1.2 + Redis | Workers run on separate hosts from the manager |
| Hono 4.13.2 | Fastify 5.12.0 | You want JSON-Schema validation/serialization and OpenAPI generation, and will pay for raw-body + SSE plumbing |
| SSE | WebSocket (`ws`) | You add bidirectional interactive steering of a running agent |
| commander 15 | oclif 4.23 | The CLI grows a third-party plugin ecosystem and needs auto-update |
| ESLint + Prettier | `@biomejs/biome@2.5.8` | You want one binary instead of ~15 dev deps and will accept a smaller rule ecosystem |
| `tsc` only | tsup 8.5.1 / tsdown 0.22.14 | You need a single-file bundle for distribution or a browser/edge target |
| pnpm workspaces | + turbo 2.10.10 | `pnpm -r build` becomes slow enough to hurt (~8+ packages) |
| Direct provider SDKs | Vercel AI SDK 7 (`ModelBackend` only) | ≥2 raw-API providers are in v1 harness scope |
| React + Vite dashboard | Preact + htm, no build | You want the dashboard to be one HTML file with zero build step |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **TypeScript 7.0.2** (right now) | `typescript-eslint@8.67.0` peer is `>=4.8.4 <6.1.0`; ESLint core, ts-jest, ts-morph all blocked on the missing programmatic API until 7.1 | `typescript@6.0.3` |
| **isomorphic-git** | Fails on git worktrees — `.git` as a file produces "Could not resolve reference". Worktree-per-feature is a core requirement | `simple-git` + the `git` binary |
| **nodegit** | Native libgit2 build; an install liability for a tool installed into other teams' infrastructure | `simple-git` |
| **Redis + BullMQ** | Hard infrastructure prerequisite for every adopting team, to serve ~1 concurrent hours-long job | SQLite lease table |
| **Prisma 7** | Separate engine, generated client, a second schema DSL for contributors, slower cold start — all wrong for embedded SQLite | Drizzle or Kysely |
| **Express 5** | Weakest types, no streaming helpers, no schema story, largest middleware supply-chain surface; raw-body for webhook HMAC needs extra plumbing | Hono (or Fastify) |
| **Next.js for the dashboard** | A second server process and SSR you don't need; fights being served as static files from your daemon | Vite SPA served by the manager |
| **worker_threads / tinypool** | Shared process — a runaway agent OOM takes the manager down, defeating the stated crash-isolation rationale | `child_process.fork()` |
| **pm2 / forever / node-windows** | The manager *is* the worker supervisor; the OS init system supervises the manager | systemd unit + Dockerfile |
| **LangChain / LangGraph** | Heavy, high churn, and its agent abstractions duplicate what the agentic CLIs already do far better | Direct CLI/SDK adapters |
| **Vercel AI SDK as the core `AgentBackend`** | Cannot drive `claude -p` or `codex exec`; its tool loop is not a coding harness. Adopting it here means rebuilding Claude Code | Direct agentic-CLI adapters; AI SDK for `ModelBackend` only |
| **tiktoken / gpt-tokenizer for Anthropic** | Wrong tokenizer — undercounts Claude tokens ~15–20% on prose, far more on code. Your budget gate would be systematically wrong | Backend-reported usage; `messages.countTokens()` |
| **`gitea-js@1.23.0`** | Last published 2025-01-13; swagger-generated and stale | ~200-line hand-rolled `fetch` client |
| **Ink (React TUI)** | Large dependency and a rendering model to debug, for a status table and a log tail | commander + picocolors |
| **winston / console.log** | Slower, heavier, weaker types; no structured context or redaction | pino |
| **`biome` (npm package)** | That name on npm is an unrelated `0.3.3` package — a typosquat hazard | `@biomejs/biome` |
| **Date-suffixed Claude model IDs** | `claude-opus-5-20260708`-style IDs will 404; current IDs are bare aliases | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` |
| **Hardcoded model prices in code** | A price change silently rewrites historical spend and breaks budget audits | Versioned `model_prices` table with `effective_from` |
| **Checking the budget after an agent turn** | Overshoots by one full agent run — at Opus rates, real money and a guaranteed bug report | Check before dispatch; warn at 80% |
| **HMAC over re-serialized JSON** | Key ordering and whitespace differ from what the forge signed; every signature silently fails | HMAC over the raw request body bytes, `timingSafeEqual` |

## Stack Patterns by Variant

- Drop `@gitbeaker/rest`, the Gitea client, `openai`, `@google/genai`, and the AI SDK entirely
- Ship `@anthropic-ai/claude-agent-sdk` as the sole `AgentBackend` and `@anthropic-ai/sdk` as the sole `ModelBackend`
- Because the *ports* exist from day one, adding backend #2 later is a new file, not a refactor — that's the whole point of defining them up front
- Add `ai@7.0.66` + `@ai-sdk/anthropic@4.0.39` + `@ai-sdk/openai` + `@ai-sdk/google` for `ModelBackend` only
- One `generateObject({ schema })` call replaces three provider-specific structured-output implementations
- Keep `AgentBackend` on direct CLI/SDK adapters regardless
- Swap to `node:sqlite` behind the repository layer (raise the `engines` floor to Node 24)
- Verify Drizzle's `node-sqlite` driver has reached `latest` first — it was on branch tags as of this research
- Postgres (`postgres@3.4.9` or `pg@8.23.0`) + `pg-boss@12.27.0` replaces SQLite + the lease table
- Workers move to separate hosts → the `fork()` IPC channel is replaced by the queue itself, and `AgentBackend` gains a remote-execution implementation
- Only then does OpenTelemetry earn its keep
- The `WorkspaceBackend` interface stays; a new implementation shells to `docker`/`podman` via `execa` instead of `git worktree`
- `codex exec --sandbox` and Claude Agent SDK permission hooks give you a second, cheaper layer of containment inside the existing worktree model in the meantime

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `typescript@6.0.3` | `typescript-eslint@8.67.0` (peer `>=4.8.4 <6.1.0`) | **`typescript@7.0.2` breaks this.** The single hardest constraint in the stack. **HIGH.** |
| `vitest@4.1.10` | `vite ^6 \|\| ^7 \|\| ^8` | Vite 8.2.1 in the dashboard workspace is fine — no dual-Vite friction. **HIGH.** |
| `vitest@4.1.10` | `node ^20 \|\| ^22 \|\| >=24`, `@types/node ^20 \|\| ^22 \|\| >=24` | **HIGH.** |
| `commander@15.0.0` | `node >=22.12.0` | **This sets your `engines` floor.** `execa@10`, `better-sqlite3@13`, `kysely@0.29`, `ai@7` all require `>=22`. **HIGH.** |
| `@hono/node-server@2.1.1` | `hono ^4`, `node >=20` | **HIGH.** |
| `drizzle-orm@0.45.2` | `better-sqlite3 >=7` (optional peer) | Also declares optional peers for `@types/better-sqlite3`. `dist-tags`: `latest=0.45.2`, `rc=1.0.0-rc.5`. **A breaking v1 is coming — pin exact and budget a migration phase.** **HIGH.** |
| `ai@7.0.66`, `@ai-sdk/anthropic@4.0.39` | `zod ^3.25.76 \|\| ^4.1.8` | `zod@4.4.3` satisfies this. **HIGH.** |
| `@anthropic-ai/claude-agent-sdk@0.3.233` | `node >=18`; optional deps for linux/darwin/win32 × x64/arm64 + linux musl | Binaries ship with the package — no separate Claude Code install for your users. **Pre-1.0: pin exact and read release notes.** **HIGH.** |
| ESM/CJS mix | `pino@10`, `better-sqlite3@13`, `simple-git@3`, `@gitbeaker/rest@43` are CJS | All consumable from ESM via default import (`import Database from 'better-sqlite3'`). Named imports from CJS can require care under `nodenext` — use default imports for these four. **HIGH.** |
| `@octokit/rest@22.0.1` | `node >= 20` | **HIGH.** |
| `@gitbeaker/rest@43.8.0` | `node >=18.20.0` | Last publish 2025-11-01 — monitor for maintenance. **HIGH.** |
| Node 24 LTS | EOL 2028-04-30 | Node 26 → Active LTS 2026-10-28. From Node 27 (Oct 2026), one calendar-aligned major per year, all releases LTS. **MEDIUM.** |

## Open questions for the roadmap

## Sources

- `registry.npmjs.org` — live version, `dist-tags`, `peerDependencies`, `engines`, and `optionalDependencies` metadata for all 60+ packages named above (2026-08-17) — **HIGH**
- Anthropic Claude API reference (bundled skill, cached 2026-06-24) — model IDs, list pricing, SDK surface, Agent SDK vs Tool Runner distinction — **HIGH**
- [Node.js Releases](https://nodejs.org/en/about/previous-releases) and [Evolving the Node.js Release Schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) — LTS dates and the 2026 cadence change — **MEDIUM**
- [InfoQ — Microsoft Releases TypeScript 7.0 with a Native Go Compiler](https://www.infoq.com/news/2026/08/typescript-7-released/) and [typescript-eslint issue #12518 (TypeScript 7.0.2 Support)](https://github.com/typescript-eslint/typescript-eslint/issues/12518) — cross-checked against the `typescript-eslint@8.67.0` peer range in the registry — **HIGH**
- [Oxlint Type-Aware Linting Stable](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable) and [oxc-project/tsgolint](https://github.com/oxc-project/tsgolint) — the TS7 lint escape hatch — **MEDIUM**
- [Claude Agent SDK (TypeScript)](https://github.com/anthropics/claude-agent-sdk-typescript) and [Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) — cross-checked against the package's `optionalDependencies` and `engines` — **HIGH**
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) — `codex exec`, `--json`, `--output-schema`, `--sandbox`, `resume` — **MEDIUM**
- [Gemini CLI headless mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) — `-p`, `--output-format json`, `--non-interactive` — **MEDIUM**
- [AI SDK 7 announcement](https://vercel.com/blog/ai-sdk-7) and [AI SDK — Agents: Loop Control](https://ai-sdk.dev/docs/agents/loop-control) — `ToolLoopAgent`, `stopWhen`, `stepCountIs(20)` — **MEDIUM**
- [isomorphic-git worktree reference resolution failure](https://lightrun.com/answers/isomorphic-git-isomorphic-git-unresolvable-reference-when-git-is-a-file-git-worktree-support) — **MEDIUM**
- [Gitea webhook documentation](https://docs.gitea.com/usage/repository/webhooks/) — `X-Gitea-Signature` / `X-Hub-Signature-256` semantics — **MEDIUM**
- [Node.js built-in SQLite: 2026 production guide](https://www.hirenodejs.com/blog/nodejs-builtin-sqlite-node-sqlite-2026) and [better-sqlite3 issue #1266](https://github.com/WiseLibs/better-sqlite3/issues/1266) — Stability 1.2 status and the better-sqlite3 comparison — **MEDIUM**
- [BullMQ alternatives for Node.js: an honest 2026 guide](https://imqueue.org/blog/bullmq-alternatives/) and [Choosing the Right Node.js Job Queue](https://judoscale.com/blog/node-task-queues) — **MEDIUM**
- [Hono vs Express vs Fastify 2026 (PkgPulse)](https://www.pkgpulse.com/guides/hono-vs-express-vs-fastify-2026) and [NestJS vs Fastify vs Hono (Encore)](https://encore.dev/articles/nestjs-vs-fastify-vs-hono) — **LOW** individually; the recommendation rests on the raw-body/SSE reasoning, not the benchmarks
- [Node.js Child process docs](https://nodejs.org/api/child_process.html) and [Graceful Shutdown in Node.js](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo) — signal propagation, PID 1, zombie reaping — **MEDIUM**

<!-- GSD:stack-end -->

## Architecture

Seven packages, bottom of the dependency graph first. `apps/` does not exist yet — the
dashboard is milestone 17.

| Package | Role | Depends on |
|---------|------|------------|
| `@adl/core` | The settled vocabulary: verdicts, findings, criterion IDs, normalized specs, `adl.yml`/`EffectiveConfig`, the lifecycle state machine, and the port *declarations* (`Workspace`, `AgentRunner`, `Stage`). **Pure and I/O-free — lint-enforced.** | nothing, deliberately |
| `@adl/plugin-sdk` | The small published contract a third-party gate depends on. Re-exports `@adl/core` and **defines nothing of its own** (asserted by reference identity). | core |
| `@adl/db` | Kysely schema, hand-written SQL migrations, migration runner, repositories, model pricing. The only package touching `better-sqlite3`. | core (dev only) |
| `@adl/workspace` | **The exec boundary.** Worktree lifecycle, zero-inherit child env, scratch `HOME`, privilege drop, git-config neutralisation, backend registry, GC. The only package allowed to import `execa` / `simple-git` / `child_process`. | core |
| `@adl/agent-claude-code` | Claude Code headless adapter. Receives a `Workspace`, never constructs one. | core |
| `@adl/manager` | The control-plane daemon: lease queue, worker supervision via `fork()`, reaper, GC schedule, Hono HTTP API, prompt builder, NDJSON transcript store, worker entry. **The only package that writes to the DB.** Ships the real, installed `adl` binary (M05 step 5.7 — `src/bin.ts`); depends on `@adl/cli` as a library, never the reverse. | core, db, workspace, agent-claude-code, cli |
| `@adl/cli` | The `adl` verb set — `status`/`pause`/`resume`/`kill`/`gc`/`dev-run`/`logs`/`daemon`. Talks to the daemon **over HTTP only** — it structurally cannot resolve `@adl/db` or `@adl/manager`. A library consumed by `@adl/manager`'s binary, not the installed executable itself (5.7): every verb is this package's own `buildProgram`, except `daemon start`, which `@adl/manager` fills in via the `BuildProgramDeps.startDaemon` injection seam. | nothing, by design |

**The shape:** a manager (control plane) owns everything singular — database, queue, config,
credentials, accounting, forge *reads*. Workers are separate OS processes holding one lease
each, giving crash isolation and creating the seam where a future sandbox backend slots in.

**Two ports, not one:** `AgentBackend` for agentic CLIs that own their own loop and tools;
`ModelBackend` for raw APIs where ADL owns the loop. Never conflate them.

---

## Conventions

House rules, drawn from four completed milestones. Several are enforced by tests that fail
the build — those are marked ⚙️.

### Architectural rules

1. ⚙️ **Nothing spawns a process outside `packages/workspace`.** `adl/no-direct-spawn` bans
   `node:child_process`, `child_process`, `execa` and `simple-git` in all three import forms
   (static, `require()`, dynamic). There is exactly **one** exemption, and its count is
   *measured* by `test/lint/no-restricted-imports.test.ts`, not argued in a comment. Only
   two sanctioned launchers exist — `src/exec/run.ts` and `src/exec/fork.ts`; a third turns
   the contract guard red.
2. ⚙️ **`@adl/core` performs zero I/O.** No filesystem, no `child_process`, no `process.env`,
   no sibling `@adl/*` imports. Inject at the purity boundary instead — a predicate, a
   lookup, a precomputed registry, a runner.
3. ⚙️ **Architecture rules are tested with deliberate-violation fixtures** under
   `test/lint/fixtures/`, run through the *same* config CI loads. Assertions read the
   **resolved** config via `calculateConfigForFile`, never the source — flat-config rule
   replacement is invisible to a source-level read, and `pnpm lint` once stayed green while
   a purity ban was silently deleted.
4. ⚙️ **No `.refine()` / `.superRefine()` under `verdict/`** — they are silently dropped by
   `z.toJSONSchema()`, which would weaken the published schema without a diff.

### How to write the code

5. **Classify, don't throw.** Expected-but-notable failures return a discriminated result,
   never an exception: `StageError`, `PreflightResult`, `FenceVerdict`, `TranscriptRead`,
   `RecoveryDecision`, `parseWorkerMessage → {ok:false, reason}`, `transition() →
   InvalidTransition`.
6. **Errors are siblings, not subclasses, when the caller must tell them apart.**
   `ContainmentError` is deliberately *not* a subclass of `WorkspaceError`, so "the
   interface refused this path" and "the file wasn't there" stay distinguishable. Named
   errors carry structured fields.
7. ⚙️ **Frozen array → derived union → compile-time exhaustiveness.** `OUTCOMES`,
   `FEATURE_STATES`, `IPC_MESSAGE_KINDS`, `AGENT_EVENT_KINDS`, `TABLE_COLUMNS`,
   `NEUTRALISED_CONFIG` … each pairs its runtime list with its type via an
   `Exclude<T, Arr[number]> extends never` assertion, so drift fails the *build*.
8. **Derive, never restate.** `SEND_BACK_ROUND_DELTA` is computed by calling
   `consumesRound()`. `DAEMON_SCHEMA_VERSION` is derived from the migrations directory.
   `DEFAULT_CONFIG.limits` is `LimitsSchema.parse({})`. A transcribed constant is the exact
   mistake these rules exist to prevent.
9. **Prefer structural impossibility to a runtime check.** Enforce by *absence of an export*
   (`buildChildEnv` is off the barrel so no second env-assembly site can exist), a *missing
   manifest entry* (`@adl/cli` cannot resolve `@adl/db`), a *message with no field to spoof*
   (the `usage` IPC carries no feature identity), or an *unrepresentable type*
   (`DeveloperOutcome` has no `pass`; a bare string is not a `TranscriptAddress`).
10. **Check a limit immediately before the state-changing action, never after.**
    `dispatchOnce`'s concurrency cap is the template the budget gate must *extend*.
    Lowering a limit **drains** — it governs future dispatch and never revokes.
11. **Persist-then-flip** for any in-memory flag backed by a row: write first, update memory
    only on success, throw a named error leaving memory untouched.
12. **Zod discipline:** `z.strictObject` under `verdict/` and `agent/`; every schema and
    union member carries `.meta({ id })` so `$defs` names are stable rather than positional.

### How to verify it

13. **Watched-failing guards.** Every load-bearing assertion is *observed failing* against
    the exact defect it exists to catch, then restored, and the observation is written down.
    **A guard that has never been seen red is not evidence.**
14. **Tracer-slice execution.** Open a milestone with one thin, production-quality path
    through every layer, verified end to end, before any widening. The tracer is a real
    cross-process integration test, not a mock.
15. **Empirical verification before implementation.** Confirm any non-obvious library or OS
    fact with a throwaway probe against the *installed* package before encoding it. The
    research prose in this file has been wrong more than once and is not taken on faith.
16. ⚙️ **Platform gates are visible, never silent.** Go through `test/helpers/platform.ts`
    (`linuxOnly`, `posixOnly`, `windowsOnly`), which prints
    `[ADL][SKIPPED][<id>] <reason> (platform: <p>)` and **throws** rather than skips when
    the platform matches but provisioning is missing — so a CI job that forgot provisioning
    goes red, not green-and-empty. Bare `process.platform` / `skipIf` in a test fails
    `test/platform-gate-discipline.test.ts`.
17. **Supply-chain gate before installing anything new.** Confirm repository/org and version
    against the public registry, with a human in the loop, *before* the install. Record the
    exact pins; the installing step consumes them verbatim and performs no fresh resolution.
18. **Documentation can be load-bearing.** `packages/workspace/README.md`'s neutralisation
    table is drift-asserted by a test, because that table is the stated justification for an
    accepted risk — and an accepted risk whose justification is absent is an *unaccepted*
    risk.

### Tests and commits

19. **Tests live in `<pkg>/test/`, never beside source.** Each package has its own
    `vitest.config.ts` naming its project. Type-level assertions go in `*.test-d.ts` or a
    package-local `tsconfig.test.json` wired into that package's `typecheck` script — *an
    assertion nothing compiles asserts nothing.*
    ⚠️ `pnpm -r test` **silently skips the root project**; that's why the root `test` script
    chains `vitest run --project root`.
20. **One atomic commit per step**, conventional-commit scoped by milestone:
    `feat(05-03): …`, `fix(04): …`, `test(02): …`, `docs(…)`. Formatting-only changes go in
    a separate `style` commit so `git blame` still points at the commit that wrote the code.
21. **Anything found but out of scope goes in `docs/plan/DEBT.md`** with a **reproduction**
    (or an explicit statement that it is unreproduced and why), a proposed shape, and an
    owning milestone. A prose "didn't touch this" note is explicitly not good enough.

---

## Stale in the research above

The Technology Stack section is a preserved research snapshot and has drifted in one place:

- **It recommends Drizzle ORM. That was reversed — Kysely with hand-written SQL migrations
  is settled and shipped.** No Drizzle migration phase exists or should be added. See
  `docs/plan/DECISIONS.md`.
