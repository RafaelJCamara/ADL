# Phase 1: Core Contracts - Research

**Researched:** 2026-08-17
**Domain:** Pure TypeScript contract design — Zod-first schemas, discriminated unions, dual-format spec parsing (markdown + Gherkin), YAML config validation, and hand-written SQLite migrations
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Acceptance Criterion Identity**

- **D-01:** Criterion IDs are **positional** (`AC-1`, `AC-2`, …) assigned in document order at parse time, with a per-criterion **`textHash`** stored alongside. The readable ID is what agents cite, what findings carry, and what the PR coverage table renders; `textHash` exists solely to detect that a criterion's meaning changed between spec revisions, so a stale cross-revision join can be invalidated instead of silently mis-joining. Within a single run this cannot bite — the normalized spec and `spec_hash` are snapshotted at lease time, and an edited spec creates a new feature revision rather than mutating the running one. — **Reversibility:** one-way — the ID is embedded in every persisted finding, test result, send-back brief, and PR comment; changing the scheme means re-running every agent prompt to regenerate the joins.

- **D-02:** **One flat `AC-n` sequence across both spec formats.** A Gherkin scenario is a single criterion with `kind: 'scenario'` retaining its Given/When/Then structure inside the record; an ADL-template bullet is `kind: 'statement'`. No separate `SCN-n` namespace, and no addressable sub-steps (`AC-4.T2`). The behaviour tester branches on `kind` in the **prompt template**, never in the loader. — **Reversibility:** one-way — same blast radius as D-01, plus every coverage-table row on every open PR.

- **D-03:** `criterionRef` is a **required discriminated union** on every `Finding`: `{ kind: 'criterion', id } | { kind: 'global', category }`. A reviewer code-quality finding or a semgrep SARIF result declares `global` with a category rather than omitting the field. This satisfies CORE-04 and success criterion 2 without a sentinel string, and lets the PR coverage table honestly show an untied-findings bucket instead of hiding one. — **Reversibility:** costly — the field is on every persisted finding; widening or relaxing it later is a data migration over the findings table plus a re-render of every open PR comment.

- **D-04:** Unknown criterion IDs are handled **asymmetrically by direction**. On a *finding*: one repair retry, then demote to `{ kind: 'global' }` and flag it loudly on the PR. In a *`pass` verdict's cited-coverage list*: one repair retry, then classify the verdict as malformed via the CORE-06 path. Rationale: demoting a complaint is safe, whereas accepting fabricated evidence that a criterion was checked is exactly the silently-wrong-but-green failure this project exists to prevent. — **Reversibility:** reversible.

**Developer Escalation & Waivers**

- **D-05:** The developer's result is its **own union**, not a `Verdict`: `DeveloperOutcome = { kind: 'committed', sha } | { kind: 'dispute', … } | { kind: 'blocked', reason }`. The developer structurally cannot emit `pass` — self-approval is unrepresentable rather than merely forbidden by a runtime guard. The pipeline sequencer special-cases index 0, since `develop` is always the implicit first mutator. — **Reversibility:** costly — unifying it into `Stage`/`Verdict` later touches the sequencer, the `stage_attempts` persistence shape, and the published plugin SDK.

- **D-06:** A **dispute must be structured**: it carries the `criterionRef` it concerns, the fingerprint of the specific finding (or the stage ID) it disputes, and a stated argument. Missing any of those makes it *malformed*, not a dispute. A dispute **consumes no round** — CORE-01 reserves that for `send_back`, and charging for the honest exit re-creates the exact economic pressure the exit removes. Structure is what makes a dispute triageable, fingerprintable for stall detection, and renderable beside the gate's position on the PR. — **Reversibility:** reversible.

- **D-07:** **`Waiver` is a Phase-1 contract**: `{ target: criterionRef | stageId, reason, actor, at }`. A waived gate reports `skip` carrying the waiver, and the PR displays it. Without this, the `escalated → queued` human-retry edge has no way to express *what changed*, so the same gate fails identically on the next round. Phase 1 defines the shape and persistence; Phase 6 enforces it. — **Reversibility:** costly — it is a table plus a field on the verdict path; adding it after Phase 6 means a migration and re-deriving escalation history.

- **Constraint carried in, not re-decided:** multi-agent arbitration is **out of scope** per REQUIREMENTS.md ("Escalating to a human is cheaper, more honest, and does not risk two agents agreeing on something wrong"). A dispute escalates to a human. Do not design a reconsideration round.

**Verdict Aggregation & the Green Proof**

- **D-08:** One **pure total function** `aggregate(verdicts) → RoundOutcome`. The "no verdict set containing `inconclusive` computes green" property is proven by **enumerating every multiset** of the six outcomes up to max pipeline length (~1,300 cases at 8 stages — milliseconds to run), so success criterion 2's word *exhaustively* is literally true rather than approximated. Supplement with property tests for order-independence and the empty list. No type-level encoding of green — the runtime function is the single enforcement point, because TypeScript cannot also prove the verdict list covers every configured stage. — **Reversibility:** reversible.

- **D-09:** `RoundOutcome` is a **discriminated union**: `{kind:'green'} | {kind:'send_back', brief} | {kind:'escalate', reason} | {kind:'unverified', inconclusive[]}`. "Gates said no" stays structurally distinct from "we could not tell" — which is the entire reason `inconclusive` exists. The loop, the PR rollup, and the escalation path each branch on one value instead of re-deriving the classification from the raw verdict list. — **Reversibility:** costly — three consumers branch on it, one of which is the PR rendering.

- **D-10:** Precedence is **`fail` → `send_back` → `inconclusive` → `warn`/`skip`/`pass`**. A broken gate short-circuits to escalation. But when *any* gate produced actionable findings, the developer receives them, because an `inconclusive` sitting alongside real findings usually resolves once the code changes (the app failed to start *because* of the bug). Only an `inconclusive` with **no `send_back` anywhere** escalates. Still structurally incapable of producing green. — **Reversibility:** reversible.

- **D-11:** `PassVerdict` requires a **non-empty `checked: criterionRef[]`**. ROLE-04's "an approval citing none is malformed rather than an approval" is enforced by the Phase-1 schema, not deferred to Phase 7 where the reviewer lands. Command gates cite `{ kind: 'global' }` — honest, and visibly different from claiming criterion coverage. FORGE-08's coverage table depends on this data existing from the very first stored verdict. — **Reversibility:** one-way — adding a required field after verdicts are persisted invalidates every stored row.

**Infrastructure Failure vs Gate Failure (CORE-06)**

- **D-12:** A stage yields **`Verdict | StageError`**. `StageError { kind: 'unparseable' | 'provider_error' | 'timeout' | 'binary_missing' | 'auth', retryable, raw }` sits **outside the six-outcome union entirely** — "the gate judged" and "the gate broke" are different kinds of thing, which is precisely what CORE-06's "never as a gate failure" says. LOOP-07 (a provider outage consuming neither round nor budget) rides the same channel instead of needing its own. — **Reversibility:** one-way — it is the return type of the interface third-party harness authors implement against.

- **D-13:** Parse strategy: schema-constrained output where the backend supports it → fenced-JSON extraction → **exactly one reprompt** carrying the parse error → `StageError`. Bounded cost, recovers the common case (valid JSON wrapped in prose), fails fast when the model is genuinely confused. — **Reversibility:** reversible.

- **D-14:** Repair-retry and failed-parse spend is **recorded and counted** against the feature budget, tagged `costCategory: 'overhead'` so `adl show` and the PR cost line can display it separately. A budget that quietly ignores some spend is not a budget; the maintainer should see both what the feature cost and what ADL wasted. — **Reversibility:** costly — `usage_events` needs the column from the first migration (see D-29).

- **D-15:** `StageError` looping is **bounded by error kind via `retryable`**. Transient kinds (provider 429/5xx) back off against a wall-clock deadline and consume neither round nor budget — LOOP-07 exactly. Non-transient kinds (unparseable, binary missing, auth) increment a consecutive-error counter and escalate at N, default 2. The `retryable` flag already on `StageError` does the routing; no new concept. — **Reversibility:** reversible.

**Feature Specs on Disk**

- **D-16:** A feature is **`features/<id>/`** containing one spec entry file plus optional supporting files (mockups, sample payloads, schemas), which become `contextRefs`. Folder name is the feature id **and** the branch suffix. No manifest file. — **Reversibility:** one-way — it is the public authoring convention; changing it breaks every adopter's repository layout.

- **D-17:** Format detection is **by filename and deterministic**: `*.feature` → Gherkin, `spec.md` → ADL template. Both present, or neither, is a **load error** — never a guess. Content sniffing is rejected on principle: a spec that sniffs wrong produces silently wrong acceptance criteria which then propagate into every prompt, finding, and coverage row downstream. — **Reversibility:** costly — public convention, though additional detection rules could be layered additively.

- **D-18:** The ADL structured template is **headings-only markdown**. Required: `# Title`, `## Acceptance Criteria`. Optional: `## Intent`, `## Non-Goals`, `## Constraints`, `## Context Files`. No frontmatter, no second syntax to get wrong. `raw` is always retained verbatim beside the parse (CORE-05), and the developer prompt contains both the raw spec and the ID'd criteria checklist. — **Reversibility:** costly — adding optional headings later is free; renaming or removing a required one is not.

- **D-19:** Criteria are extracted from **top-level list items only**; nested bullets are detail belonging to their parent criterion's text. This hands the author direct control over granularity — indent to elaborate, outdent to add a criterion. An absent or empty `## Acceptance Criteria` section **fails to load**, so a spec can never enter the loop with zero criteria. Avoids the free-prose-criteria failure the research names. — **Reversibility:** costly — changing the extraction rule changes criterion count, and therefore every ID (see D-01).

**`adl.yml` & Effective Configuration**

- **D-20:** `ready` is a **discriminated union of probe kinds** — `{ http, expect? } | { tcp } | { log } | { exec }` — with `ready_timeout`. Covers web apps, databases, queue workers and CLIs without a plugin; `exec` is the universal escape hatch (`pg_isready`, a probe script) and runs through `workspace.exec` per WORK-02. ROLE-07 promises ADL owns the lifecycle for *any* app, not only HTTP ones. — **Reversibility:** reversible — new probe kinds are additive.

- **D-21:** ADL allocates the port and exports **`ADL_PORT`**; `adl.yml` references it explicitly in `start.env` and in the probe (`http://127.0.0.1:${ADL_PORT}/health`). Interpolation is restricted to a **small documented set of ADL-provided variables — not general shell expansion** — so repo-supplied config gains no new execution surface. — **Reversibility:** costly — public config convention.

- **D-22:** `EffectiveConfig = defaults ← daemon config ← repo adl.yml`, with **daemon-enforced clamps**. `limits.*` may only be *lowered* from the daemon's ceiling; backend and credential selection is **daemon-only**. Repo-supplied `adl.yml` is untrusted input under the recorded trust boundary ("anyone who can write a file into a watched repo can execute code on the ADL host with ADL's credentials") — a budget the watched repo can raise is not a budget, and a backend it can choose is a credential-selection primitive. — **Reversibility:** one-way — this is a security property. Loosening it later is trivial; tightening it later breaks adopters' working configs.

- **D-23:** Pipeline entries are **strings for built-ins, objects when configured**: `[develop, review, { harness: 'security', with: {…} }, test]`. `harness:` resolves through a registry — built-in id, then npm package name, then repo-relative path. **Unknown ids fail at config validation, not mid-run.** The `group:` syntax ships as **parse-and-reject** so v2 parallelism does not break the file format. This is how EXEC-07 is satisfied: position is a list index, and adding a gate touches config only. — **Reversibility:** costly — public config format.

**Repository Skeleton**

- **D-24:** **pnpm 11.22.0 workspaces.** This resolves the ARCHITECTURE.md (npm workspaces) vs STACK.md/CLAUDE.md (pnpm) conflict in STACK.md's favour. Rationale: strict `node_modules` makes an undeclared cross-package import fail at resolve time, which is what turns "the worker may not import an adapter" from a review convention into a structural rule — and that rule *is* the vendor-neutrality guarantee. `catalog:` pins one version of TypeScript and Zod across every package without a syncing tool. Contributors get pnpm via corepack. — **Reversibility:** reversible.

- **D-25:** Phase 1 scaffolds **only `@adl/core` and `@adl/plugin-sdk`**, plus root tooling and CI. No placeholder packages for the other ~13 — empty packages rot, confuse contributors, and make `pnpm -r build` a list of no-ops. The `plugin-sdk` split happens **now, not later**, because it is a published package name and a dependency boundary, and extracting it after eleven phases have imported from `core` is a wide mechanical refactor at the worst possible moment. — **Reversibility:** reversible for adding packages; the core/plugin-sdk split itself is costly to undo once published.

- **D-26:** **Zod is the source of truth** for every contract; TypeScript types come from `z.infer`. The verdict-file contract is **additionally emitted as JSON Schema** so a non-TypeScript command gate (Python, Go, a shell script) has a real published spec for `.adl/verdicts/*.json` — HARN-02 promises a gate may be a plain command, and a plain command cannot read a TypeScript type. `@adl/core`'s "zero dependencies" therefore becomes "one dependency": Zod. — **Reversibility:** costly — the JSON Schema becomes a published artifact third parties validate against.

- **D-27:** The **`no-restricted-imports` dependency-graph lint rule lands in Phase 1** with the workspace, before any adapter exists to violate it. Phase 2's no-direct-spawn rule then slots into a mechanism that already exists and already fails CI. Architecture rules written alongside the first thing they would have prevented tend not to get written. — **Reversibility:** reversible.

**Database Schema & Migrations**

- **D-28:** A new **`@adl/db` package** owns schema, hand-written SQL migrations, generated Kysely types, and the migration runner. It is the only package that touches `better-sqlite3`; `core` never learns a database exists, preserving the phase's purity claim where it matters. The narrow repository layer the research asks for gets an obvious home, and the later `node:sqlite` or Postgres swap is contained to one package. — **Reversibility:** costly — moving it later means changing every import in manager and worker.

- **D-29:** Phase 1 defines **the tables Phases 1-5 need, plus `usage_events` and `model_prices(effective_from)`** — the two the roadmap names specifically, because Phase 5 records per-invocation cost against them and cost accounting cannot be designed against data that was never collected. Outbox, forge-event dedupe, and artifact tables arrive with the phases that use them. Migrations are additive and hand-written, so growth is the normal path. — **Reversibility:** reversible — additive migrations.

- **D-30:** Migrations **execute against a temp SQLite file in CI**, plus a **checksum guard** that fails the build if a previously-applied migration file changes. ADL ships schema upgrades into other people's installations, so editing an already-applied migration corrupts *their* database while CI stays green — the failure mode that never shows up where you can see it. — **Reversibility:** reversible.

