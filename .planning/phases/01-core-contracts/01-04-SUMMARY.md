---
phase: 01-core-contracts
plan: 04
subsystem: verdict-contracts
tags: [zod, json-schema, ajv, exhaustive-proof, verdict, round-outcome, tdd]

# Dependency graph
requires:
  - "01-02 (the thin VerdictSchema/aggregate/RoundOutcome skeleton this plan completes)"
provides:
  - "RoundOutcomeSchema and its four named members (GreenOutcome, SendBackOutcome, EscalateOutcome, UnverifiedOutcome) in their own module, packages/core/src/verdict/round-outcome.ts"
  - "aggregate() proven exhaustively over all 3,002 multisets for pipeline lengths 1-8, permutation-invariant, empty-list handled (CORE-02)"
  - "packages/core/schema/verdict.schema.json — the published, CI-diffed JSON Schema contract for HARN-02's plain-command gates (D-26)"
  - "packages/core/scripts/emit-json-schema.ts — emit:schema / emit:schema:check, plus emitVerdictSchema() as an importable pure function"
  - "40-fixture (24 valid + 25 invalid) accept/reject equivalence proof between VerdictSchema and the published schema (CORE-04, Pitfall 1)"
  - "Every z.object under verdict/ converted to z.strictObject, so additionalProperties: false in the published schema matches parse() behaviour"
affects: [01-08 (workspace-wide lint pass re-confirms no .refine()/.superRefine() under verdict/), Phase 4 (the oneOf-vs-discriminator open question recorded in schema/README.md), Phase 6 (fingerprint normalisation tuning against the pair corpus in finding.test.ts)]

actuals:
  tokens: 19600
  tasks: 3
  commits: 4

tech-stack:
  added:
    - "ajv-formats 3.0.1 (devDependency, exact pin) — registers the date-time format ajv 8 strict mode would otherwise throw on at compile time"
  patterns:
    - "z.strictObject, not z.object, for every schema under verdict/ — z.toJSONSchema() emits additionalProperties: false regardless, so a loose z.object would publish a contract stricter than parse() actually enforces"
    - "reused: 'inline' (not 'ref') for z.toJSONSchema — 'ref' extracts every anonymous primitive leaf into a positional __schemaN def (50 defs, 33 positional, measured); 'inline' with every named schema still getting its own $defs entry produces 17 clean PascalCase defs"
    - "Multiset enumeration (order-insensitive, C(n+5,5) per length) rather than ordered-tuple enumeration for an exhaustive proof — 3,002 cases across lengths 1-8 versus 1,679,616 ordered tuples for the same coverage"
    - "Byte comparison (--check flag) rather than git diff --exit-code as a generated-artifact drift gate — git diff passes vacuously on an untracked file, which is exactly the commit that creates the artifact"
    - "Pure emit + guarded main(): a script under scripts/ exports its core logic and only runs as a side effect when executed directly, so a test can import the exact serialisation logic without re-implementing it or triggering a file write"

key-files:
  created:
    - packages/core/src/verdict/round-outcome.ts
    - packages/core/scripts/emit-json-schema.ts
    - packages/core/schema/verdict.schema.json
    - packages/core/schema/README.md
    - packages/core/test/verdict/aggregate.exhaustive.test.ts
    - packages/core/test/verdict/schema.test.ts
    - packages/core/test/verdict/finding.test.ts
    - packages/core/test/verdict/json-schema-equivalence.test.ts
    - packages/core/test/fixtures/verdicts/valid/README.md
    - packages/core/test/fixtures/verdicts/invalid/README.md
  modified:
    - packages/core/src/verdict/aggregate.ts
    - packages/core/src/verdict/index.ts
    - packages/core/src/verdict/verdict.ts
    - packages/core/src/verdict/finding.ts
    - packages/core/src/verdict/criterion-ref.ts
    - packages/core/src/verdict/waiver.ts
    - packages/core/package.json
    - pnpm-lock.yaml

