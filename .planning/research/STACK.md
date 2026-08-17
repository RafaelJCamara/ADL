# Stack Research

**Domain:** Self-hosted, long-running Node/TypeScript daemon orchestrating multi-agent AI coding loops across git forges
**Researched:** 2026-08-17
**Confidence:** HIGH on versions (npm registry verified) / MEDIUM on ecosystem judgements (web-search cross-checked)

---

## How to read the confidence tags

Per `gsd query classify-confidence`:

| Tag | Meaning |
|-----|---------|
| **HIGH** | Verified against the npm registry API or official first-party docs during this research pass |
| **MEDIUM** | Web search cross-checked against a second independent signal (usually registry metadata) |
| **LOW** | Single uncorroborated web-search result — treat as a lead, not a decision |

Every version number below was pulled live from `registry.npmjs.org` on 2026-08-17. **HIGH.**

---

## The three findings that should change your plan

Read these before the tables.

### 1. Do NOT start on TypeScript 7. Start on TypeScript 6.0.3.

TypeScript 7.0 (the Go-native compiler) went GA on 2026-07-08 and `dist-tags.latest` is `7.0.2`. It ships **without a stable programmatic compiler API** — that lands in 7.1 (targeted autumn 2026). The consequence, verified directly from the registry:

```
typescript-eslint@8.67.0  peerDependencies: { "typescript": ">=4.8.4 <6.1.0" }
```

TypeScript 7 is **incompatible with typescript-eslint today**, and ESLint core, `ts-jest`, and `ts-morph` are blocked behind the same missing API. The last TS6 release is `6.0.3` (2026-04-16).

For a greenfield OSS project that wants outside contributors, losing `typescript-eslint` is a much bigger cost than losing a 10× faster `tsc` on a codebase that will be ~15k lines. **Pin `typescript@6.0.3`, revisit at 7.1.** (Escape hatch if you disagree: TS 7.0.2 + `oxlint@1.78.0` + `tsgolint`, which tracks TS 7.0.2 and covers 59 of typescript-eslint's 61 type-aware rules — but that's a smaller, less familiar lint ecosystem for contributors.) **HIGH.**

### 2. Your "model-agnostic adapter" is two ports, not one — and conflating them will cost you the project.

An **agentic CLI** (`claude -p`, `codex exec`, `gemini -p`) takes a task + a working directory and hands back a diff, a transcript, and a cost. A **raw model API** (`@anthropic-ai/sdk`, `openai`, `@google/genai`) takes messages + tool schemas and hands back *one assistant turn* — you must then implement Read/Write/Edit/Bash/Grep, a permission model, context compaction, and a tool loop. That second thing is *building Claude Code*, and it is a multi-year project on its own.

PROJECT.md's requirement list ("Anthropic API direct backend", "OpenAI backend (API + Codex CLI)", "Gemini backend (API + CLI)") reads as one adapter layer with six implementations. It is really:

- **`AgentBackend`** — the developer/reviewer/tester roles. Agentic CLIs only, in v1.
- **`ModelBackend`** — cheap, deterministic, non-file-editing work: harness verdict extraction, PR comment summarisation, spec parsing. Raw APIs, with structured output.

Splitting these is the single highest-leverage architectural decision in the stack. Details in §4.

### 3. No Redis. No Postgres. The queue is a SQLite table and ~150 lines.

Concurrency defaults to 1. Jobs run for *hours*. Throughput is irrelevant. BullMQ's scheduler, rate limiter, and distributed locks solve problems ADL does not have, and Redis becomes a hard install prerequisite for every team that adopts a tool whose whole pitch is "drop it into your repo". A DB-backed lease table with `UPDATE ... WHERE state='queued' ... RETURNING` is correct, inspectable, debuggable with `sqlite3`, and survives restart for free. **MEDIUM.**

---

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

---

## Installation

