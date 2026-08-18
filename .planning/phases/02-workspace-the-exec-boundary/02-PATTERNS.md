# Phase 2: Workspace & the Exec Boundary - Pattern Map

**Mapped:** 2026-08-18
**Files analyzed:** 22 new/modified files
**Analogs found:** 18 / 22

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/workspace/package.json` | config | n/a | `packages/db/package.json` | exact |
| `packages/workspace/tsconfig.json` | config | n/a | `packages/db/tsconfig.json` | exact |
| `packages/workspace/vitest.config.ts` | config | n/a | `packages/db/vitest.config.ts` | exact |
| `packages/core/src/stage/workspace.ts` (NEW) | model (pure types) | transform | `packages/core/src/stage/stage.ts` | exact |
| `packages/core/src/stage/stage.ts` (MODIFIED) | model | transform | itself (forward-decl block, lines 50-98) | exact |
| `packages/core/src/stage/index.ts` (MODIFIED) | barrel | n/a | `packages/core/src/stage/index.ts` lines 55-69 | exact |
| `packages/plugin-sdk/src/index.ts` (MODIFIED) | barrel/re-export | n/a | itself, lines 71-101 | exact |
| `packages/workspace/src/index.ts` | barrel | n/a | `packages/db/src/index.ts` + core barrels | exact |
| `packages/workspace/src/registry.ts` | provider/registry | request-response | `packages/db/src/repository/features.ts` (factory-returning-interface) | role-match |
| `packages/workspace/src/exec/run.ts` | service | streaming | **none** — first process-launch site in repo | no analog |
| `packages/workspace/src/exec/env.ts` | utility | transform | `packages/core/src/config/interpolate.ts` (allowlist-over-env philosophy) | partial |
| `packages/workspace/src/exec/privilege.ts` | utility | transform | **none** — no OS-gating code exists yet | no analog |
| `packages/workspace/src/worktree/backend.ts` | service (backend impl) | CRUD | `packages/db/src/repository/features.ts` | role-match |
| `packages/workspace/src/worktree/lifecycle.ts` | service | CRUD | `packages/db/src/migrator.ts` (ordered, idempotent steps) | partial |
| `packages/workspace/src/worktree/list.ts` | utility (parser) | transform | `packages/core/src/spec/markdown.ts` / `detect-format.ts` | role-match |
| `packages/workspace/src/worktree/gc.ts` (mechanism) | service | batch | `packages/db/src/repository/features.ts` (`listByState`) | partial |
| `packages/workspace/src/stub/backend.ts` | service (backend impl) | CRUD | `packages/workspace/src/worktree/backend.ts` (sibling) | exact (intra-phase) |
| `packages/workspace/src/paths.ts` | utility (guard) | transform | `packages/core/src/config/path-guard.ts` | exact |
| `packages/workspace/test/helpers/temp-repo.ts` | test helper | file-I/O | `packages/db/test/helpers/temp-db.ts` | exact |
| `packages/workspace/test/**/*.test.ts` | test | n/a | `packages/db/test/migrate.test.ts`, `packages/core/test/config/path-guard.test.ts` | role-match |
| `eslint.config.js` (MODIFIED) | config | n/a | itself, lines 44-126 + 179-200 | exact |
| `test/lint/fixtures/spawn-*.ts` (3 NEW) | test fixture | n/a | `test/lint/fixtures/core-fs-import.ts` | exact |
| `test/lint/no-restricted-imports.test.ts` (MODIFIED) | test | n/a | itself, `FIXTURES` array lines 43-64 | exact |

---

## Pattern Assignments

### `packages/core/src/stage/workspace.ts` (NEW — pure types, model)

**Analog:** `packages/core/src/stage/stage.ts`

**Module docblock pattern** (stage.ts lines 1-19) — every core module opens with a docblock that names the ARCHITECTURE.md section, the decision ids, and *what differs from the sketch and why*. Copy this shape; name D-01/D-02/D-03 and the ROADMAP Notes on `networkPolicy`.

**Type-with-rationale-comment pattern** (stage.ts lines 33-48):
```typescript
/**
 * Roughly what running this stage costs.
 *
 * The distinction is about *cost and failure modes*, not capability — ...
 */
export type CostClass = 'free' | 'cheap' | 'expensive';

