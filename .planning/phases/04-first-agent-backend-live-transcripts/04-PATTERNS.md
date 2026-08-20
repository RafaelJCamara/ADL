# Phase 4: First Agent Backend & Live Transcripts - Pattern Map

**Mapped:** 2026-08-20
**Files analyzed:** 13
**Analogs found:** 11 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/agent-claude-code/src/backend.ts` | service (agent adapter) | streaming (subprocess → events) | `packages/workspace/src/exec/run.ts` (`run()`) + `packages/manager/src/worker-entry/index.ts` (`productionStageRunner`) | role-match |
| `packages/agent-claude-code/src/events.ts` | transform | streaming (NDJSON line → union) | `packages/core/src/stage/stage-error.ts` (`parseStageOutput`'s ladder/candidate scanning) | partial match |
| `packages/agent-claude-code/src/preflight.ts` | utility (version gate) | request-response | `packages/core/src/stage/stage-error.ts` (`StageError`/`StageErrorKind` classify-don't-throw shape) | partial match |
| `packages/agent-claude-code/src/index.ts` | config/barrel | — | any package `index.ts` (e.g. `packages/db/src/repository/index.ts` pattern) | role-match |
| `packages/core/src/stage/stage.ts` (edit — `AgentRunner`) | model/type | request-response | same file, `Workspace`/`ExecSpec` real-interface replacement precedent (already in file) | exact (self-precedent) |
| `packages/manager/src/worker-entry/index.ts` (edit — real `productionStageRunner`) | controller (worker entry) | event-driven (IPC) | itself (existing `runWorker`/`StageRunner`/`send()` shape) | exact |
| `packages/manager/src/prompt/build.ts` | service (PromptBuilder) | transform | `packages/core/src/stage/stage-error.ts` (pure functions over typed input → typed output, no I/O) | partial match |
| `packages/manager/src/prompt/templates/developer.md` | config (template) | — | none — no existing template file in repo | no analog |
| `packages/manager/src/store/ndjson-log-store.ts` | service (file store) | file-I/O + streaming | `packages/workspace/src/exec/scratch-home.ts` (file lifecycle, discriminated-union outcomes, defensive fs error handling) | partial match |
| `packages/manager/src/api/routes/logs.ts` | route (SSE) | streaming (byte-offset reconnect) | `packages/manager/src/api/routes/health.ts` (minimal route registration shape) + `packages/manager/src/api/routes/control.ts` (deps-object + `registerXRoutes(app, deps)` convention) | role-match |
| `packages/manager/src/api/routes/dev-run.ts` | route (POST trigger) | request-response → event-driven (fork+lease) | `packages/manager/src/api/routes/control.ts` (`zValidator` + deps interface + `registerXRoutes` convention) | exact |
| `packages/cli/src/commands/dev-run.ts` | CLI command | request-response (HTTP) | `packages/cli/src/commands/pause.ts` | exact |
| `packages/cli/src/commands/logs.ts` | CLI command | streaming (SSE consumption) | `packages/cli/src/commands/pause.ts` (command shape) + `packages/cli/src/http-client.ts` (client wrapper conventions) | role-match |
| `packages/workspace/src/worktree/backend.ts` (edit — D-2-08-1 `safe.directory` fix) | service (workspace) | file-I/O | itself (`worktreeWorkspace()`'s existing `createScratchHome()`/`applyWorkerAccess()` call sequence at the cited lines) | exact |

## Pattern Assignments

### `packages/agent-claude-code/src/backend.ts` (service, streaming)

**Analog:** `packages/workspace/src/exec/run.ts` (the exec boundary) + `packages/manager/src/worker-entry/index.ts` (`productionStageRunner`, the function this phase replaces)

**The one process-launch rule** (`packages/workspace/src/exec/run.ts:1-16`):
```typescript
/**
 * The one process launch in the repository (WORK-02).
 *
 * This is the only module that imports `execa`, and `eslint.config.js`'s
 * `adl/no-direct-spawn` rule is what keeps it that way — its single exemption is
 * `packages/workspace/**`. A direct spawn anywhere else would bypass the
 * zero-inherit environment, the scratch `HOME`, the privilege drop, and the
 * git-config neutralisation simultaneously...
 */