- **D-31:** `model_prices` is **seeded by migration and overridable in daemon config**. An unrecognised model records `costSource: 'unknown'` rather than silently pricing at zero — this is BACK-09's "degrading visibly": the budget announces it cannot price something instead of quietly ceasing to enforce. Prices never live in code. — **Reversibility:** costly — the seeding mechanism and the `costSource` enum are both consumed by Phase 6's budget gate.

### Claude's Discretion

The user selected the recommended option in all eight areas; nothing was explicitly delegated. The following were surfaced during discussion but deliberately left to the researcher and planner:

- `Finding.fingerprint` input set and title-normalisation strength (research proposes `sha256(stage_id + normalised_title + path)`; too strict never fires stall detection, too loose fires falsely). Line numbers must be excluded — code moves.
- Timeout units in `adl.yml` (`"10m"` strings vs milliseconds) and what `version: 1` guarantees across ADL upgrades.
- Gherkin `Background`, `Scenario Outline`, and `Examples` handling within the `kind: 'scenario'` record.
- `context.max_bytes` cap behaviour when the cascade resolves to something oversized.
- tsconfig strategy (`nodenext`, no bundler per the stack research), Vitest setup, and whether `plugin-sdk` re-exports from `core` or owns its own types.
- Where raw unparseable agent output is retained (artifact vs DB) and how it is size-capped.
- Exact table list for "what Phases 1-5 need" beyond `usage_events` and `model_prices`.

### Deferred Ideas (OUT OF SCOPE)

No scope creep occurred — discussion stayed inside the phase boundary throughout. The following were touched and consciously routed to their own phases:

- **Waiver *enforcement*** — Phase 1 defines the `Waiver` shape and persistence (D-07); Phase 6 (Accountant) implements escalation and the human-retry path that consumes it.
- **`on_send_back` fail-fast defaults by cost class** — the research's `cheap/free → continue`, `expensive → stop` policy is pipeline runtime behaviour. Phase 1 only needs the config fields to exist and validate; Phase 7 implements the policy.
- **`group:` parallel pipeline stages** — v2. Phase 1 ships the syntax as parse-and-reject (D-23) so the file format does not break later; the `mutates` flag and `Workspace.snapshot()` that unlock it belong to Phase 2.
- **`retryable` backoff *execution*** — Phase 1 defines the `StageError` kinds and the `retryable` flag (D-12, D-15); the backoff loop and wall-clock deadline are loop runtime, landing with Phase 6's LOOP-07 work.
- **Cost-accounting spike** — already recorded in STATE.md as a blocker on Phase 6 planning, best run against a real agent turn during Phase 4/5. Phase 1's job is only to make sure `usage_events` and `model_prices` can hold whatever it finds (D-29, D-31).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORE-01 | A gate returns exactly one of six outcomes — `pass`, `send_back`, `fail`, `inconclusive`, `warn`, `skip` — and only `send_back` consumes a round | `z.discriminatedUnion('outcome', …)` verified against zod@4.4.3 (§Code Examples 1). `consumesRound` is a derived pure predicate, not a stored field — the six-outcome table in SUMMARY.md §Reconciled Decisions 1 is the source of truth |
| CORE-02 | An `inconclusive` verdict is structurally incapable of producing a green PR | Exhaustive multiset enumeration is **3,002 cases** for lengths 1–8 (1,287 at exactly 8); numbers verified by computation (§Code Examples 4). This makes "proven exhaustively" literal |
| CORE-03 | A developer agent that believes a gate is wrong can escalate rather than comply | `DeveloperOutcome` as a separate `z.discriminatedUnion('kind', …)` — the developer schema has no `pass` member, so `parse()` rejects self-approval structurally (D-05) |
| CORE-04 | Every finding carries a fingerprint, severity, source location, and the acceptance-criterion ID it relates to | `criterionRef` as a required nested discriminated union; `.min(1)`/`.length(64)`/`.regex()` are all structurally expressible so they survive JSON Schema emission (§Pitfall 1) |
| CORE-05 | A feature spec's acceptance criteria are enumerable and individually addressable, and the original spec text is retained verbatim alongside | `mdast` `listItem.position.start/end.offset` gives exact byte offsets into the source for verbatim per-criterion slices (verified, §Code Examples 2). Gherkin retains `raw` at the document level |
| CORE-06 | A malformed or unparseable agent verdict is classified as an infrastructure failure, never as a gate failure | `StageError` outside the `Verdict` union (D-12). Zod's `invalid_union` issue carries `note: "No matching discriminator"` + the `options` list — verified, and it is the exact payload the D-13 reprompt should carry |
| SPEC-01 | Maintainer can describe a feature using ADL's structured spec template and have it accepted | `mdast-util-from-markdown@2.0.3` — heading/list siblings at `tree.children`, section = walk-until-next-heading-of-depth-≤ (verified, §Code Examples 2) |
| SPEC-02 | Maintainer can describe a feature as Gherkin/BDD scenarios and have it accepted | `@cucumber/gherkin@42.0.1` + `@cucumber/messages@34.2.1`; `Parser.parse(src) → GherkinDocument`. AST types read from the shipped `.d.ts` and behaviour confirmed by running the parser (§Code Examples 3, §Pitfalls 2–4) |
| SPEC-03 | Maintainer declares build, start, test, and teardown commands for their repo in `adl.yml` | `yaml@2.9.0` + Zod. `argv` arrays only, never shell strings (ARCHITECTURE.md §7) |
| SPEC-04 | Maintainer declares an explicit readiness signal and timeout in `adl.yml` | `ready` as `z.discriminatedUnion('kind', …)` per D-20; cross-field `ready`⇒`ready_timeout` requirement via `.superRefine` (verified; config is not JSON-Schema-published so a refine is safe here — §Pitfall 1) |
| SPEC-05 | Maintainer can point `adl.yml` at additional context files; absent that, ADL falls back through `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` | Cascade is an ordered constant array in `@adl/core`; **resolution is I/O and belongs to the caller** — core exposes the ordered candidate list + a pure `pickFirstPresent(candidates, exists)` (§Architectural Responsibility Map) |
| SPEC-06 | *(Phase 5 — not this phase)* | — |
| EXEC-07 | Adding a harness requires no change to the feature lifecycle state machine | `gating` is one `FeatureState`; pipeline position is `current_stage_index` data. The proof is a test asserting `transition()`'s source text is byte-identical across a 3-stage and a 4-stage pipeline fixture, plus a migration-count assertion (§Code Examples 5) |
</phase_requirements>

## Summary

Phase 1 is unusually low-risk technically and unusually high-risk *contractually*. Every library it needs is mature, zero-to-low dependency, and behaves exactly as documented — I verified each by executing it rather than reading about it. The risk lives entirely in three places where a library's actual behaviour differs from what a careful reader would assume, and where the divergence is **silent**: Zod 4 drops `.refine()` constraints when emitting JSON Schema; the Gherkin parser accepts empty and structurally-degenerate feature files without throwing, and silently discards orphan steps; and Kysely's migration table has no checksum column, so D-30's guard is entirely ADL's to build. Each of those three would produce a Phase-1 deliverable that looks correct, passes its own tests, and is wrong in production — precisely the "silently-wrong-but-green" class this project exists to prevent.

The stack is settled by CLAUDE.md and CONTEXT.md and needs no debate: TypeScript 6.0.3 (pinned — TS 7.0.2 is now `latest` on npm and breaks `typescript-eslint@8.67.0`, whose peer range is `>=4.8.4 <6.1.0`, verified), Zod 4.4.3, pnpm 11.22.0, Kysely 0.29.5 + better-sqlite3 13.0.3, Vitest 4.1.10, `yaml` 2.9.0. Two additions this research introduces because the phase cannot be built without them: `@cucumber/gherkin` 42.0.1 (with `@cucumber/messages` 34.2.1) for SPEC-02, and `mdast-util-from-markdown` 2.0.3 for SPEC-01. The second carries a real cost worth naming up front: it pulls ~34 transitive micromark packages into `@adl/core`, which turns D-26's "one dependency: Zod" into "Zod plus two parser families". That is the correct trade — mdast's byte-offset `position` data is what makes CORE-05's verbatim-retention and D-01's `textHash` exact rather than approximate — but the planner should restate the dependency claim honestly in the package README rather than let it drift.

The `yaml` library's security posture is markedly better than the `js-yaml` reputation would suggest, and I confirmed all of it by execution: alias bombs throw (`ReferenceError: Excessive alias count indicates a resource exhaustion attack`), duplicate keys throw, multi-document input throws, `!!js/function` tags resolve to inert strings with a warning rather than executing, and merge keys (`<<`) are off by default. `__proto__` is set as an own property and does *not* pollute `Object.prototype`; Zod's `z.object()` then strips it entirely. Given D-22 explicitly treats `adl.yml` as untrusted input, these are the load-bearing facts, and none of them require configuration — they are the defaults.

**Primary recommendation:** Build every contract as a Zod schema whose constraints are **structurally expressible** (`z.literal`, `.min(1)`, `.regex()`, `z.enum`) rather than `.refine()`-based, because `z.toJSONSchema()` silently discards refinements — then add a contract test that round-trips a fixture corpus through both `VerdictSchema.parse()` and an independent JSON-Schema validator and asserts identical accept/reject verdicts. That single test is what makes D-26's published JSON Schema an honest contract instead of a weaker shadow of the TypeScript one.

## Architectural Responsibility Map

Phase 1 is "pure, no I/O" (CONTEXT.md domain). The map's job here is to keep that claim true — every capability below is assigned to the tier that owns it, and the ones that touch the filesystem are explicitly *not* in `@adl/core`.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Verdict / Finding / `criterionRef` / `Waiver` schemas | `@adl/core` (pure) | `@adl/plugin-sdk` (re-export) | Zod schema objects are values, not I/O; harness authors need the same shapes |
| `aggregate(verdicts) → RoundOutcome` | `@adl/core` (pure) | — | Total function over an in-memory array; the CORE-02 enforcement point |
| `transition(state, event, ctx)` | `@adl/core` (pure) | — | ARCHITECTURE.md §2 explicitly: no I/O, exhaustively tested |
| Markdown → `NormalizedSpec` parse | `@adl/core` (pure) | — | Takes a `string`, returns a value. File reading is the caller's |
| Gherkin → `NormalizedSpec` parse | `@adl/core` (pure) | — | Same — `Parser.parse(source: string)` |
| **Format detection (D-17)** | `@adl/core` (pure) | caller supplies listing | Core exposes `detectFormat(filenames: string[])`; the `readdir` is the caller's |
| **Reading `features/<id>/*`** | *Not Phase 1* | Phase 2 workspace / Phase 5 detector | Filesystem access — would break the purity claim |
| `adl.yml` YAML parse + Zod validation | `@adl/core` (pure) | — | Takes the file *contents* as a string |
| `EffectiveConfig` merge + daemon clamps (D-22) | `@adl/core` (pure) | — | Pure fold over three plain objects |
| **Context-file cascade resolution (SPEC-05)** | `@adl/core` (pure predicate) | Phase 2 workspace (the `exists` probe) | Core owns the *ordered candidate list* and `pickFirstPresent(candidates, exists)`; the caller injects `exists` |
| `${ADL_PORT}` restricted interpolation (D-21) | `@adl/core` (pure) | — | String substitution against a closed allowlist — no shell, no env read |
| JSON Schema emission (D-26) | `@adl/core` build step | CI artifact check | `z.toJSONSchema()` at build time; the emitted file is committed and diffed in CI |
| Fingerprint / `textHash` / `specHash` | `@adl/core` | — | `node:crypto` `createHash('sha256')` is a builtin, not I/O |
| DB schema + hand-written SQL migrations | `@adl/db` | — | D-28: the only package that touches `better-sqlite3` |
| Migration runner + checksum guard (D-30) | `@adl/db` | CI | Kysely `Migrator` + an ADL-owned checksum table |
| Generated Kysely `Database` types | `@adl/db` build step | CI drift check | Introspect a migrated temp DB; commit and diff |
| Dependency-graph lint rule (D-27) | root tooling | CI | ESLint flat config at the workspace root |

**Consequence for the planner:** `@adl/core` must have **no `node:fs` import anywhere**, and that should be enforced by the same `no-restricted-imports` mechanism D-27 introduces — add `node:fs`, `node:fs/promises`, and `node:child_process` to `@adl/core`'s restricted list in the same commit that adds the adapter rule. Enforcing purity by lint costs one config block now; discovering a stray `readFileSync` in Phase 5 costs a refactor.

## Project Constraints (from CLAUDE.md)

Directives extracted from `./.claude/CLAUDE.md` that the plan must comply with:

| # | Directive | Applies to Phase 1 as |
|---|-----------|----------------------|
| C-1 | **TypeScript 6.0.3 exact pin.** Do NOT use TypeScript 7 — `typescript-eslint@8.67.0` peers `>=4.8.4 <6.1.0` | `"typescript": "6.0.3"` exact (no `^`) in the pnpm `catalog:`. **Verified**: npm `latest` for typescript is now **7.0.2**, so an unpinned install silently breaks lint |
| C-2 | Node 24 LTS dev target; `engines: ">=22.12.0"` | Set both in root `package.json`. Kysely 0.29.5 requires `node >=22.0.0` (verified) |
| C-3 | pnpm 11.22.0 + workspaces + `catalog:` | `packageManager` field + `pnpm-workspace.yaml` with a `catalog:` block |
| C-4 | Zod 4.4.3 for all runtime validation | Single catalog entry; every package uses `catalog:` |
| C-5 | Kysely 0.29.5 + **hand-written SQL migrations**; Drizzle rejected, no migration-upgrade phase exists | `@adl/db` uses `Kysely` + `sql` template tag; no `drizzle-kit` |
| C-6 | better-sqlite3 13.0.3 — the only DB driver | `@adl/db` only (D-28) |
| C-7 | Vitest 4.1.10 | Root + per-package `vitest.config.ts` |
| C-8 | `yaml` 2.9.0 preferred over `js-yaml` (better error positions — "you'll be showing config errors to users") | Use `YAML.parseDocument` so `doc.errors[]` carries line/column for user-facing config errors |
| C-9 | ESLint 10.8.1 + typescript-eslint 8.67.0 + Prettier 3.9.6 | Flat config at root; this is where D-27's rule lives |
| C-10 | **`tsc` only — do NOT add a bundler.** Node ESM + `"module": "nodenext"` means `tsc` output runs directly | `tsconfig.base.json` with `module: nodenext`, `moduleResolution: nodenext`; no tsup/esbuild/tsdown |
| C-11 | `tsx` 4.23.12 as the dev runner | `dev` scripts only |
| C-12 | `lefthook` 2.1.10 for git hooks (over husky) | Optional in Phase 1; cheap to add with the workspace |
| C-13 | `@changesets/cli` — "add once you publish more than one package. **Not before.**" | Phase 1 has two publishable packages (`core`, `plugin-sdk`) → the threshold is met; adding it here is defensible |
| C-14 | **Hardcoded model prices in code are forbidden** — versioned `model_prices` table with `effective_from` | D-31; see §Code Examples 6 for the seed |
| C-15 | **Date-suffixed Claude model IDs will 404** — current IDs are bare aliases | The `model_prices` seed must use bare IDs |
| C-16 | Do NOT use `tiktoken`/`gpt-tokenizer` for Anthropic token counts | Phase 1 stores *reported* token counts; no estimator anywhere in `@adl/db` |
| C-17 | ESM/CJS: `better-sqlite3` is CJS — use `import Database from 'better-sqlite3'` (default import) under `nodenext` | `@adl/db` only |
| C-18 | `ulid` 3.0.2 for primary keys — lexicographically sortable, URL-safe | Use for `feature_events.id`, `stage_attempts.id`, `usage_events.id` |
| C-19 | Avoid `biome` (npm) — that name is an unrelated typosquat; the real package is `@biomejs/biome` | Not used; noted so nobody "helpfully" adds it |
| C-20 | GSD workflow enforcement — no direct repo edits outside a GSD command | Process constraint on execution, not on the plan's content |

