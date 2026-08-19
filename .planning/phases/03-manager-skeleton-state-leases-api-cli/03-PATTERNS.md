# Phase 3: Manager Skeleton — State, Leases, API, CLI - Pattern Map

**Mapped:** 2026-08-19
**Files analyzed:** ~28 new/modified files across `@adl/manager` (new), `@adl/cli` (new), `@adl/db`, `@adl/core`, `@adl/workspace`, `eslint.config.js`, `.github/workflows/ci.yml`
**Analogs found:** 24 / 28

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/manager/package.json` | config | — | `packages/workspace/package.json` | exact (most recent package template) |
| `packages/manager/tsconfig.json` | config | — | `packages/workspace/tsconfig.json` | exact |
| `packages/manager/vitest.config.ts` | config | — | `packages/workspace/vitest.config.ts` | exact |
| `packages/manager/src/index.ts` | barrel | — | `packages/workspace/src/index.ts` | exact (header-comment style) |
| `packages/cli/package.json` | config | — | `packages/workspace/package.json` (+ commander in deps) | role-match |
| `packages/cli/tsconfig.json` | config | — | `packages/workspace/tsconfig.json` | exact |
| `packages/cli/vitest.config.ts` | config | — | `packages/workspace/vitest.config.ts` | exact |
| `packages/cli/src/index.ts` | CLI entry | request-response (HTTP client) | none — new pattern (no commander usage yet in repo) | no analog |
| `packages/manager/src/config/daemon-config.ts` | config | file-I/O | `packages/core/src/config/effective-config.ts` (`DaemonConfigSchema`, EXTEND not replace) + `packages/core/src/config/yaml-parse.ts` | exact |
| `packages/db/src/repository/features.ts` (MODIFIED: add `acquireLease`/`renewLease`/`expireLease`) | repository | CRUD (optimistic-concurrency) | `compareAndSwapState` in same file, lines 82-109 | exact |
| `packages/manager/src/scheduler/reaper.ts` | service | event-driven (poll/tick) | `packages/workspace/src/worktree/gc.ts` (`sweepOrphans`'s injected-deps, no-clock shape) | role-match |
| `packages/manager/src/scheduler/gc-schedule.ts` | service | batch (periodic) | `sweepOrphans`/`sweepScratchHomes` themselves — **bind, do not reimplement** | exact (binding only) |
| `packages/manager/src/scheduler/dispatcher.ts` | service | CRUD (queue selection) | `listByState` (features.ts, FIFO by id) + `featuresRepository` shape generally | role-match |
| `packages/manager/src/worker-supervisor/fork.ts` | utility (process launch) | event-driven | `packages/workspace/src/exec/run.ts` (the *only* other process-launch site in the repo) — **must land as a workspace export**, see Shared Patterns | role-match, with a structural constraint |
| `packages/manager/src/worker-supervisor/ipc-protocol.ts` | model (Zod contract) | event-driven | `packages/core/src/state/feature-state.ts` (frozen-list + exhaustiveness pattern for `FeatureEvent`) | role-match |
| `packages/manager/src/worker-supervisor/lifecycle.ts` | service | event-driven | none direct — composed from Pattern 2 in RESEARCH.md; nearest analog is `run.ts`'s owner/kill reasoning | partial |
| `packages/manager/src/worker-entry/index.ts` (forked worker main) | controller (process entry) | event-driven (IPC) | no existing analog — first forked-process entry point in the repo; must not import `@adl/db` | no analog |
| `packages/manager/src/api/app.ts` | controller (HTTP) | request-response | no existing analog — first Hono app in the repo | no analog (use RESEARCH.md Code Examples) |
| `packages/manager/src/api/routes/*.ts` | route | request-response | no existing analog | no analog |
| `packages/manager/src/daemon.ts` | controller (startup) | event-driven (lifecycle) | `packages/db/src/migrator.ts` + `packages/db/src/checksum.ts` (startup gate machinery to bind, not rebuild) | role-match |
| `packages/core/src/state/feature-state.ts` (read-only reference for new IPC/CLI unions) | model | — | itself — the frozen-list pattern to imitate for the IPC message union and CLI verb set | exact (pattern source) |
| `packages/core/src/state/transition.ts` (consumed, not modified) | service (pure fn) | transform | itself — every manager state change routes through `transition()` | exact (pattern source) |
| `packages/db/test/helpers/temp-db.ts` (extended pattern, reused as-is) | test helper | file-I/O | itself | exact |
| `packages/manager/test/scenario/*.test.ts` | test | event-driven (integration) | `packages/db/test/migrate.test.ts` + `packages/workspace/test/contract/` for structure; `packages/workspace/test/helpers/platform.ts` for the visible-skip discipline | role-match |
| `packages/manager/test/helpers/windows-only.ts` (or similar) | test helper | — | `packages/workspace/test/helpers/platform.ts` (`linuxOnly`/`posixOnly` shape) | exact (shape to extend, new `windowsOnly`) |
| `.github/workflows/ci.yml` (MODIFIED: add Windows leg) | config | — | itself, existing `strategy.matrix.node-version` block | exact (extend the matrix) |
| `eslint.config.js` (MODIFIED: no change actually required) | config | — | itself — `WORKSPACE_EXEMPTION` already covers `packages/manager`'s use of a workspace-exported `forkWorker`, confirmed below | n/a (verify only) |

## Pattern Assignments

### `packages/manager/package.json`, `tsconfig.json`, `vitest.config.ts`

**Analog:** `packages/workspace/package.json` / `tsconfig.json` / `vitest.config.ts` (most recently created package, most current template)

**package.json shape** (verbatim, `packages/workspace/package.json`):
```json
{
  "name": "@adl/workspace",
  "version": "0.0.0",
  "type": "module",
  "description": "ADL workspace backends — the git worktree lifecycle and the one exec boundary. The only package that touches execa and simple-git.",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc -b",
    "pretypecheck": "tsc -b ../core",
    "typecheck": "tsc --noEmit",
    "pretest": "tsc -b ../core ../db",
    "test": "vitest run"
  },
  "dependencies": { "@adl/core": "workspace:*", "execa": "10.0.1", "simple-git": "3.36.0" },
  "devDependencies": {
    "@adl/db": "workspace:*",
    "@types/node": "22.20.1",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```
For `@adl/manager`: `description` should state its dependency scope ("The manager daemon — lease queue, worker supervision, HTTP API. Depends on @adl/core, @adl/db, @adl/workspace."), `dependencies` gains `hono`, `@hono/node-server`, `pino`, `croner`, `ulid`, `@adl/db` (dependency not devDependency — the manager IS the writer), `@adl/workspace` (workspace:*). `bin` is not needed here (that's `@adl/cli`).

For `@adl/cli`: dependencies are `commander` only, plus `zod`/`yaml` if the HTTP client needs schema validation of responses. **No `@adl/db` dependency at all** (D-18/D-21) — this is enforced structurally by pnpm strict workspaces, so simply not listing it is sufficient; no lint rule needed beyond what already exists for `no-restricted-imports`. Add `"bin": { "adl": "./dist/index.js" }` — the one new field relative to the workspace template, since this package ships the executable.

**tsconfig.json** (verbatim, `packages/workspace/tsconfig.json`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```
Copy verbatim for both new packages, adjusting the leading comment to explain why (`@adl/manager` needs `node` types for `child_process.fork`; `@adl/cli` needs them for `process.exit`/stdout).

**vitest.config.ts** (verbatim, `packages/workspace/vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'workspace',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```
Change only `name` (`'manager'` / `'cli'`).

---

### `packages/manager/src/index.ts` (barrel)

**Analog:** `packages/workspace/src/index.ts`

**Header-comment style to imitate** (lines 1-13):
```typescript
/**
 * `@adl/workspace` — the exec boundary.
 *
 * Every process ADL starts goes through this package (WORK-02). That is enforced
 * by the `adl/no-direct-spawn` lint rule in `eslint.config.js`, whose single
 * exemption is `packages/workspace/**`, rather than by review: a direct spawn
 * reaching the OS process table bypasses the zero-inherit environment, the
 * scratch `HOME`, the privilege drop, and the git-config neutralisation all at
 * once.
 *
 * `@adl/core` declares the {@link Workspace} interface and nothing else; the
 * implementations live here, because core is pure and I/O-free.
 */
