---
phase: 01-core-contracts
plan: 07
subsystem: config
tags: [adl-yml, zod, yaml, security, config-schema, config-format]

# Dependency graph
requires:
  - "01-02 (workspace, LoadError, yaml@2.9.0 installed, ./config subpath declared)"
provides:
  - "parseYamlDocument — the single pinned YAML entry point (packages/core/src/config/yaml-parse.ts)"
  - "DurationSchema, parseDuration, MAX_DURATION_MS — bounded duration strings (packages/core/src/config/duration.ts)"
  - "RepoRelativePathSchema, isRepoRelativePath — the shared path-traversal guard (packages/core/src/config/path-guard.ts)"
  - "AdlYmlSchema, parseAdlYml, ReadyProbeSchema, CommandSpecSchema, ADL_YML_VERSION, and the full adl.yml configuration surface (packages/core/src/config/adl-yml.ts)"
affects: [01-08]

actuals:
  tokens: 18100
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Alias-count limit enforced at toJS() conversion, not at parseDocument() — verified by execution that the yaml library defers alias expansion to conversion time"
    - "Every duration/path constraint expressed as a regex pattern rather than .refine(), so it survives z.toJSONSchema() emission"
    - "Cross-field ready/ready_timeout rule uses .superRefine() deliberately, with a comment explaining why it is safe here and not under the verdict layer"
    - "parseAdlYml returns AdlYml | LoadError rather than throwing, so a caller validating many repo configs is not forced into try/catch per file"
    - ".describe() on every schema field doubles as the config reference — no separate markdown file to drift from the source"

key-files:
  created:
    - packages/core/src/config/yaml-parse.ts
    - packages/core/src/config/duration.ts
    - packages/core/src/config/path-guard.ts
    - packages/core/src/config/adl-yml.ts
    - packages/core/test/config/duration.test.ts
    - packages/core/test/config/path-guard.test.ts
    - packages/core/test/config/yaml-security.test.ts
    - packages/core/test/config/adl-yml.test.ts
    - packages/core/test/fixtures/adl-yml/valid-http-ready.yml
    - packages/core/test/fixtures/adl-yml/valid-tcp-ready.yml
    - packages/core/test/fixtures/adl-yml/valid-log-ready.yml
    - packages/core/test/fixtures/adl-yml/valid-exec-ready.yml
    - packages/core/test/fixtures/adl-yml/invalid-shell-string.yml
    - packages/core/test/fixtures/adl-yml/invalid-unknown-key.yml
    - packages/core/test/fixtures/adl-yml/invalid-missing-ready-timeout.yml
  modified:
    - packages/core/src/config/index.ts

key-decisions:
  - "The alias-bomb defence fires inside parseYamlDocument's toJS() call, not at parseDocument() — verified by execution that yaml@2.9.0 defers alias expansion to conversion, so both calls live inside one guarded try/catch."
  - "parseAdlYml returns AdlYml | LoadError rather than throwing, matching the plan's explicit instruction, distinct from loadAdlTemplateSpec's throw-based style in 01-02/01-06."
  - "Duration and path-guard regexes are exhaustively swept by test (every whole value either side of every unit boundary, collected into one assertion rather than ~90k individual expect() calls to stay inside the 5s test timeout)."
  - "limits/context defaults are spelled out explicitly at the .default() call site (not `.default({})`) because TypeScript's inferred input type for a nested strictObject with its own field-level defaults still requires every key at the object level — an inference gap in this Zod version, not a design choice."

requirements-completed: [SPEC-03, SPEC-04]

coverage:
  - id: D1
    description: "A maintainer declares build/start/test/teardown as argv arrays with bounded duration timeouts; a shell string is a validation error naming the offending command"
    requirement: "SPEC-03"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/adl-yml.test.ts — 'fails the shell-string fixture with an issue path naming the offending command' and CommandSpecSchema argv suite"
        status: pass
    human_judgment: false
  - id: D2
    description: "All four readiness probe kinds (http/tcp/log/exec) validate; an unknown kind fails; ready requires ready_timeout and vice versa"
    requirement: "SPEC-04"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/adl-yml.test.ts — ReadyProbeSchema and 'start command: ready / ready_timeout both-or-neither' suites"
        status: pass
    human_judgment: false
  - id: D3
    description: "An unrecognised key at any level of adl.yml is a loud, named validation error"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/adl-yml.test.ts — 'fails the unknown-key fixture naming the offending key'"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every numeric field is bounded; a value at the ceiling validates, one step above fails"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/duration.test.ts, path-guard.test.ts, adl-yml.test.ts (LimitsSchema, ContextConfigSchema, ReadyProbeSchema ceilings)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The YAML parser's hardened defaults (alias bomb, duplicate key, multi-document, inert tags, merge keys, prototype pollution) are proven by execution against ADL's pinned entry point, not merely asserted from research"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/yaml-security.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "A repo-supplied path can never express a traversal, absolute path, drive letter, UNC prefix, or NUL byte at schema level"
    verification:
      - kind: automated_test
        ref: "packages/core/test/config/path-guard.test.ts; adopted by adl-yml.ts's cwd, context.files, and prompt_template fields"
        status: pass
    human_judgment: false
  - id: D7
    description: "The version: 1 guarantee — within a major version ADL only adds optional keys — is a documented promise no automated test can confirm about future releases"
    verification:
      - kind: manual_procedural
        ref: "BACKSTOP. Recorded in adl-yml.ts's module header as promise 1, and in ADL_YML_VERSION's own doc comment. No test can verify a promise about releases that have not happened yet."
        status: deferred
    human_judgment: true
    rationale: "Marked verification: backstop in the plan's must_haves for exactly this reason — this is a promise about future ADL versions, not a property the current codebase can assert against itself."