**Conflict noted and resolved:** ARCHITECTURE.md § Recommended Project Structure specifies **npm workspaces**; CLAUDE.md and D-24 specify **pnpm**. D-24 supersedes — pnpm, explicitly.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript` | **6.0.3** (exact) | Language | `[VERIFIED: npm registry]` `typescript@6.0.3` exists; `typescript-eslint@8.67.0` `peerDependencies.typescript = ">=4.8.4 <6.1.0"` — TS 7.0.2 (current `latest`) is outside it |
| `zod` | **4.4.3** | Single source of truth for every contract (D-26) | `[VERIFIED: npm registry]` `dist-tags.latest = 4.4.3`. Native `z.toJSONSchema()` removes the need for `zod-to-json-schema` |
| `@cucumber/gherkin` | **42.0.1** | Parse `*.feature` → AST (SPEC-02) | `[VERIFIED: npm registry]` The reference Gherkin implementation, maintained by the Cucumber org. ESM-only (`"type": "module"`), single dependency: `@cucumber/messages` |
| `@cucumber/messages` | **34.2.1** | Gherkin AST type definitions | `[VERIFIED: npm registry]` Zero dependencies. Required peer-of-sorts: gherkin declares `">=34.0.0 <35"` |
| `mdast-util-from-markdown` | **2.0.3** | Parse ADL-template markdown → mdast with byte offsets (SPEC-01, CORE-05) | `[VERIFIED: npm registry]` The unified/remark core parser without the `unified` pipeline overhead. `position.start.offset`/`end.offset` are the CORE-05 mechanism |
| `yaml` | **2.9.0** | `adl.yml` parsing (SPEC-03/04/05) | `[VERIFIED: npm registry]` YAML 1.2, positioned errors, and a hardened default posture (§Security Domain) |
| `kysely` | **0.29.5** | Typed SQL builder + migration runner (`@adl/db`) | `[VERIFIED: npm registry]` Zero runtime dependencies; `engines.node >= 22.0.0` |
| `better-sqlite3` | **13.0.3** | SQLite driver (`@adl/db` only, D-28) | `[VERIFIED: npm registry]` Installed and executed on this machine — prebuild, no `node-gyp`, bundles SQLite **3.53.4** |
| `ulid` | **3.0.2** | Sortable primary keys | `[VERIFIED: npm registry]` Per C-18 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | **4.1.10** | Test runner | `[VERIFIED: npm registry]` `engines.node: ^20 \|\| ^22 \|\| >=24` |
| `tsx` | **4.23.12** | Dev runner | `[VERIFIED: npm registry]` Dev scripts only; never in `build` |
| `eslint` | **10.8.1** | Lint host for D-27's rule | `[VERIFIED: npm registry]` |
| `typescript-eslint` | **8.67.0** | TS lint rules; the reason TS is pinned to 6.x | `[VERIFIED: npm registry]` |
| `prettier` | **3.9.6** | Formatting | `[ASSUMED]` (version from CLAUDE.md, not independently re-verified this session) |
| `@types/better-sqlite3` | **9.6.0** | Kysely's optional peer for the SQLite dialect | `[VERIFIED: npm registry]` `@adl/db` devDependency |
| `kysely-codegen` | **0.20.0** | Generate the `Database` interface from a migrated temp DB | `[VERIFIED: npm registry]` Last publish 2026-02-16 — slower cadence than Kysely itself. Optional; a hand-written `Database` interface is a valid alternative (see Alternatives) |
| `lefthook` | **2.1.10** | Git hooks | `[ASSUMED]` (from CLAUDE.md) |
| `@changesets/cli` | **3.0.0** | Versioning two published packages | `[ASSUMED]` (from CLAUDE.md) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `mdast-util-from-markdown` (~34 transitive deps) | `marked` (1 dep) or a hand-rolled line scanner | `marked`'s token stream lacks reliable byte offsets for nested list items, which is exactly what CORE-05's verbatim slice and D-01's `textHash` need. A hand-rolled scanner is ~150 lines and gets CommonMark list-continuation wrong in ways that silently change criterion count (D-19 says that changes every ID). **Recommendation: take the dependency**, restate `@adl/core`'s dependency claim honestly |
| `kysely-codegen` | Hand-write the `Database` interface | Codegen needs a *migrated live DB*, so it's a build-step-plus-temp-file dance; hand-writing is ~120 lines for a 10-table schema and drifts silently. **Recommendation: hand-write in Phase 1** (the schema is small and you just authored it), add a CI drift check that runs `kysely-codegen` against the temp DB and fails on diff. Best of both, no runtime dependency |
| `zod-to-json-schema@3.25.2` | — | Superseded: Zod 4 has native `z.toJSONSchema()`. Adding the separate package is a redundant dependency |
| `z.toJSONSchema()` for the published contract | Hand-write the JSON Schema | Hand-writing guarantees drift. Emit from Zod + commit the artifact + diff in CI |
| Kysely migrations | `node:sqlite` + raw SQL runner | Kysely is already the query builder; its `Migrator` handles ordering and locking. But see §Pitfall 5 — the migration table has no checksum and SQLite migrations are **not** transactional under Kysely |
| `ms` package for `"10m"` durations | Zod `.regex()` + a 15-line parser | `ms@2.1.3` last published 2025-09-08 and accepts loose input (`"10 minutes"`, negative values). Discretion item — see §Open Questions 2 |

**Installation:**

```bash
# Workspace root (devDependencies)
pnpm add -D -w typescript@6.0.3 vitest@4.1.10 tsx@4.23.12 \
  eslint@10.8.1 typescript-eslint@8.67.0 prettier@3.9.6 \
  @changesets/cli@3.0.0 lefthook@2.1.10

# packages/core
pnpm --filter @adl/core add zod@4.4.3 @cucumber/gherkin@42.0.1 \
  @cucumber/messages@34.2.1 mdast-util-from-markdown@2.0.3 yaml@2.9.0

# packages/db
pnpm --filter @adl/db add kysely@0.29.5 better-sqlite3@13.0.3 ulid@3.0.2
pnpm --filter @adl/db add -D @types/better-sqlite3@9.6.0 kysely-codegen@0.20.0

