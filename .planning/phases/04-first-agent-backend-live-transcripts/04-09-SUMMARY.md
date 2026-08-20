---
phase: 04-first-agent-backend-live-transcripts
plan: 09
subsystem: agent-backend-determinism
tags: [prompt-builder, determinism, prompt-artifact, claude-code-adapter, cross-process-test]

dependency-graph:
  requires:
    - phase: 04-first-agent-backend-live-transcripts
      provides: "04-06: buildDeveloperPrompt (initial), createProductionStageRunner, claudeCodeBackend argv, transcriptPathFor/openTranscriptWriter"
  provides:
    - "buildDeveloperPrompt's declared-context-files surface — effectiveConfig.context.files read and rendered path+content, in declared order, with head-and-tail truncation or an on_overflow: 'error' refusal"
    - "packages/agent-claude-code/test/argv.test.ts — the --bare/auto-discovery-disabling flag pinned as a permanent requirement across differing option sets"
    - "packages/manager/src/prompt/artifact.ts — writePromptArtifact/promptArtifactPathFor, the prompt persisted beside its transcript, before the agent launches"
    - "packages/manager/test/prompt/determinism.test.ts — the byte-identity proof across two real attempts' persisted artifacts, including a cross-process leg"
  affects: [phase-05-loop-runner, phase-09-pull-request-rollup]

tech-stack:
  added: []
  patterns:
    - "Single-pass template substitution (String.replace with a global regex and a FUNCTION replacer) instead of a per-placeholder split/join loop — closes both the '$&'-sequence hazard (already handled) AND a subtler order-dependent re-substitution hazard the old loop had: an earlier value containing a later placeholder's literal token would be replaced a second time"
    - "The prompt builder is the ONLY thing that reads declared context files off disk (via a caller-supplied absolute workspaceRoot, never process.cwd()) — the caller (stage-runner.ts) supplies the workspace root; the renderer never discovers anything not in effectiveConfig.context.files"
    - "The prompt artifact composes on transcriptPathFor rather than re-implementing address validation/containment — same directory, same stem, differing only in extension, so a hostile address component fails with the identical TranscriptAddressError"
    - "createProductionStageRunner gains an injectable agentBackend test seam (never used in production) — lets a test assert 'artifact exists at the moment run() is invoked' without a real subprocess"
    - "Cross-process determinism proof pattern: a standalone .mjs script started via execFileSync(process.execPath, ['--import','tsx', script, JSON.stringify(config)]), configuration passed as a JSON argv value (never env, which is itself a determinism hazard) — extends run-build-once.mjs's precedent from the renderer alone to the full HTTP-route -> dispatch -> forked-worker -> artifact path"

key-files:
  created:
    - packages/manager/src/prompt/artifact.ts
    - packages/manager/test/prompt/artifact.test.ts
    - packages/manager/test/prompt/determinism.test.ts
    - packages/manager/test/helpers/run-dev-run-once.mjs
    - packages/agent-claude-code/test/argv.test.ts
  modified:
    - packages/manager/src/prompt/build.ts
    - packages/manager/src/prompt/templates/developer.md
    - packages/manager/src/worker-entry/stage-runner.ts
    - packages/manager/src/index.ts
    - packages/manager/test/prompt/build.test.ts
    - packages/manager/test/prompt/run-build-once.mjs

decisions:
  - "buildDeveloperPrompt gained a required workspaceRoot field (an absolute path used ONLY to locate declared context files, never rendered into the output) rather than having the caller pre-read file contents — the must_haves truth 'any repository context file read by the prompt builder as declared context' names the prompt builder itself as the reader, matching the template file's own existing readFileSync precedent."
  - "The context-file CASCADE (@adl/core/config's resolveContextFiles, AGENTS.md/CLAUDE.md/.github/copilot-instructions.md/README.md fallback) is deliberately NOT wired in this plan — Task 1's own read_first list omits context-cascade.ts, and effectiveConfig.context.files stays exactly what adl.yml declared. Wiring the cascade into mergeConfig's output is a natural, separate follow-up."
  - "max_bytes/on_overflow are applied PER DECLARED FILE, not as a single assembled-total cap — ContextConfigSchema's own doc comment says 'assembled context,' but this task's own acceptance criteria describe per-file truncation with a single elision marker; documented in build.ts's own docblock as a deliberate, scoped interpretation."
  - "The prompt artifact's extension is '.prompt' (not '.prompt.json') specifically so the artifact and the transcript differ ONLY in extension with an identical stem — 'same directory and stem, differ only in extension' is a literal acceptance criterion, and a compound extension would also change the stem."
  - "Task 3's 'run the same feature twice' is proven via TWO DIFFERENT feature ids carrying byte-identical spec content, not by re-dispatching one feature id twice: POST /dev-run/:featureId refuses (409) a feature whose state is no longer 'queued', and nothing in this phase moves a feature back to 'queued' after its first attempt (that is Phase 5's loop runner). NormalizedSpec.id never reaches buildDeveloperPrompt's rendered output (verified independently in build.test.ts), so this substitution is faithful, not a weaker proxy."
  - "The cross-process test's two child processes run from two real sibling package directories (packages/agent-claude-code, packages/workspace), not from the temp repositories under test — --import tsx resolves the loader by walking up from cwd, and a temp directory outside the repo tree never reaches node_modules/tsx. Two distinct real directories still exercise a genuinely different process.cwd() per process."

