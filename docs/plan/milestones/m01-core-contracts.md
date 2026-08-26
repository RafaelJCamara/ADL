# M01 — Core Contracts

**Status:** ✅ Done · 2026-08-17
**Depends on:** nothing (first milestone)
**Requirements:** CORE-01…06, SPEC-01…05, EXEC-07 (12)

**Goal:** every downstream component speaks one settled vocabulary — verdicts, findings,
criterion IDs, normalized specs, target-repo configuration — so no later milestone can
force a contract migration.

Pure, no I/O. This milestone also landed the database schema, because cost recording in
M05 cannot be designed against data that was never collected.

---

## Done when

- [x] A gate result is exactly one of six outcomes, only `send_back` consumes a round, a
      malformed verdict is an infrastructure failure rather than a gate failure, and a
      developer that believes a gate is wrong has an honest escalation outcome.
- [x] No combination of verdicts containing `inconclusive` can compute to green —
      proven exhaustively — and every finding carries fingerprint, severity, location,
      and criterion ID or fails validation.
- [x] A structured ADL spec and a Gherkin feature file both load into one normalized
      shape with individually addressable criterion IDs, original text retained verbatim.
- [x] `adl.yml` validates build/start/test/teardown commands and its `ready` /
      `ready_timeout` contract, and resolves context files through the
      `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` cascade.
- [x] A new gate stage is added by configuration alone — the transition function is
      untouched and no migration is required.

---

## What shipped

- **Six-outcome verdict union** — `packages/core/src/verdict/verdict.ts`. Frozen
  `OUTCOMES`, discriminated `VerdictSchema`, `consumesRound()` true only for `send_back`.
  `SkipVerdict` has no `checked` field at all, so a skipped gate is _structurally_
  incapable of contributing criterion coverage.
- **`aggregate()` proven exhaustively** — `packages/core/src/verdict/aggregate.ts`.
  Precedence `fail → send_back → inconclusive → green`; green reachable from exactly one
  return behind three guards. `test/verdict/aggregate.exhaustive.test.ts` enumerates all
  **3,002 multisets** for pipeline lengths 1–8. Zero offenders, permutation-invariant.
- **Published JSON Schema that provably matches the Zod schema** —
  `packages/core/schema/verdict.schema.json`, emitted by `scripts/emit-json-schema.ts`
  with a byte-comparison drift gate (`emit:schema:check`). A 40-fixture corpus runs
  through both Zod and an independent `ajv` validator; zero disagreements.
- **Infrastructure failures can't masquerade as gate failures** —
  `packages/core/src/stage/stage-error.ts`. `StageError` sits outside the verdict union;
  `stageErrorPolicy` is a closed 5-kind table with `consumesRound: false` throughout.
  Mutual non-assignability asserted at compile time in `test/stage/type-boundary.test-d.ts`.
- **Self-approval is unrepresentable** — `packages/core/src/stage/developer-outcome.ts`.
  Exactly three members (`committed` / `dispute` / `blocked`), no `pass`.
- **Two spec formats, one flat `AC-n` sequence** — `spec/markdown.ts` + `spec/gherkin.ts`
  both route through `spec/criterion-ids.ts`, the single choke point that numbers criteria
  and refuses an empty set. Criterion text is a byte-exact `raw.slice(start, end)`.
- **`adl.yml` validation surface** — `config/adl-yml.ts` (argv arrays only; a shell string
  is a typed error naming the field), `duration.ts`, `path-guard.ts`, and `yaml-parse.ts`
  (the only module importing `yaml`, with six hardened parse options).
- **`EffectiveConfig` fold with daemon-authoritative clamps** — `config/effective-config.ts`.
  Repo values clamp down-only; `agents.*.backend` / `.model` from a repo are discarded and
  the attempt reported. `interpolate.ts` never reads `process.env`.
- **Lifecycle state machine** — `state/transition.ts`. 11 states × 15 event kinds = 165
  pairs, all total and non-throwing. `SEND_BACK_ROUND_DELTA` is _computed_ by calling
  `consumesRound()`, never restated.
- **Database layer** — `packages/db`. Migrations `0001`–`0004`, 11 tables, a migration
  checksum guard proven by mutating a migration byte and watching the migrator refuse,
  and `pricing.ts` returning `cost_source: 'unknown'` with `cost_usd: null` (never zero)
  for an unknown model.

## Deliberately excluded

- No filesystem, `child_process`, or `process.env` anywhere in `@adl/core` — grep-verified
  and lint-enforced by the `adl/core-purity` rule.
- No `.refine()` / `.superRefine()` under `verdict/` — silently dropped by
  `z.toJSONSchema()`, so lint bans them there.
- Gherkin Scenario Outlines are **not** expanded per Examples row: one criterion, table
  retained verbatim, placeholders unexpanded. A one-way contract decision.
- `group:` pipeline syntax parses and is unconditionally rejected as a v2 capability.
- Outbox, forge-event and artifact tables absent by design (a `DEFERRED_TABLES` test
  asserts it) — they arrive with M09.

## Still open

Nothing blocking. Two soft items live in [`DEBT.md`](../DEBT.md): fingerprint-normalisation
_strength_ is unproven (deferred to M06 evidence), and the `version: 1` "additive keys only"
promise is untestable.