duration: ~2h (session interrupted by a rate limit between Task 1 verification and Task 2 start; net working time was shorter)
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 07: `adl.yml` Config Schema Summary

**A validated, explicit contract for how ADL builds, starts, probes, tests, and tears down the app under test: every command an argv array (never a shell string), every timeout a bounded duration string capped at 24h, every repo-supplied path rejected at schema level if it could express a traversal, and every unknown key a loud, named validation error — with the YAML parser's six hardened defaults proven by execution against ADL's own pinned entry point rather than assumed from the library's reputation.**

## Performance

- **Duration:** ~2h wall-clock across two sessions (interrupted by a rate limit after Task 1; resumed and completed Tasks 2–3 without re-doing prior work)
- **Tasks:** 3 (all `tdd="true"` on Tasks 1–2; Task 3 documentation-only)
- **Commits:** 5 (test/feat pairs for Tasks 1–2, one docs commit for Task 3)
- **Tests:** 92 passing in `@adl/core` (49 duration/path-guard/yaml-security, 38 adl-yml, 5 pre-existing spine)
- **Files created:** 15 (4 src modules, 4 test files, 7 fixtures); 1 modified (`config/index.ts`)

## Accomplishments

- **`yaml-parse.ts`** — the single module in the repository importing the `yaml` library, with every parse option pinned and commented per the attack it prevents. Verified by execution (not assumed) that the alias-count limit fires at `toJS()` conversion time rather than at `parseDocument()`, which is why both calls sit inside one guarded block.
- **`duration.ts`** — a closed vocabulary of `\d+(ms|s|m|h)` strings, bounded at 24h (`MAX_DURATION_MS`), rejecting bare integers, negatives, zero, and natural-language phrases. The four hand-written regex ranges are swept exhaustively by test against the arithmetic they encode.
- **`path-guard.ts`** — `RepoRelativePathSchema`, rejecting absolute paths, `..` segments (segment-aware, not substring), drive-letter and UNC prefixes, and NUL bytes, expressed as one linear regex so it survives future JSON Schema emission.
- **`adl-yml.ts`** — the full `adl.yml` surface: strict objects at every level, `ADL_YML_VERSION` as a literal `1`, `CommandSpecSchema` requiring argv arrays, `ReadyProbeSchema` as a four-member discriminated union, `ready`/`ready_timeout` enforced both-or-neither via a documented `.superRefine()`, `pipeline`'s `group:` syntax parsed-and-rejected naming itself a future capability, and every numeric field bounded. Every field carries a `.describe()` that doubles as the config reference, and the module header's worked example is extracted verbatim by the test suite and parsed for real.

---

## The prohibitions, and how they are enforced

**1. "Repo-supplied configuration must never gain execution surface."**

`CommandSpecSchema.argv` accepts only a non-empty array of non-empty strings — a shell string (`"npm ci"` instead of `["npm", "ci"]`) fails with `invalid_type` naming the exact field path. Every object in the schema is `z.strictObject`, so a typo'd key is `unrecognized_keys` naming the offender, never a silently-ignored setting.

**2. "A readiness signal must never be inferred."**

There is no default readiness probe and no timeout default when one is declared. `ready` and `ready_timeout` are enforced as a pair by `.superRefine()` — declaring one without the other is a validation error naming which half is missing. An app with no declared probe has no probe; ADL never invents one.

---

## Deviations from Plan

### 1. [Rule 1 - Bug] `.default({})` failed to typecheck on nested strict objects