key-decisions:
  - "reused: 'inline' chosen over reused: 'ref' for JSON Schema emission — verified by execution that 'ref' extracts every anonymous leaf schema (z.string().min(1), z.literal('pass'), etc.) into $defs under a positional __schemaN name even when every meaningful schema already carries .meta({ id }). Measured: 'ref' produced 50 defs (33 positional), 'inline' produces 17, all PascalCase. Naming union members alone does not fix this under 'ref' — the offenders are primitives with no identity worth naming."
  - "Every z.object under packages/core/src/verdict/ converted to z.strictObject. z.toJSONSchema() emits additionalProperties: false for every object schema regardless of strict/loose, so a z.object (which parse() strips unknown keys from) would publish a contract stricter than the one actually enforced — the same drift direction Pitfall 1 warns about, from the opposite side. Verified: Zod accepted an extra property that a strict-mode ajv validator against the emitted schema rejected, before this fix."
  - "ajv-formats added as a devDependency (exact pin 3.0.1) under 01-01-SUMMARY.md's conditional pre-approval, condition confirmed met by execution: the emitted schema carries format: 'date-time' on Waiver.at, and ajv 8 strict mode throws at compile time on that unrecognised format without ajv-formats registering it."
  - "emit-json-schema.ts refactored to export emitVerdictSchema() (pure) and guard the file-write/process.exit main() behind an isDirectlyExecuted check, so json-schema-equivalence.test.ts's byte-identity assertion imports the emitter's actual serialisation logic instead of re-implementing a second copy that could itself drift from what the script writes."
  - "Added a second emitter guard, assertNamedUnionMembers, beyond the plan's originally-scoped positional-$defs-name guard. Under reused: 'inline', an unnamed union member does not produce a positional $defs key at all — it is silently inlined into the root oneOf. Verified by removing .meta({ id: 'FailVerdict' }) and re-emitting: the original guard did not fire, but the drift check (byte comparison) did, and the new guard now catches the same case earlier and more specifically."

requirements-completed: [CORE-02, CORE-04]

coverage:
  - id: D1
    description: "aggregate() is proven exhaustively over all 3,002 multisets for pipeline lengths 1-8: no multiset containing inconclusive computes green, the function is permutation-invariant, and the empty list is handled explicitly (returns escalate)"
    requirement: CORE-02
    verification:
      - kind: automated_test
        ref: "packages/core/test/verdict/aggregate.exhaustive.test.ts — 9 tests, 3,002-case enumeration asserted as a length check, all four D-10 precedence rules as separate named tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "The published JSON Schema and the enforced Zod schema agree on 40 fixtures (24 valid, 25 invalid), zero disagreements, and the committed artifact cannot drift from a fresh emission without the suite going red"
    requirement: CORE-04
    verification:
      - kind: automated_test
        ref: "packages/core/test/verdict/json-schema-equivalence.test.ts — 50 fixture-level tests plus a zero-disagreements test plus a byte-identity test, 53 tests total"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every Finding constraint (criterionRef required, fingerprint length, optional location, sortFindings determinism) and every Verdict constraint (six outcomes, seventh-outcome rejection shape, consumesRound) is individually asserted, not only exercised inside the bulk enumeration"
    requirement: "CORE-01, CORE-04"
    verification:
      - kind: automated_test
        ref: "packages/core/test/verdict/schema.test.ts (11 tests), packages/core/test/verdict/finding.test.ts (17 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Fingerprint normalisation strength — rephrasings collide, genuinely different findings do not"
    verification:
      - kind: manual_procedural
        ref: "BACKSTOP, as flagged in the plan's must_haves. The pair corpus in finding.test.ts pins current behaviour (case, whitespace, trailing line-ref collapse; different identifiers/problems/stageId/path do not collapse) but whether that is the *right* strength for stall detection is a judgement 01-RESEARCH.md § Open Questions 1 explicitly defers to Phase 6 evidence."
        status: deferred
    human_judgment: true
    rationale: "Same backstop carried forward from 01-02-SUMMARY.md's D8 — the normalisation is implemented and pinned, but 'is this the right strength' is not decidable by a unit test on day one."

duration: ~2h
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 04: Exhaustive Green Proof and Honest Published Schema Summary

**`aggregate()`'s green-unreachable-with-inconclusive claim is now backed by a literal, asserted enumeration of all 3,002 multisets across pipeline lengths 1–8 (not a hand-written sample), and the published `verdict.schema.json` is proven — by a 40-fixture corpus run through both Zod and an independent ajv validator — to accept and reject exactly what the enforced Zod schema does, with a byte-identity gate that fails the build the moment the two diverge.**

