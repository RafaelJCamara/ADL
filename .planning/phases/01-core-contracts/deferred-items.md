# Deferred Items — Phase 01 Core Contracts

**Status: resolved.** Originally an out-of-scope catalogue from plan 01-08's
authoritative whole-workspace `pnpm exec eslint .` and `pnpm exec prettier
--check .` runs — the first point in the phase where either could run
against the fully merged tree (`eslint.config.js` / `.prettierrc.json`, both
01-03, did not exist when Wave 3 plans authored these files). Correctly kept
out of 01-08's own scope at the time (its dispatch instruction was "do not
fix those; just report them for the phase verifier").

The 01-REVIEW.md code review (WR-04) flagged the *aggregate* consequence:
CI's `Lint` and `Format` steps have no `continue-on-error`, so both would
fail on every push regardless of diff. Resolved as part of closing the phase:

- **15 ESLint errors** — 4 of the 10 `Kysely<any>` occurrences in
  `packages/db/src/checksum.ts` were genuinely avoidable (ADL's own
  functions, always called with a concrete `Kysely<Database>`) and made
  generic over `DB` (see 01-REVIEW.md WR-02); the other 6 are structurally
  forced by Kysely's own `Migration.up(db: Kysely<any>)` interface and now
  carry a scoped, documented `eslint-disable`/`eslint-enable` block instead
  of silently failing lint. The 5 `no-unused-vars` errors were all the
  `const { x: _dropped, ...rest } = obj` destructure-to-omit pattern;
  `eslint.config.js` now sets `ignoreRestSiblings: true` on
  `@typescript-eslint/no-unused-vars` repo-wide, which is typescript-eslint's
  own documented option for exactly this idiom.
- **55 Prettier-dirty files** — reformatted in one dedicated, format-only
  commit (never mixed with a logic change, so `git blame` on any of these
  files still points to the plan that actually wrote the code).

`pnpm lint`, `pnpm format`, `pnpm -r typecheck`, `pnpm -r build`,
`pnpm -r test`, and `pnpm vitest run --project root` are all green on the
merged tree as of this resolution. The original catalogue is preserved below
for the historical record.

## Original catalogue (as of plan 01-08, now resolved)

## `pnpm lint` (`eslint .`) — 15 errors, 0 warnings, all outside 01-08's scope

### `packages/core/test/stage/developer-outcome.test.ts` (owned by 01-05)

- `100:27`, `105:21`, `127:23` — `'_dropped' is assigned a value but never used` (`@typescript-eslint/no-unused-vars`)
- `135:27` — `'_a' is assigned a value but never used` (`@typescript-eslint/no-unused-vars`)

### `packages/core/test/verdict/finding.test.ts` (owned by 01-02)

- `26:27` — `'_drop' is assigned a value but never used` (`@typescript-eslint/no-unused-vars`)

### `packages/db/src/checksum.ts` (owned by 01-10)

- `27:54`, `48:15`, `94:60`, `118:14`, `194:27`, `201:47`, `201:91`, `206:50`, `207:64`, `218:16`
  — `Unexpected any. Specify a different type` (`@typescript-eslint/no-explicit-any`)

All ten are on `Kysely<any>` parameter/return types in the migration
checksum-guard machinery — plausibly deliberate (this module operates
across arbitrary migration transactions and does not know the concrete
`Database` shape at that layer), but never confirmed against the rule
since it postdates this file.

## `pnpm format` (`prettier --check .`) — 55 files outside 01-08's scope, all pre-existing width/wrap drift

Every file below was written before `.prettierrc.json` (`printWidth: 80`)
existed and has never been run through Prettier. None are in 01-08's
`files_modified`; reformatting them here would touch content across five
other plans' commits for a formatting-only reason, which is explicitly out
of scope per the SCOPE BOUNDARY deviation rule.

By owning plan:

- **01-01/01-02:** `packages/core/README.md`, `packages/core/src/spec/{detect-format,gherkin,index,markdown}.ts`, `packages/core/src/verdict/{aggregate,round-outcome}.ts`, `packages/core/test/spec/*.test.ts`, `packages/core/test/spine.e2e.test.ts`, `packages/core/test/verdict/*.test.ts`, `packages/core/test/fixtures/spec/bad/README.md`
- **01-04:** (schema emission — verdict test files above overlap; no unique files beyond those listed)
- **01-05:** `packages/core/src/stage/{developer-outcome,stage-error}.ts`, `packages/core/test/stage/*.test.ts`, `packages/plugin-sdk/package.json`, `packages/plugin-sdk/README.md`, `packages/plugin-sdk/test/reexport-identity.test.ts`
- **01-07:** `packages/core/scripts/emit-json-schema.ts`, `packages/core/src/config/{duration,yaml-parse}.ts`, `packages/core/test/config/{adl-yml,duration,path-guard,yaml-security}.test.ts`, `packages/core/test/fixtures/adl-yml/*.yml`
- **01-09:** `packages/core/src/state/{feature-state,transition}.ts`, `packages/core/test/state/transition.test.ts`
- **01-10:** `packages/db/package.json`, `packages/db/src/{checksum,migrator,pricing,schema}.ts`, `packages/db/src/repository/{features,usage,verdicts}.ts`, `packages/db/test/{checksum-guard,migrate.smoke,model-prices,schema-drift,spine.persist}.test.ts`, `packages/db/test/helpers/temp-db.ts`, `packages/db/migrations/0002_contracts.ts`

**Action for whoever next touches these files, or for `/gsd-verify-work`:**
run `pnpm exec prettier --write` scoped to each plan's own files (never a
blanket `prettier --write .`, which would attribute unrelated formatting
diffs to whichever commit runs it), and resolve or explicitly waive the
15 ESLint findings above.

## Verified out of 01-08's scope

None of the files above are in 01-08's `files_modified`. Fixing them here
would violate the SCOPE BOUNDARY rule (only auto-fix issues directly caused
by the current task's changes) and risk masking whether 01-02/01-05/01-07/
01-09/01-10 intended these patterns.
