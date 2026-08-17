---
phase: 01-core-contracts
reviewed: 2026-08-17T18:40:00Z
depth: standard
files_reviewed: 120
files_reviewed_list:
  - .github/workflows/ci.yml
  - .gitignore
  - .npmrc
  - .prettierignore
  - .prettierrc.json
  - eslint.config.js
  - package.json
  - packages/core/package.json
  - packages/core/README.md
  - packages/core/schema/README.md
  - packages/core/schema/verdict.schema.json
  - packages/core/scripts/emit-json-schema.ts
  - packages/core/src/config/adl-yml.ts
  - packages/core/src/config/context-cascade.ts
  - packages/core/src/config/duration.ts
  - packages/core/src/config/effective-config.ts
  - packages/core/src/config/index.ts
  - packages/core/src/config/interpolate.ts
  - packages/core/src/config/path-guard.ts
  - packages/core/src/config/pipeline.ts
  - packages/core/src/config/yaml-parse.ts
  - packages/core/src/errors.ts
  - packages/core/src/hash.ts
  - packages/core/src/spec/criterion-ids.ts
  - packages/core/src/spec/detect-format.ts
  - packages/core/src/spec/gherkin.ts
  - packages/core/src/spec/index.ts
  - packages/core/src/spec/markdown.ts
  - packages/core/src/spec/types.ts
  - packages/core/src/stage/developer-outcome.ts
  - packages/core/src/stage/index.ts
  - packages/core/src/stage/stage.ts
  - packages/core/src/stage/stage-error.ts
  - packages/core/src/state/feature-state.ts
  - packages/core/src/state/index.ts
  - packages/core/src/state/transition.ts
  - packages/core/src/verdict/aggregate.ts
  - packages/core/src/verdict/criterion-ref.ts
  - packages/core/src/verdict/finding.ts
  - packages/core/src/verdict/index.ts
  - packages/core/src/verdict/round-outcome.ts
  - packages/core/src/verdict/verdict.ts
  - packages/core/src/verdict/waiver.ts
  - packages/core/test/config/adl-yml.test.ts
  - packages/core/test/config/context-cascade.test.ts
  - packages/core/test/config/duration.test.ts
  - packages/core/test/config/effective-config.test.ts
  - packages/core/test/config/interpolate.test.ts
  - packages/core/test/config/path-guard.test.ts
  - packages/core/test/config/pipeline.test.ts
  - packages/core/test/config/yaml-security.test.ts
  - packages/core/test/fixtures/adl-yml/invalid-missing-ready-timeout.yml
  - packages/core/test/fixtures/adl-yml/invalid-shell-string.yml
  - packages/core/test/fixtures/adl-yml/invalid-unknown-key.yml
  - packages/core/test/fixtures/adl-yml/valid-exec-ready.yml
  - packages/core/test/fixtures/adl-yml/valid-http-ready.yml
  - packages/core/test/fixtures/adl-yml/valid-log-ready.yml
  - packages/core/test/fixtures/adl-yml/valid-tcp-ready.yml
  - packages/core/test/fixtures/spec/bad/README.md
  - packages/core/test/fixtures/spec/good/checkout.feature
  - packages/core/test/fixtures/spec/good/outline.feature
  - packages/core/test/fixtures/spec/good/rules.feature
  - packages/core/test/fixtures/spec/good/spec.md
  - packages/core/test/fixtures/verdicts/invalid/README.md
  - packages/core/test/fixtures/verdicts/valid/README.md
  - packages/core/test/spec/criterion-ids.test.ts
  - packages/core/test/spec/detect-format.test.ts
  - packages/core/test/spec/gherkin.test.ts
  - packages/core/test/spec/markdown.test.ts
  - packages/core/test/spine.e2e.test.ts
  - packages/core/test/stage/developer-outcome.test.ts
  - packages/core/test/stage/stage-error.test.ts
  - packages/core/test/stage/type-boundary.test-d.ts
  - packages/core/test/state/exec-07.test.ts
  - packages/core/test/state/transition.test.ts
  - packages/core/test/verdict/aggregate.exhaustive.test.ts
  - packages/core/test/verdict/finding.test.ts
  - packages/core/test/verdict/json-schema-equivalence.test.ts
  - packages/core/test/verdict/schema.test.ts
  - packages/core/tsconfig.json
  - packages/core/tsconfig.test.json
  - packages/core/vitest.config.ts
  - packages/db/migrations/0001_initial.ts
  - packages/db/migrations/0002_contracts.ts
  - packages/db/migrations/0003_seed_model_prices.ts
  - packages/db/migrations/0004_feature_state_constraint.ts
  - packages/db/package.json
  - packages/db/src/checksum.ts
  - packages/db/src/index.ts
  - packages/db/src/migrator.ts
  - packages/db/src/pricing.ts
  - packages/db/src/repository/features.ts
  - packages/db/src/repository/index.ts
  - packages/db/src/repository/usage.ts
  - packages/db/src/repository/verdicts.ts
  - packages/db/src/schema.ts
  - packages/db/test/checksum-guard.test.ts
  - packages/db/test/helpers/temp-db.ts
  - packages/db/test/migrate.smoke.test.ts
  - packages/db/test/migrate.test.ts
  - packages/db/test/model-prices.test.ts
  - packages/db/test/schema-drift.test.ts
  - packages/db/test/spine.persist.test.ts
  - packages/db/tsconfig.json
  - packages/db/vitest.config.ts
  - packages/plugin-sdk/package.json
  - packages/plugin-sdk/README.md
  - packages/plugin-sdk/src/index.ts
  - packages/plugin-sdk/test/reexport-identity.test.ts
  - packages/plugin-sdk/tsconfig.json
  - packages/plugin-sdk/vitest.config.ts
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - test/lint/fixtures/core-env-read.ts
  - test/lint/fixtures/core-fs-import.ts
  - test/lint/fixtures/core-imports-db.ts
  - test/lint/fixtures/verdict-refine.ts
  - test/lint/no-restricted-imports.test.ts
  - test/toolchain.test.ts
  - tsconfig.base.json
