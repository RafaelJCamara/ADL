# Phase 1: Core Contracts - Context

**Gathered:** 2026-08-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the **vocabulary every later phase speaks**, as pure code with no I/O in the core: the six-outcome verdict schema, the `Finding` shape, acceptance-criterion identity, the `DeveloperOutcome` union, the normalized spec loader for both spec formats, the `adl.yml` schema and `EffectiveConfig` resolution, the pure lifecycle `transition()` function, and the initial database schema with hand-written Kysely migrations.

Requirements in scope: **CORE-01 … CORE-06, SPEC-01 … SPEC-05, EXEC-07** (12 of 92).

Explicitly *not* in this phase: any forge call, any agent invocation, any workspace or process execution, the manager, the worker, detection, budgets enforcement, the reviewer, the tester. Phase 1 defines the shapes those phases must not be allowed to change.

The organising principle behind every decision below: **a contract that is cheap now and ruinous to retrofit gets settled here.** `criterionId` retrofitted means re-running every agent prompt; `inconclusive` retrofitted means auditing every pull request ever labelled verified.

</domain>

<decisions>
## Implementation Decisions

### Acceptance Criterion Identity

- **D-01:** Criterion IDs are **positional** (`AC-1`, `AC-2`, …) assigned in document order at parse time, with a per-criterion **`textHash`** stored alongside. The readable ID is what agents cite, what findings carry, and what the PR coverage table renders; `textHash` exists solely to detect that a criterion's meaning changed between spec revisions, so a stale cross-revision join can be invalidated instead of silently mis-joining. Within a single run this cannot bite — the normalized spec and `spec_hash` are snapshotted at lease time, and an edited spec creates a new feature revision rather than mutating the running one. — **Reversibility:** one-way — the ID is embedded in every persisted finding, test result, send-back brief, and PR comment; changing the scheme means re-running every agent prompt to regenerate the joins.

- **D-02:** **One flat `AC-n` sequence across both spec formats.** A Gherkin scenario is a single criterion with `kind: 'scenario'` retaining its Given/When/Then structure inside the record; an ADL-template bullet is `kind: 'statement'`. No separate `SCN-n` namespace, and no addressable sub-steps (`AC-4.T2`). The behaviour tester branches on `kind` in the **prompt template**, never in the loader. — **Reversibility:** one-way — same blast radius as D-01, plus every coverage-table row on every open PR.

- **D-03:** `criterionRef` is a **required discriminated union** on every `Finding`: `{ kind: 'criterion', id } | { kind: 'global', category }`. A reviewer code-quality finding or a semgrep SARIF result declares `global` with a category rather than omitting the field. This satisfies CORE-04 and success criterion 2 without a sentinel string, and lets the PR coverage table honestly show an untied-findings bucket instead of hiding one. — **Reversibility:** costly — the field is on every persisted finding; widening or relaxing it later is a data migration over the findings table plus a re-render of every open PR comment.

- **D-04:** Unknown criterion IDs are handled **asymmetrically by direction**. On a *finding*: one repair retry, then demote to `{ kind: 'global' }` and flag it loudly on the PR. In a *`pass` verdict's cited-coverage list*: one repair retry, then classify the verdict as malformed via the CORE-06 path. Rationale: demoting a complaint is safe, whereas accepting fabricated evidence that a criterion was checked is exactly the silently-wrong-but-green failure this project exists to prevent. — **Reversibility:** reversible.

### Developer Escalation & Waivers

- **D-05:** The developer's result is its **own union**, not a `Verdict`: `DeveloperOutcome = { kind: 'committed', sha } | { kind: 'dispute', … } | { kind: 'blocked', reason }`. The developer structurally cannot emit `pass` — self-approval is unrepresentable rather than merely forbidden by a runtime guard. The pipeline sequencer special-cases index 0, since `develop` is always the implicit first mutator. — **Reversibility:** costly — unifying it into `Stage`/`Verdict` later touches the sequencer, the `stage_attempts` persistence shape, and the published plugin SDK.

- **D-06:** A **dispute must be structured**: it carries the `criterionRef` it concerns, the fingerprint of the specific finding (or the stage ID) it disputes, and a stated argument. Missing any of those makes it *malformed*, not a dispute. A dispute **consumes no round** — CORE-01 reserves that for `send_back`, and charging for the honest exit re-creates the exact economic pressure the exit removes. Structure is what makes a dispute triageable, fingerprintable for stall detection, and renderable beside the gate's position on the PR. — **Reversibility:** reversible.