## Performance

- **Duration:** ~2h (including two rounds of empirical schema-emission investigation)
- **Tasks:** 3 (2 TDD, 1 plain auto)
- **Commits:** 4 (1 RED, 1 GREEN, 1 emitter, 1 equivalence suite)
- **Tests added:** 89 → 94 core tests total (aggregate.exhaustive 9, schema.test 11, finding.test 17, json-schema-equivalence 53)
- **Exhaustive test latency:** 664 ms for the full test file against a 5 s quick-run budget

## Accomplishments

- Extracted `RoundOutcomeSchema` and its four named members into `round-outcome.ts`, completed `aggregate()` to D-10's exact precedence, and proved CORE-02's *exhaustively* literally: every one of the 3,002 multisets over lengths 1–8 runs through `aggregate`, none containing `inconclusive` computes green, the result is permutation-invariant, and the count itself (6, 21, 56, 126, 252, 462, 792, 1287 → 3,002) is asserted rather than trusted.
- Built `emit-json-schema.ts`: emits the verdict-file JSON Schema from the Zod source with `reused: 'inline'`, guards against positional `$defs` names and inline (unnamed) union members, and exposes a `--check` byte-comparison drift gate that does not rely on `git diff` (which is vacuous for a file git has never tracked).
- Converted every `z.object` under `verdict/` to `z.strictObject`, closing a drift Pitfall 1 did not name directly: `z.toJSONSchema()` emits `additionalProperties: false` unconditionally, so a loose `z.object` (which `parse()` silently strips unknown keys from) would have published a contract *stricter* than the one actually enforced.
- Built the 40-fixture (24 valid, 25 invalid) equivalence corpus in `json-schema-equivalence.test.ts`, proving Zod and an independent `ajv` validator loaded from the committed `verdict.schema.json` agree on every fixture, plus a byte-identity test against a fresh emission.

---

## Deviations from Plan

### 1. [Rule 1 — Bug] `reused: 'ref'` does not do what 01-RESEARCH.md § Pattern 2 implied it would

- **Found during:** Task 2, first emission attempt
- **Issue:** The plan's read-first pointed at Pattern 2's guidance — name every union member and `reused: 'ref'` gives stable `$defs`. Verified by execution: even with every meaningful schema carrying `.meta({ id })`, `reused: 'ref'` additionally extracts every anonymous *leaf* schema (`z.string().min(1)`, `z.literal('pass')`, etc.) into `$defs` under a positional `__schemaN` name. Measured against this exact schema: `'ref'` produced 50 defs, 33 of them positional; `'inline'` produces 17, all PascalCase, with every named schema still landing in `$defs` and `$ref`'d (that behaviour is registry-driven, not `reused`-driven).
- **Fix:** Switched emission to `reused: 'inline'`. Documented the measured counts and the reasoning inline in `emit-json-schema.ts` so a future reader does not have to re-derive it.
- **Commit:** `1bcf6cb`

### 2. [Rule 2 — Missing critical functionality] `z.object` → `z.strictObject` under `verdict/`

- **Found during:** Task 2, verifying ajv strict-mode behaviour before writing the equivalence test
- **Issue:** `z.toJSONSchema()` emits `additionalProperties: false` on every object schema regardless of whether the Zod schema is `z.object` (loose — `parse()` silently strips unknown keys) or `z.strictObject` (rejects them). Verified by execution: `VerdictSchema.safeParse()` on a `pass` verdict with an extra `bogus` property returned `success: true` while a strict-mode ajv validator against the then-current emission rejected the same payload. This is Pitfall 1's drift from the *opposite* direction — not a constraint present in code and silently dropped from the schema, but a constraint present in the schema and silently absent from `parse()`.
- **Fix:** Every `.object(` under `packages/core/src/verdict/` (verdict.ts, finding.ts, criterion-ref.ts, waiver.ts, round-outcome.ts) is now `.strictObject(`. Documented at the top of `verdict.ts` so the reason travels with the code, not only with this summary.
- **Commit:** `1bcf6cb`