# packages/plugin-sdk  (types + re-exports only)
pnpm --filter @adl/plugin-sdk add zod@4.4.3
```

**Version verification performed this session:** every version above was checked with `npm view <pkg> version` and `npm view <pkg> dist-tags`. `typescript@6.0.3` was confirmed to still resolve despite `latest` having moved to `7.0.2`. `better-sqlite3@13.0.3` was additionally **installed and executed** to confirm a prebuild exists for this platform.

## Package Legitimacy Audit

Run via `gsd-tools query package-legitimacy check --ecosystem npm …` this session.

| Package | Registry | Latest publish | Weekly downloads | Source Repo | Verdict | Disposition |
|---------|----------|----------------|------------------|-------------|---------|-------------|
| `zod` | npm | 2026-05-04 | 224,127,336 | github.com/colinhacks/zod | **OK** | Approved |
| `yaml` | npm | 2026-05-11 | 163,067,115 | github.com/eemeli/yaml | **OK** | Approved |
| `mdast-util-from-markdown` | npm | 2026-02-21 | 35,686,652 | github.com/syntax-tree/mdast-util-from-markdown | **OK** | Approved |
| `vitest` | npm | 2026-07-06 | 77,612,487 | github.com/vitest-dev/vitest | **OK** | Approved |
| `typescript` | npm | 2026-07-08 | 180,404,383 | github.com/microsoft/TypeScript | **OK** | Approved |
| `ulid` | npm | 2025-11-30 | 8,869,982 | github.com/ulid/javascript | **OK** | Approved |
| `kysely` | npm | 2026-08-10 | 11,657,376 | github.com/kysely-org/kysely | SUS (`too-new` only) | Approved — heuristic false positive |
| `better-sqlite3` | npm | 2026-08-05 | 6,858,675 | github.com/WiseLibs/better-sqlite3 | SUS (`too-new` only) | Approved — heuristic false positive |
| `@cucumber/gherkin` | npm | 2026-08-05 | 5,808,446 | github.com/cucumber/gherkin | SUS (`too-new` only) | Approved — heuristic false positive |
| `@cucumber/messages` | npm | 2026-08-05 | 6,651,287 | github.com/cucumber/messages | SUS (`too-new` only) | Approved — heuristic false positive |
| `tsx` | npm | 2026-08-10 | 72,095,539 | (privatenumber/tsx) | SUS (`too-new` only) | Approved — heuristic false positive |
| `eslint` | npm | 2026-08-07 | 135,093,798 | github.com/eslint/eslint | SUS (`too-new` only) | Approved — heuristic false positive |
| `typescript-eslint` | npm | 2026-08-10 | 61,153,896 | (typescript-eslint/typescript-eslint) | SUS (`too-new` only) | Approved — heuristic false positive |
| `prettier` | npm | 2026-07-21 | 111,128,037 | github.com/prettier/prettier | SUS (`too-new` only) | Approved — heuristic false positive |
| `dependency-cruiser` | npm | 2026-08-10 | 2,311,700 | github.com/sverweij/dependency-cruiser | SUS (`too-new` only) | **Not adopted** — D-27 uses ESLint `no-restricted-imports` |

**Packages removed due to [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** `kysely`, `better-sqlite3`, `@cucumber/gherkin`, `@cucumber/messages`, `tsx`, `eslint`, `typescript-eslint`, `prettier`, `dependency-cruiser`.

**Reading the SUS verdicts honestly:** in every case the *only* reason returned was `too-new`, and the signal the seam reads is the **most recent release date**, not the package's age. Every one of these has millions of weekly downloads and a canonical source repository, and none declares a `postinstall` script (checked). These are heuristic false positives caused by recent, routine releases — not supply-chain risk. **No `checkpoint:human-verify` task is warranted for these**; the seam's own signal payload contradicts its verdict. The planner should not gate installs on them.

**`postinstall` audit:** `npm view <pkg> scripts.postinstall` returned `null` for all packages above. `better-sqlite3` has an `install` script (the standard prebuild-install fallback to `node-gyp`); on this machine it resolved to a prebuild in 3 seconds with no compilation.

**Provenance note:** `@cucumber/gherkin`, `@cucumber/messages`, and `mdast-util-from-markdown` were not named in CLAUDE.md's Technology Stack and were selected during this research. Their APIs are `[VERIFIED]` because I read the shipped `.d.ts` files and executed the parsers; their *selection* is `[ASSUMED]` (see Assumptions Log A1, A2). They are the canonical implementations in their ecosystems, but a `checkpoint:human-verify` before the first install of these two families is a cheap, defensible gate.

## Architecture Patterns

### System Architecture Diagram

```
                       ┌──────────────────────────────────────────────┐
   INPUTS              │              @adl/core  (PURE)               │
                       │                                              │
 spec source ─────────▶│  detectFormat(filenames[])                   │
 (string, from caller) │        │                                     │
                       │        ├─ "*.feature" ──▶ GherkinLoader ──┐  │
                       │        │                  (Parser+AstBuilder)│
                       │        ├─ "spec.md"  ───▶ MarkdownLoader ─┤  │
                       │        │                  (fromMarkdown)   │  │
                       │        └─ both / neither ▶ ✖ LoadError     │  │
                       │                                           ▼  │
                       │                              assignCriterionIds()
                       │                              (flat AC-1..AC-n,
                       │                               + sha256 textHash)
                       │                                           │  │
                       │                                           ▼  │
 adl.yml text ────────▶│  YAML.parseDocument ─▶ AdlYmlSchema ──┐  NormalizedSpec
 (string, from caller) │       (positioned errors)             │  { raw, specHash,
                       │                                       │    criteria[] }
 daemon config ───────▶│  mergeConfig(defaults, daemon, repo)  │        │
                       │       + clampLimits()  (D-22)         ▼        │
                       │       + interpolate(${ADL_PORT})  EffectiveConfig
                       │       + resolvePipeline(registryIds)   │        │
                       │                                        ▼        ▼
                       │   ┌────────────── CONTRACT LAYER ──────────────────┐
                       │   │  VerdictSchema (6-outcome discriminated union) │
                       │   │  FindingSchema (criterionRef required)         │
                       │   │  StageErrorSchema      (OUTSIDE Verdict)       │
                       │   │  DeveloperOutcomeSchema (no `pass` member)     │
                       │   │  WaiverSchema                                  │
                       │   └───────┬───────────────────────────────┬────────┘
                       │           │                               │
                       │           ▼                               ▼
                       │   aggregate(Verdict[])            transition(state, event)
                       │       → RoundOutcome                  → TransitionResult
                       │   {green|send_back|escalate         (gating = ONE state;
                       │    |unverified}                      stage index is DATA)
                       └───────────┬───────────────────────────────┬────────┘
                                   │                               │
        ┌──────────────────────────┴───────┐                       │
        ▼                                  ▼                       ▼
 ┌───────────────┐              ┌─────────────────────┐   ┌──────────────────┐
 │ @adl/plugin-  │              │  build step:        │   │    @adl/db       │
 │     sdk       │              │  z.toJSONSchema()   │   │  (only package   │
 │ re-exports    │              │       │             │   │   touching       │
 │ Stage/Verdict │              │       ▼             │   │   better-sqlite3)│
 │ /Finding for  │              │  verdict.schema.json│   │                  │
 │ 3rd parties   │              │  (committed +       │   │  migrations/*.ts │
 └───────────────┘              │   CI-diffed)        │   │  → Kysely Migrator│
                                └─────────┬───────────┘   │  + checksum guard│
                                          │               │  → temp .db (CI) │
                                          ▼               │  → Database types│
                                  non-TS command gates    └──────────────────┘
                                  validate .adl/verdicts/*.json
```

### Recommended Project Structure

```
.
├── pnpm-workspace.yaml         # packages/* + catalog: (TS, Zod pinned once)
├── package.json                # packageManager, engines >=22.12.0, root scripts
├── tsconfig.base.json          # module: nodenext, strict, no bundler (C-10)
├── eslint.config.js            # flat config; D-27 no-restricted-imports lives here
├── vitest.workspace.ts
├── .changeset/
├── .github/workflows/ci.yml    # typecheck · lint · test · migrate-temp-db · schema-diff
└── packages/
    ├── core/                   # @adl/core — PURE. no node:fs, no node:child_process
    │   ├── src/
    │   │   ├── verdict/        #   Verdict, Finding, criterionRef, StageError,
    │   │   │                   #   DeveloperOutcome, Waiver, aggregate()
    │   │   ├── state/          #   FeatureState, FeatureEvent, transition()
    │   │   ├── spec/           #   detectFormat, markdown loader, gherkin loader,
    │   │   │                   #   criterion id assignment, hashing
    │   │   ├── config/         #   adl.yml schema, EffectiveConfig merge, clamps,
    │   │   │                   #   ${ADL_PORT} interpolation, context cascade list
    │   │   └── index.ts
    │   ├── schema/             #   EMITTED + COMMITTED verdict.schema.json (D-26)
    │   ├── scripts/emit-json-schema.ts
    │   └── test/fixtures/      #   good/ and bad/ spec + adl.yml + verdict corpora
    ├── plugin-sdk/             # @adl/plugin-sdk — Stage/StageContext + re-exports
    └── db/                     # @adl/db — schema, migrations, runner, repo layer
        ├── migrations/         #   0001_initial.ts … (hand-written SQL via sql``)
        ├── src/
        │   ├── schema.ts       #   hand-written Kysely `Database` interface
        │   ├── migrator.ts     #   Migrator wiring + checksum guard (D-30)
        │   └── repository/     #   the narrow DAL the research asks for
        └── test/
```

### Pattern 1: Structurally-Expressible Constraints (the D-26 discipline)

**What:** Every constraint that must appear in the published JSON Schema is expressed with a *structural* Zod combinator (`z.literal`, `z.enum`, `.min()`, `.max()`, `.length()`, `.regex()`), never with `.refine()`/`.superRefine()`.

**When to use:** Any schema that flows into `z.toJSONSchema()` — i.e. `Verdict`, `Finding`, `criterionRef`, `StageError`. Cross-field rules in `adl.yml` (which is *not* published as JSON Schema) may use `.superRefine()` freely.

**Why:** `.refine()` is **silently dropped** by `z.toJSONSchema()` — verified by execution. A refined schema emits as though the refinement never existed, producing a published contract strictly weaker than the TypeScript one.

```typescript
// Source: verified against zod@4.4.3 by execution this session
import * as z from 'zod';

// ✅ Structural — survives JSON Schema emission
export const CriterionIdSchema = z.string().regex(/^AC-\d+$/);
export const PassVerdictSchema = z.object({
  outcome: z.literal('pass'),
  summary: z.string().min(1),
  checked: z.array(CriterionRefSchema).min(1),   // D-11, emitted as minItems: 1
});

// ❌ Refined — parse() enforces it, the published JSON Schema does NOT
const Bad = z.object({ checked: z.array(CriterionRefSchema) })
  .refine(v => v.checked.length > 0, 'must cite at least one criterion');
// z.toJSONSchema(Bad) emits no minItems — the constraint vanishes silently
```

### Pattern 2: Stable `$defs` via `.meta({ id })`

**What:** Every schema that appears more than once in the emitted JSON Schema carries `.meta({ id: 'PascalName', description })`, **including each member of a discriminated union**.

**Why:** With `reused: 'ref'`, un-named schemas are extracted into `$defs` as `__schema0`, `__schema1`, … — verified. Those names are positional and churn whenever union member order changes, so a published artifact third parties validate against would produce meaningless diffs. Naming the outer schema is not enough: the union *members* still get `__schemaN` unless individually named.

```typescript
// Source: verified against zod@4.4.3 by execution this session
const CriterionRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('criterion'), id: CriterionIdSchema })
    .meta({ id: 'CriterionRefCriterion' }),          // ← member also named
  z.object({ kind: z.literal('global'), category: GlobalCategory })
    .meta({ id: 'CriterionRefGlobal' }),
]).meta({ id: 'CriterionRef', description: 'Points at an acceptance criterion or a global category' });

const json = z.toJSONSchema(VerdictSchema, { target: 'draft-2020-12', reused: 'ref' });
// → $defs: { CriterionRef, CriterionRefCriterion, CriterionRefGlobal, Finding, … }
```

### Pattern 3: Recursive Gherkin Walk with Explicit Node Discrimination

**What:** Collecting scenarios walks `feature.children[]` **and** recurses into `child.rule.children[]`, discriminating `Scenario` from `Scenario Outline` by `scenario.keyword`, and excluding `Background`.

**When to use:** The SPEC-02 loader, always.

**Why:** Verified by execution — `Scenario` and `Scenario Outline` are both `FeatureChild.scenario` (only `keyword` differs), `Background` is a separate `FeatureChild.background` with `name: ""`, and `Rule` nests scenarios one level deeper in `RuleChild`. A naive `feature.children.map(c => c.scenario)` silently drops every Rule-scoped scenario and would either omit criteria or misnumber every `AC-n` (D-01 says renumbering means re-running every prompt).

```typescript
// Source: verified against @cucumber/gherkin@42.0.1 by execution this session
import type { Feature, Scenario, Background } from '@cucumber/messages';

export function collectScenarios(feature: Feature): Scenario[] {
  const out: Scenario[] = [];
  for (const child of feature.children) {
    if (child.scenario) out.push(child.scenario);
    if (child.rule) {
      for (const rc of child.rule.children) if (rc.scenario) out.push(rc.scenario);
    }
    // child.background is deliberately NOT a criterion — it is shared preamble
  }
  return out;
}

export function isOutline(s: Scenario): boolean {
  // keyword is the ONLY discriminant; s.examples is non-empty for outlines
  return s.keyword.trim() === 'Scenario Outline' || s.examples.length > 0;
}
```

### Pattern 4: Verbatim Slice by Byte Offset

**What:** A criterion's text is the exact source substring `raw.slice(node.position.start.offset, node.position.end.offset)`, never a reconstruction from the AST.

**Why:** CORE-05 requires the author's original text verbatim; D-01's `textHash` must be stable and meaningful. Re-serialising mdast loses inline formatting nuance, table pipes, and whitespace, so a `textHash` over a reconstruction would change when the serialiser changes rather than when the author's meaning changes.

### Pattern 5: Named-Boundary Section Extraction

**What:** `fromMarkdown` returns headings and lists as flat siblings on `tree.children`. A section is the run of siblings after a heading, terminated by the next heading of depth ≤ that heading's depth.

**Why:** Verified — mdast does not nest content under headings. This makes D-18's headings-only template trivially implementable, and makes an absent `## Acceptance Criteria` detectable as "no matching heading" rather than as an empty result.

### Anti-Patterns to Avoid

- **Trusting `Parser.parse()` to throw on a bad feature file.** Verified: an empty file, a whitespace-only file, and a comment-only file all parse **successfully** with `doc.feature === undefined`; a `Feature:` line with no scenarios parses successfully with `children.length === 0`. The loader must check both explicitly. Instead: `if (!doc.feature) throw LoadError('no Feature declared')` and `if (criteria.length === 0) throw LoadError('zero acceptance criteria')` — D-19's rule applies to both formats.
- **Putting `.refine()` on anything that becomes published JSON Schema.** See Pattern 1.
- **Using `IdGenerator.uuid()` in the Gherkin `AstBuilder`.** Verified: `uuid()` makes two parses of identical source produce different ASTs; `incrementing()` makes them byte-identical. Any hash over the AST, and any snapshot test, breaks under `uuid()`. Use `IdGenerator.incrementing()` — or ignore AST ids entirely and derive `AC-n` positionally per D-01.
- **Reading `step.keyword` without trimming.** Verified: it carries a trailing space (`"Given "`, `"And "`). Use `keywordType` (`Context`/`Action`/`Outcome`/`Conjunction`) for semantics, and `keyword.trim()` for display.
- **Assuming Kysely wraps SQLite migrations in a transaction.** Verified: `SqliteAdapter.supportsTransactionalDdl === false`, so it does not. See §Pitfall 5.
- **Assuming `kysely_migration` records a checksum.** Verified: exactly two columns, `name` and `timestamp`. D-30's guard is entirely ADL's to build.
- **Storing only `input_tokens`/`output_tokens` in `usage_events`.** Cache-read tokens bill at ~0.1× and cache-write at 1.25×/2× — a schema that collapses them into one input column cannot reconstruct cost. See §Pitfall 6.
- **Letting `@adl/core` import `node:fs`.** Kills the purity claim and the fast test suite; enforce by lint alongside D-27.
- **Using `z.object().passthrough()` or a loose object for `adl.yml`.** A typo'd key should be a loud config error, not silently ignored — use `z.strictObject`, which produces an `unrecognized_keys` issue naming the offending key (verified).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Gherkin parsing | A regex/line-scanner for `Feature:`/`Scenario:`/`Given` | `@cucumber/gherkin` | Docstrings, data tables, `Rule:`, `Scenario Outline` + `Examples`, tags, i18n keywords in 70+ languages, and cell-count validation. A hand-rolled parser that mis-handles any of these changes criterion count — and D-01 says that means re-running every prompt |
| Markdown structure | Split on `/^#+ /` and `/^[-*] /` | `mdast-util-from-markdown` | List continuation, lazy continuation lines, fenced code containing `#`, setext headings, nested list indentation, and — critically — **byte offsets**. A code fence containing a `## ` line will fool a regex scanner into inventing a section |
| YAML parsing | Any hand-rolled indentation parser | `yaml@2.9.0` | Anchors/aliases (and the alias-bomb defence), block scalars, quoting rules, and positioned errors for user-facing messages |
| JSON Schema generation | Hand-writing `verdict.schema.json` | `z.toJSONSchema()` + commit + CI diff | A hand-written schema drifts from the Zod source the first time anyone edits one and not the other. Emitting makes drift impossible; committing makes it reviewable |
| Discriminated-union parsing + error reporting | `switch (raw.outcome)` + manual field checks | `z.discriminatedUnion` | Verified: an unknown discriminant yields `code: 'invalid_union'` with `note: "No matching discriminator"` and the full `options` array — exactly the payload D-13's single reprompt should carry back to the model |
| SQL migration ordering + locking | A bespoke runner | Kysely `Migrator` + `FileMigrationProvider` | Alphanumeric ordering, out-of-order detection, and a DB-level lock. **But** add your own checksum table — Kysely has none |
| Content hashing | Any custom hash | `node:crypto` `createHash('sha256')` | Builtin, no dependency, and `sha256` is what ARCHITECTURE.md §2 already specifies for fingerprints |
| Sortable IDs | `Date.now() + random` | `ulid@3.0.2` | Lexicographic sort order is what makes `ORDER BY id` correct on `feature_events` |
| Token cost estimation | Any tokenizer | Backend-reported usage only | C-16 — `tiktoken` undercounts Claude tokens 15–20% on prose and far more on code |

**Key insight:** every hand-rolled alternative in this table fails the same way — it produces a *plausible* result on the happy path and a *silently different* result on a real-world input. For a spec loader that failure mode is not an inconvenience: a mis-parsed spec yields wrong acceptance criteria, which propagate into every prompt, finding, test result, and PR coverage row downstream, and D-01 makes the correction expensive. Parsing is exactly the domain where "it works on my fixture" is worthless evidence.

## Common Pitfalls

### Pitfall 1: `z.toJSONSchema()` silently drops `.refine()` — the published contract is weaker than the code

**What goes wrong:** `VerdictSchema.parse()` rejects a payload, but the JSON Schema published for non-TypeScript command gates (D-26, HARN-02) *accepts* it. A Python or shell harness writes `.adl/verdicts/security.json`, validates it against the published schema, sees green, and ADL's loader then rejects it as malformed — routing a perfectly-intentioned gate down the CORE-06 infrastructure-failure path.

**Why it happens:** Verified by execution against `zod@4.4.3`: `z.toJSONSchema(z.object({x: z.number()}).refine(o => o.x > 0))` emits `{"type":"object","properties":{"x":{"type":"number"}},"required":["x"],"additionalProperties":false}` — **no error, no warning, and no trace of the refinement.** By contrast `.transform()` throws loudly (`"Transforms cannot be represented in JSON Schema"`). The asymmetry is the trap: the noisy case is safe, the silent case is not.

**How to avoid:**
1. Ban `.refine()`/`.superRefine()` in `packages/core/src/verdict/**` by convention *and* by an ESLint `no-restricted-syntax` rule — this is exactly the D-27 mechanism, extended.
2. Express every published constraint structurally (Pattern 1).
3. Add the **equivalence contract test**: a fixture corpus of ~20 valid and ~20 invalid verdict payloads, each run through both `VerdictSchema.safeParse()` and an independent JSON-Schema validator loaded from the emitted `verdict.schema.json`; assert the accept/reject decisions match for every fixture. This is the only test that catches the drift.

**Warning signs:** a `.refine()` anywhere under `verdict/`; a `verdict.schema.json` diff that removes a constraint without a corresponding schema change; a harness author reporting "my verdict validates but ADL rejects it".

### Pitfall 2: The Gherkin parser accepts degenerate feature files without throwing

**What goes wrong:** A maintainer commits `features/dark-mode/checkout.feature` containing a stub — a `Feature:` line and a TODO comment. The parser succeeds. If the loader assumes success means "we have criteria", the feature enters the loop with **zero acceptance criteria**, and every downstream gate has nothing to check against. It cannot fail, so it goes green. This is Pitfall 8 from PITFALLS.md (coverage mapping degrading to vibes) arriving through the front door.

**Why it happens:** Verified by execution:

| Input | Result |
|-------|--------|
| Empty file | **OK**, `doc.feature === undefined` |
| Whitespace only | **OK**, `doc.feature === undefined` |
| Comment only | **OK**, `doc.feature === undefined`, `comments.length === 1` |
| `Feature: Bare` (no scenarios) | **OK**, `children.length === 0` |
| `Scenario:` with no steps | **OK**, one child with `steps.length === 0` |
| `Scenario Outline` with no `Examples` | **OK** |
| Two `Feature:` blocks | throws `CompositeParserException` |
| Ragged `Examples` table | throws `CompositeParserException` ("inconsistent cell count") |
| Free text at top level | throws `CompositeParserException` |

**How to avoid:** treat parser success as necessary, never sufficient. The loader must assert, in order: `doc.feature` is defined; at least one scenario exists after the recursive walk (Pattern 3); and — a discretion call worth making explicitly — every scenario has ≥1 step. Each failure is a `LoadError` with the offending file and, where available, the line.

**Warning signs:** a feature that reaches `pr_open` with an empty coverage table; a `NormalizedSpec` with `acceptanceCriteria.length === 0` anywhere in the codebase.

### Pitfall 3: An orphan Gherkin step is silently discarded

**What goes wrong:** An author writes a step at feature level (outside any `Scenario:`) — a common mistake when reorganising a file. Verified: `Feature: A\n  Given orphan step\n` parses **successfully** with `children.length === 0`. The author's intent vanishes with no error anywhere. If the file also contains real scenarios, the loader produces a spec that is quietly missing a requirement, and no gate can detect the omission because nothing knows the step was ever written.

**How to avoid:** compare the number of `StepLine` tokens in the source against the number of steps reachable through the AST walk, and raise a `LoadError` on mismatch. A cheap approximation that catches the common case: count source lines matching the Gherkin step keywords for the document's declared `language` (available as `feature.language`, verified `'en'` by default) and compare to `sum(scenario.steps.length) + sum(background.steps.length)`. Alternatively, and more simply: `doc.comments` plus the recursive walk cover everything the parser retained, so anything else is loss.

**Warning signs:** a criterion count that surprises the author; a scenario in the source that has no `AC-n` in the rendered checklist.

### Pitfall 4: `Scenario Outline` and `Background` are structurally invisible

**What goes wrong:** Two distinct failures from the same root cause. First, `Background` steps are shared preamble, not a criterion — but `Background` sits in `FeatureChild` next to `scenario`, and treating every child uniformly turns it into a spurious `AC-1`, shifting every subsequent ID by one. Second, `Scenario Outline` is *not* a distinct node type: verified, both `Scenario` and `Scenario Outline` arrive as `FeatureChild.scenario` with only `keyword` differing, and an outline's `examples[]` is non-empty. Code that assumes a separate node type will handle outlines as plain scenarios and drop the `Examples` table — losing the parameterisation that is the whole reason the author used an outline.

**Why it happens:** the AST is shaped for round-tripping, not for consumption. `FeatureChild = { rule?, background?, scenario? }` is a three-way optional, and `Rule` adds a second nesting level (`RuleChild = { background?, scenario? }`).

**How to avoid:** Pattern 3's explicit walk, plus a discretion decision recorded in the plan for how `kind: 'scenario'` stores outlines. Recommendation: store `steps[]` with `<placeholder>` tokens verbatim, plus `examples?: { headers: string[]; rows: string[][] }`, and **do not** expand the outline into one criterion per example row — expansion multiplies `AC-n` count by the row count, and D-01 makes that a one-way decision. Store `background?: { steps[] }` on the `NormalizedSpec`, not on individual criteria.

**Warning signs:** an `AC-n` whose text is empty or reads like setup; a coverage table with more rows than the author wrote scenarios.

### Pitfall 5: SQLite migrations under Kysely are **not** transactional, and there is no checksum

**What goes wrong:** Two separate failures, both landing in *adopters'* databases rather than in CI. (a) A migration fails halfway — say the third of five `sql` statements in `up()` — and leaves the database in a partial state with no rollback, and Kysely records nothing, so the next run replays from the top and hits "table already exists". (b) A maintainer edits an already-shipped migration file (fixing a typo, adding a column). CI is green because CI migrates from empty every time. Every existing installation has the *old* schema recorded under the *same* migration name and will never re-run it — silent divergence.

**Why it happens:** Verified by reading Kysely 0.29.5's source:
- `SqliteAdapter.supportsTransactionalDdl` returns **`false`**, so `Migrator` takes the non-transactional path.
- `DEFAULT_MIGRATION_TABLE = 'kysely_migration'` is created with exactly two columns: `name varchar(255) NOT NULL PRIMARY KEY` and `timestamp varchar(255) NOT NULL`. **No checksum column exists**, and Kysely never compares file contents.

**How to avoid:**
1. **Wrap each migration's `up()` body in an explicit `db.transaction()`** so a mid-migration failure rolls back. Caveat: `PRAGMA foreign_keys` cannot be changed inside a transaction, so any migration needing SQLite's 12-step table rebuild must toggle it *outside* the transaction — make that an explicit, documented exception rather than a discovered one.
2. **Take a file copy of the database before migrating** (ARCHITECTURE.md §2 already prescribes this) — cheap insurance that also covers case (a).
3. **Build an ADL-owned checksum table** — `adl_migration_checksums(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)` — written in the same transaction as each `up()`. On startup, recompute the sha256 of every migration file whose name appears in `kysely_migration` and refuse to start on mismatch. Do **not** add a column to `kysely_migration`; Kysely owns that table's shape and could change it.
4. Assert the guard in CI: a test that migrates a temp DB, mutates a migration file's bytes on disk, re-runs the migrator, and asserts it **fails**. A checksum guard nobody has seen fail is a checksum guard nobody knows works.

**Precedent:** this is exactly Flyway's `flyway_schema_history` checksum + `validate` behaviour — a well-trodden pattern, just one Kysely does not provide.

**Warning signs:** a migration file modified in a commit that does not also add a new migration; an adopter reporting a column that "should exist"; a `kysely_migration` row with no matching checksum row.

### Pitfall 6: `usage_events` that cannot reconstruct cost

**What goes wrong:** `usage_events` stores `input_tokens` and `output_tokens`. Six months later Phase 6 tries to compute spend and discovers that cached input billed at ~0.1× and cache-writes at 1.25×/2× were folded into one number. The recorded history is unrecoverable, and D-29 exists precisely so this does not happen ("cost accounting cannot be designed against data that was never collected").

**Why it happens:** the Messages API reports four distinct input-side counters — `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` — priced at materially different multipliers `[CITED: claude-api skill, Prompt Caching]`. A schema that collapses them is lossy at write time.

**How to avoid:** `usage_events` carries, at minimum: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `model_id`, `speed` (fast mode is separately priced), `cost_usd`, `cost_source` (`reported` | `computed` | `unknown`, per D-31 and Architecture Flag 4), and `cost_category` (`feature` | `overhead`, per D-14). Store nullable rather than defaulting to zero — a backend that does not report cache tokens must be distinguishable from one reporting zero.

**Warning signs:** a `usage_events` migration with fewer than four token columns; any `DEFAULT 0` on a token column.

### Pitfall 7: The `model_prices` seed drifts, and the `effective_from` column is never exercised

**What goes wrong:** `effective_from` exists but every seeded row shares one date, so the temporal query is never tested. The first real price change — which lands in an adopter's installation, not yours — is the first time the code path runs.

**Why it happens:** the design is right; the seed data is too uniform to prove it.

**How to avoid:** the current price table contains a real, imminent boundary that exercises this for free. Claude Sonnet 5 is $2.00/$10.00 per MTok **introductory through 2026-08-31**, reverting to $3.00/$15.00 after `[CITED: claude-api skill, Current Models]`. Seed **two rows** for `claude-sonnet-5` with different `effective_from` values, and write a test asserting that pricing a usage event dated 2026-08-15 differs from one dated 2026-09-15. That single fixture makes the temporal lookup real rather than aspirational.

**Warning signs:** every `model_prices` row sharing one `effective_from`; no test that queries by date.

### Pitfall 8: A `no-restricted-imports` rule that does not actually fail CI

**What goes wrong:** D-27's whole argument is that the rule lands *before* the adapter that would violate it. But a rule with no violation to catch is a rule nobody has seen work. It ships mis-configured (wrong `patterns` glob, wrong file scope, `warn` instead of `error`), and Phase 2 discovers it was decorative all along.

**How to avoid:** ship the rule with a **deliberate negative fixture** — a file under `test/fixtures/lint/` containing a forbidden import, plus a test that runs ESLint programmatically against it and asserts a non-zero error count. Verify the rule set covers both D-27's adapter boundary and this research's addition: `node:fs`, `node:fs/promises`, `node:child_process` banned inside `@adl/core`.

**Warning signs:** an ESLint config with no corresponding test; `severity: "warn"` on an architectural rule.

### Pitfall 9: The exhaustive green-proof enumerates the wrong thing

**What goes wrong:** the test enumerates *ordered tuples* (6^8 = 1,679,616 — slow but tractable), or enumerates only length exactly 8 (1,287 — but silently skips shorter pipelines), or enumerates the six *outcome names* without also varying the payloads that `aggregate` branches on. Any of these makes "proven exhaustively" a claim the test does not support.

**Why it happens:** CONTEXT.md says "~1,300 cases at 8 stages", which is the count for exactly 8. The count for lengths 1–8 is **3,002** (verified by computation: Σ C(n+5,5) for n=1..8).

**How to avoid:** enumerate multisets for **every** length 1..maxPipelineLength inclusive, plus the empty list explicitly. Assert two properties over the whole enumeration: (i) any multiset containing ≥1 `inconclusive` never yields `{kind:'green'}`; (ii) `aggregate` is invariant under permutation (property test with a shuffled input). Both numbers — 3,002 and 1,287 — belong in the test's comment so a future reader can check the count rather than trust it.

**Warning signs:** a test named "exhaustive" with a hardcoded array of hand-written cases; a case count that is not 3,002 (or the documented value for a different max length).

### Pitfall 10: `${ADL_PORT}` interpolation grows into shell expansion

**What goes wrong:** the interpolator is implemented as a general `${VAR}` replacer over `process.env`, or with a regex that accepts arbitrary expressions. D-22's trust boundary says `adl.yml` is untrusted; a general expander turns a config file into a read primitive over the daemon's environment — which, per WORK-06, is where credentials live.

**How to avoid:** implement against a **closed allowlist object** (`{ ADL_PORT, ADL_FEATURE_ID, ADL_ROUND, ADL_VERDICT_FILE }`) passed in as an argument; an unknown variable name is a **validation error**, not an empty-string substitution. Never read `process.env` inside `@adl/core` — which is also enforced by the purity lint. Write the negative test: `${PATH}` and `${ANTHROPIC_API_KEY}` must both fail validation.

**Warning signs:** `process.env` anywhere in `packages/core`; a regex with `.*` inside `\$\{…\}`; an unknown variable silently becoming `""`.

### Pitfall 11: Big integers in `adl.yml` silently lose precision

**What goes wrong:** verified — `YAML.parse('a: 99999999999999999999')` yields `100000000000000000000`. A timeout or budget field given an absurd value is silently rounded rather than rejected.

**How to avoid:** bound every numeric field in the Zod schema (`z.int().positive().max(...)`) rather than accepting an unbounded number. `limits.budget_usd` and every `timeout` should have a documented ceiling — which D-22's clamps require anyway.

## Code Examples

### 1. The six-outcome verdict union (CORE-01, CORE-04, D-11)

```typescript
// Source: verified by execution against zod@4.4.3 this session
import * as z from 'zod';

export const Severity = z.enum(['blocker', 'major', 'minor', 'nit']);
export const GlobalCategory = z.enum(['code_quality', 'security', 'build', 'other']);
export const CriterionId = z.string().regex(/^AC-\d+$/);

export const CriterionRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('criterion'), id: CriterionId })
    .meta({ id: 'CriterionRefCriterion' }),
  z.object({ kind: z.literal('global'), category: GlobalCategory })
    .meta({ id: 'CriterionRefGlobal' }),
]).meta({ id: 'CriterionRef' });

export const Finding = z.object({
  fingerprint: z.string().length(64),          // sha256 hex — structural, survives emission
  severity: Severity,
  title: z.string().min(1),
  detail: z.string(),
  criterionRef: CriterionRef,                  // D-03: REQUIRED, never optional
  location: z.object({
    path: z.string(),                          // workspace-relative (ARCHITECTURE Leak #2)
    line: z.int().positive().optional(),
    endLine: z.int().positive().optional(),
  }).optional(),
  suggestedAction: z.string().optional(),
}).meta({ id: 'Finding' });

export const Verdict = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('pass'), summary: z.string().min(1),
             checked: z.array(CriterionRef).min(1) }).meta({ id: 'PassVerdict' }),      // D-11
  z.object({ outcome: z.literal('send_back'), summary: z.string().min(1),
             findings: z.array(Finding).min(1) }).meta({ id: 'SendBackVerdict' }),
  z.object({ outcome: z.literal('fail'), summary: z.string().min(1),
             reason: z.string().min(1) }).meta({ id: 'FailVerdict' }),
  z.object({ outcome: z.literal('inconclusive'), summary: z.string().min(1),
             reason: z.string().min(1) }).meta({ id: 'InconclusiveVerdict' }),
  z.object({ outcome: z.literal('warn'), summary: z.string().min(1),
             findings: z.array(Finding) }).meta({ id: 'WarnVerdict' }),
  z.object({ outcome: z.literal('skip'), reason: z.string().min(1),
             waiver: Waiver.optional() }).meta({ id: 'SkipVerdict' }),                  // D-07
]).meta({ id: 'Verdict' });

export type Verdict = z.infer<typeof Verdict>;

// StageError lives OUTSIDE the union entirely (D-12, CORE-06)
export const StageError = z.object({
  kind: z.enum(['unparseable', 'provider_error', 'timeout', 'binary_missing', 'auth']),
  retryable: z.boolean(),
  detail: z.string(),
  rawRef: z.string().optional(),               // artifact pointer, not the blob
}).meta({ id: 'StageError' });

export type StageOutcome = Verdict | z.infer<typeof StageError>;
```

**Verified emission behaviour:** `z.toJSONSchema(Verdict, { target: 'draft-2020-12', reused: 'ref' })` produces `oneOf` (not the JSON Schema `discriminator` keyword), with `additionalProperties: false` on every member and `minItems: 1` preserved from `.min(1)`. The `oneOf`-not-`discriminator` shape matters if the schema is ever handed to a backend's structured-output mode — flag for Phase 4, not Phase 1.

**Verified error payload for D-13's reprompt:** an unknown `outcome` yields
`{ code: 'invalid_union', note: 'No matching discriminator', discriminator: 'outcome', options: ['pass','send_back','fail','inconclusive','warn','skip'], path: ['outcome'] }`.
That `options` array is precisely what the single repair reprompt should quote back.

### 2. Markdown criteria extraction with verbatim slices (SPEC-01, CORE-05, D-19)

```typescript
// Source: verified by execution against mdast-util-from-markdown@2.0.3 this session
import { fromMarkdown } from 'mdast-util-from-markdown';
import { createHash } from 'node:crypto';

/** Siblings after `heading`, up to the next heading of depth <= heading.depth. */
function sectionNodes(children: any[], title: string) {
  const i = children.findIndex(
    (n) => n.type === 'heading' && nodeText(n).trim().toLowerCase() === title.toLowerCase(),
  );
  if (i === -1) return null;                       // absent heading — distinct from empty
  const depth = children[i].depth;
  const out = [];
  for (let j = i + 1; j < children.length; j++) {
    const n = children[j];
    if (n.type === 'heading' && n.depth <= depth) break;
    out.push(n);
  }
  return out;
}

export function extractCriteria(raw: string) {
  const tree = fromMarkdown(raw);
  const section = sectionNodes(tree.children, '## Acceptance Criteria');
  if (section === null) throw new LoadError('missing "## Acceptance Criteria" heading');

  const lists = section.filter((n: any) => n.type === 'list');
  const items = lists.flatMap((l: any) => l.children);   // TOP-LEVEL items only (D-19)
  if (items.length === 0) throw new LoadError('"## Acceptance Criteria" contains no list items');

  return items.map((li: any, idx: number) => {
    // Verbatim slice — never a re-serialisation (Pattern 4)
    const text = raw.slice(li.position.start.offset, li.position.end.offset);
    return {
      id: `AC-${idx + 1}`,                                          // D-01: positional
      kind: 'statement' as const,
      text,
      textHash: createHash('sha256').update(text).digest('hex'),    // D-01
    };
  });
}
```

**Verified structural facts this relies on:** headings and lists are flat siblings on `tree.children`; a nested bullet appears as a `list` child *of its parent `listItem`* and is therefore inside the parent's byte range, never a sibling item — which is exactly D-19's rule, for free. Both `-` bullets and `1.` ordered lists parse as `list` (`ordered: true, start: 1` for the latter) — decide in the plan whether to accept both.

**Note:** `mdast-util-from-markdown` alone does **not** parse GFM tables — a table inside a list item arrives as a plain `paragraph` of literal pipe text. For D-19 that is harmless (the verbatim slice preserves it), but do not build logic that expects `table` nodes without adding `mdast-util-gfm-table`. It also does not parse YAML frontmatter; a leading `---` block becomes `thematicBreak` + text, which would silently join a section. Given D-18 forbids frontmatter, add an explicit reject for a leading `---` line.

### 3. Gherkin parse with deterministic IDs (SPEC-02, D-02)

```typescript
// Source: verified by execution against @cucumber/gherkin@42.0.1 this session
import { AstBuilder, GherkinClassicTokenMatcher, Parser, Errors } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';

export function parseFeature(raw: string) {
  // incrementing() — NOT uuid(): verified that uuid() makes repeat parses differ
  const parser = new Parser(
    new AstBuilder(IdGenerator.incrementing()),
    new GherkinClassicTokenMatcher(),
  );

  let doc;
  try {
    doc = parser.parse(raw);
  } catch (e) {
    if (e instanceof Errors.CompositeParserException) {
      throw new LoadError(e.errors.map((x) => x.message).join('\n'));   // carries (line:col)
    }
    throw e;
  }

  // Parser success is NECESSARY, NOT SUFFICIENT (Pitfall 2)
  if (!doc.feature) throw new LoadError('no Feature declared');

  const scenarios = collectScenarios(doc.feature);                      // Pattern 3
  if (scenarios.length === 0) throw new LoadError('feature declares zero scenarios');

  return { doc, scenarios };
}
```

**Verified AST shapes** (read from `@cucumber/messages@34.2.1` `dist/messages.d.ts`, then confirmed by parsing a fixture):

```typescript
type GherkinDocument = { uri?: string; feature?: Feature; comments: readonly Comment[] };
type Feature   = { location; tags; language; keyword; name; description; children: readonly FeatureChild[] };
type FeatureChild = { rule?: Rule; background?: Background; scenario?: Scenario };
type Rule      = { location; tags; keyword; name; description; children: readonly RuleChild[]; id };
type RuleChild = { background?: Background; scenario?: Scenario };
type Scenario  = { location; tags; keyword; name; description; steps: readonly Step[];
                   examples: readonly Examples[]; id };
type Background= { location; keyword; name; description; steps: readonly Step[]; id };
type Step      = { location; keyword; keywordType?: StepKeywordType; text; docString?; dataTable?; id };
type Examples  = { location; tags; keyword; name; description; tableHeader?: TableRow;
                   tableBody: readonly TableRow[]; id };
enum StepKeywordType { UNKNOWN='Unknown', CONTEXT='Context', ACTION='Action',
                       OUTCOME='Outcome', CONJUNCTION='Conjunction' }
```

Observed on a real parse: `step.keyword === "Given "` (trailing space), `keywordType === 'Context'`; `Scenario Outline` arrives as `child.scenario` with `keyword === "Scenario Outline"` and `examples.length === 1`; `Background` has `name === ""`; a `Rule:` block's scenarios are one level deeper.

### 4. The exhaustive green proof (CORE-02, D-08)

```typescript
// Counts verified by computation this session
import { describe, expect, it } from 'vitest';

const OUTCOMES = ['pass', 'send_back', 'fail', 'inconclusive', 'warn', 'skip'] as const;
const MAX_STAGES = 8;

/** Every multiset (order-insensitive combination with repetition) of length n. */
function multisets<T>(items: readonly T[], n: number): T[][] {
  if (n === 0) return [[]];
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length === n) { out.push([...acc]); return; }
    for (let i = start; i < items.length; i++) { acc.push(items[i]); walk(i, acc); acc.pop(); }
  };
  walk(0, []);
  return out;
}