findings:
  critical: 0
  warning: 4
  info: 1
  total: 5
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-08-17T18:40:00Z
**Depth:** standard
**Files Reviewed:** 120
**Status:** issues_found

## Summary

This phase builds a genuinely pure, well-tested contract layer: the `Verdict`
union, `StageError`/`DeveloperOutcome` channels, the spec loaders, the
`adl.yml` schema, `EffectiveConfig` merge, the lifecycle `transition()`
function, the architecture-enforcing ESLint rules, and the SQLite/Kysely
persistence + migration-checksum layer. I traced the specific areas the phase
context asked for close attention on:

- **Command-injection surface of `adl.yml`** — `CommandSpecSchema.argv` is a
  non-empty array of non-empty strings with no shell-string escape hatch
  anywhere in the schema; verified structurally and by test
  (`adl-yml.test.ts` "rejects a shell string in place of an argv array"). No
  issue found.
- **YAML parser hardening** — `yaml-parse.ts` pins `merge: false`,
  `uniqueKeys: true`, `schema: 'core'`, and enforces `maxAliasCount: 100` at
  `toJS()`. `yaml-security.test.ts` proves the alias bomb, the `!!js/function`
  tag, the merge key, and a `__proto__` payload are all neutralized by
  execution, not merely by claim. No issue found.
- **`EffectiveConfig` interpolation allowlist** — `interpolate()`'s allowlist
  is the caller-supplied `values` object's own key set (checked via
  `Object.prototype.hasOwnProperty.call`), the module never reads
  `process.env` (enforced by the `no-restricted-properties` ESLint rule with
  its own fixture and test), and an unrecognised name is always a thrown
  `LoadError`, verified against `PATH` and `ANTHROPIC_API_KEY` specifically.
  No issue found. (Note: `interpolate()` has no production call site yet
  within this phase — it is exported, tested, and documented as the contract
  a later phase substitutes against; that is consistent with the phase's
  stated scope, not a defect.)
- **Migration checksum guard** — traced `assertMigrationsUnmodified`,
  `wrapMigrationWithChecksum`, and `reentrantTransactionProxy` against
  `checksum-guard.test.ts`'s mutation, deletion, partial-failure, and
  new-migration-after-guard cases, and independently confirmed every one of
  the four real migrations wraps its own statements in exactly one
  `db.transaction()` call (a precondition the checksum proxy assumes silently
  — see W2 below for the one place this assumption is not type-enforced). The
  tamper-detection logic is sound: mutation, deletion of the evidence row, and
  partial mid-migration failure are all correctly refused or rolled back.

I also independently re-ran the two commands `deferred-items.md` reports as
producing known, deferred findings (`pnpm exec eslint .` and
`pnpm exec prettier --check .`) against the current tree. Both counts are
still exactly accurate: **15 ESLint errors, 0 warnings**, and **55 files**
Prettier reports as needing reformatting, matching the catalogue file byte for
byte. I did not re-report any of those 15/55 individually. I also ran the full
test suite (`pnpm -r test`): all 455 tests across the three packages pass, and
`pnpm -r typecheck` (implicitly, via the `pretest` hooks) is clean. The logic
itself is solid; the issues below are things the catalogue does not already
name, plus one nuanced answer to the `Kysely<any>` question the phase context
asked me to judge independently.

## Warnings

### WR-01: `FindingLocation.path` still lacks the repo-relative path guard, and a `findings` row is persisted with the intent to render it publicly