metrics:
  duration: "single session, 3 tasks"
  completed: "2026-08-20"

status: complete

actuals:
  tokens: 21455
  tasks: 3
  commits: 3
---

# Phase 04 Plan 09: Prompt Determinism — Explicit Context, Persisted Artifacts, Byte-Identity Across Real Runs Summary

**The agent CLI now runs with repository config auto-discovery permanently disabled and every declared context file explicitly supplied by the prompt builder; every stage attempt's rendered prompt is persisted beside its transcript before the agent launches; and a same-commit re-run — proven across two real daemon processes on two different working directories — produces byte-identical prompt artifacts, with a negative control showing the assertion has teeth.**

## Performance

- **Duration:** single extended session, 3 tasks
- **Tasks:** 3/3 completed
- **Files modified:** 11 (5 created, 6 modified)

## Accomplishments

- `buildDeveloperPrompt` renders declared `context.files` — path and content, in declared order, head-and-tail truncated at `context.max_bytes` with an explicit elision marker, or a refusal (`PromptContextOverflowError`) when `on_overflow: 'error'` — and a repository file present on disk but not declared never appears in the render.
- Fixed a latent, pre-existing template-injection-order bug found while extending the renderer: the old per-placeholder `split/join` loop re-scanned already-substituted (untrusted) content on every subsequent call, so a spec narrative or context file containing a literal `{{rawSpec}}`-shaped token would be substituted a second time. A single-pass, global-regex, function-replacer substitution closes this and remains immune to the `$&`/`$$` string-replacement hazard the original code already guarded against.
- `packages/agent-claude-code/test/argv.test.ts` pins `--bare` (the auto-discovery-disabling flag) on every invocation across three differing option sets, and proves the system prompt reaches the argv verbatim — without modifying `backend.ts`.
- `packages/manager/src/prompt/artifact.ts` (`writePromptArtifact`/`promptArtifactPathFor`) persists the rendered prompt as a sibling of the transcript (same directory, same stem, differing only in extension), composing on `transcriptPathFor` rather than re-implementing its address validation or containment guard. An identical rewrite is a no-op; a different rewrite for the same attempt is a named refusal (`PromptArtifactConflictError`).
- `stage-runner.ts` writes the artifact after rendering and **before** launching the agent; a write failure fails the attempt (`stage_error`) rather than being swallowed.
- `packages/manager/test/prompt/determinism.test.ts` proves success criterion 4 against real, persisted artifacts (never a same-process renderer comparison): one daemon running two byte-identical-content features with real wall-clock time elapsing between dispatches; the same content under two separate daemon **processes** started from different working directories; a distinctive environment variable set only for the second run; and a negative control (a changed spec changes the artifact) proving the byte-identity assertions are not vacuous. All comparisons are over file bytes with a custom matcher that names the first differing byte offset.

## Task Commits

Each task was committed atomically:

1. **Task 1: ADL is the sole source of the agent's context, and the invocation says so** - `51d40b2` (feat)
2. **Task 2: The rendered prompt is persisted per attempt, beside the transcript** - `275ff0d` (feat)
3. **Task 3: Two runs, one commit, byte-identical prompts — proven from the artifacts** - `d9e4535` (test)

**Plan metadata:** this SUMMARY's own commit (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave merges)

## Files Created/Modified