describe('aggregate() — CORE-02, exhaustively', () => {
  // C(n+5,5) per length: 6, 21, 56, 126, 252, 462, 792, 1287.
  // Sum over lengths 1..8 = 3002.  Exactly-8 alone = 1287.
  const all = Array.from({ length: MAX_STAGES }, (_, i) => multisets(OUTCOMES, i + 1)).flat();

  it('enumerates every multiset for lengths 1..8', () => {
    expect(all).toHaveLength(3002);
  });

  it('no verdict set containing `inconclusive` can compute green', () => {
    for (const combo of all) {
      if (!combo.includes('inconclusive')) continue;
      expect(aggregate(combo.map(stubVerdict)).kind).not.toBe('green');
    }
  });

  it('is invariant under permutation', () => {
    for (const combo of all) {
      const a = aggregate(combo.map(stubVerdict));
      const b = aggregate([...combo].reverse().map(stubVerdict));
      expect(b.kind).toBe(a.kind);
    }
  });

  it('handles the empty verdict list explicitly', () => {
    expect(() => aggregate([])).not.toThrow();
  });
});
```

If a directly-exhaustive check over *ordered* tuples is ever wanted instead, `6^8 = 1,679,616` — still seconds, but the multiset form plus a permutation-invariance property is the stronger and cheaper proof.

### 5. Proving EXEC-07 mechanically

```typescript
// The success criterion is "the lifecycle transition function is untouched and
// no schema migration is required" — assert it, don't assume it.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