**File:** `packages/core/src/verdict/finding.ts:27-38`
**Issue:** `path-guard.ts` itself documents this exact gap under "Adoption
note": `FindingLocation.path` is `z.string().min(1)` rather than
`RepoRelativePathSchema`, even though the two fields "make the same promise
and only one of them currently keeps it." This phase is the one that shipped
the guard (plan 01-07) *and* the one that shipped the persistence layer that
stores this exact value with the stated intent to surface it in a PR: the
`findings` table's own migration comment says `path` is "workspace-relative
and nothing else... it is persisted and then rendered into a public
pull-request comment (T-1-36)." Every `Finding` a third-party gate returns
flows through `VerdictSchema`/`parseStageOutput` unchanged and is then
insertable via `verdictsRepository.recordVerdict` with no additional
normalisation. As written today, a gate (buggy or malicious) can set
`location.path` to `/etc/passwd`, `../../secrets.env`, or a UNC path, and it
validates successfully at every layer in this phase and would persist
verbatim. Phase 2/3 presumably will not literally open this path from
`@adl/core` (`@adl/core` performs no I/O), but the value is on a documented
trajectory toward being rendered in a public PR comment, and nothing between
here and there currently re-validates it.
**Fix:**
```ts
// packages/core/src/verdict/finding.ts
import { RepoRelativePathSchema } from '../config/path-guard.js';

export const FindingLocationSchema = z
  .strictObject({
    path: RepoRelativePathSchema,
    line: z.int().positive().optional(),
    endLine: z.int().positive().optional(),
  })
  .meta({ id: 'FindingLocation', description: 'A workspace-relative path and optional line range' });
```
Note this does cross a package-internal boundary (`verdict/` importing from
`config/`) that does not currently exist elsewhere in `@adl/core`; confirm
that import is acceptable to the architecture before making the change, or
inline an equivalent regex constraint directly in `finding.ts` if `verdict/`
is meant to stay decoupled from `config/`.

### WR-02: `Kysely<any>` in `checksum.ts` is only partially forced — half the occurrences could be generic

