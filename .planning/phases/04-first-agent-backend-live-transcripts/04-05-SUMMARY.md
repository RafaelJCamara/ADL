---
phase: 04-first-agent-backend-live-transcripts
plan: 05
subsystem: infra
tags: [ndjson, zod, filesystem, byte-offset, transcript]

# Dependency graph
requires:
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-03: AgentEvent/TranscriptRecordSchema — the on-disk envelope this store appends and reads"
  - phase: 04-first-agent-backend-live-transcripts
    provides: "04-04: bookkeeping/attempt.ts's AttemptAddress/findAttempt — the DB-resolved shape transcriptPathFor accepts, and openAttempt's round/stage-attempt rows the address addresses"
provides:
  - "transcriptPathFor(root, address): pure, type-safe path builder — logs/<feature>/<round>/<stage>/<attempt>.ndjson — that only accepts a resolved TranscriptAddress and refuses a hostile component rather than sanitising it"
  - "logsRootFor(dbFilePath): the logs-root derivation both a future worker wiring and the manager compute identically"
  - "openTranscriptWriter/readTranscriptFrom/transcriptLength: the byte-offset append-and-read primitive ARCHITECTURE.md §9's ?offset=N&follow=1 addressing depends on"
affects: [04-06-worker-stage-execution, 04-08-logs-sse-route, phase-09-pr-rollup, phase-17-dashboard]

# Actuals (#2632)
actuals:
  tokens: 9200
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reject-not-sanitise path-component validation with a named, structured error (component + value) — mirrors resolveHarnessId's isRepoRelativePath refusal in packages/core/src/config/pipeline.ts"
    - "Lexical (not realpath-walking) containment backstop for a path builder that must run before its own output directory exists — resolveWithinRoot from @adl/workspace reused directly rather than assertWithinRoot, since assertWithinRoot requires the root to already exist on disk"
    - "Three-outcome discriminated union for a store read (read | absent | past-end), mirroring ScratchHomeTeardown's (removed | already-absent | not-removed) discipline"
    - "Byte-offset tracking via re-stat after write (not accumulated Buffer.byteLength) — makes the offset-equals-file-size guarantee true by construction"

key-files:
  created:
    - packages/manager/src/store/transcript-path.ts
    - packages/manager/src/store/ndjson-log-store.ts
    - packages/manager/test/store/transcript-path.test.ts
    - packages/manager/test/store/ndjson-log-store.test.ts
  modified:
    - packages/manager/src/index.ts

key-decisions:
  - "transcriptPathFor uses @adl/workspace's resolveWithinRoot (the synchronous, lexical containment guard) as its backstop rather than assertWithinRoot (the async, realpath-walking one the plan's action text names). assertWithinRoot requires the root to already exist on disk; transcriptPathFor is called to compute a path BEFORE openTranscriptWriter creates the directory chain underneath it, so a builder that could only run once its own output directory exists would not be the pure function of an address the plan's own must_haves require. resolveWithinRoot enforces the identical rule with no filesystem access."
  - "TranscriptAddress is a type alias for AttemptAddress (bookkeeping/attempt.ts), re-exported under the store module's own name rather than a new shape, so the type-level guarantee is literally 'the shape findAttempt returns' and not merely 'a shape that looks like it'."
  - "logsRootFor(dbFilePath) is exported (unlike daemon.ts's inline scratchRoot expression) because — unlike scratchRoot, computed once by the manager at boot — a transcript's root must be computed identically by two different call sites (the writer's path and the reader's path), which is exactly the drift risk publishing one calculation removes. Wiring it into daemon.ts/AssignMessage is out of this plan's file scope (04-05's files_modified lists only store/ and index.ts) and is left for the worker-wiring plan that actually calls openTranscriptWriter."

patterns-established:
  - "Reject-not-sanitise per-component path validation, named-error style (TranscriptAddressError{component, value}) — a later path-building module addressing an untrusted-looking id should follow this rather than re-arguing sanitisation."

requirements-completed: [OBS-02]