- **D-07:** **`Waiver` is a Phase-1 contract**: `{ target: criterionRef | stageId, reason, actor, at }`. A waived gate reports `skip` carrying the waiver, and the PR displays it. Without this, the `escalated → queued` human-retry edge has no way to express *what changed*, so the same gate fails identically on the next round. Phase 1 defines the shape and persistence; Phase 6 enforces it. — **Reversibility:** costly — it is a table plus a field on the verdict path; adding it after Phase 6 means a migration and re-deriving escalation history.

- **Constraint carried in, not re-decided:** multi-agent arbitration is **out of scope** per REQUIREMENTS.md ("Escalating to a human is cheaper, more honest, and does not risk two agents agreeing on something wrong"). A dispute escalates to a human. Do not design a reconsideration round.

### Verdict Aggregation & the Green Proof

- **D-08:** One **pure total function** `aggregate(verdicts) → RoundOutcome`. The "no verdict set containing `inconclusive` computes green" property is proven by **enumerating every multiset** of the six outcomes up to max pipeline length (~1,300 cases at 8 stages — milliseconds to run), so success criterion 2's word *exhaustively* is literally true rather than approximated. Supplement with property tests for order-independence and the empty list. No type-level encoding of green — the runtime function is the single enforcement point, because TypeScript cannot also prove the verdict list covers every configured stage. — **Reversibility:** reversible.

- **D-09:** `RoundOutcome` is a **discriminated union**: `{kind:'green'} | {kind:'send_back', brief} | {kind:'escalate', reason} | {kind:'unverified', inconclusive[]}`. "Gates said no" stays structurally distinct from "we could not tell" — which is the entire reason `inconclusive` exists. The loop, the PR rollup, and the escalation path each branch on one value instead of re-deriving the classification from the raw verdict list. — **Reversibility:** costly — three consumers branch on it, one of which is the PR rendering.

- **D-10:** Precedence is **`fail` → `send_back` → `inconclusive` → `warn`/`skip`/`pass`**. A broken gate short-circuits to escalation. But when *any* gate produced actionable findings, the developer receives them, because an `inconclusive` sitting alongside real findings usually resolves once the code changes (the app failed to start *because* of the bug). Only an `inconclusive` with **no `send_back` anywhere** escalates. Still structurally incapable of producing green. — **Reversibility:** reversible.

- **D-11:** `PassVerdict` requires a **non-empty `checked: criterionRef[]`**. ROLE-04's "an approval citing none is malformed rather than an approval" is enforced by the Phase-1 schema, not deferred to Phase 7 where the reviewer lands. Command gates cite `{ kind: 'global' }` — honest, and visibly different from claiming criterion coverage. FORGE-08's coverage table depends on this data existing from the very first stored verdict. — **Reversibility:** one-way — adding a required field after verdicts are persisted invalidates every stored row.

### Infrastructure Failure vs Gate Failure (CORE-06)

- **D-12:** A stage yields **`Verdict | StageError`**. `StageError { kind: 'unparseable' | 'provider_error' | 'timeout' | 'binary_missing' | 'auth', retryable, raw }` sits **outside the six-outcome union entirely** — "the gate judged" and "the gate broke" are different kinds of thing, which is precisely what CORE-06's "never as a gate failure" says. LOOP-07 (a provider outage consuming neither round nor budget) rides the same channel instead of needing its own. — **Reversibility:** one-way — it is the return type of the interface third-party harness authors implement against.

- **D-13:** Parse strategy: schema-constrained output where the backend supports it → fenced-JSON extraction → **exactly one reprompt** carrying the parse error → `StageError`. Bounded cost, recovers the common case (valid JSON wrapped in prose), fails fast when the model is genuinely confused. — **Reversibility:** reversible.

- **D-14:** Repair-retry and failed-parse spend is **recorded and counted** against the feature budget, tagged `costCategory: 'overhead'` so `adl show` and the PR cost line can display it separately. A budget that quietly ignores some spend is not a budget; the maintainer should see both what the feature cost and what ADL wasted. — **Reversibility:** costly — `usage_events` needs the column from the first migration (see D-29).

- **D-15:** `StageError` looping is **bounded by error kind via `retryable`**. Transient kinds (provider 429/5xx) back off against a wall-clock deadline and consume neither round nor budget — LOOP-07 exactly. Non-transient kinds (unparseable, binary missing, auth) increment a consecutive-error counter and escalate at N, default 2. The `retryable` flag already on `StageError` does the routing; no new concept. — **Reversibility:** reversible.

### Feature Specs on Disk