```
The adapter MUST call `workspace.exec(spec, log)` — never import `execa` itself. Its own `ExecSpec` shape (from `packages/core/src/stage/workspace.ts:266-296`, already cited in RESEARCH.md's Pattern 1) is `{ argv, cwd, path, env, timeoutMs, signal }`.

**Streaming translation shape to copy** (line-buffering a stdout stream — same shape `run.ts` itself uses for its two concurrent stdout/stderr loops, lines 188-198):
```typescript
const [, , result] = await Promise.all([
  (async () => {
    for await (const text of subprocess.iterable({ from: 'stdout' })) {
      log({ stream: 'stdout', text });
    }
  })(),
  (async () => {
    for await (const text of subprocess.iterable({ from: 'stderr' })) {
      log({ stream: 'stderr', text });
    }
  })(),
  subprocess,
]);
```
The adapter's own `log` callback (passed into `workspace.exec`) should buffer partial lines and emit one `AgentEvent` per complete NDJSON line — see RESEARCH.md's own Pattern 1 code example, which already follows this file's buffering idiom.

**Replaced function's contract** (`packages/manager/src/worker-entry/index.ts:172-187`):
```typescript
/**
 * The production stage runner: a real implementation that reports a named
 * "no agent backend configured in this phase" outcome. This is a
 * functionality gap, not an architectural one — Phase 4 replaces this one
 * function.
 */