```bash
# Workspace root
pnpm add -D typescript@6.0.3 tsx vitest@^4 eslint@^10 typescript-eslint@^8 prettier lefthook @types/node

# packages/core — daemon runtime
pnpm add better-sqlite3@^13 drizzle-orm@0.45.2 zod@^4 pino@^10 ulid@^3 yaml@^2 execa@^10 croner@^10 simple-git@^3
pnpm add -D drizzle-kit@^0.31 @types/better-sqlite3 pino-pretty

# packages/core — forge adapters
pnpm add octokit@^5 @octokit/auth-app@^8 @octokit/webhooks@^14 @gitbeaker/rest@^43

# packages/core — agent backends
pnpm add @anthropic-ai/claude-agent-sdk@^0.3 @anthropic-ai/sdk@^0.117 openai@^7 @google/genai@^2

# packages/api — HTTP surface
pnpm add hono@^4 @hono/node-server@^2

# packages/cli
pnpm add commander@^15 @clack/prompts@^1 eventsource-parser@^4 picocolors

# apps/dashboard (last phase)
pnpm add react@^19 react-dom@^19 @tanstack/react-query@^5
pnpm add -D vite@^8 @vitejs/plugin-react tailwindcss@^4
```

---

## §1 — Runtime & language tooling (detail)

**tsconfig posture.** ESM-only (`"type": "module"` everywhere), `nodenext` resolution, and `erasableSyntaxOnly` so the source stays runnable under `node --experimental-strip-types` and `tsx` without a compile step:

```jsonc
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,   // catches the array-access bugs that bite state machines
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,        // forces `import type`, avoids ESM/CJS surprises
    "erasableSyntaxOnly": true,          // bans enums/namespaces/param-properties → source runs unstripped
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

`erasableSyntaxOnly` is the non-obvious one and it's worth taking: it means a contributor can `node --experimental-strip-types src/foo.ts` to poke at something without understanding your build, and it keeps the door open to dropping `tsc` entirely once Node's type-stripping is boring.

**Monorepo.** pnpm workspaces, **no Nx, no Turborepo, no Lerna**. Layout:

```
packages/core        # domain: loop, state machine, ports (AgentBackend, Forge, Workspace)
packages/adapters    # implementations: claude/codex/gemini, github/gitlab/gitea, worktree
packages/api         # Hono app + SSE
packages/cli         # commander binary, depends on api client
apps/dashboard       # Vite SPA, built into packages/api's static dir
```

`turbo@2.10.10` earns its keep at ~8+ packages with slow builds. You have 5 packages and a `tsc` build. Adding it now buys you a config file and a cache-invalidation bug. Add it when `pnpm -r build` annoys you.

**Test runner: Vitest over `node:test`.** `node:test` is the right call for a zero-dependency library. ADL needs to fake three agent CLIs, three forge APIs, a git repo, and a clock — that is a mocking-heavy suite, and `vi.mock` / `vi.useFakeTimers` / worker isolation are worth the dependency. Vitest 4 is current; `5.0.0-rc.1` exists on the `rc` tag — stay on 4.

---

## §2 — Daemon & process supervision (detail)

**Spawn model.** `fork()` for workers, `execa` for external commands.

```
manager (long-lived)
  ├─ fork() → worker A ── execa → git worktree add
  │                    ── execa → claude -p / codex exec / gemini -p
  │                    ── execa → `adl.yml` build/test/teardown commands
  └─ fork() → worker B ...
```

`fork()` gives you a free structured IPC channel between two Node processes you both control. `execa` gives you the cancellation, timeout, and cleanup semantics you need when an agent runs for 40 minutes and the user hits `adl kill`.

**Do NOT use `worker_threads` or `tinypool@2.1.0`.** They share the process. PROJECT.md's stated reason for the manager/worker split is *"crash isolation so a runaway agent cannot take the manager down"* — a thread that OOMs takes the whole process with it. `tinypool` is also designed for short CPU-bound tasks in a pool, not for one long-lived leased job.

**Do NOT reach for a supervisor (pm2, node-windows, forever).** The manager *is* the supervisor for workers; the OS init system (systemd / launchd / a Docker restart policy) is the supervisor for the manager. Ship a systemd unit file and a Dockerfile, not a process manager dependency.

**IPC contract.** Keep it small and typed with Zod:

```ts
// manager → worker
type ManagerMsg =
  | { t: 'lease';    feature: FeatureSnapshot; lease: LeaseToken }
  | { t: 'cancel';   reason: 'user' | 'budget' | 'rounds' | 'shutdown' }
  | { t: 'ping' }