- **D-16:** A feature is **`features/<id>/`** containing one spec entry file plus optional supporting files (mockups, sample payloads, schemas), which become `contextRefs`. Folder name is the feature id **and** the branch suffix. No manifest file. — **Reversibility:** one-way — it is the public authoring convention; changing it breaks every adopter's repository layout.

- **D-17:** Format detection is **by filename and deterministic**: `*.feature` → Gherkin, `spec.md` → ADL template. Both present, or neither, is a **load error** — never a guess. Content sniffing is rejected on principle: a spec that sniffs wrong produces silently wrong acceptance criteria which then propagate into every prompt, finding, and coverage row downstream. — **Reversibility:** costly — public convention, though additional detection rules could be layered additively.

- **D-18:** The ADL structured template is **headings-only markdown**. Required: `# Title`, `## Acceptance Criteria`. Optional: `## Intent`, `## Non-Goals`, `## Constraints`, `## Context Files`. No frontmatter, no second syntax to get wrong. `raw` is always retained verbatim beside the parse (CORE-05), and the developer prompt contains both the raw spec and the ID'd criteria checklist. — **Reversibility:** costly — adding optional headings later is free; renaming or removing a required one is not.

- **D-19:** Criteria are extracted from **top-level list items only**; nested bullets are detail belonging to their parent criterion's text. This hands the author direct control over granularity — indent to elaborate, outdent to add a criterion. An absent or empty `## Acceptance Criteria` section **fails to load**, so a spec can never enter the loop with zero criteria. Avoids the free-prose-criteria failure the research names. — **Reversibility:** costly — changing the extraction rule changes criterion count, and therefore every ID (see D-01).

### `adl.yml` & Effective Configuration

- **D-20:** `ready` is a **discriminated union of probe kinds** — `{ http, expect? } | { tcp } | { log } | { exec }` — with `ready_timeout`. Covers web apps, databases, queue workers and CLIs without a plugin; `exec` is the universal escape hatch (`pg_isready`, a probe script) and runs through `workspace.exec` per WORK-02. ROLE-07 promises ADL owns the lifecycle for *any* app, not only HTTP ones. — **Reversibility:** reversible — new probe kinds are additive.

- **D-21:** ADL allocates the port and exports **`ADL_PORT`**; `adl.yml` references it explicitly in `start.env` and in the probe (`http://127.0.0.1:${ADL_PORT}/health`). Interpolation is restricted to a **small documented set of ADL-provided variables — not general shell expansion** — so repo-supplied config gains no new execution surface. — **Reversibility:** costly — public config convention.

- **D-22:** `EffectiveConfig = defaults ← daemon config ← repo adl.yml`, with **daemon-enforced clamps**. `limits.*` may only be *lowered* from the daemon's ceiling; backend and credential selection is **daemon-only**. Repo-supplied `adl.yml` is untrusted input under the recorded trust boundary ("anyone who can write a file into a watched repo can execute code on the ADL host with ADL's credentials") — a budget the watched repo can raise is not a budget, and a backend it can choose is a credential-selection primitive. — **Reversibility:** one-way — this is a security property. Loosening it later is trivial; tightening it later breaks adopters' working configs.

- **D-23:** Pipeline entries are **strings for built-ins, objects when configured**: `[develop, review, { harness: 'security', with: {…} }, test]`. `harness:` resolves through a registry — built-in id, then npm package name, then repo-relative path. **Unknown ids fail at config validation, not mid-run.** The `group:` syntax ships as **parse-and-reject** so v2 parallelism does not break the file format. This is how EXEC-07 is satisfied: position is a list index, and adding a gate touches config only. — **Reversibility:** costly — public config format.

### Repository Skeleton

- **D-24:** **pnpm 11.22.0 workspaces.** This resolves the ARCHITECTURE.md (npm workspaces) vs STACK.md/CLAUDE.md (pnpm) conflict in STACK.md's favour. Rationale: strict `node_modules` makes an undeclared cross-package import fail at resolve time, which is what turns "the worker may not import an adapter" from a review convention into a structural rule — and that rule *is* the vendor-neutrality guarantee. `catalog:` pins one version of TypeScript and Zod across every package without a syncing tool. Contributors get pnpm via corepack. — **Reversibility:** reversible.

- **D-25:** Phase 1 scaffolds **only `@adl/core` and `@adl/plugin-sdk`**, plus root tooling and CI. No placeholder packages for the other ~13 — empty packages rot, confuse contributors, and make `pnpm -r build` a list of no-ops. The `plugin-sdk` split happens **now, not later**, because it is a published package name and a dependency boundary, and extracting it after eleven phases have imported from `core` is a wide mechanical refactor at the worst possible moment. — **Reversibility:** reversible for adding packages; the core/plugin-sdk split itself is costly to undo once published.