- **Found during:** Task 2, `pnpm --filter @adl/core typecheck`
- **Issue:** `ContextConfigSchema.default({})` and `LimitsSchema.default({})` both failed with `TS2769: No overload matches this call` — even though every field inside those objects already carries its own `.default()`. TypeScript's inferred *input* type for a `ZodObject` wrapped in `.default()` still requires every key to be present at the object level in this Zod version; the field-level defaults do not make the outer object's input type optional at those keys.
- **Fix:** Spelled the defaults out explicitly at the call site — `.default({ files: ['README.md'], max_bytes: 200_000, on_overflow: 'truncate' })` and `.default({ max_rounds: 6, budget_usd: 15, repeat_finding_threshold: 2 })` — rather than relying on the nested defaults to satisfy an empty object literal.
- **Files modified:** `packages/core/src/config/adl-yml.ts`
- **Commit:** `a9985b4`

### 2. [Rule 1 - Bug] Duration boundary sweep timed out under the full suite

- **Found during:** Task 1, `pnpm vitest run --project core` (full suite, not the three-file targeted run)
- **Issue:** The brute-force sweep across every whole value either side of each duration unit's boundary made ~90,000 individual `expect()` calls. In isolation it passed; under the loaded full-suite run it tripped Vitest's 5s default test timeout.
- **Fix:** Collected mismatches into an array during the loop and asserted `expect(mismatches).toEqual([])` once at the end, rather than asserting inside the loop. Same coverage, one assertion instead of ~90,000.
- **Files modified:** `packages/core/test/config/duration.test.ts`
- **Commit:** `e523e19`

No Rule 4 (architectural) deviations arose. No auth gates. No package installs were required — `yaml@2.9.0` was already installed by 01-02.

---

## Decisions Made

Beyond the deviations above:

