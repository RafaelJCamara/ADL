---
phase: 01-core-contracts
plan: 06
subsystem: spec-loader
tags: [gherkin, mdast, cucumber, zod-adjacent, criterion-ids, spec-intake]

# Dependency graph
requires:
  - phase: "01-02 (walking skeleton)"
    provides: "NormalizedSpec/AcceptanceCriterion types, loadAdlTemplateSpec, LoadError, sha256Hex, the pinned @cucumber/gherkin + @cucumber/messages + mdast-util-from-markdown install"
  - phase: "01-01 (package legitimacy)"
    provides: "the approved parser pins and Assumption A6's resolution (Scenario Outline is one criterion, never expanded per Examples row)"
provides:
  - "detectFormat(filenames) — deterministic, filename-only spec-format detection with named entry-file constants"
  - "assignCriterionIds/criterionTextHash — the single shared AC-n numbering path both loaders route through, and the single place zero criteria is refused"
  - "loadGherkinSpec/collectScenarios/isOutline — Gherkin -> NormalizedSpec, Background excluded, Rule-nested scenarios included, outlines kept whole with unexpanded placeholders and a verbatim Examples table"
  - "markdown.ts rewritten to route through the shared assignment path instead of numbering inline"
  - "AcceptanceCriterion's scenario union member (name/tags/steps/examples) and SourceSpan on both members; NormalizedSpec.background"
  - "the nine degenerate Gherkin inputs from 01-RESEARCH.md Pitfall 2, each proven to raise a distinct named LoadError"
  - "the cross-format addressing invariant test, proving AC-n is gap-free, duplicate-free, and format-blind across every fixture of both formats"
affects: [01-08, 02]

# Actuals (#2632)
actuals:
  tokens: 20400
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "One shared assignCriterionIds path enforces D-02's flat AC-n sequence for both formats, instead of each loader agreeing to number the same way by convention"
    - "criterionTextHash is deliberately the fidelity-hash opposite of fingerprintFinding (matching-hash) — documented as a contrast that must not be unified"
    - "Gherkin block boundaries derived by sorting every child/tag start offset ascending, then slicing each scenario from its own start to the next boundary — because Gherkin Location marks only where things begin, unlike mdast's start+end node positions"
    - "Step-count reconciliation (source step-keyword lines vs. steps reachable through the AST walk) as the mechanical check for the orphan-step-loss failure mode, skipping docstring bodies so prose inside one cannot be miscounted"
    - "IdGenerator.incrementing(), never uuid() — verified by execution that repeat parses are then byte-identical"

key-files:
  created:
    - packages/core/src/spec/detect-format.ts
    - packages/core/src/spec/criterion-ids.ts
    - packages/core/src/spec/gherkin.ts
    - packages/core/test/spec/detect-format.test.ts
    - packages/core/test/spec/gherkin.test.ts
    - packages/core/test/spec/markdown.test.ts
    - packages/core/test/spec/criterion-ids.test.ts
    - packages/core/test/fixtures/spec/good/checkout.feature
    - packages/core/test/fixtures/spec/good/rules.feature
    - packages/core/test/fixtures/spec/good/outline.feature
    - packages/core/test/fixtures/spec/bad/README.md
  modified:
    - packages/core/src/spec/types.ts
    - packages/core/src/spec/markdown.ts
    - packages/core/src/spec/index.ts

key-decisions:
  - "01-RESEARCH.md § Pitfall 2's prose ('five parse, four throw') is wrong; its own table, and re-running the parser against @cucumber/gherkin@42.0.1 while implementing this loader, both give six parse, three throw. The loader and its tests follow the verified behaviour, not the prose."
  - "A Rule: block absorbs every scenario that follows it until the next Rule or end of file, regardless of indentation — verified by execution, not assumed. rules.feature is written with the top-level scenario FIRST specifically so this doesn't accidentally go untested."
  - "Two adjacent Feature: lines ('Feature: A\\nFeature: B\\n') parse successfully — the second is absorbed as the first feature's description. Only two Feature: blocks separated by real content (a scenario) throws CompositeParserException. The row-7 degenerate-input fixture uses the separated form, since that's what an author actually writes."
  - "step.keyword is discriminated primarily by its trimmed literal (so 'But' stays 'But' rather than collapsing into keywordType's CONJUNCTION alongside 'And'), falling back to keywordType only for non-English dialects."
  - "Gherkin Location has no offset field (unlike mdast's node.position), so byte offsets are computed by scanning raw for line starts and combining with the parser's 1-based line/column. Verified correct under both LF and CRLF by direct execution before writing the implementation."
  - "The three 'no Feature declared' degenerate cases (empty file, whitespace-only, comment-only) are given three distinct error messages rather than one shared one, so the six-parse-accepted-inputs-get-six-distinct-messages assertion holds meaningfully rather than by coincidence."