/** One chunk of streamed output from a running stage. */
export interface LogChunk {
  readonly stream: 'stdout' | 'stderr' | 'agent';
  readonly text: string;
}
```
`LogChunk` is reused verbatim by D-01 — import the type, do not redeclare it.

**Readonly-everything interface pattern** (stage.ts lines 100-120) — `StageContext` marks every member `readonly` with a one-line `/** */` above it. `ExecSpec`, `ResourceLimits`, and `RestoreHandle` follow this exactly.

**Frozen-const-plus-derived-union pattern** (`packages/core/src/state/feature-state.ts` line 94):
```typescript
export const TERMINAL_STATES = Object.freeze(['merged', 'abandoned'] as const);
export type TerminalState = (typeof TERMINAL_STATES)[number];
```
Use this for `NETWORK_POLICIES` / `NetworkPolicy` if a runtime value is wanted. Pure data — permitted under core's purity ban (see `eslint.config.js` line 52-61; only `node:` imports are banned).

**Argv-shape precedent to mirror** (`packages/core/src/config/adl-yml.ts` lines 136-163) — `CommandSpecSchema` already carries `argv`/`cwd`/`env`/`timeout` and its docblock explicitly says the shape must stay compatible with Phase 2's `ExecSpec`:
```typescript
export const CommandSpecSchema = z.strictObject({
  argv: z.array(z.string().min(1)).min(1).describe(...),
  cwd: RepoRelativePathSchema.optional().describe(...),
  env: z.record(EnvVarNameSchema, z.string()).optional().describe(...),
  timeout: DurationSchema.optional().describe(...),
});
```

---

### `packages/core/src/stage/stage.ts` (MODIFIED — replace the `Workspace` forward declaration)

**Analog:** itself, lines 50-68.

**The block being replaced:**
```typescript
/** **Forward declaration.** Phase 2 supplies the real `WorkspaceBackend` — exec, read, write, snapshot. */
export interface Workspace {
  /** Structural placeholder only; never read. Phase 2 replaces this interface wholesale. */
  readonly __adlForwardDeclaration?: never;
}
```
Delete this interface, add `import type { ... } from './workspace.js'` (note the `.js` extension — nodenext), and re-export. The surrounding forward-declaration comment block (lines 50-62) stays; only the `Workspace` entry leaves it. `StageContext.workspace` (line 103) needs no edit if the name is preserved.

**Import style** (stage.ts lines 20-21): `import type { Finding } from '../verdict/finding.js';` — type-only imports, explicit `.js`.

---

### `packages/core/src/stage/index.ts` and `packages/plugin-sdk/src/index.ts` (MODIFIED)

**Analog:** `packages/plugin-sdk/src/index.ts` lines 71-101.

**Re-export pattern with grouping comments:**
```typescript
export {
  // The gate interface itself — what the built-in reviewer and behaviour tester
  // are also implemented against, with no special-casing (HARN-04).
  type Stage,
  type StageContext,
  type LogChunk,

  // `Workspace` is a forward declaration until Phase 2 lands the real interface.
  type Workspace,
  ...
} from '@adl/core/stage';
```
Line 94's comment ("forward declaration until Phase 2") is the exact line to rewrite. Add the new type names (`ExecSpec`, `ExecResult`, `RestoreHandle`, `NetworkPolicy`, `ResourceLimits`) to both this list and `packages/core/src/stage/index.ts`'s `export type { ... } from './stage.js'` block (lines 55-69).

**Constraint from `packages/plugin-sdk/test/reexport-identity.test.ts`:** the SDK defines nothing of its own and identity is asserted by reference. New types must be re-exports, never redeclarations.

---

### `packages/workspace/package.json` (NEW)

**Analog:** `packages/db/package.json`

```json
{
  "name": "@adl/db",
  "version": "0.0.0",
  "type": "module",
  "description": "ADL persistence — ... The only package that touches better-sqlite3.",
  "license": "MIT",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "files": ["dist", "migrations"],
  "exports": { ".": { "types": "./dist/src/index.d.ts", "default": "./dist/src/index.js" } },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "pretest": "tsc -b ../core",
    "test": "vitest run"
  },
  "dependencies": { "better-sqlite3": "13.0.3", "kysely": "0.29.5", "ulid": "3.0.2" },
  "devDependencies": {
    "@adl/core": "workspace:*",
    "@types/node": "22.20.1",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```
Copy the `description` convention verbatim in spirit — `@adl/db` names itself "the only package that touches better-sqlite3"; `@adl/workspace` should say "the only package that touches execa / node:child_process". Keep the `pretest: tsc -b ../core` hook (`@adl/core` must be built before the suite runs). Pin `execa` `10.0.1` and `simple-git` `3.36.0` exactly, as `@adl/db` pins its runtime deps; use `catalog:` for `typescript`/`vitest`/`zod`.

**Note:** `@adl/db` places `@adl/core` in `devDependencies` (types-only usage). If `packages/workspace` imports core types only, mirror that; a runtime import moves it to `dependencies`.

**`pnpm-workspace.yaml`:** no `allowBuilds` entry needed — research verified `execa` and `simple-git` have no postinstall. Do not touch the `catalog:` block.

---

### `packages/workspace/tsconfig.json` and `vitest.config.ts` (NEW)

**Analogs:** `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "migrations/**/*.ts"]
}
```
For workspace: `rootDir: "src"`, `include: ["src/**/*.ts"]` (there is no `migrations/` sibling to hoist), keep `types: ["node"]` — required, this package uses `node:fs`/`node:os`/`node:path`.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',            // -> 'workspace'
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```
Root `vitest.config.ts` needs **no edit** — its `projects: ['packages/*/vitest.config.ts']` glob auto-enrols the new package (that file's docblock says so explicitly: "Adding a package to the workspace enrols its tests automatically").

---

### `packages/workspace/src/registry.ts` (provider, request-response)

**Analog:** `packages/db/src/repository/features.ts`

**Interface-plus-factory-function pattern** (features.ts lines 23-51):
```typescript
export interface FeaturesRepository {
  insert(feature: NewFeature): Promise<void>;
  findById(id: string): Promise<FeaturesTable | undefined>;
  ...
}

export function featuresRepository(db: Kysely<Database>): FeaturesRepository {
  return {
    async insert(feature) { ... },
    findById(id) { ... },
  };
}
```
The registry follows this: a `WorkspaceRegistry` interface plus a `workspaceRegistry(config)` factory returning an object literal. Note the deliberate *narrow surface* rationale (features.ts lines 9-17) — "the surface that leaves this package is a handful of named functions rather than a `Kysely` instance handed to the manager". The registry must likewise hand out `Workspace` instances, not backend constructors (this is what makes success criterion 3's "registry is the only site naming either constructor" assertable).

---

### `packages/workspace/src/paths.ts` (utility, D-02 containment guard)

**Analog:** `packages/core/src/config/path-guard.ts`

**Reuse, don't reimplement:** `RepoRelativePathSchema` (lines 55-67) already rejects absolute paths, `..` segments, drive-letter/UNC prefixes and NUL bytes. Its own docblock (lines 29-31) says whether a path *exists* is "Phase 2's question" — this file answers that question and nothing else.

**Regex-with-annotated-rationale pattern** (path-guard.ts lines 35-56) — the guard's regex is preceded by a line-by-line breakdown of each assertion and a note on why it is linear (no catastrophic backtracking). Any new pattern here copies that commenting density.

**Pure-predicate export shape** (lines 76-78):
```typescript
export function isRepoRelativePath(value: string): boolean {
  return REPO_RELATIVE_PATH_PATTERN.test(value);
}
```

**Error type to throw on rejection:** `packages/core/src/errors.ts` lines 22-35 —
```typescript
export class LoadError extends Error {
  override readonly name = 'LoadError';
  readonly position: SourcePosition | undefined;
  constructor(message: string, position?: SourcePosition) {
    super(message);
    this.position = position;
    Object.setPrototypeOf(this, LoadError.prototype);
  }
}
```
Copy this class shape (named `override readonly name`, extra readonly context field, `Object.setPrototypeOf` with the comment) for a `WorkspaceError` / `ContainmentError`. `LoadError` itself is core-scoped and about author files — do not reuse it for workspace failures.

---

### `packages/workspace/src/worktree/list.ts` (utility, parser)

**Analog:** `packages/core/src/spec/markdown.ts` / `detect-format.ts` — the repo's existing "parse a foreign textual format into readonly typed records" files. Same conventions: exported `readonly` result interface, pure function, no I/O (the caller supplies the string), docblock naming the format's stability guarantee.

`parseWorktreeList(porcelainZ: string): readonly WorktreeEntry[]` takes the already-captured string so it is unit-testable without git — mirroring how core's loaders "take the file CONTENTS as a string instead" (the exact phrase in `eslint.config.js` line 45).

---

### `packages/workspace/src/exec/run.ts` (service, streaming) — NO ANALOG

First process-launch site in the repository. Use `02-RESEARCH.md` § Code Examples § "Zero-inherit exec with a per-call allowlist" as the source. Two conventions still apply from the codebase:

- **Comment-the-hazard style**: every non-obvious option gets an inline comment naming the decision id and the verified reason (see `packages/db/test/helpers/temp-db.ts` lines 43-45: *"Destroy before removing: on Windows an open handle makes the unlink fail, which would turn a passing test into a confusing teardown error."*).
- **`AbortSignal` already exists on the caller side**: `packages/core/src/stage/stage.ts` line 119 `readonly signal: AbortSignal;` — feed it straight into execa's `cancelSignal`.

---

### `packages/workspace/test/helpers/temp-repo.ts` (test helper, file-I/O)

**Analog:** `packages/db/test/helpers/temp-db.ts` — copy this file's structure almost line for line.

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDb {
  readonly db: Kysely<Database>;
  /** The database file's path, so a test can assert it is gone afterwards. */
  readonly filePath: string;
}

export async function withTempDb<T>(fn: (ctx: TempDb) => Promise<T>): Promise<T> {
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

Three things to carry over exactly: the `withX(fn)` callback shape (not `setup`/`teardown` pairs), teardown in `finally` with the stated rationale (*"a leaked file is invisible locally and accumulates on the machine running CI"*, lines 30-32), and the `adl-<scope>-` mkdtemp prefix convention (`adl-db-` → `adl-repo-`, `adl-home-`). The Windows-open-handle comment applies doubly here (Pitfall: `fs.rm` after a just-exited child).

Also mirror `MIGRATIONS_DIR` (lines 9-12) for locating a fixture child script:
```typescript
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
```
→ use the same `fileURLToPath(new URL(..., import.meta.url))` form for `env-dump-child.cjs`.

---

### `eslint.config.js` (MODIFIED — the spawn ban, WORK-02)

**Analog:** itself. This file is the pattern; extend it in place, do not add a parallel mechanism.

**Rule-table docblock** (lines 15-20) — the header table has an `Extended by` column that already names this phase: *"Phase 2's no-direct-spawn rule"*. Move that entry into the `Implements` column and add the new row.

**Both-specifier ban with a shared message** (lines 44-61):
```typescript
const PURITY_MESSAGE =
  'is not available inside @adl/core. Core is pure and I/O-free — ...';

const FORBIDDEN_CORE_BUILTINS = [
  'node:fs', 'fs', 'node:fs/promises', 'fs/promises',
  'node:child_process', 'child_process', 'node:process', 'process',
].map((name) => ({ name, message: `${name} ${PURITY_MESSAGE}` }));
```
Note the comment at lines 47-51 giving the reason both forms are listed — *"banning only one leaves the rule trivially bypassable by dropping four characters"*. The new `FORBIDDEN_SPAWN` const copies this `.map()` shape.

**One complete rule object per glob** (lines 77-100) — the docblock already states the hazard:
> `no-restricted-imports` carries both the builtin ban and the sibling-package ban in ONE entry, deliberately: ESLint allows a single configuration per rule per file, so registering them as two entries would mean the second silently replaced the first.

```typescript
const CORE_PURITY_RULES = {
  'no-restricted-imports': [
    'error',
    { paths: FORBIDDEN_CORE_BUILTINS, patterns: FORBIDDEN_CORE_SIBLINGS },
  ],
  'no-restricted-properties': ['error', { object: 'process', property: 'env', message: '...' }],
};
```
Per Pitfall 1, the spawn paths must be **appended into `FORBIDDEN_CORE_BUILTINS`** for the core glob, and a separate complete object defined for non-core globs. `execa` also belongs in the ban list.

**`no-restricted-syntax` selector array shape** (lines 110-126) — `VERDICT_SCHEMA_RULES` is the template for the `require()` / dynamic-`import()` selectors:
```typescript
const VERDICT_SCHEMA_RULES = {
  'no-restricted-syntax': [
    'error',
    { selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='refine']",
      message: 'refine() is banned under packages/core/src/verdict/. ...' },
    { selector: "...superRefine...", message: '...' },
  ],
};
```
Same Pitfall-1 caution: `packages/core/src/verdict/**` already carries a `no-restricted-syntax` object, so a spawn-syntax entry must not overlap that glob without merging into it.

**Paired real-source + fixture registration** (lines 179-200):
```typescript
export const architectureConfigs = [
  { name: 'adl/core-purity',          files: ['packages/core/src/**/*.ts'],     rules: CORE_PURITY_RULES },
  { name: 'adl/core-purity-fixtures', files: ['test/lint/fixtures/core-*.ts'],  rules: CORE_PURITY_RULES },
  { name: 'adl/verdict-schema',       files: ['packages/core/src/verdict/**/*.ts'], rules: VERDICT_SCHEMA_RULES },
  { name: 'adl/verdict-schema-fixtures', files: ['test/lint/fixtures/verdict-*.ts'], rules: VERDICT_SCHEMA_RULES },
];
```
The new entries follow the `adl/no-direct-spawn` + `adl/no-direct-spawn-fixtures` (`test/lint/fixtures/spawn-*.ts`) pairing, with an entry-level `ignores: ['packages/workspace/src/**/*.ts']` exemption. `ARCHITECTURE_RULE_IDS` (lines 38-42) already lists all three rule ids — no addition needed unless a fourth rule appears.

---

### `test/lint/fixtures/spawn-{direct-import,require,dynamic-import}.ts` (NEW)

**Analog:** `test/lint/fixtures/core-fs-import.ts` (whole file):
```typescript
// DELIBERATE VIOLATION FIXTURE — owned by plan 01-03.
// Trips: `no-restricted-imports` (the @adl/core purity ban on node:fs).
// Never compiled, never executed, never imported. It exists so the rule is
// watched failing rather than merely configured (01-RESEARCH.md § Pitfall 8).
import { readFileSync } from 'node:fs';

export function readSpec(specPath: string): string {
  return readFileSync(specPath, 'utf8');
}
```
Copy the four-line header verbatim in form (owning plan id, which rule it trips, the "never compiled" disclaimer, the research citation) and keep the file otherwise valid TypeScript — the negative-control test at `test/lint/no-restricted-imports.test.ts` lines 129-149 requires the fixture to report **zero** errors once architecture rules are removed. An unused import or a type error there breaks that control.

---

### `test/lint/no-restricted-imports.test.ts` (MODIFIED)

**Analog:** itself.

**Fixture-case table** (lines 34-64) — add three entries:
```typescript
interface FixtureCase {
  readonly file: string;    // repo-relative, so failures name something greppable
  readonly ruleId: string;
  readonly mentions: string; // substring the report must mention
}

const FIXTURES: readonly FixtureCase[] = [
  { file: 'test/lint/fixtures/core-fs-import.ts', ruleId: 'no-restricted-imports', mentions: 'node:fs' },
  ...
];
```

**Severity-and-content assertion** (lines 101-126) — reused unchanged; the loop covers new fixtures automatically.

**The Pitfall-1 regression guard must be a NEW test**, built from the existing `calculateConfigForFile` pattern (lines 152-172):
```typescript
const resolved = await realConfigLinter().calculateConfigForFile(
  path.join(REPO_ROOT, 'packages', 'core', 'src', 'verdict', 'verdict.ts'),
);
for (const ruleId of ARCHITECTURE_RULE_IDS) {
  const entry = resolved.rules?.[ruleId];
  expect(entry).toBeDefined();
  expect(Array.isArray(entry) ? entry[0] : entry).toBe(2);
}
```
Extend it to assert the *resolved options* still contain both `node:fs` and the `@adl/*` sibling group — the existing test only checks the rule is registered at error, not what it bans.

**Exhaustiveness invariant** (lines 192-204) asserts registered rule ids exactly equal exercised ones — this is why the three spawn fixtures are mandatory, not optional.

---

## Shared Patterns

### Docblock-carries-the-decision
**Source:** `packages/core/src/stage/stage.ts` lines 1-19, `packages/db/src/repository/features.ts` lines 9-17, `eslint.config.js` lines 3-35
**Apply to:** every new source file in this phase
Every module in this repo opens with a docblock that (a) names the requirement/decision id, (b) states what would go wrong without this design, and (c) names the phase that will extend it. Prose density is deliberately high. Example (features.ts lines 9-17):
```typescript
/**
 * The narrow set of feature operations Phases 1 through 5 need.
 *
 * "Narrow" is the point (D-28). Every query in this package is a query the
 * eventual `node:sqlite` or Postgres swap has to reimplement, so the surface
 * that leaves this package is a handful of named functions rather than a
 * `Kysely` instance handed to the manager.
 */
```

### Interface + factory function, never classes
**Source:** `packages/db/src/repository/features.ts` lines 23-51
**Apply to:** `registry.ts`, `worktree/backend.ts`, `stub/backend.ts`
The repo has no service classes. Exported `interface X` + `export function x(deps): X` returning an object literal. Dependencies arrive as function parameters (`db: Kysely<Database>`), which is what makes the GC mechanism/policy split (D-20) natural: `sweep(deps: GcDeps)`.

### Type-only imports with explicit `.js`
**Source:** `packages/core/src/stage/stage.ts` lines 20-21, `packages/db/src/repository/features.ts` lines 1-7
**Apply to:** all new `.ts` files
```typescript
import type { Finding } from '../verdict/finding.js';
import type { Database, FeaturesTable } from '../schema.js';
```
`"module": "nodenext"` — extensions are mandatory. CJS deps (`simple-git`) use default import: `import simpleGit from 'simple-git';`.

### Barrel re-export with grouping comments
**Source:** `packages/core/src/stage/index.ts` (full file), `packages/plugin-sdk/src/index.ts` lines 25-101
**Apply to:** `packages/workspace/src/index.ts`, both modified barrels
Named exports grouped by concept with a `//` comment per group explaining what the group is for. No `export *`.

### `withTempX` test fixtures, teardown in `finally`
**Source:** `packages/db/test/helpers/temp-db.ts` lines 33-48
**Apply to:** every integration test in `packages/workspace/test/`
Callback-scoped resource helpers, `mkdtemp(join(tmpdir(), 'adl-<scope>-'))`, cleanup in `finally` with `rm(dir, { recursive: true, force: true })`, and a comment naming the Windows open-handle hazard.

### Deliberate-violation fixture per lint rule
**Source:** `test/lint/fixtures/core-fs-import.ts`, enforced by `test/lint/no-restricted-imports.test.ts` lines 192-204
**Apply to:** every rule added in this phase
Non-negotiable — the exhaustiveness test fails a rule without a fixture.

### Frozen const array → derived union type
**Source:** `packages/core/src/state/feature-state.ts` lines 94-96
**Apply to:** `NETWORK_POLICIES`, any new closed vocabulary
```typescript
export const TERMINAL_STATES = Object.freeze(['merged', 'abandoned'] as const);
export type TerminalState = (typeof TERMINAL_STATES)[number];
```
GC consumes `TERMINAL_STATES` directly (`import { TERMINAL_STATES } from '@adl/core/state'`) — note the docblock at lines 86-92 explaining `escalated` is deliberately excluded, which GC must honour.

### Custom Error subclass shape
**Source:** `packages/core/src/errors.ts` lines 22-35
**Apply to:** any workspace-layer error type
`override readonly name`, readonly context field, `Object.setPrototypeOf(this, X.prototype)` with the transpilation comment.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/workspace/src/exec/run.ts` | service | streaming | First process launch in the repository; `execa` is not yet a dependency. Use `02-RESEARCH.md` § Code Examples. |
| `packages/workspace/src/exec/privilege.ts` | utility | transform | No OS-gating (`os.platform()`) or launcher-selection code exists. `02-RESEARCH.md` Pitfall 8 table is the source. |
| `packages/workspace/src/exec/env.ts` | utility | transform | No env-construction code exists (core is banned from `process`). Only the *philosophy* has an analog — `eslint.config.js` lines 91-99's closed-allowlist rationale for `process.env`. |
| Linux CI job (D-21) | config | n/a | ~~No `.github/workflows/` directory exists in the repo at all. Entirely new.~~ **CORRECTION (plan-checker, verified against the live repo):** `.github/workflows/ci.yml` **does** exist — one `jobs:` key, job `verify`, `ubuntu-latest`, Node 22/24 matrix. This row was wrong. The CI work is an **extension of the existing job**, not a new workflow, and it lands in plan `02-07` Task 3 (Wave 5, not Wave 0). `02-07` Task 3 reads the real file first and asserts exactly one `jobs:` key so a duplicate workflow fails the gate. |

---

## Metadata

**Analog search scope:** `packages/core/src/**`, `packages/db/src/**`, `packages/db/test/**`, `packages/plugin-sdk/**`, `test/lint/**`, root config files (`eslint.config.js`, `vitest.config.ts`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`)
**Files scanned:** 84 TypeScript sources enumerated; 14 read in full
**Pattern extraction date:** 2026-08-18