function productionStageRunner(): StageRunner {
  return async () =>
    Promise.resolve({
      verdictJson: JSON.stringify({
        outcome: 'skip',
        summary: 'no agent backend configured in this phase',
        findings: [],
      }),
    });
}
```
This phase's `productionStageRunner()` keeps the same `StageRunner = (assign: AssignMessage) => Promise<StageRunnerResult>` signature and the same "must not import `@adl/db`" constraint (worker-entry reports over IPC; the manager owns the DB write — see Pattern 4 below).

---

### `packages/agent-claude-code/src/events.ts` (transform, streaming)

**Analog:** `packages/core/src/stage/stage-error.ts` — no direct precedent for NDJSON-line translation exists in the repo, but this file's **candidate-scanning / classify-don't-throw** shape is the closest structural analog for "take untrusted external text and turn it into a closed union, defensively":

```typescript
// packages/core/src/stage/stage-error.ts:360-375
function* jsonCandidates(raw: string): Generator<unknown> {
  const whole = tryJson(raw);
  if (whole.ok) yield whole.value;
  for (const block of fencedBlocks(raw)) {
    const parsed = tryJson(block);
    if (parsed.ok) yield parsed.value;
  }
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) {
    const span = tryJson(raw.slice(open, close + 1));
    if (span.ok) yield span.value;
  }
}
```

Apply the same defensiveness discipline to `translateLine(line: string): AgentEvent`: parse with `JSON.parse` inside a try/catch, and an unrecognized/malformed line should map to a distinct `error`-kind `AgentEvent` (never thrown) so one bad line does not crash the translator mid-stream — this mirrors `stage-error.ts`'s "classify, don't throw, for expected-but-notable outcomes" convention named in RESEARCH.md's Established Patterns.

---

### `packages/agent-claude-code/src/preflight.ts` (utility, request-response)

**Analog:** `packages/core/src/stage/stage-error.ts` — `StageErrorKind` / `stageErrorPolicy` (classification over a closed enum, never a throw for an expected failure):

```typescript
// packages/core/src/stage/stage-error.ts:45-58
export const STAGE_ERROR_KINDS = Object.freeze([
  'unparseable', 'provider_error', 'timeout', 'binary_missing', 'auth',
] as const);
export type StageErrorKind = (typeof STAGE_ERROR_KINDS)[number];
```

The preflight result (already sketched in RESEARCH.md's Code Examples section) should follow this same "typed classification, not an exception" shape:
```typescript
export interface PreflightResult {
  readonly ok: boolean;
  readonly installedVersion: string | null;
  readonly expectedVersion: string;
  readonly detail?: string;
}
```
`binary_missing` (exit code non-zero / not found) vs a version mismatch are two distinct, nameable outcomes — mirror `StageErrorKind`'s enumeration discipline rather than a single boolean.

---

### `packages/manager/src/worker-entry/index.ts` (edit — real `productionStageRunner`)

**Analog:** itself — `runWorker()`'s existing `send()` / `StageRunner` / "must not import `@adl/db`" shape (lines 1-53, 172-187, quoted above). The IPC-report-not-direct-DB-write pattern is load-bearing: usage events and stage results are reported over `process.send`, and the **manager** performs the `usageRepository().record()` insert (see Pattern 4 below) — do not add a `@adl/db` import to this module; `eslint.config.js`'s `adl/worker-entry-no-db` rule will fail the build.

---

### `packages/manager/src/prompt/build.ts` (service, transform)

**Analog:** `packages/core/src/stage/stage-error.ts` — pure-function style (no I/O inside the render function itself; deterministic input → output). No direct prompt-building precedent exists in the codebase; RESEARCH.md's Open Question 1 recommends a markdown template file loaded and rendered by this module. Follow the "Zod as source of truth, types via `z.infer`" convention (Established Patterns, CONTEXT.md) for the `PromptBuilder` input shape `(NormalizedSpec, EffectiveConfig, SendBackBrief, capabilities)`.

---

### `packages/manager/src/store/ndjson-log-store.ts` (service, file-I/O)

**Analog:** `packages/workspace/src/exec/scratch-home.ts` — closest file-lifecycle precedent in the repo for a service that manages files with a discriminated-union outcome and defensive error handling:

```typescript
// packages/workspace/src/exec/scratch-home.ts:143-161
export type ScratchHomeTeardown =
  | { readonly outcome: 'removed'; readonly path: string; readonly attempts: number; }
  | { readonly outcome: 'already-absent'; readonly path: string; }
  | { readonly outcome: 'not-removed'; readonly path: string; readonly attempts: number; readonly reason: string; };
```

Copy this "return the outcome, do not throw for an expected condition" discipline for the log store's append/read operations. Also copy the `codeOf(error)` defensive error-code narrowing helper (`scratch-home.ts:348-352`) for any `fs` error handling the log store needs (e.g. `ENOENT` on a not-yet-created transcript file at offset 0).

---

### `packages/manager/src/api/routes/logs.ts` (route, streaming)

**Analog:** `packages/manager/src/api/routes/health.ts` (minimal single-route registration) and `packages/manager/src/api/routes/control.ts` (deps-object + validated-body convention for a more complex route)

**Registration convention** (`packages/manager/src/api/routes/health.ts:17-21`):
```typescript
export function registerHealthRoute(app: Hono, deps: HealthRouteDeps): void {
  app.get('/health', (c) =>
    c.json({ status: 'ok', schemaVersion: deps.schemaVersion }),
  );
}
```
`logs.ts` should export `registerLogsRoute(app: Hono, deps: LogsRouteDeps): void`, matching every existing route module's `register*Routes(app, deps)` shape (`control.ts`, `health.ts`).

**Deps-interface convention** (`packages/manager/src/api/routes/control.ts:90-97`):
```typescript
export interface ControlRoutesDeps {
  readonly db: Kysely<Database>;
  readonly controlState: ControlState;
  readonly supervisor?: WorkerSupervisor;
  readonly workerStopGraceMs?: number;
  readonly logger?: Logger;
}
```
`LogsRouteDeps` should similarly be an explicit readonly interface (e.g. `resolveLogPath: (stageId: string) => string`, per RESEARCH.md Pattern 3) rather than passing the whole app context.

**Security note from RESEARCH.md's Security Domain, load-bearing for this route:** resolve `:id` through the DB-backed `stage_attempts` lookup (mirroring `control.ts`'s `repo.findById(featureId)` → 404-if-undefined shape at lines 283-286) — never build a filesystem path directly from the untrusted `:id` param.

**404-on-not-found convention to copy** (`packages/manager/src/api/routes/control.ts:281-287`):
```typescript
app.post('/features/:id/pause', async (c) => {
  const featureId = c.req.param('id');
  const repo = featuresRepository(deps.db);
  const feature = await repo.findById(featureId);
  if (feature === undefined) {
    return c.json({ error: 'not found' }, 404);
  }
  ...
```

---

### `packages/manager/src/api/routes/dev-run.ts` (route, request-response → event-driven)

**Analog:** `packages/manager/src/api/routes/control.ts` — the `zValidator` + `strictObject` + deps-interface + `registerXRoutes` convention, in full:

```typescript
// packages/manager/src/api/routes/control.ts:43-63
export const PauseRequestSchema = z
  .strictObject({
    scope: ControlScopeSchema,
    repoId: z.string().min(1).optional(),
  })
  .meta({ id: 'PauseRequest' })
  .superRefine((value, ctx) => {
    if (value.scope === 'repo' && value.repoId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['repoId'], message: "repoId is required when scope is 'repo'" });
    }
  });