patterns-established:
  - "Empirical verification before implementation: every non-obvious parser fact used in gherkin.ts (Rule absorption, Location column optionality, offset computation under CRLF, step.keyword trailing space, dialect table shape) was confirmed by a throwaway probe script run against the installed package before being encoded, not taken from RESEARCH.md prose on faith."

requirements-completed: [SPEC-01, SPEC-02, CORE-05]

coverage:
  - id: D1
    description: "Both an ADL template spec and a Gherkin feature file load into one NormalizedSpec with one flat AC-n sequence; no separate SCN-n namespace exists anywhere in the addressing scheme"
    requirement: "SPEC-01, SPEC-02, CORE-05"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/criterion-ids.test.ts — 'the cross-format addressing invariant, over every fixture of both formats' (19 assertions across 4 fixtures)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Format detection is filename-only and deterministic; both entry-file kinds present, neither present, or two of one kind is a load error naming what was found"
    requirement: "SPEC-01, SPEC-02"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/detect-format.test.ts — detectFormat describe block (9 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "assignCriterionIds is the single choke point refusing an empty criterion set for both loaders, and criterionTextHash applies no normalisation (distinguishes trailing-space and combining-character variants)"
    requirement: "CORE-05"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/detect-format.test.ts — assignCriterionIds and criterionTextHash describe blocks"
        status: pass
    human_judgment: false
  - id: D4
    description: "All nine degenerate Gherkin inputs from 01-RESEARCH.md Pitfall 2 behave as specified: six that parse successfully are each rejected with a distinct named error, three that throw CompositeParserException are surfaced with line and column"
    requirement: "SPEC-02"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/gherkin.test.ts — 'the nine degenerate inputs from 01-RESEARCH.md Pitfall 2' describe block, including the count-check and distinctness assertions"
        status: pass
    human_judgment: false
  - id: D5
    description: "Background never becomes a criterion; Rule-nested scenarios are included in document order; a Scenario Outline is exactly one criterion retaining its Examples table verbatim with steps keeping unexpanded placeholder tokens, never expanded per example row"
    requirement: "SPEC-02"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/gherkin.test.ts — 'loadGherkinSpec over checkout.feature' (Background), 'over rules.feature' (Rule nesting), 'over outline.feature' (exactly one criterion, examples.rows verbatim, unexpanded steps)"
        status: pass
    human_judgment: false
  - id: D6
    description: "An orphan Gherkin step outside any scenario is refused rather than silently discarded, without miscounting steps written inside a docstring"
    requirement: "SPEC-02"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/gherkin.test.ts — 'orphan steps (01-RESEARCH.md Pitfall 3)' describe block"
        status: pass
    human_judgment: false
  - id: D7
    description: "Every criterion's text, for both formats, is a byte-exact raw.slice(start, end) — never a re-serialisation — and raw round-trips unchanged; a nested markdown bullet stays inside its parent's byte range; a missing acceptance-criteria heading and an empty one raise two distinct errors; frontmatter and fenced-code-block heading lookalikes are handled correctly; a source over the 1 MB UTF-8-byte cap is rejected before parsing, for both loaders"
    requirement: "CORE-05, SPEC-01"
    verification:
      - kind: unit
        ref: "packages/core/test/spec/markdown.test.ts (11 tests) and packages/core/test/spec/gherkin.test.ts 'input limits' + 'retains raw byte-identically' tests"
        status: pass
    human_judgment: false
  - id: D8
    description: "The 01-02 end-to-end spine test still passes unchanged after markdown.ts was rewritten to route through the shared assignCriterionIds path"
    verification:
      - kind: e2e
        ref: "packages/core/test/spine.e2e.test.ts (5 tests, unmodified)"
        status: pass
    human_judgment: false

duration: ~11min active (spread across two sessions; see Issues Encountered)
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 06: Spec Intake — Gherkin Loader and Format Detection Summary

**Both ADL-template and Gherkin feature specs now load into one `NormalizedSpec` through a single shared `assignCriterionIds` path, with `detectFormat` refusing to guess and all nine of `@cucumber/gherkin`'s verified degenerate-input traps turned into named `LoadError`s.**

## Performance

- **Tasks:** 3 (all `type="auto" tdd="true"`)
- **Commits:** 3 task commits + this summary
- **Files created:** 11
- **Files modified:** 3
- **Tests:** 80 passing in `@adl/core` (was 5 before this plan; +75)
- **Diff size:** ~81.5 KB (~20,400 estimateTokens, chars/4) against a 62,000-token, low-confidence estimate

## Accomplishments

- `detectFormat(filenames)` — filename-only, deterministic, refuses every ambiguous listing (both kinds, two of a kind, neither) by naming what it found. No content sniffing, ever.
- `assignCriterionIds`/`criterionTextHash` — the one place `AC-n` is assigned and the one place an empty criterion set is refused, for both formats. `markdown.ts` now routes through it instead of numbering inline.
- `loadGherkinSpec`/`collectScenarios`/`isOutline` — the full Gherkin loader. `Background` excluded from the criteria; `Rule`-nested scenarios included in document order; `Scenario Outline` stored as exactly one criterion with its `Examples` table retained verbatim and its step placeholders unexpanded (Assumption A6).
- All nine degenerate Gherkin inputs from `01-RESEARCH.md § Pitfall 2` proven to raise a distinct, named `LoadError` — six that the parser silently accepts, three that it throws on.
- Orphan-step detection via step-count reconciliation, correctly skipping docstring bodies so prose inside one cannot be miscounted as a step.
- The cross-format addressing invariant (`criterion-ids.test.ts`): every criterion of every fixture of both formats is `AC-1..AC-n`, gap-free, duplicate-free, carries no format-specific id prefix, and slices verbatim from `raw`.

## Task Commits

1. **Task 1: Deterministic format detection and the shared AC-n assignment path** — `0fe7e9b` (feat)
2. **Task 2: The Gherkin loader and the nine degenerate inputs** — `dbe0f1f` (feat)
3. **Task 3: Verbatim retention and the cross-format addressing invariant** — `4773740` (test)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `packages/core/src/spec/detect-format.ts` — filename-only format detection, `SPEC_ENTRY_FILENAME`, `GHERKIN_EXTENSION`
- `packages/core/src/spec/criterion-ids.ts` — `assignCriterionIds`, `criterionTextHash`, `CriterionBody`
- `packages/core/src/spec/gherkin.ts` — the full Gherkin loader (456 lines)
- `packages/core/src/spec/types.ts` — `SourceSpan`, `SpecStep`, the `scenario` union member, `NormalizedSpec.background`
- `packages/core/src/spec/markdown.ts` — rewritten to route through `assignCriterionIds`
- `packages/core/src/spec/index.ts` — exports for all of the above
- `packages/core/test/spec/detect-format.test.ts`, `gherkin.test.ts`, `markdown.test.ts`, `criterion-ids.test.ts`
- `packages/core/test/fixtures/spec/good/checkout.feature`, `rules.feature`, `outline.feature`
- `packages/core/test/fixtures/spec/bad/README.md`

## Decisions Made

See `key-decisions` in the frontmatter for the full list with rationale. The one most likely to matter to a future reader: **`01-RESEARCH.md § Pitfall 2`'s prose ("five parse, four throw") is wrong** — its own table, and re-running the parser against the pinned `@cucumber/gherkin@42.0.1` while implementing this loader, both give **six parse, three throw**. The implementation and its tests follow the verified behaviour. This is recorded in `test/fixtures/spec/bad/README.md` as well, so a future reader of the research doc isn't misled by the prose.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Own test bug: Unicode combining-character assertion was vacuous as first written**

- **Found during:** Task 3, writing the Unicode fidelity test in `criterion-ids.test.ts`
- **Issue:** The first draft wrote `const precomposed = 'café'; const combining = 'café';` — two source-code literals that look different in intent but, once the file was saved, were byte-identical (an editor/tool-transport normalises typed accented characters to one form). The test would have compared a string to itself and asserted nothing about normalisation.
- **Fix:** Rebuilt both literals from explicit, verified-distinct Unicode: confirmed by direct `.length` (1 vs 2) and codepoint inspection that one string is the precomposed `é` (U+00E9) and the other is `e` + combining acute (U+0065 U+0301) before using them in the assertion.
- **Files modified:** `packages/core/test/spec/criterion-ids.test.ts`
- **Verification:** `expect(precomposedE).not.toBe(combiningE)`, `.length` checks, and the final hash-inequality assertion, all passing.
- **Committed in:** `4773740` (Task 3 commit — caught before commit, not a follow-up fix)

**2. [Rule 3 - Blocking] TypeScript errors from `@cucumber/messages`'s `Location.column` being optional**

- **Found during:** Task 2, `pnpm -r typecheck` after the RED-then-GREEN cycle
- **Issue:** `Location = { line: number; column?: number }` — the upstream type declares `column` optional (though every location this parser actually emits carries one), and `Errors.CompositeParserException.errors` is typed as plain `Error[]`, not `GherkinException[]`. Both surfaced as `tsc` errors across ~8 call sites, plus a `dialects` cast that didn't type-check against the real `Dialect` interface.
- **Fix:** Added a `toPosition()` helper centralizing the `column ?? 1` default and reused it at every call site; narrowed `CompositeParserException.errors[0]` via `instanceof Errors.GherkinException` rather than an unsound cast; imported the real `Dialect` type from `@cucumber/gherkin/dist/Dialect.js` and rewrote `stepKeywordsFor` against it instead of an ad hoc `Record` cast.
- **Files modified:** `packages/core/src/spec/gherkin.ts`
- **Verification:** `pnpm --filter @adl/core typecheck` clean; `pnpm -r typecheck` 3/3; `pnpm -r build` 3/3.
- **Committed in:** `dbe0f1f` (Task 2 commit)

**3. [Rule 1 - Bug] The three "no Feature declared" degenerate inputs shared one error message**

- **Found during:** Task 2, running `gherkin.test.ts`'s "six distinct messages" assertion
- **Issue:** Empty file, whitespace-only file, and comment-only file all hit the same `throw new LoadError('...no Feature...')`, producing only 4 distinct messages across the six parser-accepted degenerate inputs instead of 6.
- **Fix:** Split into three distinct messages (`"is empty"`, `"contains only whitespace"`, `"declares no Feature — only comments were found"`), keeping the shared branch's intent (parser said no feature) but giving the author three different, more actionable diagnoses.
- **Files modified:** `packages/core/src/spec/gherkin.ts`, `packages/core/test/spec/gherkin.test.ts`
- **Verification:** the "gives the six parser-accepted inputs six distinct messages" test passes.
- **Committed in:** `dbe0f1f` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 own-test bug, 1 blocking typecheck, 1 bug in error-message distinctness)
**Impact on plan:** All three are within-scope corrections to this plan's own new code; no scope creep, no architectural change, no Rule 4 decision arose.