- `packages/manager/src/prompt/artifact.ts` - `writePromptArtifact`/`promptArtifactPathFor` — the persisted prompt artifact, a sibling of the transcript
- `packages/manager/src/prompt/build.ts` - declared-context-files rendering, truncation/overflow handling, single-pass template substitution
- `packages/manager/src/prompt/templates/developer.md` - added the "Repository Context" section and a determinism warning comment
- `packages/manager/src/worker-entry/stage-runner.ts` - writes the prompt artifact before launching the agent; threads `workspace.root` into `buildDeveloperPrompt`; gained an injectable `agentBackend` test seam
- `packages/manager/src/index.ts` - exported the artifact surface and the two new `build.ts` error classes
- `packages/agent-claude-code/test/argv.test.ts` - new: pins `--bare` and the explicit system prompt across option sets
- `packages/manager/test/prompt/artifact.test.ts` - new: path derivation, write/no-op/conflict, and the "artifact exists before the agent runs" + "write failure fails the attempt" integration tests
- `packages/manager/test/prompt/determinism.test.ts` - new: the byte-identity proof, including the cross-process leg
- `packages/manager/test/helpers/run-dev-run-once.mjs` - new: a real second daemon process helper for the cross-process proof
- `packages/manager/test/prompt/build.test.ts` - new tests for declared context files, truncation, overflow-as-error, and no-env-leak
- `packages/manager/test/prompt/run-build-once.mjs` - added the now-required `workspaceRoot` fixture value

## Decisions Made