```
Each export group is preceded by a comment explaining **why** it is public, not just what it is — e.g. (lines 108-123):
```typescript
// The GC backstop (D-15, D-16, D-20) — the POLICY half. It reaches feature
// state through an injected lookup rather than importing @adl/db, so the
// swappable backend layer carries no database dependency. The manager binds
// the lookup and owns the trigger; both are Phase 3.
export {
  sweepOrphans,
  type FeatureStateLookup,
  type GcDeps,
  type SweepFailure,
  sweepScratchHomes,
  processIsAlive,
  type ScratchHomeGcDeps,
  type ScratchHomeSweepFailure,
} from './worktree/gc.js';
```
`@adl/manager`'s barrel should export: the daemon startup/shutdown entry (`startDaemon`/`stopDaemon` or similar), the Hono `app` factory (for tests to mount without binding a port), the reaper/dispatcher/gc-schedule bind functions, and the IPC message union types — each with a "why public" comment in this style. Do **not** export the worker-entry module's internals — same reasoning as `packages/workspace/src/exec/env.ts` being deliberately unexported (barrel comment lines 28-32): it is an implementation detail of one caller.

---

### `packages/db/src/repository/features.ts` — new lease methods

**Analog:** `compareAndSwapState`, same file, lines 82-109 (already shipped)

**The exact pattern to extend** (verbatim):
```typescript
async compareAndSwapState({
  id,
  expectedVersion,
  state,
  currentStageIndex,
  round,
  updatedAt,
}) {
  let query = db
    .updateTable('features')
    .set({
      state,
      state_version: expectedVersion + 1,
      updated_at: updatedAt,
    })
    .where('id', '=', id)
    .where('state_version', '=', expectedVersion);

  if (currentStageIndex !== undefined) {
    query = query.set({ current_stage_index: currentStageIndex });
  }
  if (round !== undefined) {
    query = query.set({ round });
  }

  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
},
```
**New methods follow this exactly**, substituting the fence predicate:
```typescript
// acquireLease / renewLease / expireLease shape (composed from the pattern above)
async renewLease({ id, leaseToken, heartbeatAt }: {
  id: string; leaseToken: string; heartbeatAt: string;
}): Promise<boolean> {
  const result = await db
    .updateTable('features')
    .set({ heartbeat_at: heartbeatAt })
    .where('id', '=', id)
    .where('lease_token', '=', leaseToken)   // D-06/D-08's fence, required param
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
},
```
`leaseToken: string` — **never `string | undefined`** (D-08). The `FeaturesRepository` interface (lines 23-48) should gain these method signatures beside `compareAndSwapState`, with the same JSDoc style explaining the invariant each guards (see lines 28-35 for the existing example of that JSDoc shape). `acquireLease` additionally guards `WHERE lease_token IS NULL OR lease_expires_at < ?` (only an unheld or expired lease can be acquired) and sets `lease_owner`, `lease_token`, `lease_expires_at` together with `heartbeat_at`.

**Schema columns already exist** (verified, `packages/db/src/schema.ts:65-69`): `lease_owner: string | null`, `lease_token: string | null`, `lease_expires_at: string | null`, `heartbeat_at: string | null`, `crash_count: number`. **No migration is needed for the lease methods.** If `lease_owner`'s content changes shape (D-14, PID + start time as a composite value), it stays the same `TEXT` column — just JSON- or delimiter-encoded — so `FEATURES_COLUMNS`/`TABLE_COLUMNS` (schema.ts:263-341) do not need a new entry, only the drift test needs to keep passing (it already does, since no column is added or removed).

---

### `packages/manager/src/scheduler/gc-schedule.ts` — binding, not reimplementing

**Analog:** `packages/workspace/src/worktree/gc.ts` — `sweepOrphans`, `sweepScratchHomes`, `GcDeps`, `FeatureStateLookup` (all exported from the barrel, verified `packages/workspace/src/index.ts:108-123`)

**The dependency shape to bind against** (verbatim, `gc.ts` lines 68-82):
```typescript
export type FeatureStateLookup = (
  featureId: string,
) => Promise<string | undefined>;