### 3. [Rule 2 — Missing critical functionality] Second emitter guard: `assertNamedUnionMembers`

- **Found during:** Task 2, verifying the `$defs`-name guard actually fires (per the plan's own instruction to verify guards in a scratch run before trusting them)
- **Issue:** The plan's guard as specified catches positional `$defs` names. Under `reused: 'inline'` (deviation 1, above), a union member missing its `.meta({ id })` does not produce a positional `$defs` key at all — it is silently inlined directly into the root `oneOf`. Verified: removing `.meta({ id: 'FailVerdict' })` and re-emitting did not trip the original guard; the byte-identity drift check caught it, but only reactively, not as a load-bearing emission guard.
- **Fix:** Added `assertNamedUnionMembers`, which rejects any root `oneOf` member that is not a `$ref`. Verified in the same scratch run (remove the meta, re-emit, confirm the new guard fires with the offending index named; restore).
- **Commit:** `1bcf6cb`

### 4. [Rule 3 — Blocking] `emit-json-schema.ts` refactored to be safely importable

- **Found during:** Task 3, writing the byte-identity assertion in `json-schema-equivalence.test.ts`
- **Issue:** The plan's Task 3 action calls for a test asserting the committed schema is byte-identical to "a fresh emission from the current Zod source." Re-implementing the emission/serialisation logic inside the test file would create a second copy of that logic that could itself drift from what the script actually writes — exactly the failure mode this whole plan exists to close off, one level removed. The original script also called `main()` unconditionally at module scope, which would write to disk or call `process.exit` as a side effect of merely importing it.
- **Fix:** Extracted the schema-production logic into an exported `emitVerdictSchema()` (pure — returns the schema and its serialised bytes, runs both `$defs` guards, throws no side effects). Guarded the script's own `main()` invocation behind an `isDirectlyExecuted` check (`import.meta.url === pathToFileURL(process.argv[1]).href`) so `tsx scripts/emit-json-schema.ts` still works standalone, but importing the module for its exports triggers nothing. Re-verified `emit:schema` and `emit:schema:check` both still pass after the refactor.
- **Commit:** `7582ef7`

### 5. `ajv-formats` added, under the pre-approved condition — confirmed, not assumed

- **Found during:** Task 3
- **Context:** 01-01-SUMMARY.md § 4c pre-approved `ajv-formats` as a devDependency *conditionally* — "ONLY IF the emitted draft-2020-12 schema actually carries a `format` keyword that ajv 8 strict mode rejects."
- **Verification performed:** Probed the emitted schema directly — it carries exactly one `format` keyword, `format: "date-time"` on `Waiver.at`. Compiling that schema with `new Ajv2020({ strict: true })` and no format plugin threw `unknown format "date-time" ignored in schema at path "#/properties/at"` at compile time. The condition is met.
- **Action:** Added `ajv-formats@3.0.1` as a devDependency of `@adl/core`, pinned exact (no caret) to match the package's existing pin convention (`ajv: "8.20.0"`). No return to a human gate, per the pre-approval's own terms.
- **Commit:** `7582ef7`

None of the five deviations are Rule 4 (architectural) — no schema, table, or interface shape changed; all five are either bug fixes surfaced by verifying the plan's own acceptance criteria empirically, or the exercise of a decision the plan already pre-authorized.

---

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-06 (Tampering — `verdict.schema.json` vs `VerdictSchema` drift) | mitigate | **Mitigated.** 40-fixture equivalence test plus byte-identity drift test against a fresh emission; zero `.refine()`/`.superRefine()` under `verdict/` (grep-verified). The `z.strictObject` conversion (deviation 2) closes a drift direction the threat register's wording did not name explicitly but that the same mechanism catches. |
| T-1-16 (Spoofing — a verdict claiming coverage it did not perform) | mitigate | **Mitigated, unchanged from 01-02.** `pass.checked` remains `.min(1)`, preserved through emission as `minItems: 1` — verified present in the committed schema and covered by the equivalence corpus (`pass with an empty checked array` is in the invalid set). |
| T-1-17 (Tampering — `inconclusive` aggregated into green) | mitigate | **Mitigated, now exhaustively.** All 3,002 multisets, not a sample; permutation invariance proven over the whole enumeration. |
| T-1-18 (Repudiation — `$defs` key churn) | accept | **As dispositioned, with an added mechanism.** The plan's guard (positional names) is in place; deviation 3 adds a second guard (inline/unnamed union members) that the plan did not originally scope but that the same failure mode required once `reused: 'inline'` replaced `reused: 'ref'`. Residual risk — a reviewer ignoring a legitimate diff — is unchanged, as the threat register itself notes. |

## Known Stubs

None. Every file this plan touches is a real, schema-valid implementation exercised by a passing test; nothing returns a hardcoded empty value or placeholder text.

## Verification

Run from a clean state after the final commit:

| Command | Result |
|---|---|
| `pnpm vitest run --project core packages/core/test/verdict/` | **4 test files, 89 passed** |
| `pnpm --filter @adl/core emit:schema && pnpm --filter @adl/core emit:schema:check` | emits, then reports up to date — no diff produced by re-emission |
| `pnpm vitest run --project core packages/core/test/verdict/aggregate.exhaustive.test.ts` | **9 passed in 664 ms** (budget: 5 s) |
| `pnpm -r typecheck` | **3/3 packages Done** |
| `pnpm -r build` | **3/3 packages Done** |
| `pnpm -r test` | **core 94 passed · db 6 passed · plugin-sdk 0 (by design)** |
| `grep -rn "\.refine(\|\.superRefine(" packages/core/src/verdict/` | 0 matches |
| Mutate one constraint in the committed `verdict.schema.json`, re-run the equivalence suite | **13 tests fail** (byte-identity + fixtures whose accept/reject decision the mutation changed); reverted, suite green again |
| Guard scratch-run: strip `.meta({ id: 'FailVerdict' })`, re-emit | `assertNamedUnionMembers` fires, names `oneOf[2]`; reverted |
| Guard scratch-run: append a space to the committed schema, run `emit:schema:check` | exits 1 with a unified diff; reverted |
| Guard scratch-run: delete the committed schema, run `emit:schema:check` | exits 2 with the "missing published schema" message; restored |

**01-03's ESLint config is not present in this worktree** (Wave 3 sibling plan, not yet merged at execution time), so the plan's `pnpm exec eslint packages/core/src/verdict` re-confirmation step could not run as written. Substituted a grep-based verification of the same property (zero `.refine()`/`.superRefine()` matches). The plan itself names this as expected: "plan 01-08 runs the workspace-wide `pnpm lint` once Wave 4 closes" — that pass will exercise the real rule against these files.

## Self-Check: PASSED

- All 12 new files claimed above are present in `git ls-files`.
- All 4 commits exist: `222287f` (RED), `e6ba0aa` (GREEN), `1bcf6cb` (emitter), `7582ef7` (equivalence suite).
- No unexpected file deletions in any commit (`git diff --diff-filter=D` checked after each commit).

## User Setup Required

None. `ajv-formats` installs via the existing `pnpm install` — no new environment variable, credential, or manual step.

## Next Phase Readiness

- **01-08 (workspace lint):** re-running `pnpm exec eslint packages/core/src/verdict` once the ESLint config lands will find zero violations — pre-verified by grep in this plan.
- **Phase 4 (agent backend structured output):** `packages/core/schema/README.md` carries the `oneOf`-vs-`discriminator` open question exactly where a Phase 4 planner will find it — at the artifact, not buried in this summary. The `override` callback escape hatch in `z.toJSONSchema()` remains available inside `emit-json-schema.ts` if a backend's structured-output mode turns out to reject root-level `oneOf`.
- **Phase 6 (fingerprint tuning):** the pair corpus in `finding.test.ts` — 5 collapsing pairs, 4 non-collapsing pairs (including a same-title-different-`stageId` case and a same-title-different-`location.path` case) — is the evidence base 01-RESEARCH.md § Open Questions 1 calls for. It pins today's behaviour; it does not claim the strength is finally right.
- **Downstream consumers of `RoundOutcome`:** the shape did not change from 01-02 (still `green | send_back | escalate | unverified`), only its module location and the stability of its emitted `$defs` names — no consumer of the type needs to change.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