// worker → manager
type WorkerMsg =
  | { t: 'ready' }
  | { t: 'heartbeat'; lease: LeaseToken; phase: Phase }
  | { t: 'event';     event: LoopEvent }     // round started, verdict, usage delta
  | { t: 'done';      outcome: Outcome }
  | { t: 'pong' }
```

**Who writes to the DB: the manager, and only the manager.** Workers stream `event` messages; the manager persists them. This preserves PROJECT.md's "manager owns state" invariant, avoids multi-process SQLite write contention entirely, and means a worker crash can never leave a half-written transaction.

**Transcripts do not go in the database.** Agent transcripts are large and append-only. Write them as JSONL to `.adl/transcripts/<featureId>/<round>/<role>.jsonl` **from the worker**, and store `{ path, bytes, sha256, summary }` in the DB. This keeps SQLite small, makes `adl logs -f` a `tail`, and makes the PR-comment summarisation step a file read instead of a query.

**Leasing.** One SQL statement, atomic:

```sql
UPDATE features
   SET state = 'running',
       lease_owner = ?, lease_expires_at = ?, lease_epoch = lease_epoch + 1
 WHERE id = (SELECT id FROM features
              WHERE state = 'queued'
                AND (lease_expires_at IS NULL OR lease_expires_at < ?)
              ORDER BY priority DESC, created_at ASC
              LIMIT 1)
RETURNING *;
```

Worker heartbeats every 15s; manager reclaims leases whose `lease_expires_at` has passed. `lease_epoch` is the fencing token — a zombie worker that wakes up with a stale epoch must be rejected.

**Graceful shutdown.** The sequence matters, and getting it wrong means orphaned worktrees and stuck leases:

1. Manager traps `SIGTERM`/`SIGINT` → stop leasing, stop accepting HTTP writes, keep `/healthz` up.
2. Send `{ t: 'cancel', reason: 'shutdown' }` to every worker.
3. Worker finishes the *current agent turn* (never mid-turn — the transcript would be unusable), persists partial state via a final `event`, releases its worktree, marks the feature `paused`, exits 0.
4. Manager waits `shutdown_grace_seconds` (default 300 — agent turns are long). Then `SIGTERM` the child, then `SIGKILL` after 10s.
5. Manager reclaims any lease still held, closes the DB (`PRAGMA wal_checkpoint(TRUNCATE)`), exits.

**Orphan prevention.** In the worker: `process.on('disconnect', () => shutdown('parent-gone'))`. The IPC channel closing is the signal that the manager died; without this you get worktrees held by processes nobody is tracking.

**Windows.** There is no `SIGTERM`. The IPC `cancel` message must be the *primary* shutdown mechanism on every platform, with signals as the fallback — design it that way from the start rather than discovering it when a Windows user files an issue. `execa`'s `forceKillAfterDelay` handles the external-command side.

**Crash-loop guard.** On `child.on('exit', code => ...)` with a non-zero code: release the lease, increment `crash_count`, and escalate to a human after N consecutive crashes on the same feature. A feature that crashes the worker three times is a bug report, not a retry candidate.

---

## §3 — Job queue & persistence (detail)

### SQLite vs Postgres

| | SQLite (`better-sqlite3`) | Postgres |
|---|---|---|
| User install burden | none — a file | a server, a user, a password, a backup story |
| Fits "installed into someone else's repo" | ✅ | ❌ |
| Concurrent writers | one (fine — manager is the only writer) | many |
| Multi-repo fleet / HA | ❌ | ✅ |
| Debuggable by the user | `sqlite3 .adl/adl.db` | needs credentials |

PROJECT.md explicitly puts multi-repo fleet management out of v1 scope. **SQLite is correct for v1.** Design for the migration anyway: put every query behind a repository interface, avoid SQLite-only SQL where a portable form exists, and use `TEXT` timestamps in ISO-8601 UTC rather than SQLite integer time.

**Required pragmas** (get these wrong and you will chase phantom "database is locked" bugs):

```ts
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');     // WAL makes FULL unnecessary for this workload
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1000');
```

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

**Recommendation: Drizzle**, pinned exact at `0.45.2`, with an explicit roadmap item "upgrade to drizzle-orm v1 when `latest` moves off 0.45" and all DB access behind a repository layer.

**The honest counter-argument:** Kysely is the lower-risk pick for a three-year solo project. It is a typed SQL builder and nothing else, its API barely moves, and hand-written SQL migrations are arguably *better* for a tool that ships schema upgrades into other people's machines — you control the exact DDL and can hand-write the tricky data migrations without fighting a generator. If you'd rather never do a v1 ORM migration, take Kysely and lose nothing but drizzle-kit's `generate`.

**Do NOT use Prisma 7.** Separate engine, generated client, a second schema language for contributors to learn, and slower cold start — all wrong for an embedded SQLite file inside a CLI-installed daemon.

### Queue

Hand-rolled lease table (above). Not a library.

- **`bullmq@6.1.2` + Redis** — only if you later run workers on separate hosts. That is explicitly out of v1 scope.
- **`pg-boss@12.27.0`** — the right answer *if and when* you move to Postgres. Don't adopt Postgres to get it.
- **`graphile-worker@0.17.3`** — same, Postgres-only.
- **Bunqueue** — Bun-only. Not applicable.

Schedule the polling fallback with `croner@10.0.1`, not `node-cron`.

---

## §4 — AI/agent backends (detail)

### The two ports

```ts
// The developer / reviewer / tester roles. v1 = agentic CLIs only.
interface AgentBackend {
  readonly id: string;                 // 'claude-code' | 'codex' | 'gemini-cli'
  readonly capabilities: {
    resume: boolean;                   // claude ✅  codex ✅  gemini ❌
    incrementalEvents: boolean;        // claude ✅  codex ✅  gemini ❌
    structuredFinalOutput: boolean;    // claude ✅  codex ✅ (--output-schema)  gemini ✅
    reportsCost: boolean;              // claude ✅ (total_cost_usd)  codex ✅  gemini ~usage only
    sandbox: boolean;                  // codex ✅ (--sandbox)
  };
  run(req: AgentRequest): AsyncIterable<AgentEvent>;   // MUST end with a terminal event
}