export interface SweepFailure {
  readonly featureId: string;
  readonly worktreePath: string;
  readonly error: unknown;
}

export interface GcDeps {
  readonly mainRepo: string;
  readonly lookupFeatureState: FeatureStateLookup;
  readonly onFailure?: (failure: SweepFailure) => void;
}
```
The manager's job is exactly: `lookupFeatureState: (id) => featuresRepository.findById(id).then((row) => row?.state)`, wiring `onFailure` to the pino logger, and calling `sweepOrphans`/`sweepScratchHomes` on a `croner` schedule plus from `adl gc`'s HTTP handler. **Note `GcDeps` deliberately takes no clock** — the manager must not add one when binding it. `processIsAlive` (same file, lines 200-212) is directly reusable for D-13/D-14's boot-time orphan-kill liveness check; do not write a second liveness probe.

---

### `packages/manager/src/worker-supervisor/fork.ts` — the process-launch seam

**Analog:** `packages/workspace/src/exec/run.ts` (the only other process-launch site in the repo) + the load-bearing `eslint.config.js` comment, both verified this session.

**The comment that settles the "second exemption?" question** (verbatim, `eslint.config.js:21`, inside the architecture rule-set table):
> "Composed against 02-RESEARCH.md § Pitfall 1 (overlapping flat-config entries REPLACE rather than merge, so a careless glob silently deletes the two bans above) and § Pitfall 2 (`no-restricted-imports` is blind to `require()` and dynamic `import()`, so the ban is otherwise bypassable by changing the import form). | **Phase 3, when the manager→worker `fork()` seam lands as a named export of `packages/workspace` rather than as a second exemption**"

And the ban message itself (verbatim, `eslint.config.js:218`):
> "Direct process launch is banned outside packages/workspace (WORK-02). Every process ADL starts — including the agent CLIs — goes through Workspace.exec(), which is what makes the container backend in v2 a registry entry rather than a repository-wide call-site sweep. **The Phase 3 manager→worker seam is not an exception: fork() lands as a named export of packages/workspace too, so the exemption count stays at one.** If you need to run something, take the Workspace instance the caller already has."

**Consequence for the plan:** create `packages/workspace/src/exec/fork.ts` (sibling of `run.ts`, not a modification of it — `run` is execa-specific, `fork()` is a different primitive) exporting a `forkWorker(entryPath, opts): ChildProcess`-shaped function, and re-export it from `packages/workspace/src/index.ts`'s barrel with a "why public" comment in the established style. `WORKSPACE_EXEMPTION` (`eslint.config.js:318`, `const WORKSPACE_EXEMPTION = [mod('packages/workspace/**/*')];`) already covers this location with **no eslint.config.js edit required** — verify this by writing the fixture/positive test only, not new rule config. `@adl/manager` then imports `forkWorker` from `@adl/workspace`, exactly as it imports `sweepOrphans`.

**`run()`'s own header comment**, for the analogous rationale to restate in `fork.ts` (verbatim, `run.ts:1-9`):
```typescript
/**
 * The one process launch in the repository (WORK-02).
 *
 * This is the only module that imports `execa`, and `eslint.config.js`'s
 * `adl/no-direct-spawn` rule is what keeps it that way — its single exemption is
 * `packages/workspace/**`. A direct spawn anywhere else would bypass the
 * zero-inherit environment, the scratch `HOME`, the privilege drop, and the
 * git-config neutralisation simultaneously, and none of those bypasses would be
 * visible in a diff.
 */