1. **`parseAdlYml` returns `AdlYml | LoadError`, not a thrown exception.** This is what the plan's action text explicitly specifies, and it differs deliberately from `loadAdlTemplateSpec`'s throw-based style from 01-02/01-06 — a caller validating many repo configs across a fleet is not forced into try/catch per file.
2. **The alias-bomb defence lives inside the same try/catch as the syntactic parse**, because `toJS({ maxAliasCount: 100 })` — not `parseDocument()` — is where the `ReferenceError` actually throws. This was verified by execution before writing the implementation, not assumed from the research document's description of the library's defaults.
3. **`InterpolatableUrlSchema` deliberately does not use `z.url()`.** `z.url()` rejects `http://127.0.0.1:${ADL_PORT}/health` as an invalid host — exactly the value every realistic `start.ready` fixture needs to write, since `${ADL_PORT}` interpolation (D-21) happens after schema validation, in 01-08. A narrower regex (`^https?://[^\s\0"'<>\\^`|]+$`) accepts the placeholder while still rejecting `javascript:`, `file:`, embedded whitespace, and embedded NUL bytes.
4. **Numeric ceilings were chosen and documented, not left to instinct:** `limits.max_rounds` at 50 ("needing more is a signal the feature is too large"), `limits.budget_usd` at 10,000 ("protects against a config typo, not a real budget policy signal"), `limits.repeat_finding_threshold` at 20, HTTP `expect` at the valid status-code range 100–599, TCP `port` at 1–65535. Each ceiling's rationale is in the field's own `.describe()` string per Task 3.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-01 (Tampering — argv/strict objects) | mitigate | **Mitigated.** `CommandSpecSchema.argv` rejects shell strings; every object is `z.strictObject`. |
| T-1-02 (Info disclosure — repo-supplied paths) | mitigate | **Mitigated.** `RepoRelativePathSchema` adopted by `cwd`, `context.files`, and `prompt_template`; rejects absolute, `..`, drive-letter, UNC, and NUL at schema level, so a traversal never reaches Phase 2's filesystem calls. |
| T-1-05 (DoS — unbounded numerics / oversized YAML integers) | mitigate | **Mitigated.** Every numeric field (durations, limits, HTTP status, TCP port, context.max_bytes) carries a documented ceiling expressed structurally. |
| T-1-10 (Tampering — YAML deserialization/alias/duplicate/multi-doc/merge/proto-pollution) | accept | **Verified by execution** in `yaml-security.test.ts` against ADL's own pinned entry point, not merely inherited from research. Residual risk is a future edit to the pinned options block; the per-option comments in `yaml-parse.ts` make that edit visible. |
| T-1-11 (DoS — validation regexes) | accept | **Accepted as reviewed.** Duration and path-guard patterns are linear, no nested quantifiers; confirmed by the exhaustive boundary sweeps rather than by inspection alone. |
| T-1-26 (Spoofing — readiness never inferred) | mitigate | **Mitigated.** `ready`/`ready_timeout` both-or-neither via `.superRefine()`; no default probe exists. |

## Known Stubs

None. Every exported schema and function is fully implemented; no placeholder values, no hardcoded empty returns, no "coming soon" text.

## Issues Encountered

- **Session interrupted by a rate limit** between completing and verifying Task 1 and beginning Task 2. On resume, prior commits (`5e77965`, `e523e19`) were verified present via `git log` before continuing — no work was redone, and no commit was duplicated.
- **A scratch investigation file (`packages/core/probe-tmp.mjs`)** was created and deleted across the session to verify `yaml@2.9.0` and `zod@4.4.3` API behaviour by execution before writing tests and implementation (alias-bomb timing, `z.url()` vs a custom URL pattern, `.superRefine()` on a `.extend()`ed strict object, duration/path regex boundary sweeps). It was never committed and is not present in the final tree.

## Verification

| Command | Result |
|---|---|
| `pnpm vitest run --project core packages/core/test/config/duration.test.ts packages/core/test/config/path-guard.test.ts packages/core/test/config/yaml-security.test.ts` | 49 passed |
| `pnpm vitest run --project core packages/core/test/config/adl-yml.test.ts` | 38 passed |
| `pnpm vitest run --project core packages/core/test/config/` | 87 passed |
| `pnpm vitest run --project core` (full package) | 92 passed |
| `pnpm --filter @adl/core typecheck` | clean |
| `pnpm -r typecheck` | 3/3 packages Done |
| `pnpm -r build` | 3/3 packages Done |
| `pnpm -r test` | core 92 · db 6 · plugin-sdk 0 (by design) |
| `grep -rn "node:fs\|node:child_process\|process\.env\|node:os" packages/core/src/` | 0 matches — purity intact |
| `grep -rl "from 'yaml'" packages --include=*.ts` | only `packages/core/src/config/yaml-parse.ts` |
| `ls packages/core/test/fixtures/adl-yml/` | 7 files, as declared |
| `git status --short` (after build) | clean — `dist/` correctly gitignored |

`pnpm exec eslint packages/core/src/config` was **not** run: no ESLint config exists yet in this worktree (01-03 lands it this same wave, per the plan's own note that the workspace-wide lint pass is 01-08's job after Wave 4 closes). Purity was instead confirmed directly by `grep`, matching the acceptance criterion's actual intent.

## Self-Check: PASSED

- All 16 created/modified files (`git status --short` clean, `git diff --stat` against the wave-2 base) are present under `git ls-files`.
- All 5 commits exist in `git log`: `5e77965`, `e523e19`, `18d5c58`, `a9985b4`, `a8dddab`.
- No file deletions in any commit (`git diff --diff-filter=D` empty for every commit range checked).

## User Setup Required

None.

## Next Phase Readiness

**01-08 (effective-config resolution, interpolation, context cascade, pipeline execution)** is unblocked. Carry-forwards it should know:

- `packages/core/src/config/index.ts` currently re-exports exactly: `parseYamlDocument`, `Duration`-family, `RepoRelativePath`-family, and the full `adl-yml.ts` surface (`AdlYmlSchema`, `parseAdlYml`, `ADL_YML_VERSION`, `CommandSpecSchema`, `StartCommandSpecSchema`, `ReadyProbeSchema`, `ContextConfigSchema`, `PipelineEntrySchema`, `LimitsSchema`, `AgentsConfigSchema`, `OnOverflowSchema`, `OnSendBackSchema`, and their inferred types). This plan does **not** create `effective-config.ts`, `interpolate.ts`, `context-cascade.ts`, or `pipeline.ts` — those are 01-08's files in the same directory, per the wave boundary.
- **Interpolation contract to implement against:** `${ADL_PORT}`, `${ADL_FEATURE_ID}`, `${ADL_ROUND}`, `${ADL_VERDICT_FILE}` are the closed variable set (D-21), documented in `adl-yml.ts`'s module header as promise 2. Currently only `ReadyProbeSchema`'s `http.url` field documents an interpolatable string; `InterpolatableUrlSchema` validates shape only and performs no substitution.
- **Daemon clamp contract to implement against:** `limits.*` may only be lowered from the daemon's ceiling, never raised; `agents.*.backend`/`agents.*.model` selection is daemon-only (D-22, promise 3). This schema validates the repo-supplied value's own shape only — `AgentBlockSchema` and `LimitsSchema` exist so `EffectiveConfig`'s daemon-side clamp has a matching shape to fold against, but the clamp itself is not implemented here.
- `harness:` id *resolution* against a registry (built-in → npm package → repo-relative path) is 01-08's job; `HarnessEntrySchema` in `adl-yml.ts` validates shape only.
- The `group:` pipeline syntax parses and is unconditionally rejected with a message naming it a future capability — 01-08 does not need to handle it, only v2 parallel-pipeline work eventually will.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