See `decisions` in the frontmatter above for the six load-bearing design choices this plan made (workspaceRoot ownership, cascade scoping, per-file truncation, artifact extension, the two-different-features substitution for "run twice," and the cross-process cwd choice).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Per-placeholder template substitution re-scanned already-substituted, untrusted content**
- **Found during:** Task 1, extending `build.ts` to add the `declaredContextFiles` placeholder.
- **Issue:** The existing `substitute(template, literal, value)` loop called `split(literal).join(value)` once per placeholder, in sequence, against the CUMULATIVE result. If an earlier value (e.g. the spec narrative, or a declared context file's content — both untrusted, repo-supplied) happened to contain the literal text of a placeholder not yet substituted (e.g. `{{rawSpec}}`), a later call would replace that occurrence too — untrusted content that is supposed to render inert becoming a second, uncontrolled substitution point.
- **Fix:** Replaced the loop with a single `template.replace(globalRegex, (match, key) => values[key])` pass over the ORIGINAL template. A function replacer's return value is inserted literally (no `$&`/`$$` reinterpretation — the original hazard this code already guarded against), and a single pass over the unmodified template never re-scans a value for further placeholder syntax.
- **Files:** `packages/manager/src/prompt/build.ts`.
- **Verification:** `build.test.ts`'s existing `$&`/`$$` test still passes; the new declared-context-files tests exercise multiple untrusted values substituted in one render.

**2. [Rule 3 - Blocking] `POST /dev-run/:featureId` refuses a second dispatch of the same feature id**
- **Found during:** Task 3, writing `determinism.test.ts`'s first draft (re-dispatching one feature twice).
- **Issue:** `dev-run.ts` returns 409 for a feature whose `state` is no longer `'queued'` — true immediately after the first attempt completes, since nothing in this phase (Phase 5's loop runner is the owner) requeues a feature.
- **Fix:** The "run the same feature twice" tests dispatch two DIFFERENT feature ids carrying byte-identical spec content instead. `NormalizedSpec.id` (the folder name) is verified, independently, to never reach `buildDeveloperPrompt`'s rendered output — so this substitution proves the identical claim the task names, not a weaker one. Documented at length in `determinism.test.ts`'s own comments and in this SUMMARY's `decisions`.
- **Files:** `packages/manager/test/prompt/determinism.test.ts`.
- **Verification:** the test suite itself, plus `build.test.ts`'s pre-existing coverage that no spec-id-shaped value appears in a rendered prompt.

**3. [Rule 3 - Blocking] Default `concurrency.global: 1` refused the second of two intentionally-concurrent dispatches**
- **Found during:** Task 3, running the two-features-one-daemon test — the second `POST /dev-run` returned 409 "dispatch could not proceed."
- **Fix:** The test's own `daemonConfigFixture` sets `concurrency: { global: 2 }`, documented inline as necessary because this suite deliberately dispatches two features against one daemon before the first's worker has fully exited.
- **Files:** `packages/manager/test/prompt/determinism.test.ts`.

**4. [Rule 3 - Blocking] `--import tsx` cannot resolve the loader from a `cwd` outside the repository tree**
- **Found during:** Task 3, the cross-process test's first draft (child processes run with `cwd` set to their own temp repositories).
- **Fix:** The two child processes run from two real, distinct sibling package directories inside the repo (`packages/agent-claude-code`, `packages/workspace`) instead — both resolve `tsx` via Node's directory walk-up, and both are still genuinely different `process.cwd()` values.
- **Files:** `packages/manager/test/prompt/determinism.test.ts`.

**5. [Rule 3 - Blocking] pino's default stdout transport corrupted the cross-process script's base64 payload**
- **Found during:** Task 3, the cross-process test — the decoded artifact bytes were garbage from byte 0.
- **Issue:** `startDaemon` defaults to a pino logger at `level: 'info'`, which writes JSON lines to stdout — the same stream `run-dev-run-once.mjs` uses to hand its one meaningful value (the artifact's base64 bytes) back to the parent test.
- **Fix:** The script passes `logger: pino({ level: 'silent' })` to `startDaemon`.
- **Files:** `packages/manager/test/helpers/run-dev-run-once.mjs`.

**6. [Rule 3 - Blocking] `startDaemon`'s own `migrationsDir` does not bootstrap a database with no `meta` table**
- **Found during:** Task 3, the cross-process script's first run — `SqliteError: no such table: meta`.
- **Issue:** `runStartupGate` reads `meta.schema_version` before any other database access; it handles a VERSION MISMATCH against an already-bootstrapped database, not the first-ever migration of a truly empty file.
- **Fix:** The script explicitly calls `migrateToLatest(db, MIGRATIONS_DIR)` against its own `createDb(dbFilePath)` connection before calling `startDaemon`, matching `dev-run-end-to-end.test.ts`'s own established precedent.
- **Files:** `packages/manager/test/helpers/run-dev-run-once.mjs`.

---

**Total deviations:** 6 auto-fixed (1 Rule 1 bug fix, 5 Rule 3 blocking-issue fixes, all inside test infrastructure or the module already being extended).
**Impact on plan:** All auto-fixes were necessary for correctness (the template-injection-order bug) or to make the plan's own required tests actually run (the five Rule 3 items, all confined to test scaffolding). No scope creep — no production code changed beyond what Tasks 1 and 2 already specified.

## Issues Encountered

None beyond the auto-fixed deviations above — each was found and resolved while writing/running this plan's own required tests.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `buildDeveloperPrompt`'s declared-context-files surface, `writePromptArtifact`/`promptArtifactPathFor`, and the determinism proof are all real, tested, and wired into `createProductionStageRunner` end to end — no redesign expected for Phase 5's loop runner or Phase 9's pull-request rollup (which the `04-06` SUMMARY already named as a future consumer of the artifact pointer).
- The context-file CASCADE (`resolveContextFiles`, the `AGENTS.md`/`CLAUDE.md`/`.github/copilot-instructions.md`/`README.md` fallback) is still not wired into `mergeConfig`'s output — a natural, separate follow-up whenever a phase needs "no `context.files` declared" to mean something other than "no context supplied."
- `promptArtifactPathFor`'s `attempt` is still hardcoded to `1` in `stage-runner.ts` (unchanged from `04-06`) — a real repair/retry ordinal is not yet threaded through `AssignMessage`, tracked as a known, non-urgent gap since `04-06`.

## Self-Check: PASSED

- FOUND: `packages/manager/src/prompt/artifact.ts`
- FOUND: `packages/manager/test/prompt/artifact.test.ts`
- FOUND: `packages/manager/test/prompt/determinism.test.ts`
- FOUND: `packages/manager/test/helpers/run-dev-run-once.mjs`
- FOUND: `packages/agent-claude-code/test/argv.test.ts`
- FOUND: `packages/manager/src/prompt/build.ts` (modified)
- FOUND: `packages/manager/src/worker-entry/stage-runner.ts` (modified)
- FOUND commit `51d40b2` in `git log --oneline`
- FOUND commit `275ff0d` in `git log --oneline`
- FOUND commit `d9e4535` in `git log --oneline`

## Verification

- `pnpm --filter @adl/manager test`: 226/226 passed (28 test files).
- `pnpm --filter @adl/agent-claude-code test`: 29/29 passed (4 test files).
- `pnpm -r test` (whole workspace): cli 24/24, core 446/446, agent-claude-code 29/29, plugin-sdk 28/28, db 75/75, workspace 222/228 (6 skipped, Windows-gated), manager 226/226.
- `npx vitest run --project root` (architecture/spawn-ban suite): 65/65 passed.
- `pnpm lint`, `pnpm -r typecheck`, `pnpm run format`: all exit 0.
- The determinism suite's negative control confirmed the byte-identity assertions are not vacuous (a changed spec produces a differing artifact).

---

*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