```

---

### `packages/manager/src/worker-supervisor/ipc-protocol.ts` — the message union

**Analog:** `packages/core/src/state/feature-state.ts` — the frozen-list + compile-time-exhaustiveness pattern (`FEATURE_STATES`, `FEATURE_EVENT_KINDS`, `TRANSITION_CTX_FIELDS`)

**The pattern to replicate exactly** (verbatim, lines 166-197):
```typescript
/** The discriminator values of `FeatureEvent`, as runtime data. */
export const FEATURE_EVENT_KINDS = Object.freeze([
  'admit',
  'lease_acquired',
  // ...
  'unrecoverable',
] as const) satisfies readonly FeatureEvent['t'][];

export type FeatureEventKind = FeatureEvent['t'];

/**
 * Compile-time exhaustiveness: an event kind added to the union but missing
 * from `FEATURE_EVENT_KINDS` fails the **build**, not a test.
 */
type _EveryEventKindListed =
  Exclude<FeatureEventKind, (typeof FEATURE_EVENT_KINDS)[number]> extends never
    ? true
    : never;
const _everyEventKindListed: _EveryEventKindListed = true;
void _everyEventKindListed;
```
The IPC message union (`heartbeat`, `result`, `soft_stop`, and whatever else the planner designs per CONTEXT's "Claude's Discretion" item) should be a Zod discriminated union (project convention — see `## Shared Patterns` below) paired with a frozen list of its discriminator values and the identical `_Every...Listed` compile-time assertion. Model it as a sibling file to `feature-state.ts`, not inside it — `@adl/core` is pure/I/O-free and the IPC contract belongs to `@adl/manager` (or a shared type-only module both `@adl/manager` and the worker-entry import), never to `@adl/core/state` itself.