coverage:
  - id: D1
    description: "transcriptPathFor is a pure function of a resolved TranscriptAddress: the same address produces the identical path, two attempts differing only in attempt number produce different paths, and the builder only accepts the resolved address type (a bare string is a compile-time error)"
    requirement: OBS-02
    verification:
      - kind: unit
        ref: "packages/manager/test/store/transcript-path.test.ts#transcriptPathFor"
        status: pass
    human_judgment: false
  - id: D2
    description: "A hostile address component (path separator, ..-reference, drive-letter prefix, NUL byte, empty string) is refused with a named TranscriptAddressError rather than silently sanitised, and every path produced satisfies @adl/workspace's own containment check against the logs root"
    requirement: OBS-02
    verification:
      - kind: unit
        ref: "packages/manager/test/store/transcript-path.test.ts#transcriptPathFor > refuses a hostile component rather than sanitising it"
        status: pass
    human_judgment: false
  - id: D3
    description: "openTranscriptWriter creates the parent directory chain and appends TranscriptRecords as one line each, with the returned offset equal to the file's real byte size after every call — including when the appended record contains a multi-byte character"
    requirement: OBS-02
    verification:
      - kind: unit
        ref: "packages/manager/test/store/ndjson-log-store.test.ts#openTranscriptWriter"
        status: pass
    human_judgment: false
  - id: D4
    description: "readTranscriptFrom resumes from a byte offset, returns whole records only (a partial final line is neither emitted nor counted, and is emitted exactly once once complete), and reports absent/past-end as named outcomes rather than throwing or returning an ambiguous empty array; a negative/non-integer/non-finite offset is refused before reaching the filesystem"
    requirement: OBS-02
    verification:
      - kind: unit
        ref: "packages/manager/test/store/ndjson-log-store.test.ts#readTranscriptFrom"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-08-20
status: complete
---

# Phase 4 Plan 5: NDJSON Transcript Store Summary

**A type-safe transcript path builder (`logs/<feature>/<round>/<stage>/<attempt>.ndjson`) that only accepts a database-resolved `TranscriptAddress`, plus a byte-offset append-and-read primitive that lets a reader reconnect at any offset without dropping or repeating a record.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-20
- **Tasks:** 2
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `packages/manager/src/store/transcript-path.ts`: `transcriptPathFor(root, address)` builds a transcript's path as a pure function of a resolved `TranscriptAddress` (a type alias for `bookkeeping/attempt.ts`'s `AttemptAddress`) — a bare string id is a compile-time error, not a runtime check
- Every address component is validated and **refused, not sanitised**, when it carries a path separator, a `.`/`..` reference, a drive-letter prefix, or a NUL byte — a named `TranscriptAddressError` identifies which component and why
- `resolveWithinRoot` (from `@adl/workspace`) backstops the containment guarantee, reusing the existing implementation rather than writing a second one
- `logsRootFor(dbFilePath)` derives the logs root beside the database file, mirroring `daemon.ts`'s `scratchRoot` derivation, published so the worker and the manager compute the identical root
- `packages/manager/src/store/ndjson-log-store.ts`: `openTranscriptWriter(path)` creates the parent directory chain and appends `TranscriptRecord`s one line at a time, returning the file's new byte length as the next offset — verified against the real file size after every write, so a multi-byte character in agent output never desynchronises a reader
- `readTranscriptFrom(path, offset)` returns a three-outcome union (`read` / `absent` / `past-end`) rather than throwing or returning an ambiguous empty array — a reader attaching before the file exists, or past the current end, is an ordinary outcome
- Whole-records-only reading: a partial final line (the writer mid-append) is neither emitted nor counted toward the next offset, and is emitted exactly once once it completes — proven directly by a test that writes a record's bytes in two halves
- `transcriptLength(path)` answers the current byte length, or `undefined` for an absent file, with no read of the file's content
- Both modules exported from `@adl/manager`'s barrel with "why public" comments naming the worker and the transcript route (04-08) as the two consumers that must agree on offsets

## Task Commits