- **D-26:** **Zod is the source of truth** for every contract; TypeScript types come from `z.infer`. The verdict-file contract is **additionally emitted as JSON Schema** so a non-TypeScript command gate (Python, Go, a shell script) has a real published spec for `.adl/verdicts/*.json` — HARN-02 promises a gate may be a plain command, and a plain command cannot read a TypeScript type. `@adl/core`'s "zero dependencies" therefore becomes "one dependency": Zod. — **Reversibility:** costly — the JSON Schema becomes a published artifact third parties validate against.

- **D-27:** The **`no-restricted-imports` dependency-graph lint rule lands in Phase 1** with the workspace, before any adapter exists to violate it. Phase 2's no-direct-spawn rule then slots into a mechanism that already exists and already fails CI. Architecture rules written alongside the first thing they would have prevented tend not to get written. — **Reversibility:** reversible.

### Database Schema & Migrations

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition and requirements
- `.planning/ROADMAP.md` § "Phase 1: Core Contracts" — goal, the five success criteria, and the Notes paragraph mandating the DB schema and `usage_events` / `model_prices` in this phase
- `.planning/REQUIREMENTS.md` § Core Contracts, § Feature Intake — CORE-01…06, SPEC-01…05; § Execution & State for EXEC-07; § Out of Scope (multi-agent arbitration is forbidden)
- `.planning/PROJECT.md` § Constraints, § Key Decisions, § Context — especially "The dominant risk class is silently-wrong-but-green" and "Why breadth is expensive before the gate"