```
```typescript
// packages/manager/src/api/routes/control.ts:319-322 (validated route registration)
app.post(
  '/control/pause',
  zValidator('json', PauseRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    ...
```
`dev-run.ts` should define a `DevRunRequestSchema` (likely just the feature id from the path param, no body) and register `POST /v1/dev-run/:featureId` the same way, wiring into the real lease→fork→assign path Phase 3 built (per RESEARCH.md's architecture diagram) rather than calling anything in-process.

**Error-classification-in-the-handler convention** (`packages/manager/src/api/routes/control.ts:333-350`):
```typescript
try {
  const affected = await pauseScope(deps, body.scope, body.repoId);
  return c.json({ affected } satisfies ControlResult);
} catch (error) {
  if (error instanceof GlobalPausePersistError) {
    deps.logger?.error({ err: error }, 'POST /control/pause: global pause flag was not persisted');
    return c.json({ error: '...' }, 500);
  }
  throw error;
}
```
Copy this try/catch-with-named-error-type shape for the dev-run route's own failure modes (lease unavailable, spec load failure, preflight hard-block per D-02).

---

### `packages/cli/src/commands/dev-run.ts` (CLI command, request-response)

**Analog:** `packages/cli/src/commands/pause.ts` (full file — exact structural match: a CLI verb that takes an id/options, calls the `DaemonClient`, writes a one-line result to stdout):

```typescript
// packages/cli/src/commands/pause.ts (full pattern)
export interface PauseCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  readonly isInteractive?: () => boolean;
  readonly confirmInput?: NodeJS.ReadableStream;
  readonly confirmOutput?: NodeJS.WritableStream;
}

export async function pauseCommand(
  options: PauseCommandOptions,
  deps: PauseCommandDeps,
): Promise<void> {
  const resolved = resolveScope(options);
  const out = deps.stdout ?? process.stdout;
  ...
  const result: ControlResult = await deps.client.postFeatureControl(...);
  out.write(`Paused: ${result.affected.join(', ') || '(none)'}\n`);
}
```
`dev-run.ts` follows the same `(options, deps: { client: DaemonClient; stdout?: WriteSink }) => Promise<void>` shape. Deps injection (`client` rather than importing `daemonClient()` directly) is what makes this and every other command file testable without a real daemon — keep it.

**Client-wrapper convention to extend** (`packages/cli/src/http-client.ts:61-79, 111-144`):
```typescript
export interface DaemonClient {
  getFeatures(): Promise<readonly unknown[]>;
  postFeatureControl(featureId: string, verb: 'pause' | 'resume' | 'kill'): Promise<ControlResult>;
  ...
}
function postJson<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'POST', ...(body !== undefined ? { headers: {...}, body: JSON.stringify(body) } : {}) });
}
```
Add `postDevRun(featureId: string): Promise<DevRunResult>` to `DaemonClient` using the same `postJson<T>(path, body?)` helper — never a second `fetch` call site in `@adl/cli` (D-18/D-21: CLI speaks HTTP only, through this one client).

---

### `packages/cli/src/commands/logs.ts` (CLI command, streaming)

**Analog:** `packages/cli/src/commands/pause.ts` (command/deps shape) + `packages/cli/src/http-client.ts` (`daemonClient`'s `Authorization: Bearer` header wrapper, lines 86-101) — no existing SSE-consuming command exists in the repo, so this is a role-match, not exact. Use `eventsource-parser@4.0.0` (named in both CLAUDE.md and RESEARCH.md's Standard Stack) against `fetch(..., { headers: { Authorization: \`Bearer ${token}\` } })` — the same bearer-header convention `daemonClient`'s `rawRequest` already establishes — rather than a second auth mechanism.

**Unreachable-daemon convention to reuse** (`packages/cli/src/http-client.ts:16-26`):
```typescript
export class DaemonUnreachableError extends Error {
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number) {
    super(daemonDownMessage(host, port));
    this.name = 'DaemonUnreachableError';
    this.host = host;
    this.port = port;
  }
}
```
The `adl logs -f` fetch/reconnect loop should surface the same `DaemonUnreachableError` on a connection failure rather than inventing a second "daemon down" message.

---

### `packages/workspace/src/worktree/backend.ts` (edit — D-2-08-1 fix)

**Analog:** itself — the existing `worktreeWorkspace()` call sequence already creates `scratchHome` and calls `applyWorkerAccess()` on a fixed path list:

```typescript
// packages/workspace/src/worktree/backend.ts (worktreeWorkspace, cited region)
const scratchHome = await createScratchHome();
...
const adminDir = await worktreeAdminDir(worktreePath);
reportWorkerAccess(
  await applyWorkerAccess(
    [scratchHome.path, worktreePath, ...(adminDir === undefined ? [] : [adminDir])],
    { mode: privilege.mode, group: worker.group },
  ),
);
```
Per RESEARCH.md's Pitfall 3, the fix is to `writeFile` a `[safe]\n\tdirectory = <worktreePath>\n` stanza into `<scratchHome.path>/.gitconfig` (the file `packages/workspace/src/exec/env.ts`'s `GIT_CONFIG_GLOBAL` already points at) at this same point in `worktreeWorkspace()`, immediately after `createScratchHome()` returns and before any agent exec occurs — copy `scratch-home.ts`'s `writeFile(..., { encoding: 'utf8', mode: 0o600 })` convention (see `recordOwner`, lines 232-244) for the write itself. This must NOT be threaded through `ExecSpec.env` — `env.ts`'s `namesGitExecution()` explicitly blocks `GIT_CONFIG_*` there by design.

## Shared Patterns

### Route registration: `register*Routes(app: Hono, deps: XDeps): void`
**Source:** `packages/manager/src/api/routes/health.ts`, `packages/manager/src/api/routes/control.ts`
**Apply to:** `logs.ts`, `dev-run.ts`
Every route module exports a single `register*Routes` function taking `(app, deps)`, with `deps` as an explicit readonly interface (not the whole app-wide context object). `zValidator('json'|'query', Schema)` is applied per-route, never via `app.use()`, so validated types infer correctly at the handler (03-RESEARCH.md § "Code Examples", already cited in `control.ts`'s own docblock).

### Zod as source of truth, types via `z.infer`
**Source:** `packages/manager/src/api/routes/control.ts` (`PauseRequestSchema`, `.meta({ id: '...' })`)
**Apply to:** `AgentTask`/`AgentEvent`/`AgentCapabilities` in `@adl/agent-claude-code`, `DevRunRequestSchema`, any new API request/response schema
Every schema gets a stable `.meta({ id: '...' })` name (feeds the published JSON Schema contract) and its TS type is `z.infer<typeof Schema>`, never hand-written alongside the schema.

### Classify-don't-throw for expected-but-notable outcomes
**Source:** `packages/core/src/stage/stage-error.ts` (`StageError`, `stageErrorPolicy`), `packages/workspace/src/exec/scratch-home.ts` (`ScratchHomeTeardown`)
**Apply to:** `preflight.ts` (version mismatch), `events.ts` (malformed NDJSON line), `ndjson-log-store.ts` (file-not-yet-created at offset 0)
A discriminated-union return value, not a thrown exception, for any outcome that is "notable but expected" — reserve thrown errors for genuinely unexpected/programmer-error conditions.

### The one process-launch rule (WORK-02)
**Source:** `packages/workspace/src/exec/run.ts` (module docblock)
**Apply to:** `packages/agent-claude-code/src/backend.ts` — the only place in the new package allowed to reach a subprocess is through `workspace.exec(spec, log)`. `eslint.config.js`'s `adl/no-direct-spawn` rule's exemption list is `packages/workspace/**` only — verify (per RESEARCH.md Pitfall 5) that adding `@adl/agent-claude-code` does not require widening that exemption; it must not.

### CLI speaks HTTP only, via `DaemonClient`
**Source:** `packages/cli/src/http-client.ts`, `packages/cli/src/commands/pause.ts`
**Apply to:** `dev-run.ts`, `logs.ts` (CLI commands)
`@adl/cli` never imports `@adl/db` or `@adl/manager` internals (D-18/D-21) — pnpm's strict `node_modules` makes this a resolve-time failure, not just a convention. Every new CLI verb adds one method to `DaemonClient` and calls it from a `*Command(options, deps)` function that takes the client as an injected dependency.

### Worker-entry may not import `@adl/db`
**Source:** `packages/manager/src/worker-entry/index.ts` (module docblock, `adl/worker-entry-no-db` lint rule)
**Apply to:** the real `productionStageRunner()`, the usage-recording half of Pattern 4 in RESEARCH.md
The worker reports `usage`/`result` events over the existing `process.send` IPC channel (extend `WorkerToManagerMessage` in `packages/manager/src/ipc/protocol.js` if a new message variant is needed); the manager is the one process that calls `usageRepository(db).record(event)` (`packages/db/src/repository/usage.ts:55-57`).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/manager/src/prompt/templates/developer.md` | config (template) | — | No existing template-file convention anywhere in the repo; RESEARCH.md's Open Question 1 recommends this shape from first principles (diffable, PR-reviewable), not from an existing analog. Planner should treat this as new-pattern territory, following only the general "files are the most reviewable option" rationale already stated in RESEARCH.md. |
| `packages/cli/src/commands/logs.ts` | CLI command | streaming (SSE) | No existing CLI command consumes a stream — every current command (`pause`, `resume`, `kill`, `status`, `gc`, `daemon`) is a single request/response. Use RESEARCH.md's Pattern 3 code example (server side) plus `eventsource-parser`'s own documented client usage as the shape; the `pause.ts` command/deps convention still applies to argument parsing and dependency injection, just not to the streaming body. |

## Metadata

**Analog search scope:** `packages/core/src/stage/`, `packages/workspace/src/exec/`, `packages/workspace/src/worktree/`, `packages/manager/src/api/routes/`, `packages/manager/src/worker-entry/`, `packages/db/src/repository/`, `packages/cli/src/commands/`, `packages/cli/src/http-client.ts`
**Files scanned:** ~14 (targeted reads, no re-reads of overlapping ranges)
**Pattern extraction date:** 2026-08-20