1. **Task 1: Where a transcript lives, derived from a resolved address and nothing else** - `643f231` (feat)
2. **Task 2: Append-and-read with byte offsets a reader can resume from** - `d6d961e` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/manager/src/store/transcript-path.ts` - `TRANSCRIPT_EXTENSION`, `TranscriptAddress`, `TranscriptAddressError`, `transcriptPathFor`, `logsRootFor`
- `packages/manager/test/store/transcript-path.test.ts` - Path-determinism, refusal, containment, and `@ts-expect-error` type-boundary proofs
- `packages/manager/src/store/ndjson-log-store.ts` - `TranscriptWriter`, `TranscriptRead`, `TranscriptOffsetError`, `openTranscriptWriter`, `readTranscriptFrom`, `transcriptLength`
- `packages/manager/test/store/ndjson-log-store.test.ts` - Offset, partial-line, multi-byte, absent-file, and past-end proofs
- `packages/manager/src/index.ts` - Barrel exports for both modules, each with a "why public" comment

## Decisions Made

- **`resolveWithinRoot`, not `assertWithinRoot`, is the containment backstop.** The plan's action text names `assertWithinRoot` by name, but `assertWithinRoot` walks the filesystem via `realpath` and requires the root to already exist on disk — `transcriptPathFor` computes a path *before* `openTranscriptWriter` (Task 2) creates the directory chain underneath it, so a builder that could only succeed once its own output directory exists would contradict the plan's own must_have that the path be "a pure function of a resolved attempt address." `resolveWithinRoot` — the lexical half of the same guard, exported from the same `@adl/workspace` barrel entry the action text points at — enforces the identical rule with no filesystem access, and is what every component's pre-validation (no `..`, no separator, no drive-letter prefix) already guarantees passes. Documented in the module's own docblock rather than silently substituted.
- **`TranscriptAddress` is a type alias for `AttemptAddress`**, not a new shape, so "the builder accepts only the resolved address type" is literally "the shape `findAttempt` returns," re-exported under the store module's own name so a consumer of `store/transcript-path.js` need not import from `bookkeeping/`.
- **`logsRootFor` is exported rather than left inline** (unlike `daemon.ts`'s `scratchRoot` expression) because it must be computed identically by two different call sites in the general case; wiring it into `daemon.ts`/`AssignMessage` is left to the plan that actually calls `openTranscriptWriter` in the worker, since `daemon.ts` and `protocol.ts` are outside this plan's `files_modified`.
- **`openTranscriptWriter.append` validates via `TranscriptRecordSchema.parse` before serialising**, not merely trusting the caller's `TranscriptRecord`-typed argument — catching a malformed record at the write site is cheaper than discovering it can't be read back later. Not explicitly required by the plan's acceptance criteria; added under deviation Rule 2 (see below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - auto-add missing critical functionality] Validated `TranscriptRecord` with `TranscriptRecordSchema.parse` inside `append`, before serialising**
- **Found during:** Task 2, implementing `openTranscriptWriter`
- **Issue:** The plan's `<action>` describes `append` serialising the record it is given; it does not explicitly require re-validating it. A `TranscriptRecord`-typed argument built by a caller elsewhere in the codebase is already schema-shaped at the type level, but a value from a less-trusted boundary (e.g. a future harness-adjacent caller) constructing one by hand could still violate a runtime invariant `TranscriptRecordSchema` enforces (e.g. an `AgentEvent` with an unmodelled extra field, caught by `.strictObject`) that `JSON.stringify` alone would not catch — it would just serialize whatever was handed to it.
- **Fix:** `append` calls `TranscriptRecordSchema.parse(record)` and serialises the parsed (not the raw) value, so a malformed record fails loudly at the write site rather than becoming an unreadable line discovered only when something later tries to read the transcript back.
- **Files modified:** `packages/manager/src/store/ndjson-log-store.ts`
- **Verification:** `pnpm --filter @adl/manager test` — all 185 tests pass, including the "every appended record occupies exactly one line" test, which round-trips every appended record through `TranscriptRecordSchema.parse` on read
- **Committed in:** `d6d961e` (Task 2)

**2. [Rule 3 - blocking] The `@ts-expect-error` type-boundary test needed a runtime wrapper**
- **Found during:** Task 1, writing the acceptance criterion's `@ts-expect-error` assertion
- **Issue:** Unlike a `.test-d.ts` file (which `vitest`'s typecheck stage reads but never executes), a `@ts-expect-error` comment placed inside a regular `.test.ts` file only suppresses the compiler's error — the line underneath it still runs under `vitest run`. Calling `transcriptPathFor(root, 'a-bare-string')` at runtime threw an unhandled `TypeError` (`Cannot read properties of undefined`) reading `.featureId` off a string, failing the whole suite rather than proving the type-boundary.
- **Fix:** Wrapped the call in `expect(() => { ... }).toThrow()`, matching the codebase's own precedent for this exact situation (`packages/core/test/config/effective-config.test.ts`'s two `@ts-expect-error` assertions inside `expect(() => {...}).toThrow(TypeError)`). `pnpm --filter @adl/manager typecheck` (which runs `tsc --noEmit -p tsconfig.test.json`, and does typecheck `test/**/*.ts` per that config's own docblock) still enforces that the `@ts-expect-error` comment continues to suppress a real error — no separate `.test-d.ts` file was needed, unlike `04-03`'s `agent-runner.test-d.ts` precedent, because `@adl/manager`'s `tsconfig.test.json` (unlike `@adl/core`'s build-only `tsconfig.json`) already includes `test/**/*.ts` in what `pnpm -r typecheck` compiles.
- **Files modified:** `packages/manager/test/store/transcript-path.test.ts`
- **Verification:** `pnpm --filter @adl/manager test` passes (185/185); `pnpm -r typecheck` exits 0 with the `@ts-expect-error` comment present and meaningful (removing it locally to confirm reproduces a real `tsc` failure, then re-added)
- **Committed in:** `643f231` (Task 1)

---

**Total deviations:** 2 auto-fixed (1 Rule 2 — missing runtime validation, 1 Rule 3 — blocking test-infrastructure fix)
**Impact on plan:** Both are scoped additions inside the two files the plan already names. No scope creep into `daemon.ts`, `protocol.ts`, or any file outside this plan's `files_modified` list.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Self-Check: PASSED

- FOUND: `packages/manager/src/store/transcript-path.ts`
- FOUND: `packages/manager/src/store/ndjson-log-store.ts`
- FOUND: `packages/manager/test/store/transcript-path.test.ts`
- FOUND: `packages/manager/test/store/ndjson-log-store.test.ts`
- FOUND: `packages/manager/src/index.ts` (modified)
- FOUND commit `643f231` in `git log --oneline`
- FOUND commit `d6d961e` in `git log --oneline`
- `pnpm --filter @adl/manager test`: 21/21 test files, 185/185 tests pass
- `pnpm -r typecheck`, `pnpm lint`, `pnpm format`: all exit 0

## Next Phase Readiness

- `transcriptPathFor`, `logsRootFor`, `openTranscriptWriter`, `readTranscriptFrom`, and `transcriptLength` are published from `@adl/manager`'s barrel and ready for the worker-side wiring (calling `openTranscriptWriter` as `AgentEvent`s arrive during stage execution) and the transcript SSE route (`04-08`, calling `readTranscriptFrom`/`transcriptLength` behind `?offset=N&follow=1`, resolving the attempt id through `findAttempt` first per T-4-15)
- `logsRootFor`/`AssignMessage` wiring — actually threading a logs root into the worker's environment, the way `04-04` threaded `scratchRoot` — is explicitly **not** done here; it is out of this plan's file scope and is the natural first step of whichever plan calls `openTranscriptWriter` for real
- No blockers. `pnpm --filter @adl/manager test`, `pnpm -r typecheck`, `pnpm lint`, and `pnpm format` all exit 0 on this worktree (Windows leg); the offset/multi-byte assertions are written to be platform-neutral (byte counts verified against `fs.stat`, not assumed) but have not yet been run on the Linux CI leg from this worktree

---
*Phase: 04-first-agent-backend-live-transcripts*
*Completed: 2026-08-20*