### Contract design (the primary source for this phase)
- `.planning/research/ARCHITECTURE.md` §2 "State Machine" — the pure `transition()` function, `FeatureState` / `FeatureEvent` unions, `gating` as one state with `current_stage_index` as data (this is EXEC-07's mechanism), append-only `feature_events`, `state_version` optimistic concurrency, and the versioning rules ("never rename or delete a state")
- `.planning/research/ARCHITECTURE.md` §3 "Stage / Gate Abstraction" — `Stage`, `StageContext`, `Verdict`, `Finding`, the `fail` vs `send_back` distinction, `CommandStage` with its three-tier verdict resolution (structured file → SARIF → exit code), pipeline ordering, and `SendBackBrief`. **Note:** the `Verdict` union shown there has four outcomes; the six-outcome schema below supersedes it.
- `.planning/research/SUMMARY.md` § "Reconciled Decisions" §1 — the authoritative six-outcome verdict table (`pass` / `send_back` / `fail` / `inconclusive` / `warn` / `skip`) with consumes-a-round and blocks-the-PR columns. This overrides the four-outcome sketch in ARCHITECTURE.md §3.
- `.planning/research/ARCHITECTURE.md` §7 "Context Assembly" — `NormalizedSpec` and `AcceptanceCriterion` type definitions, the two normalisation rules (normalise the container not the content; always ship `raw`), criterion IDs as the join key, and the `adl.yml` shape sketch

### Stack, persistence, and structure
- `.claude/CLAUDE.md` § Technology Stack — exact pinned versions (TypeScript 6.0.3, Node 24 LTS / engines `>=22.12.0`, Zod 4.4.3, pnpm 11.22.0, better-sqlite3 13.0.3, Vitest 4.1.10) and § "What NOT to Use"
- `.planning/research/SUMMARY.md` § "Reconciled Decisions" §3 — Kysely 0.29.5 + hand-written SQL migrations; Drizzle is rejected and no migration-upgrade phase exists
- `.planning/research/ARCHITECTURE.md` § "Recommended Project Structure" and § "Structure rationale" — package boundaries as the plugin contract, `core` has no I/O, `plugin-sdk` separate from `core`, adapters as packages so vendor neutrality is enforced by the dependency graph. **Note:** it specifies npm workspaces; D-24 supersedes that with pnpm.
- `.planning/research/SUMMARY.md` § "Reconciled Decisions" §4 — the trust-boundary mitigations that make D-22's config clamps necessary (`argv` arrays never shell strings; repo config is untrusted input)

### Failure modes this phase is designed against
- `.planning/research/PITFALLS.md` Pitfall 1 — the developer attacks the gate rather than the problem; the honest-exit mitigation (92% → 1%) behind D-05/D-06
- `.planning/research/PITFALLS.md` Pitfall 5 — the tester cannot start the app and reports green anyway; behind `inconclusive` (D-10) and the `ready` contract (D-20)
- `.planning/research/PITFALLS.md` Pitfall 8 — premature success and coverage mapping degrading to vibes; behind D-19's strict criteria extraction
- `.planning/research/PITFALLS.md` Pitfall 10 — state and concurrency; idempotency and lease shape are schema decisions made here
- `.planning/research/PITFALLS.md` Pitfall 11 — prompt injection through the feature spec and repo content; behind D-21's restricted interpolation and D-22's clamps
- `.planning/research/PITFALLS.md` Pitfall 12 — the "model-agnostic" adapter quietly shaped by the first backend; behind D-27's lint rule landing before any adapter exists

</canonical_refs>

<code_context>
## Existing Code Insights

**Greenfield.** The repository contains only `.planning/` and `.claude/` — no source, no `package.json`, no lockfile, no CI. Nothing to reuse and no patterns to match.

### Reusable Assets
- None. Phase 1 creates the first code in the repository.

### Established Patterns
- None in code. The binding patterns are documentary: `.claude/CLAUDE.md` § Technology Stack (pinned versions, "What NOT to Use") and `.planning/research/ARCHITECTURE.md` § Recommended Project Structure.

### Integration Points
- None yet. Phase 1's outputs — `@adl/core`, `@adl/plugin-sdk`, `@adl/db` — are the integration points every later phase consumes.
- Downstream consumers to keep in view while shaping the exports: Phase 2 (`WorkspaceBackend`, and the lint rule from D-27 gains its second rule), Phase 3 (`@adl/db` gets its first real writer), Phase 5 (first `usage_events` rows, first stored verdicts), Phase 7 (reviewer implemented on the same `Stage` interface a third party would use), Phase 13 (first genuinely third-party harness against the published JSON Schema from D-26).

</code_context>

<specifics>
## Specific Ideas

A consistent preference ran through all eight areas: **make the wrong thing unrepresentable rather than merely forbidden.** Every choice landed on the option that pushes enforcement into the type system, the schema, or the build, and away from convention and runtime guards:

- `DeveloperOutcome` as its own union so the developer *cannot* emit `pass` (D-05), rather than a runtime guard that says it must not
- `criterionRef` as a required discriminated union rather than an optional field or a sentinel string (D-03)
- `PassVerdict` requiring non-empty cited coverage in the Phase-1 schema rather than a Phase-7 runtime check (D-11)
- `StageError` outside the verdict union so "the gate broke" cannot be mistaken for "the gate judged" (D-12)
- pnpm's strict `node_modules` so an undeclared import fails at resolve time (D-24)
- The dependency-graph lint rule landing before any adapter exists to break it (D-27)
- A migration checksum guard, because the failure it prevents lands in adopters' databases rather than in CI (D-30)

The second recurring theme is **honest degradation over silent approximation**: `costSource: 'unknown'` rather than pricing at zero (D-31), `costCategory: 'overhead'` so wasted spend is visible rather than uncounted (D-14), an untied-findings bucket on the coverage table rather than a hidden one (D-03), and a load error rather than a format guess (D-17).

</specifics>

<deferred>
## Deferred Ideas

No scope creep occurred — discussion stayed inside the phase boundary throughout. The following were touched and consciously routed to their own phases:

- **Waiver *enforcement*** — Phase 1 defines the `Waiver` shape and persistence (D-07); Phase 6 (Accountant) implements escalation and the human-retry path that consumes it.
- **`on_send_back` fail-fast defaults by cost class** — the research's `cheap/free → continue`, `expensive → stop` policy is pipeline runtime behaviour. Phase 1 only needs the config fields to exist and validate; Phase 7 implements the policy.
- **`group:` parallel pipeline stages** — v2. Phase 1 ships the syntax as parse-and-reject (D-23) so the file format does not break later; the `mutates` flag and `Workspace.snapshot()` that unlock it belong to Phase 2.
- **`retryable` backoff *execution*** — Phase 1 defines the `StageError` kinds and the `retryable` flag (D-12, D-15); the backoff loop and wall-clock deadline are loop runtime, landing with Phase 6's LOOP-07 work.
- **Cost-accounting spike** — already recorded in STATE.md as a blocker on Phase 6 planning, best run against a real agent turn during Phase 4/5. Phase 1's job is only to make sure `usage_events` and `model_prices` can hold whatever it finds (D-29, D-31).

</deferred>

---

*Phase: 1-Core Contracts*
*Context gathered: 2026-08-17*