// Cheap, deterministic, non-file-editing work. Raw model APIs.
interface ModelBackend {
  judge<T>(req: { prompt: string; schema: ZodType<T>; model: string }):
    Promise<{ value: T; usage: Usage }>;
}
```

**Design `AgentEvent` so a backend with zero incremental events is legal.** Gemini CLI returns one JSON object at completion. If your loop assumes a token stream, Gemini either doesn't work or forces a fake-streaming shim. Model it as: optional `progress` events, one mandatory `terminal` event carrying `{ outcome, usage, sessionId?, transcriptPath }`.

### Which have official Node SDKs vs CLI-only

| Backend | Official Node SDK | Agentic CLI | Notes |
|---------|-------------------|-------------|-------|
| Claude Code | ✅ `@anthropic-ai/claude-agent-sdk@0.3.233` | ✅ `claude -p` | **The only agentic harness with a real Node SDK.** Ships its own per-platform binaries via optional deps — no separate install step for your users. |
| Anthropic Messages API | ✅ `@anthropic-ai/sdk@0.117.1` | n/a | Raw API. |
| OpenAI Codex | ❌ — CLI only | ✅ `codex exec` | Shell out. `--json`, `--output-schema`, `--sandbox`, `resume`. |
| OpenAI API | ✅ `openai@7.4.0` | n/a | Raw API. |
| Gemini CLI | ❌ — CLI only | ✅ `gemini -p` | Shell out. `--output-format json`, `--non-interactive`. |
| Gemini API | ✅ `@google/genai@2.17.1` | n/a | Raw API. |

**HIGH** on SDK versions, **MEDIUM** on CLI flags.

### What a realistic common abstraction looks like

Concretely, the three agentic CLIs are close enough to share one port:

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

The *common* surface is: **spawn with a prompt + cwd → consume an event stream (or don't) → parse a terminal result → extract usage → optionally hold a session id for a follow-up turn.** That's the port. Everything else — permission models, sandbox flags, turn caps — is per-backend config that the loop never sees.

**Deliberately keep the harness's own agent execution on `ModelBackend`, not `AgentBackend`.** A security-check harness that needs to judge a diff does not need a filesystem agent; it needs one structured-output call. This is where model-agnosticism is genuinely cheap and where PROJECT.md's vendor-neutrality constraint is easiest to honour.

### Vercel AI SDK: honest assessment

`ai@7.0.66` (with `@ai-sdk/anthropic@4.0.39`, `@ai-sdk/openai`, `@ai-sdk/google`) genuinely does unify raw model APIs behind `generateText` / `generateObject` / `streamText`, and v7 added real agent-loop machinery: a `ToolLoopAgent` class with `stopWhen` conditions (default `stepCountIs(20)` as a runaway guard), tool approvals, durability, timeouts, and sandbox support.

**Where it fits ADL:** the `ModelBackend` port. One `generateObject({ schema })` call gets you a typed harness verdict from Anthropic, OpenAI, or Gemini with a one-line provider swap. That is exactly the thing ADL needs three-provider parity on, and it's ~100 lines you don't write.

**Where it does not fit, and why it must never be the core adapter:**

1. **It abstracts model APIs, not agentic CLIs.** There is no way to drive `claude -p` or `codex exec` through it. It can only ever cover the half of ADL's adapter surface that ADL cares *less* about.
2. **Its agent loop is a tool loop, not a coding harness.** `ToolLoopAgent` calls the tools you give it. Read/Write/Edit/Bash/Grep, the permission model, context compaction, and the diff-application semantics are still entirely yours. Choosing it as the developer-agent backend is choosing to rebuild Claude Code.
3. **The abstraction leaks exactly where agentic coding needs it not to** — adaptive/extended thinking configuration, prompt-caching breakpoint placement, per-provider cost reporting. You end up with provider-specific option blocks inside the "unified" call.
4. **Churn.** v4 → v5 → v6 → v7 in under two years. That is a real maintenance tax for a solo maintainer, layered *between* you and provider SDKs that are themselves stable.

**Verdict:** adopt it for `ModelBackend` **if** two or more raw-API providers are actually in v1 scope for harness work. If v1 harnesses only ever call Anthropic, use `@anthropic-ai/sdk` directly and skip the layer. Never for `AgentBackend`.

### Cost accounting (this is a product requirement, not telemetry)

PROJECT.md makes budget a hard gate, so this is core-loop code:

- **Prefer the backend's reported cost over your own arithmetic.** `claude -p --output-format json` returns `total_cost_usd`. Codex reports usage in its JSONL. Record `cost_source ∈ { reported, computed }` so you can tell later which numbers you trust.
- **Model prices live in a versioned data table with `effective_from`, not in code.** Otherwise a price change silently rewrites historical spend. Current Anthropic list prices per MTok (from the Claude API reference, cached 2026-06-24 — **HIGH**): `claude-opus-5` $5 / $25, `claude-sonnet-5` $3 / $15 (introductory $2 / $10 through 2026-08-31), `claude-haiku-4-5` $1 / $5, `claude-fable-5` $10 / $50. Model IDs are bare with **no date suffixes**.
- **Check the budget *before* dispatching the next agent turn, never after.** A check-after design overshoots by one full agent run; at Opus rates on a long turn that is real money and it will be the first bug a user reports.
- Emit a `budget.warn` at 80% so the escalation isn't a surprise.
- **Do NOT use `tiktoken@1.0.22` or `gpt-tokenizer@4.0.0` to estimate Anthropic tokens.** Wrong tokenizer — undercounts Claude tokens by ~15–20% on prose and far more on code. Use the backend's reported usage, or `client.messages.countTokens()` for pre-flight estimates. **HIGH.**

---

## §5 — Git & forge integration (detail)

**Worktrees.** `simple-git` (or plain `execa` + `git`) behind PROJECT.md's `WorkspaceBackend` interface:

```ts
interface WorkspaceBackend {
  create(featureId: string, baseRef: string): Promise<Workspace>;  // git worktree add --detach
  destroy(ws: Workspace): Promise<void>;                            // git worktree remove --force
  gc(): Promise<void>;                                              // git worktree prune
}
```

**Do NOT use `isomorphic-git@1.41.4`.** It is a pure-JS reimplementation aimed at browsers, requires a bring-your-own fs/http layer, and — decisively — **fails on worktrees**: when `.git` is a *file* (as it is in every linked worktree) it errors with "Could not resolve reference". Worktree-per-feature is a core PROJECT.md requirement. **HIGH.**

**Do NOT use `nodegit`.** Native libgit2 bindings are an install liability for a tool other teams `npm i` into their infrastructure. Requiring the `git` binary on PATH is a far weaker requirement — it's already there.

**Forge abstraction.** There is **no credible library that unifies GitHub + GitLab + Gitea.** Don't look for one. Build a `Forge` port with ~8 methods:

```ts
interface Forge {
  createBranch(repo, name, fromRef): Promise<void>;
  openPullRequest(repo, head, base, title, body): Promise<PullRef>;
  comment(pr: PullRef, body: string): Promise<CommentRef>;
  updateComment(c: CommentRef, body: string): Promise<void>;
  listOpenPullRequests(repo): Promise<PullRef[]>;
  getFile(repo, ref, path): Promise<string | null>;
  getDiff(pr: PullRef): Promise<string>;
  verifyWebhook(raw: Uint8Array, headers: Headers, secret: string): boolean;
}
```

**Webhook verification — the three forges differ, and one of them is not an HMAC:**

| Forge | Header | Scheme |
|-------|--------|--------|
| GitHub | `X-Hub-Signature-256` | `sha256=` + HMAC-SHA256 hex of the raw body |
| Gitea / Forgejo | `X-Gitea-Signature` (also sends GitHub-compatible `X-Hub-Signature-256`) | lowercase hex HMAC-SHA256 of the raw body, **no prefix** |
| GitLab | `X-Gitlab-Token` | **plain shared secret, compared verbatim — not an HMAC** |

Three rules that are non-negotiable:

1. **HMAC over the raw request body bytes, never over re-serialized JSON.** Key-ordering and whitespace differences will silently break every signature. Hono's `await c.req.arrayBuffer()` gives you the raw bytes; this is the concrete reason Hono beats Express here.
2. **`crypto.timingSafeEqual` for every comparison**, including GitLab's plain-token path.
3. **If Gitea has no secret configured it still sends the signature header, with an empty digest.** Reject unsigned deliveries explicitly rather than falling through to "signature matched".

`@octokit/webhooks@14.2.0` handles GitHub's side (verification + fully typed payloads). GitLab and Gitea are ~20 lines of `node:crypto` each.

---

## §6 — HTTP API, CLI, dashboard (detail)

### Server: Hono

Chosen for four concrete reasons, in order of weight:

1. **Raw-body access is free** (`await c.req.arrayBuffer()`), because Hono is Web-standard `Request`/`Response`. Webhook HMAC verification is the security-critical path in this project, and Express/Fastify both need extra plumbing to expose raw bodies.
2. **`streamSSE` is built in** (`hono/streaming`) — no plugin, no manual `Content-Type: text/event-stream` bookkeeping.
3. **Hono RPC** gives the dashboard end-to-end types from the route definitions, with no code generation and no tRPC.
4. Small enough that one maintainer can read all of it.

**`fastify@5.12.0` is the defensible alternative** if you want JSON-Schema-driven validation, fast serialization, and OpenAPI generation from schemas. Costs for ADL: raw-body needs `fastify-raw-body` or a custom content-type parser; SSE needs `@fastify/sse@0.6.0` (young, published 2026-07) or manual work; a bigger API surface to learn.

**Do NOT use `express@5.2.1`** — weakest type story, no built-in streaming helpers, no schema story, and the largest middleware supply-chain surface.

**API style:** plain JSON REST + Zod validation. **Do NOT add tRPC or GraphQL.** The dashboard is a first-party consumer of a ~15-endpoint API; Hono RPC gives you the same typing for free, and a REST API is what someone scripting against ADL with `curl` expects.

**Auth for v1:** one shared bearer token from config, stored hashed. Bind to `127.0.0.1` by default; binding `0.0.0.0` must be an explicit opt-in that logs a warning. Do not build user accounts or OAuth in v1.

### Streaming logs: SSE, not WebSocket

| | SSE | WebSocket |
|---|---|---|
| Direction needed | server → client only ✅ | bidirectional (unused) |
| Corporate proxies / TLS terminators | plain HTTP, works | upgrade often blocked |
| CLI consumption | `fetch` + `eventsource-parser@4.0.0`, `Authorization` header just works | needs a WS client lib and header plumbing |
| Reconnect | in the spec (`Last-Event-ID`) | hand-rolled |
| `curl`-able | ✅ | ❌ |

One caveat to design around: **the browser's native `EventSource` cannot set headers.** For the dashboard, authenticate with an httpOnly cookie or a short-lived signed token in the query string — not the bearer header. Revisit WebSocket only if you add bidirectional interactive steering ("answer this agent's question mid-run").

### CLI: commander

| | commander 15.0.0 | clipanion 4.0.0-rc.4 | oclif 4.23.30 | citty 0.2.2 |
|---|---|---|---|---|
| Stability | stable, `engines >=22.12.0` | **still RC** after years | stable | 0.x |
| Weight | tiny | medium | a framework (plugins, auto-update, manifests, hooks) | tiny |
| Contributor familiarity | highest | low | medium | low |
| Right for `adl status\|logs\|pause\|kill` | ✅ | — | overweight | — |

oclif is the right choice for a product CLI with a plugin marketplace and auto-update. ADL's CLI is four verbs over an HTTP API. **commander. HIGH.**

Companions: `@clack/prompts@1.7.0` for `adl init`, `picocolors` for colour. **Do NOT use `ink@7.1.1`** — React in a terminal is a large dependency and a rendering model to debug, for what is a status table and a log tail.

### Dashboard: the scope-control answer

**Ship it as a static SPA bundled into the npm package and served by the manager's own Hono app at `/`, hitting the same JSON API the CLI uses.** No second server, no second deploy, no second auth system, no SSR.

**Do NOT use Next.js.** It is a second server process, it wants SSR you don't need, and it actively fights being served as static files out of a Node daemon. Same objection to Remix/React Router framework mode and Nuxt.

Five screens, and no more, for v1:
1. Feature list (state, round, spend, elapsed)
2. Feature detail — round timeline with each agent's verdict
3. Live log stream (SSE)
4. Config view (read-only render of resolved `adl.yml` + daemon config)
5. Settings (budget defaults, concurrency, pause-all)

**Sequence it last.** The dashboard is a view over an API that must already exist and be correct. CLI + API prove the loop closes; if the loop hasn't closed, the dashboard is decoration on an unvalidated assumption — which is exactly the scope tension PROJECT.md already flagged.

---

## §7 — Observability (detail)

**Logging: `pino@10.3.1`.** Child loggers give you correlation for free:

```ts
const log = root.child({ featureId, runId });
const roundLog = log.child({ round, role: 'reviewer' });
```

Configure `redact` for `['*.token','*.apiKey','*.authorization','*.password']` on day one — you are handling forge tokens and model API keys, and a leaked credential in a support-bundle log is the worst bug this project can ship. `pino-pretty@13.1.3` as a **dev-only** dependency; production emits JSON to stdout and lets systemd/Docker handle rotation.

**Do NOT use winston** (slower, heavier, weaker TS types) and do not use `console.log` anywhere in `packages/core`.

**OpenTelemetry: defer, but prepare cheaply.**

Arguments for deferring: `@opentelemetry/sdk-node` is still `0.221.0` (pre-1.0), Node auto-instrumentation is a meaningful dependency and configuration burden, and a single-node self-hosted daemon that already writes structured logs *and* persists every round to a queryable database gets ~90% of tracing's value with none of the cost. Asking OSS users to stand up a collector to debug your tool is a poor first impression.

Arguments for not painting yourself into a corner — **do this now, it's nearly free:** give every unit of work a trace-shaped identity in the DB from the first migration:

```
runs   (id, feature_id, started_at, ended_at, status)
rounds (id, run_id, n, started_at, ended_at, status)
spans  (id, round_id, parent_id, name, kind, started_at, ended_at, status, attrs_json)
```

With that shape in place, adding OTel later is writing an exporter over data you already have, not re-instrumenting the codebase. Add `@opentelemetry/api@1.9.1` + `@opentelemetry/sdk-node` when someone runs ADL across multiple repos, or needs to correlate ADL spans with the target repo's CI.

**Metrics:** skip Prometheus for v1. `prom-client` on `/metrics` is ~30 lines whenever someone asks.

**Health endpoints:** `/healthz` (process alive, always cheap) and `/readyz` (DB open, `git --version` succeeds, at least one agent backend credential resolvable). Keep `/healthz` up during graceful shutdown while `/readyz` goes red — that's how orchestrators drain correctly.

**Token/cost tracking: build it in phase 1, not as observability.** See §4 — it's a hard gate in the loop, so it's core-loop code, and the schema is:

```
usage_events (id, feature_id, round, role, backend, model,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_usd, cost_source, created_at)
model_prices (model, input_per_mtok, output_per_mtok, effective_from)
```

---

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

---

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

---

## Stack Patterns by Variant

**If the vertical slice is GitHub + Claude Code + CLI only (recommended per PROJECT.md's scope-tension note):**
- Drop `@gitbeaker/rest`, the Gitea client, `openai`, `@google/genai`, and the AI SDK entirely
- Ship `@anthropic-ai/claude-agent-sdk` as the sole `AgentBackend` and `@anthropic-ai/sdk` as the sole `ModelBackend`
- Because the *ports* exist from day one, adding backend #2 later is a new file, not a refactor — that's the whole point of defining them up front

**If harness verdicts must work across ≥2 raw-API providers in v1:**
- Add `ai@7.0.66` + `@ai-sdk/anthropic@4.0.39` + `@ai-sdk/openai` + `@ai-sdk/google` for `ModelBackend` only
- One `generateObject({ schema })` call replaces three provider-specific structured-output implementations
- Keep `AgentBackend` on direct CLI/SDK adapters regardless

**If `node-gyp` install failures from better-sqlite3 become a support burden:**
- Swap to `node:sqlite` behind the repository layer (raise the `engines` floor to Node 24)
- Verify Drizzle's `node-sqlite` driver has reached `latest` first — it was on branch tags as of this research

**If ADL later manages many repos (explicit v2, out of v1 scope):**
- Postgres (`postgres@3.4.9` or `pg@8.23.0`) + `pg-boss@12.27.0` replaces SQLite + the lease table
- Workers move to separate hosts → the `fork()` IPC channel is replaced by the queue itself, and `AgentBackend` gains a remote-execution implementation
- Only then does OpenTelemetry earn its keep

**If a container/sandbox workspace backend is added (deferred per PROJECT.md):**
- The `WorkspaceBackend` interface stays; a new implementation shells to `docker`/`podman` via `execa` instead of `git worktree`
- `codex exec --sandbox` and Claude Agent SDK permission hooks give you a second, cheaper layer of containment inside the existing worktree model in the meantime

---

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

---

## Open questions for the roadmap

1. **Drizzle v1 timing.** `latest` is still 0.45.2 with `1.0.0-rc.5` on the `rc` tag. Either pin 0.45.2 and add an explicit "upgrade to drizzle v1" phase, or choose Kysely and never have the conversation. This is a decision the roadmap should force, not defer.
2. **`node:sqlite` graduation.** Watch for Stability 2 (Stable) and for Drizzle's `node-sqlite` driver reaching `latest`. That combination removes the only native-module install risk in the stack.
3. **TypeScript 7.1 (autumn 2026).** When typescript-eslint supports TS 7, a `6.0.3 → 7.x` bump is a genuine win. Worth a roadmap placeholder, not a v1 phase.
4. **Gitea client health.** If `gitea-js` gets a 2026 release, revisit; otherwise the hand-rolled client stands.
5. **Claude Agent SDK is pre-1.0** (`0.3.233`). Pin exact, and treat its version bumps as a plan-worthy change, not a dependabot merge.

---

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

---
*Stack research for: self-hosted multi-agent software-delivery daemon (TypeScript/Node)*
*Researched: 2026-08-17*