it('adding a gate stage changes neither transition() nor the migration set', () => {
  const transitionHash = createHash('sha256')
    .update(readFileSync('packages/core/src/state/transition.ts')).digest('hex');
  const migrationCount = readdirSync('packages/db/migrations').length;

  const three = resolvePipeline(['develop', 'review', 'test']);
  const four  = resolvePipeline(['develop', 'review', { harness: 'security' }, 'test']);

  expect(four).toHaveLength(three.length + 1);
  // The added stage is a list index, never a state:
  expect(new Set(four.map(s => s.id)).size).toBe(four.length);
  expect(createHash('sha256')
    .update(readFileSync('packages/core/src/state/transition.ts')).digest('hex'))
    .toBe(transitionHash);
  expect(readdirSync('packages/db/migrations')).toHaveLength(migrationCount);
});
```

*(This test necessarily reads files; it lives in `packages/core/test/`, not in `src/`, so the purity lint scopes to `src/**`.)*

### 6. `model_prices` seed — verified IDs and prices

```sql
-- Source: Anthropic Claude API reference (bundled claude-api skill, cached 2026-06-24)
-- C-15: bare model IDs only. Date-suffixed IDs 404.
-- C-14: prices live here, never in code.
INSERT INTO model_prices
  (model_id, input_usd_per_mtok, output_usd_per_mtok, speed, effective_from) VALUES
  ('claude-fable-5',    10.00, 50.00, 'standard', '2026-01-01'),
  ('claude-mythos-5',   10.00, 50.00, 'standard', '2026-01-01'),
  ('claude-opus-5',      5.00, 25.00, 'standard', '2026-01-01'),
  ('claude-opus-5',     10.00, 50.00, 'fast',     '2026-01-01'),   -- fast mode is separately priced
  ('claude-opus-4-8',    5.00, 25.00, 'standard', '2026-01-01'),
  ('claude-opus-4-7',    5.00, 25.00, 'standard', '2026-01-01'),
  ('claude-opus-4-6',    5.00, 25.00, 'standard', '2026-01-01'),
  ('claude-sonnet-5',    2.00, 10.00, 'standard', '2026-01-01'),   -- introductory
  ('claude-sonnet-5',    3.00, 15.00, 'standard', '2026-09-01'),   -- reverts after 2026-08-31
  ('claude-sonnet-4-6',  3.00, 15.00, 'standard', '2026-01-01'),
  ('claude-haiku-4-5',   1.00,  5.00, 'standard', '2026-01-01');
```

The two `claude-sonnet-5` rows are deliberate — they exercise `effective_from` with a real boundary (see Pitfall 7). Cache-read and cache-write multipliers (~0.1× read; 1.25× for 5-minute TTL, 2× for 1-hour) `[CITED: claude-api skill, Prompt Caching]` should be columns on this table too, not constants in code — the same argument C-14 makes for base prices applies to them.

### 7. Migration checksum guard (D-30)

```typescript
// Kysely has no checksum column (verified) — this table is ADL's.
import { sql, type Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export async function assertMigrationsUnmodified(db: Kysely<any>, dir: string) {
  const applied = await db.selectFrom('kysely_migration').select(['name']).execute();
  const recorded = await db.selectFrom('adl_migration_checksums')
    .select(['name', 'sha256']).execute();
  const byName = new Map(recorded.map(r => [r.name, r.sha256]));

  for (const { name } of applied) {
    const want = byName.get(name);
    if (!want) throw new Error(`migration "${name}" applied with no recorded checksum`);
    const bytes = await readFile(`${dir}/${name}.ts`);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want) {
      throw new Error(
        `migration "${name}" was modified after being applied ` +
        `(recorded ${want.slice(0, 12)}, found ${got.slice(0, 12)}). ` +
        `Never edit an applied migration — add a new one.`,
      );
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `zod-to-json-schema@3.25.2` as a separate dependency | Native `z.toJSONSchema()` | Zod 4 | One fewer dependency; but see Pitfall 1 — the native emitter silently drops refinements |
| Zod 3 `z.discriminatedUnion` limited to shallow object members | Zod 4 handles nested unions as members; error carries `note` + `options` | Zod 4 | `criterionRef` can be a union *inside* a union member (D-03) without workarounds; the error payload is directly usable for D-13 |
| `@cucumber/gherkin` as CJS | **ESM-only** (`"type": "module"`, no `exports` map) | v42 | Fits the `nodenext` ESM plan; a CJS consumer would need dynamic `import()` |
| `remark`/`unified` full pipeline for markdown parsing | `mdast-util-from-markdown` directly | mdast-util v2 | Skips the `unified` plugin machinery for a pure parse; fewer moving parts, same AST and `position` data |
| Drizzle + generated migrations | Kysely + hand-written SQL | Project decision (SUMMARY.md §Reconciled Decisions 3) | You control every DDL statement shipped into adopters' databases — but you also own the checksum guard Kysely doesn't provide |
| `js-yaml` `load()` vs `safeLoad()` split | `yaml@2` — safe by construction | yaml v2 | Verified: `!!js/function` resolves to an inert string with a warning; no unsafe entry point exists |
| Prices hardcoded in a constants file | Versioned `model_prices` table with `effective_from` | C-14 / D-31 | A price change no longer rewrites historical spend |

**Deprecated / outdated:**
- **TypeScript 7.0.2** — GA and now npm `latest`, but `typescript-eslint@8.67.0` peers `>=4.8.4 <6.1.0`. **Do not let an unpinned install pick it up** (C-1).
- **`zod-to-json-schema`** — superseded by native `z.toJSONSchema()`.
- **`IdGenerator.uuid()` in the Gherkin AstBuilder** — non-deterministic; use `incrementing()`.
- **`tiktoken` / `gpt-tokenizer`** for Anthropic token counts — wrong tokenizer (C-16).
- **Date-suffixed Claude model IDs** (`claude-opus-5-20260708`-style) — will 404 (C-15).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@cucumber/gherkin` + `@cucumber/messages` is the right SPEC-02 parser. Its *API and behaviour* are `[VERIFIED]` by execution; its *selection* was made during this research and is not in CLAUDE.md's stack | Standard Stack | Low. It is the reference implementation maintained by the Cucumber org with 5.8M weekly downloads. The main alternative (hand-rolling) is worse for the reasons in §Don't Hand-Roll. Cheap to gate behind a `checkpoint:human-verify` |
| A2 | `mdast-util-from-markdown` is the right SPEC-01 parser, and its ~34 transitive micromark packages are an acceptable cost inside `@adl/core` | Standard Stack, Alternatives | Medium. It directly contradicts D-26's "one dependency: Zod" framing. If the user objects, `marked` or a hand-rolled scanner is the fallback — but both lose reliable byte offsets, which weakens CORE-05 and D-01's `textHash`. **Confirm before implementation** |
| A3 | The recommended `usage_events` column set (four token counters + `speed` + `cost_source` + `cost_category`) is sufficient for Phase 6 | Pitfall 6 | Medium. The cost-accounting spike (STATE.md blocker) has not run. Mitigated because `cost_source: 'unknown'` (D-31) is the documented degradation, and additive migrations are the normal path (D-29). Extra nullable columns are cheap; missing ones are not |
| A4 | Wrapping each migration's `up()` in an explicit `db.transaction()` is safe and desirable given `supportsTransactionalDdl === false` | Pitfall 5 | Low-medium. SQLite *does* support transactional DDL; Kysely declares otherwise. The known exception is `PRAGMA foreign_keys`, which cannot change inside a transaction — flagged explicitly. Worth a spike on the first table-rebuild migration |
| A5 | `prettier@3.9.6`, `lefthook@2.1.10`, `@changesets/cli@3.0.0` versions | Supporting stack | Very low. Taken from CLAUDE.md; not independently re-verified against the registry this session |
| A6 | Not expanding `Scenario Outline` into one criterion per `Examples` row is the right call | Pitfall 4 | Medium — this is a discretion item CONTEXT.md left open, and D-01 makes criterion numbering one-way. Expansion multiplies `AC-n` count by row count and couples IDs to test data. **Confirm before implementation** |
| A7 | Requiring `ready_timeout` whenever `ready` is present (via `.superRefine`) is the intended SPEC-04 reading | Phase Requirements | Low. SPEC-04 says "an explicit readiness signal **and** timeout", which reads as both-or-neither. If `ready_timeout` should instead have a default, the refine becomes a `.default()` |
| A8 | The context-file cascade order is exactly `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → `README.md` | Architectural Responsibility Map | Very low — quoted verbatim from SPEC-05 and CONTEXT.md success criterion 4 |
| A9 | Claude model prices in §Code Examples 6 are current | Code Examples | Low-medium. Sourced from the bundled Anthropic API reference, **cached 2026-06-24** — ~2 months stale as of this research. The design (D-31, versioned table) is specifically what makes staleness recoverable: a wrong seed row is corrected by a new row with a later `effective_from`, not a migration rewrite |

## Open Questions (RESOLVED)

> All seven questions were closed during phase planning on 2026-08-17. Six are implemented by Phase 1 plans; Q7 is deferred to Phase 4 research by design (it cannot be answered before an agent backend exists to test against). Each item's `RESOLVED:` line names the plan that carries the decision.

1. **`Finding.fingerprint` input set and normalisation strength** *(CONTEXT.md discretion)*
   - What we know: ARCHITECTURE.md §2 proposes `sha256(stage_id + normalised_title + path)`; CONTEXT.md is explicit that line numbers must be excluded because code moves. The fingerprint drives LOOP-06 stall detection, so too strict never fires and too loose fires falsely.
   - What's unclear: how aggressively to normalise the title. Lowercase + whitespace collapse is safe. Stripping quoted identifiers, numbers, and paths *inside* the title is where it gets judgemental — an agent rephrasing "`foo` is unvalidated" as "`bar` is unvalidated" is a different finding, but "line 42 is unvalidated" vs "line 47 is unvalidated" is the same one.
   - Recommendation: `sha256(stageId + '\u0000' + normalise(title) + '\u0000' + (location?.path ?? ''))` where `normalise` = NFKC → lowercase → collapse whitespace → strip a trailing `(line N)`-style suffix. Include the NUL separators so field-boundary collisions are impossible. Ship it with a fixture set of ~10 rephrasing pairs (should match) and ~10 genuinely-different pairs (should not), so Phase 6 can tune against evidence rather than intuition.
   - **RESOLVED: adopted as recommended.** Implemented by **01-02** (the `fingerprint` and `normalise` helpers in `packages/core/src/hash.ts`, plus the `Finding.fingerprint` schema field) and **01-04** (the rephrasing-pair and genuinely-different-pair fixture corpus, plus the length and format assertions in `finding.test.ts`). Phase 6's tuning latitude is preserved: the fixture corpus is the evidence base. The "rephrasings collide, distinct findings do not" claim carries an explicit backstop in 01-02's `must_haves`, because whether two differently-worded findings are *the same finding* is a judgement no unit test settles on its own.

2. **Timeout units in `adl.yml`, and what `version: 1` guarantees** *(CONTEXT.md discretion)*
   - What we know: ARCHITECTURE.md's sketch uses `timeout: 10m`. Bare integers invite the ambiguity that has bitten every config format that allowed them.
   - What's unclear: whether to accept both forms, and what `version: 1` promises across ADL upgrades.
   - Recommendation: accept **only** duration strings matching `/^\d+(ms|s|m|h)$/`, parsed by a ~15-line function in `@adl/core`, not by `ms` (which accepts loose input and negatives). Bound the result (Pitfall 11). For `version:`, document it narrowly: *within a major version, ADL will only add optional keys; a removed or renamed key requires `version: 2`.* Validate `version` as `z.literal(1)` so a future `2` fails loudly rather than being ignored.
   - **RESOLVED: adopted as recommended.** Implemented by **01-07**: `packages/core/src/config/duration.ts` carries the `/^\d+(ms|s|m|h)$/` regex and the bounded hand-written parser (no `ms` dependency), and `packages/core/src/config/adl-yml.ts` validates `version` as `z.literal(1)`. The narrow `version: 1` promise — *within a major version ADL only adds optional keys; a removed or renamed key requires `version: 2`* — is recorded in the schema's header comment so it lives next to the thing it constrains.

3. **`context.max_bytes` behaviour on overflow** *(CONTEXT.md discretion)*
   - What we know: ARCHITECTURE.md §4 says head+tail with an elision marker beats silent tail-drop.
   - What's unclear: whether truncation is Phase 1's (schema + policy field) or Phase 4's (PromptBuilder). Phase 1 is pure and does not read files, so it cannot truncate anything.
   - Recommendation: Phase 1 defines the field and its validation (`z.int().positive().max(2_000_000).default(200_000)`) plus an `on_overflow: 'truncate' | 'error'` enum defaulting to `'truncate'`; Phase 4 implements head+tail. Making overflow an *error* an option matters: silently truncating a 2 MB `AGENTS.md` and proceeding is exactly the kind of quiet degradation this project is designed against.
   - **RESOLVED: adopted as recommended, split exactly as proposed.** Implemented by **01-07**: `context.max_bytes` validates as `z.int().positive().max(2_000_000).default(200_000)` and `context.on_overflow` as an enum of `'truncate' | 'error'` defaulting to `'truncate'`, both in `packages/core/src/config/adl-yml.ts`. Phase 1 defines the field and its validation only; head+tail truncation belongs to Phase 4's PromptBuilder, because Phase 1 reads no files and so cannot truncate anything.

4. **`plugin-sdk` re-export vs own types** *(CONTEXT.md discretion)*
   - What we know: ARCHITECTURE.md's rationale is that a third-party harness should depend on one small stable package, not on `@adl/manager`.
   - Recommendation: `@adl/plugin-sdk` **re-exports** the Zod schemas and inferred types from `@adl/core` and adds only `Stage`, `StageContext`, and `Workspace` (the latter as a type-only forward declaration until Phase 2). Two definitions of `Verdict` in two packages is a divergence waiting to happen; a re-export is one definition with two import paths. Ship a test asserting `PluginSdk.Verdict === Core.Verdict` by reference.
   - **RESOLVED: adopted as recommended.** Implemented by **01-05**: `packages/plugin-sdk/src/index.ts` re-exports the `@adl/core` schemas and inferred types and adds only `Stage`, `StageContext`, and a type-only forward declaration of `Workspace` (filled in Phase 2). `packages/plugin-sdk/test/reexport-identity.test.ts` asserts reference identity — not structural equality — so a copy-paste divergence fails the build rather than passing a deep-equal check.

5. **Where raw unparseable agent output is retained, and its cap** *(CONTEXT.md discretion)*
   - What we know: ARCHITECTURE.md anti-pattern 3 is unambiguous that transcripts must not live in DB rows.
   - Recommendation: `StageError.rawRef` holds an artifact pointer (path/id), never the blob. Phase 1 only needs the field and a documented cap (16 KB head + 16 KB tail with an elision marker) so Phase 3's artifact store has a contract to implement.
   - **RESOLVED: adopted as recommended.** Implemented by **01-05**: `packages/core/src/stage/stage-error.ts` declares `rawRef` as an artifact pointer with the 16 KB head + 16 KB tail cap and elision marker documented as the contract Phase 3's artifact store implements. Phase 1 stores no blob and writes no file — the field is a pointer type and a documented cap, nothing more.

6. **Exact table list for "what Phases 1-5 need"** *(CONTEXT.md discretion)*
   - Recommendation, derived from ARCHITECTURE.md §§1–3 and §8 plus the Phase 1-5 requirement set: `meta` (schema_version), `repos`, `features` (incl. `state`, `state_version`, `lease_owner`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `crash_count`, `current_stage_index`, `round`, `spec_hash`, `effective_config_json`, `workspace_handle`), `feature_events` (append-only), `rounds`, `stage_attempts`, `verdicts`, `findings`, `waivers`, `usage_events`, `model_prices`. Deferred to their own phases per D-29: `outbox`, `forge_events`, `artifacts`.
   - Open sub-question worth a decision in the plan: whether `verdicts` is a table or a JSON column on `stage_attempts`. Recommend a **table** — FORGE-08's coverage table and D-11's `checked[]` both want to be queried, and a JSON column makes that a scan.
   - **RESOLVED: adopted as recommended, including the sub-question.** Implemented by **01-10**: migration `0002_contracts.ts` creates exactly the recommended table set, with `verdicts` as a **table** rather than a JSON column on `stage_attempts`, and `0003_seed_model_prices.ts` seeds `model_prices`. `outbox`, `forge_events`, and `artifacts` stay deferred to their own phases per D-29's additive-migration rule.

7. **Does the emitted JSON Schema's `oneOf` shape work for schema-constrained agent output?**
   - What we know: verified that `z.toJSONSchema` emits `oneOf` for discriminated unions rather than the JSON Schema `discriminator` keyword. Some structured-output implementations are picky about root-level `oneOf`.
   - Recommendation: out of scope for Phase 1 (no agent invocation until Phase 4), but the emitted artifact should be *tested against a real backend's schema validator* during Phase 4. Record it as a Phase 4 research input rather than solving it now. If it turns out to be a problem, the fix is an `override` callback in `z.toJSONSchema()` — the shape changes, the source of truth does not.
   - **RESOLVED: deferred to Phase 4 research.** This is the one question Phase 1 deliberately does not answer, because answering it requires invoking a real agent backend's structured-output validator and no backend is invoked before Phase 4. **01-04** ships the artifact the Phase 4 test will run against (`packages/core/schema/verdict.schema.json`, emitted from the Zod source of truth and byte-checked against its committed copy), and `packages/core/schema/README.md` records the open question so whoever plans Phase 4 finds it at the artifact rather than in this file. The `override`-callback fix stays available precisely because the schema is emitted, never hand-edited.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Everything | ✓ | **22.23.2** | Meets `engines >=22.12.0`; **below CLAUDE.md's Node 24 dev target** |
| npm | Bootstrap | ✓ | 11.11.0 | — |
| **pnpm** | D-24 workspaces | **✗** | — | `corepack prepare pnpm@11.22.0 --activate` (corepack **is** present) |
| corepack | pnpm provisioning | ✓ | 0.34.6 | — |
| git | Everything | ✓ | 2.49.0.windows.1 | — |
| Python 3 | `node-gyp` fallback for `better-sqlite3` | ✓ | 3.12.10 | Not needed — prebuild resolved |
| `better-sqlite3` native build | `@adl/db`, D-30 CI | ✓ | 13.0.3 installed in 3 s from prebuild; SQLite **3.53.4** | — |
| `sqlite3` CLI | Manual DB inspection | ✗ | — | Not required; `better-sqlite3` covers everything Phase 1 needs |
| `node:sqlite` builtin | Future escape hatch (SUMMARY.md) | ✓ (present on 22.23) | — | Informational only — not adopted in Phase 1 |

**Missing dependencies with no fallback:** none.

**Missing dependencies with fallback:**
- **pnpm** — provision via `corepack prepare pnpm@11.22.0 --activate` (or `corepack enable pnpm`). This should be the plan's very first task; every subsequent install depends on it, and pinning through `packageManager` in `package.json` is what makes contributors' installs match.

**Version note the planner must decide:** the machine runs **Node 22.23.2**, CLAUDE.md names **Node 24 LTS** as the dev target, and `engines` is `>=22.12.0`. Everything in the stack works on 22 (Kysely needs `>=22.0.0`, Vitest accepts `^22`, better-sqlite3's prebuild resolved). Two viable positions: (a) develop on 22 and set CI's matrix to `[22, 24]` so the floor is actually tested — arguably better for an OSS tool whose `engines` floor is a promise; or (b) install Node 24 locally to match the stated dev target. Recommend (a) *plus* a CI job on 24, which tests both ends of the supported range for the cost of one matrix entry.

## Validation Architecture

`workflow.nyquist_validation` is `true` in `.planning/config.json`.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest **4.1.10** |
| Config file | **none — Wave 0** (`vitest.workspace.ts` + per-package `vitest.config.ts`) |
| Quick run command | `pnpm vitest run --project core` |
| Full suite command | `pnpm -r test && pnpm -r typecheck && pnpm lint` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORE-01 | Exactly six outcomes parse; a seventh is rejected; `consumesRound` true only for `send_back` | unit | `pnpm vitest run packages/core/test/verdict/schema.test.ts` | ❌ Wave 0 |
| CORE-02 | No multiset containing `inconclusive` yields green — all 3,002 cases | unit | `pnpm vitest run packages/core/test/verdict/aggregate.exhaustive.test.ts` | ❌ Wave 0 |
| CORE-02 | `aggregate` is permutation-invariant; empty list handled | property | same file | ❌ Wave 0 |
| CORE-03 | `DeveloperOutcomeSchema.safeParse({kind:'pass'})` fails | unit | `pnpm vitest run packages/core/test/verdict/developer-outcome.test.ts` | ❌ Wave 0 |
| CORE-03 | A dispute missing `criterionRef`/fingerprint/argument is malformed, not a dispute (D-06) | unit | same file | ❌ Wave 0 |
| CORE-04 | A finding without `criterionRef` fails; fingerprint length enforced; location path is workspace-relative | unit | `pnpm vitest run packages/core/test/verdict/finding.test.ts` | ❌ Wave 0 |
| CORE-04 | **JSON-Schema equivalence** — 40-fixture corpus accepted/rejected identically by Zod and by the emitted schema (Pitfall 1) | contract | `pnpm vitest run packages/core/test/verdict/json-schema-equivalence.test.ts` | ❌ Wave 0 |
| CORE-05 | Criterion `text` is a byte-exact source slice; `raw` round-trips unchanged | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ Wave 0 |
| CORE-06 | Malformed verdict → `StageError{kind:'unparseable'}`, never a `Verdict`; `StageError` is not assignable to `Verdict` (type test) | unit + type | `pnpm vitest run packages/core/test/verdict/stage-error.test.ts` | ❌ Wave 0 |
| SPEC-01 | Headings-only template parses; missing `## Acceptance Criteria` errors; empty section errors; nested bullets stay inside their parent | unit | `pnpm vitest run packages/core/test/spec/markdown.test.ts` | ❌ Wave 0 |
| SPEC-02 | Gherkin parses; `Background` excluded; `Rule`-nested scenarios included; outline retains `Examples`; **all 9 degenerate inputs from Pitfall 2 behave as specified** | unit | `pnpm vitest run packages/core/test/spec/gherkin.test.ts` | ❌ Wave 0 |
| SPEC-01+02 | Both formats produce one flat `AC-n` sequence (D-02); IDs are deterministic across repeat parses | unit | `pnpm vitest run packages/core/test/spec/criterion-ids.test.ts` | ❌ Wave 0 |
| D-17 | Both spec files present → load error; neither → load error | unit | `pnpm vitest run packages/core/test/spec/detect-format.test.ts` | ❌ Wave 0 |
| SPEC-03 | `build`/`start`/`test`/`teardown` validate as `argv` arrays; a shell string is rejected | unit | `pnpm vitest run packages/core/test/config/adl-yml.test.ts` | ❌ Wave 0 |
| SPEC-04 | Each `ready` probe kind validates; `ready` without `ready_timeout` is rejected | unit | same file | ❌ Wave 0 |
| SPEC-05 | Cascade order is exactly the four documented files; `pickFirstPresent` returns the first present | unit | `pnpm vitest run packages/core/test/config/context-cascade.test.ts` | ❌ Wave 0 |
| D-22 | `limits.*` may only be lowered from the daemon ceiling; a repo-set `backend` is ignored/rejected | unit | `pnpm vitest run packages/core/test/config/effective-config.test.ts` | ❌ Wave 0 |
| D-21 | `${ADL_PORT}` interpolates; `${PATH}` and `${ANTHROPIC_API_KEY}` are validation errors | unit | `pnpm vitest run packages/core/test/config/interpolate.test.ts` | ❌ Wave 0 |
| D-23 | Unknown `harness:` id fails at config validation; `group:` parses then rejects with a v2 message | unit | `pnpm vitest run packages/core/test/config/pipeline.test.ts` | ❌ Wave 0 |
| EXEC-07 | Adding a stage changes neither `transition()`'s bytes nor the migration count | integration | `pnpm vitest run packages/core/test/state/exec-07.test.ts` | ❌ Wave 0 |
| D-27 | The dependency-graph lint rule **fails** on a deliberate violating fixture | integration | `pnpm vitest run test/lint/no-restricted-imports.test.ts` | ❌ Wave 0 |
| D-29/D-30 | Migrations apply cleanly to a temp SQLite file; the schema matches the committed `Database` types | integration | `pnpm vitest run packages/db/test/migrate.test.ts` | ❌ Wave 0 |
| D-30 | Mutating an applied migration's bytes makes the runner **fail** | integration | `pnpm vitest run packages/db/test/checksum-guard.test.ts` | ❌ Wave 0 |
| D-31 | Pricing a usage event dated 2026-08-15 differs from one dated 2026-09-15 (`claude-sonnet-5`); an unknown model yields `costSource: 'unknown'`, never 0 | integration | `pnpm vitest run packages/db/test/model-prices.test.ts` | ❌ Wave 0 |
| C-1 | Installed TypeScript is exactly 6.0.3 and satisfies typescript-eslint's peer range | integration | `pnpm vitest run test/toolchain.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm vitest run --project core` (pure unit tests, sub-second)
- **Per wave merge:** `pnpm -r test && pnpm -r typecheck && pnpm lint`
- **Phase gate:** full suite green + `pnpm --filter @adl/db test` (temp-DB migrations) + the emitted `verdict.schema.json` matching its committed copy, before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `vitest.workspace.ts` + per-package `vitest.config.ts` — no test infrastructure exists (greenfield)
- [ ] `packages/core/test/fixtures/spec/` — good and bad markdown + `.feature` corpora, **including all 9 degenerate Gherkin inputs from Pitfall 2**
- [ ] `packages/core/test/fixtures/verdicts/` — ~20 valid + ~20 invalid payloads for the JSON-Schema equivalence contract test
- [ ] `packages/core/test/fixtures/adl-yml/` — valid configs per `ready` kind, plus clamp-violation and unknown-key cases
- [ ] `test/fixtures/lint/` — a deliberately violating import, for D-27's negative test
- [ ] `packages/db/test/helpers/temp-db.ts` — temp-file SQLite fixture with teardown
- [ ] Framework install: `pnpm add -D -w vitest@4.1.10` (plus a JSON-Schema validator for the equivalence test — `ajv` is the obvious choice but is **not** yet verified; treat as an open install)

## Security Domain

`workflow.security_enforcement` is `true`; `security_asvs_level` is 1. Phase 1 is pure, but it defines the **parsing and validation boundary** for two untrusted inputs — `adl.yml` and the feature spec — under the trust boundary D-22 records ("anyone who can write a file into a watched repo can execute code on the ADL host with ADL's credentials").

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth surface in Phase 1 |
| V3 Session Management | no | No sessions in Phase 1 |
| V4 Access Control | **yes** (design-time) | D-22's clamps *are* an access-control decision: `limits.*` lower-only, backend/credential selection daemon-only. Enforce in `mergeConfig`, tested |
| V5 Input Validation | **yes — the phase's core** | Zod for every external input; `z.strictObject` for `adl.yml` so unknown keys are loud; bounded numerics (Pitfall 11); no `.refine()`-only constraints on published contracts (Pitfall 1) |
| V6 Cryptography | **partial** | `node:crypto` `sha256` for `specHash`/`textHash`/`fingerprint`. These are **integrity/identity hashes, not secrets** — no HMAC, no salting, and nothing security-critical rests on them. Forge webhook HMAC is Phase 10 |
| V12 Files & Resources | **yes** | `context.files` and spec `contextRefs` are repo-supplied paths. Reject absolute paths, `..` segments, NUL bytes, drive letters (`C:\`), and UNC prefixes (`\\`) **at schema level**, so a traversal never reaches a filesystem call in Phase 2 |
| V14 Configuration | **yes** | `adl.yml` is untrusted config; `version: z.literal(1)`; documented defaults; `EffectiveConfig` frozen after merge |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation | Status |
|---------|--------|---------------------|--------|
| YAML deserialization → code execution (`!!js/function`) | Elevation of Privilege | `yaml@2` resolves unknown tags to inert values | **Verified safe** — resolves to the string `"function(){}"` with a `TAG_RESOLVE_FAILED` warning; nothing executes |
| YAML billion-laughs / alias bomb | Denial of Service | `yaml@2` alias-count limit | **Verified safe by default** — throws `ReferenceError: Excessive alias count indicates a resource exhaustion attack` |
| Prototype pollution via `__proto__` in YAML | Tampering | `yaml@2` sets it as an own property; Zod `z.object()` strips it | **Verified safe** — `({}).polluted === undefined` after parse; `hasOwnProperty('__proto__')` is `false` on the Zod output |
| YAML merge-key (`<<`) abuse | Tampering | Off by default in `yaml@2` | **Verified** — `<<` is treated as a literal key unless `{merge: true}` |
| Duplicate-key last-wins ambiguity | Tampering | Throws by default | **Verified** — `YAMLParseError: Map keys must be unique at line N` |
| Multi-document smuggling (`---`) | Tampering | Throws by default | **Verified** — `YAMLParseError: Source contains multiple documents` |
| Path traversal via `context.files` / `contextRefs` | Information Disclosure | Schema-level rejection of `..`, absolute, drive-letter, UNC, NUL | **Must be built** — Phase 1 owns the validator |
| Environment exfiltration via `${VAR}` interpolation | Information Disclosure | Closed allowlist, never `process.env` (D-21) | **Must be built** — see Pitfall 10 |
| Repo config raising its own budget / choosing a backend | Elevation of Privilege | D-22 clamps, daemon-only fields | **Must be built** — `mergeConfig` + tests |
| Prompt injection via spec content | Tampering | Out of scope for Phase 1 (PITFALLS 11, Phase 15). Phase 1's contribution: `raw` is *retained*, never *executed*, and criteria are structurally enumerated so injected prose cannot masquerade as a criterion | Design-level |
| ReDoS in validation regexes | Denial of Service | Keep every regex linear — `/^AC-\d+$/`, `/^\d+(ms\|s\|m\|h)$/` have no nested quantifiers | **Design constraint** — review any new regex against catastrophic backtracking |
| Unbounded input size (a 500 MB `spec.md`) | Denial of Service | Cap input length before parsing | **Must be built** — a documented max (e.g. 1 MB per spec file) checked before `fromMarkdown`/`Parser.parse` |

**Two security notes specific to this phase:**

1. **Zod strips `__proto__` — verified — but only for schemas that do not passthrough.** `z.object()` (strip mode, the default) and `z.strictObject()` are both safe; `.passthrough()` / `.catchall()` would carry the key through. Another reason `adl.yml` must use `z.strictObject`.
2. **`yaml`'s safe defaults are defaults, not guarantees against future config drift.** Someone adding `{ merge: true }` or a custom schema to "fix" a parse would silently re-open a hole. Pin the parse options in one place with a comment naming what each default protects against.

## Sources

### Primary (HIGH confidence)

- **npm registry** (`npm view`), 2026-08-17 — versions, `dist-tags`, `engines`, `dependencies`, `peerDependencies`, `scripts.postinstall` for all 20 packages named above. Confirmed `typescript@6.0.3` still resolves while `latest` is `7.0.2`, and `typescript-eslint@8.67.0` peers `typescript >=4.8.4 <6.1.0`
- **Direct execution against installed packages**, this session:
  - `zod@4.4.3` — `z.toJSONSchema` output shape for discriminated unions (`oneOf`, `additionalProperties:false`, `minItems`), `.meta({id})` `$defs` naming, **silent `.refine()` drop**, `.transform()` throw, `io:'input'` vs `'output'`, `invalid_union` error payload, `__proto__` stripping, `z.strictObject` `unrecognized_keys`
  - `@cucumber/gherkin@42.0.1` + `@cucumber/messages@34.2.1` — full AST type definitions read from shipped `.d.ts`; parse behaviour on 10 fixtures including all degenerate inputs; `IdGenerator.incrementing()` vs `uuid()` determinism; ESM-only packaging
  - `mdast-util-from-markdown@2.0.3` — heading/list sibling structure, `position.offset` byte ranges, nested-list containment, ordered-list handling, absent GFM table support
  - `yaml@2.9.0` — alias-bomb defence, duplicate-key rejection, multi-document rejection, `!!js/function` inertness, merge-key default, `__proto__` behaviour, big-integer precision loss
  - `kysely@0.29.5` — `DEFAULT_MIGRATION_TABLE = 'kysely_migration'` with exactly `name`/`timestamp` columns (**no checksum**), `SqliteAdapter.supportsTransactionalDdl === false`, `MigratorProps` surface
  - `better-sqlite3@13.0.3` — installs from prebuild on win32-x64 + Node 22 in 3 s; bundles SQLite 3.53.4; `.transaction()` present
- **Anthropic Claude API reference** (bundled `claude-api` skill, cached 2026-06-24) — current model IDs, per-MTok pricing, Sonnet 5 introductory-price boundary (2026-08-31), cache-read/cache-write multipliers, fast-mode pricing
- **Project documents** — `.planning/research/ARCHITECTURE.md` §§1–3, 7, 9, Anti-Patterns, Project Structure; `.planning/research/SUMMARY.md` §Reconciled Decisions 1–4; `.planning/REQUIREMENTS.md`; `.planning/ROADMAP.md` Phase 1; `.claude/CLAUDE.md` Technology Stack + What NOT to Use
- **Local toolchain probe** — Node 22.23.2, npm 11.11.0, corepack 0.34.6, git 2.49.0, Python 3.12.10, pnpm absent, `node:sqlite` present

### Secondary (MEDIUM confidence)

- [Zod — JSON Schema](https://zod.dev/json-schema) — `z.toJSONSchema` options reference (`target`, `io`, `unrepresentable`, `cycles`, `reused`, `override`). Explicitly does **not** document discriminated-union or refinement conversion — that gap is why I tested it directly
- [Kysely — Migrations](https://kysely.dev/docs/migrations) — `Migrator`, `FileMigrationProvider`, `Migration` interface, alphanumeric ordering, `allowUnorderedMigrations`, DB-level locking. Does not document the migration-table columns or SQLite transaction behaviour — read from source instead
- [Flyway `validate` / checksum semantics](https://www.red-gate.com/hub/product-learning/flyway/flyways-validate-command-explained-simply) and [Baeldung — Flyway Repair](https://www.baeldung.com/spring-boot-flyway-repair) — the named precedent for D-30's modified-migration guard (CRC32 recorded in `flyway_schema_history`, mismatch halts execution)

### Tertiary (LOW confidence)

- `prettier@3.9.6`, `lefthook@2.1.10`, `@changesets/cli@3.0.0` versions — taken from CLAUDE.md, not re-verified against the registry this session (see Assumptions A5)
- `ajv` as the JSON-Schema validator for the equivalence contract test — the obvious choice, but neither version-verified nor legitimacy-checked this session; treat as an open install decision

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — every version pulled live from the npm registry; every runtime behaviour claim confirmed by executing the package rather than reading about it
- Architecture: **HIGH** — CONTEXT.md locked 31 decisions and ARCHITECTURE.md supplies the type sketches; this research resolved the library-level mechanics beneath them and found three places where the obvious implementation is silently wrong
- Pitfalls: **HIGH** for 1–6 and 9–11 (each reproduced by direct execution or source reading); **MEDIUM** for 7–8 (design-judgement, not observed failures)
- Security: **HIGH** on the `yaml` and Zod behaviours (all six verified by execution); **MEDIUM** on the completeness of the path-traversal and input-size controls, which are prescribed here but not yet built
- Model prices: **MEDIUM** — sourced from a reference cached 2026-06-24 (~2 months stale). D-31's versioned table is precisely the design that makes this recoverable

**Research date:** 2026-08-17
**Valid until:** 2026-09-16 (30 days). Two earlier triggers: (a) any Zod 4.5+ release — `z.toJSONSchema`'s refinement handling is the single most load-bearing verified behaviour here and is the kind of thing a minor release could change; (b) 2026-09-01, when Claude Sonnet 5's introductory pricing lapses and the `model_prices` seed's second row becomes the live one.