**File:** `packages/db/src/checksum.ts:27,48,94,118,194,201,206,207,218`
**Issue:** The phase context asked for an independent judgment on whether the
ten `no-explicit-any` lint errors here are justified. I checked
`kysely@0.29.5`'s own shipped type declarations
(`node_modules/kysely/dist/migration/migrator.d.ts`):
```ts
export interface Migration {
    up(db: Kysely<any>): Promise<void>;
    down?(db: Kysely<any>): Promise<void>;
}
```
Kysely's own `Migration` interface is declared with `Kysely<any>`, not a
generic. That makes the `any` in `wrapMigrationWithChecksum`'s `up: async
(db: Kysely<any>) => {...}` (line 194) and in `reentrantTransactionProxy`'s
signature/cast (lines 201, 206, 207, 218) — which exists specifically to
produce an object satisfying that third-party interface — genuinely forced:
there is no way to implement `Migration.up` with a narrower parameter type
without violating the interface Kysely itself declares.

The other four occurrences are **not** so constrained. `ensureChecksumTable`
(line 27), `recordMigrationChecksum` (line 48),
`migrationsBookkeepingTableExists` (line 94), and `assertMigrationsUnmodified`
(line 118) are ADL's own functions — none of them implements a third-party
interface, and every call site (`migrator.ts`) passes a concrete
`Kysely<Database>`. These four could be written generically with no loss of
functionality and a real type-safety gain (an `any` parameter silently
disables checking of the *entire* function body, not just the parameter
itself — a stray typo'd property access elsewhere in these functions would
not be caught today).
**Fix:**
```ts
export async function ensureChecksumTable<DB>(db: Kysely<DB>): Promise<void> { ... }
export async function recordMigrationChecksum<DB>(trx: Kysely<DB>, name: string, digest: string): Promise<void> { ... }
async function migrationsBookkeepingTableExists<DB>(db: Kysely<DB>): Promise<boolean> { ... }
export async function assertMigrationsUnmodified<DB>(db: Kysely<DB>, migrationsDir: string): Promise<void> { ... }
```
This closes 4 of the 10 already-catalogued lint errors with a genuine
improvement (not a suppression), and leaves exactly the 6 occurrences that
are structurally forced by Kysely's own `Migration` type as documented
`any` usage.

### WR-03: `limits` defaults are duplicated in two independently-maintained places and can silently diverge

**File:** `packages/core/src/config/adl-yml.ts:456-486` (each `LimitsSchema`
field's `.default(...)`) and
`packages/core/src/config/effective-config.ts:67-72` (`DEFAULT_CONFIG.limits`)
**Issue:** `LimitsSchema`'s three fields each carry their own
`z...default(6)` / `.default(15)` / `.default(2)`, and
`DEFAULT_CONFIG.limits` restates the same three numbers as a second literal.
I verified with a standalone script that these two sources of truth are
consulted under *different conditions*, not consistently:

- When a `DaemonConfig`'s `limits` key is **entirely absent** from the raw
  input, `LimitsSchema.partial().default({})` short-circuits and yields the
  literal `{}` — Zod does not run the inner partial schema's own field
  defaults in this case. `mergeConfig`'s `daemon.limits.max_rounds ??
  defaults.limits.max_rounds` then genuinely falls through to
  `DEFAULT_CONFIG.limits`.
- When a `DaemonConfig`'s `limits` key is **present but partial** (e.g.
  `{ max_rounds: 4 }`), the inner `LimitsSchema.partial()` schema *does* run
  and *does* apply its own per-field defaults to the omitted fields — so
  `daemon.limits.budget_usd` is already `15` (from `LimitsSchema`'s own
  default) by the time `mergeConfig` reads it, and the `?? defaults.limits...`
  fallback is dead code for that call.

Today both sources agree (6/15/2 in both places), so this is invisible.
The moment one is edited without the other — e.g. a future change lowers
`DEFAULT_CONFIG.limits.budget_usd` to reflect a new documented default but
someone forgets `LimitsSchema`'s `.default(15)` — a daemon config that
specifies *any* `limits` field gets a different budget default than one that
specifies *none*, for logically identical "I didn't configure this" intent.
No existing test would catch this divergence, since every test fixture keeps
the two literals in sync.
**Fix:** Derive one from the other so there is exactly one literal per
default:
```ts
// effective-config.ts
export const DEFAULT_CONFIG = Object.freeze({
  limits: LimitsSchema.parse({}) satisfies Limits,
  agents: { developer: DEFAULT_AGENT_BLOCK, reviewer: DEFAULT_AGENT_BLOCK, tester: DEFAULT_AGENT_BLOCK },
});
```

### WR-04: CI's `lint` and `format` steps are currently failing on the merged tree, and nothing mitigates the aggregate effect

**File:** `.github/workflows/ci.yml:70-74` (the `Lint` and `Format` steps)
**Issue:** `deferred-items.md` catalogues the 15 ESLint errors and 55
Prettier-noncompliant files individually and explains, correctly, why each
one is out of scope for the plan that would otherwise fix it. I independently
re-ran both commands and both counts are accurate. What is not addressed
anywhere is the *aggregate* consequence: `ci.yml`'s `Lint` step runs
`pnpm lint` (bare `eslint .`, exit code 1 on any error) and the `Format` step
runs `pnpm format` (bare `prettier --check .`, exit code 1 on any diff),
neither with `continue-on-error`. Both will fail on every push and every PR
against `main` as the tree stands today. This means the CI badge on this
repository is red right now, and every subsequent PR — including one that
touches none of the 55/15 offending files — will show a red CI run for
reasons unrelated to its own diff, which defeats CI's purpose as a
change-scoped signal. This is exactly the "decorative rule" failure mode
`eslint.config.js`'s own header warns against, just at the pipeline level
rather than the rule level.
**Fix:** Before merging this phase (or as the very next follow-up commit),
either (a) run `pnpm exec prettier --write` scoped to each plan's own files
as `deferred-items.md` § "Action for whoever next touches these files"
already prescribes, and fix or waive the 15 lint errors (4 of which W2 above
gives a concrete fix for), or (b) if landing the fix is genuinely out of
scope for this phase, add an explicit, temporary `continue-on-error: true` to
the `Lint` and `Format` steps with a comment linking to
`deferred-items.md` and a tracking item to remove it, so CI's red state is a
deliberate, visible decision rather than an unflagged side effect.

## Info

### IN-01: `@types/better-sqlite3` is pinned three majors behind the `better-sqlite3` runtime it types

**File:** `packages/db/package.json:23,29`
**Issue:** `better-sqlite3` is pinned at `13.0.3` (dependencies) but
`@types/better-sqlite3` is pinned at `9.6.0` (devDependencies) — a
significant version gap between the runtime API surface and the type
declarations checked against it. `pnpm -r typecheck` currently passes clean,
so this is not causing an active problem, but a three-major-version-old
`@types` package increases the risk that a newer `better-sqlite3` API
(constructor options, new methods) either silently typechecks as `any`/is
missing entirely, or that a removed API still typechecks as present.
**Fix:** Check whether a `@types/better-sqlite3` release compatible with
`better-sqlite3@13` exists and bump to it; if none does (some packages have
moved their types inline), confirm that and drop the separate `@types`
package instead of carrying a stale one.

---

_Reviewed: 2026-08-17T18:40:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