---

### `packages/manager/src/config/daemon-config.ts` — extend, do not duplicate

**Analog:** `packages/core/src/config/effective-config.ts` — `DaemonConfigSchema` and `mergeConfig`

**Verified: `DaemonConfigSchema` exists today but does NOT yet have the lease/API/repo fields RESEARCH.md describes** (verified by direct read this session, `effective-config.ts:119-130`):
```typescript
export const DaemonConfigSchema = z
  .strictObject({
    limits: LimitsSchema.partial().default({}),
    agents: z
      .strictObject({
        developer: DaemonAgentBlockSchema.optional(),
        reviewer: DaemonAgentBlockSchema.optional(),
        tester: DaemonAgentBlockSchema.optional(),
      })
      .default({}),
  })
  .meta({ id: 'DaemonConfig' });

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
```
This is the object to **extend in place** — add `lease_ttl_ms`, `heartbeat_interval_ms`, `concurrency` (`{ global: number; perRepo?: number }`), `api: { port: number; token: string }`, and `repos` (an array of watched-repo declarations) as new top-level fields on this same `z.strictObject`. Per D-02's TTL≥3×interval rule, add a `.refine()` at the schema level (matching the project's existing `.refine()` usage elsewhere in `adl-yml.ts`/`context-cascade.ts` — check those files for the exact `.refine()` call shape before writing a new one). **Do not create a second `ManagerConfigSchema`** — `mergeConfig`'s clamp/reject fold (lines 246-318) is for repo-vs-daemon authority over `limits`/`agents` and does **not** need to touch the new daemon-only fields (they have no repo-side counterpart at all, per RESEARCH.md Pitfall 4) — they are read straight off the parsed daemon config.

**`mergeConfig`'s fold shape**, useful for understanding what NOT to reimplement (verbatim excerpt, lines 246-318 — clamp for `limits`, reject for `DAEMON_ONLY_FIELDS`) is already fully wired; Phase 3 calls `mergeConfig(DEFAULT_CONFIG, daemonConfig, parsedAdlYml)` at lease-acquire time to build `effective_config_json`, exactly as RESEARCH.md's "Don't Hand-Roll" table states. The result is already `deepFreeze`'d (line 315).

**Parser to reuse**: `packages/core/src/config/yaml-parse.ts` — the daemon config file uses "same format and parser as `adl.yml`" per D-36; read that file's exported `parseYamlDocument`-shaped function before writing a second YAML-loading path.

---

### `packages/manager/test/**` — test structure and helpers

**Analog:** `packages/db/test/helpers/temp-db.ts` (temp SQLite per test) + `packages/workspace/test/helpers/platform.ts` (visible-skip discipline)