## Issues Encountered

- **Session interruption between Task 1 and Task 2.** A rate limit paused execution after Task 1's commit (`0fe7e9b`) and before the Gherkin loader was type-clean. Work resumed from the coordinator's handoff message with the working tree exactly as left (uncommitted Task 2/3 files in progress, no lost state) and continued through typecheck fixes, Task 2's commit, and Task 3. No rework was required — `git status` and the prior test runs were sufficient to re-establish context.
- **Verified several non-obvious parser facts by direct execution before encoding them**, rather than trusting `01-RESEARCH.md` prose alone: that a `Rule:` block absorbs every following scenario regardless of indentation; that `Location.column` is typed optional; that byte-offset computation from Gherkin's line/column locations is correct under both LF and CRLF; that two adjacent `Feature:` lines parse successfully (only a `Feature:` separated by real content throws); and the corrected "six parse, three throw" count for Pitfall 2's degenerate inputs. None of these were assumed from documentation.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `@adl/core`'s spec intake surface (`detectFormat` + both loaders + shared `assignCriterionIds`) is complete for SPEC-01, SPEC-02, and CORE-05. Anything needing to load a feature spec — Phase 2's workspace/detector, later behaviour-tester prompt assembly — can import from `packages/core/src/spec/index.ts`.
- `pnpm -r build`, `pnpm -r typecheck`, and `pnpm vitest run --project core` are all green (80 tests, `tests` phase 555ms against the 5s budget). `pnpm exec eslint packages/core/src/spec` was not run as a full command in this plan (01-03's ESLint config is a concurrent Wave 3 plan not yet merged into this worktree); purity was instead verified directly via `grep` for `node:fs`/`node:child_process`/`process.env` across `packages/core/src` — zero matches, matching 01-02's baseline.
- **01-08** (workspace-wide lint pass once Wave 4 closes) should re-run `pnpm exec eslint packages/core/src/spec` once 01-03's config lands, to get the mechanical enforcement this plan could only verify by hand.
- Nothing in this plan touched `packages/core/package.json`, `vitest.config.ts`, or any file outside its declared `files_modified` — no lockfile changes, no collision surface with sibling Wave 3 plans.

## Known Stubs

None. Every exported symbol has a real implementation; no hardcoded empty values, no placeholder text.

## Self-Check: PASSED

- All 11 created files confirmed present via `ls`.
- All three task commits (`0fe7e9b`, `dbe0f1f`, `4773740`) confirmed present in `git log`.
- No unexpected file deletions in any task commit.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