**Temp-DB pattern** (verbatim, `packages/db/test/helpers/temp-db.ts:33-48`):
```typescript
export async function withTempDb<T>(
  fn: (ctx: TempDb) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-db-'));
  const filePath = join(dir, 'adl.db');
  const db = createDb(filePath);

  try {
    return await fn({ db, filePath });
  } finally {
    // Destroy before removing: on Windows an open handle makes the unlink fail,
    // which would turn a passing test into a confusing teardown error.
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
```
Manager scenario tests (`test/scenario/*.test.ts`) reuse this directly (`@adl/db` is a devDependency of `@adl/manager`'s test suite already, since the manager package itself depends on `@adl/db` in production).

**Visible-skip helper shape** (verbatim, `packages/workspace/test/helpers/platform.ts:57-92`, `linuxOnly`):
```typescript
export function linuxOnly(
  reason: string,
  requirementId = 'WORK-05',
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): LinuxOnlyGate {
  if (platform !== 'linux') {
    const stated = `${SKIP_PREFIX}[${requirementId}] ${reason} (platform: ${platform})`;
    process.stderr.write(`${stated}\n`);
    return { kind: 'skip', reason: stated };
  }
  // ... throws if misconfigured on the platform where it should run — never a silent pass
}
```
`SKIP_PREFIX = '[ADL][SKIPPED]'` is exported from the same file and is the greppable marker CI logs are checked against. D-33's Windows-specific assertions (e.g. `/proc`-based start-time verification, which structurally has no Windows subject) need an equivalent `windowsOnly`/cross-platform gate beside `linuxOnly`/`posixOnly` in a **new** file at `packages/manager/test/helpers/platform.ts` (or extend the existing one if it is promoted to a shared test-utility — check whether `@adl/workspace`'s `test/helpers/platform.ts` is importable from `@adl/manager`'s test suite before duplicating it; if not, copy the shape, not the file).

---

### `packages/manager/src/daemon.ts` — startup gate

**Analog:** `packages/db/src/migrator.ts` + `packages/db/src/checksum.ts` (the migration runner and checksum guard D-37 builds on — bind, do not rebuild)

D-37 requires: refuse a schema newer than the daemon, copy the DB file before auto-migrating an older one, then reconcile repos (D-35) and expire leases (D-13). The migration runner and checksum guard already exist and are verified present (`packages/db/src/migrator.ts`, `packages/db/src/checksum.ts`) — this phase's job is calling them in the right order at startup, not reimplementing schema-version comparison logic. Read `packages/db/src/migrator.ts` directly during planning for the exact function signatures (`migrateToLatest`, `MIGRATIONS_DIR` usage already shown in the temp-db helper above) before writing `daemon.ts`'s startup sequence.

---

## Shared Patterns

### Return-don't-throw for expected-but-notable outcomes
**Source:** `packages/core/src/state/transition.ts` — `InvalidTransition` (lines 333-341 of `feature-state.ts`) and `compareAndSwapState`'s boolean return (`features.ts:82-109`)
**Apply to:** D-09's stale-result rejection, every new lease-scoped repository method, and the IPC message handler's fencing check. Never throw for a benign race; return a typed result the caller can log/count/decide on.
```typescript
// features.ts's own comment on the shape (lines 28-35):
/**
 * Advance a feature's state, asserting the version it was read at.
 *
 * The `state_version` predicate is the whole method. Two workers that both
 * read version 4 cannot both write version 5 — the second update matches no
 * row and reports `false`, which is a caller-visible loss rather than a
 * silent overwrite of the first worker's transition.
 */
```

### Frozen-list + compile-time exhaustiveness
**Source:** `packages/core/src/state/feature-state.ts` lines 60-83 (`FEATURE_STATES`), 166-197 (`FEATURE_EVENT_KINDS`), 242-262 (`TRANSITION_CTX_FIELDS`)
**Apply to:** the IPC message-kind union, and the CLI's verb set if it benefits from the same runtime/compile-time pairing (verbs are read by commander directly, so this is optional there — mandatory for the IPC union per CONTEXT's discretion item).

### Every state change routes through the pure `transition()` function
**Source:** `packages/core/src/state/transition.ts`, full file — especially the "three properties" header comment (lines 13-40): pure, total, ignorant of stage identity.
**Apply to:** every manager-side state write — `lease_acquired`, `lease_expired`, `pause`, `resume`, `unrecoverable`. The manager reads a row, calls `transition(state, event, ctx)`, and if `ok: true` writes both the state update (guarded by `expectedStateVersion`) and the `FeatureEventEffect` in one transaction, following `compareAndSwapState`'s existing guard shape.

### Zod-first contracts, types via `z.infer`
**Source:** `packages/core/src/config/effective-config.ts` (`DaemonConfigSchema`, `EffectiveConfigSchema` — note `.strictObject` and `.meta({ id: '...' })` conventions) and `packages/core/src/config/adl-yml.ts`
**Apply to:** the daemon config extension, HTTP request/response bodies (paired with `@hono/zod-validator`'s `zValidator`, per RESEARCH.md Code Examples), and the IPC message union.
```typescript
// The .strictObject + .meta id convention to follow for every new schema:
export const DaemonConfigSchema = z
  .strictObject({ /* ... */ })
  .meta({ id: 'DaemonConfig' });
```

### Injected-dependency style for testability, no clock
**Source:** `packages/workspace/src/worktree/gc.ts` — `GcDeps`/`FeatureStateLookup` (lines 57-82), and `TransitionCtx.at` being caller-supplied (`feature-state.ts:229-230`)
**Apply to:** the reaper (`reaper.ts` should take an injected `now: () => string` or receive `now` as a parameter per tick, never read `Date.now()` inside a per-row loop — RESEARCH.md's own anti-pattern warning), and any lease-scoped logic under test. `GcDeps` itself notably takes **no clock at all** — the manager's reaper is the one place in this phase that legitimately reads a clock, and it should do so once per tick and pass the resulting ISO string down as data (Pattern 5 in RESEARCH.md).

### The exec/process-launch boundary
**Source:** `packages/workspace/src/exec/run.ts` (header, lines 1-14) + `eslint.config.js:21,218,318` (`WORKSPACE_EXEMPTION`)
**Apply to:** `worker-supervisor/fork.ts`. See the dedicated Pattern Assignment above — the settled answer is a named `@adl/workspace` export, not a second lint exemption.

### ISO-8601 TEXT timestamps for lexicographic-safe comparison
**Source:** `packages/db/src/checksum.ts:52` — `const appliedAt = new Date().toISOString();` (verified this session as the actual format in use)
**Apply to:** `lease_expires_at`, `heartbeat_at`, and every reaper-tick comparison (`WHERE lease_expires_at < ?`). Use one shared `nowIso()` helper for every write site, to keep the "lexicographic order == chronological order" property from drifting (RESEARCH.md Pattern 5's stated pitfall).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `packages/manager/src/api/app.ts`, `api/routes/*.ts` | controller | request-response | First Hono app in the repo — no existing HTTP server to model. Use RESEARCH.md § Code Examples (bearer-auth middleware, `zValidator`, `@hono/node-server` graceful shutdown) as the pattern source instead of an in-repo analog. |
| `packages/manager/src/worker-entry/index.ts` | controller (process entry) | event-driven (IPC) | First forked-process entry point in the repo. Nearest conceptual analog is `run.ts`'s owner/kill reasoning, but the shape (a `process.on('message', ...)` loop, no `@adl/db` import) has no existing twin. Composed from RESEARCH.md Pattern 2's code example. |
| `packages/manager/src/worker-supervisor/lifecycle.ts` (SIGTERM→IPC-soft-stop→SIGKILL escalation) | service | event-driven | No existing cross-platform process-escalation code in the repo — `execa`'s `forceKillAfterDelay` (used in `run.ts`) explicitly does not extend to the `fork()`'d worker (RESEARCH.md Pitfall 3). Composed from RESEARCH.md Pattern 2. |
| `packages/cli/src/index.ts`, `commands/*.ts` | CLI entry / controller | request-response | No existing commander usage anywhere in the repo — this is the first CLI package. No in-repo analog; follow commander 15's own documented subcommand shape. |
| `packages/cli/src/http-client.ts` | service (HTTP client) | request-response | No existing fetch-wrapper pattern in the repo to model (`octokit`/forge clients are Phase 5). Build from D-19's bearer-token contract directly. |

## Metadata

**Analog search scope:** `packages/core/src`, `packages/db/src`, `packages/db/test`, `packages/workspace/src`, `packages/workspace/test`, `eslint.config.js`, `.github/workflows/ci.yml`
**Files scanned:** `packages/workspace/src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`; `packages/db/src/repository/features.ts`, `schema.ts` (grep), `package.json`, `vitest.config.ts`; `packages/db/test/helpers/temp-db.ts`; `packages/workspace/src/worktree/gc.ts`, `exec/run.ts`; `packages/workspace/test/helpers/platform.ts`; `packages/core/src/state/feature-state.ts`, `transition.ts`; `packages/core/src/config/effective-config.ts`; `eslint.config.js` (targeted reads); `.github/workflows/ci.yml` (head)
**Pattern extraction date:** 2026-08-19
