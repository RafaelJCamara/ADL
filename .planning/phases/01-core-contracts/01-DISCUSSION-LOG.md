# Phase 1: Core Contracts - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-17
**Phase:** 1-Core Contracts
**Areas discussed:** Criterion ID scheme, Dev escalation exit, Green-proof & aggregation, Malformed verdict path, Feature folder & spec template, adl.yml specifics, Repo skeleton & package split, DB schema scope

**Area selection:** eight gray areas were offered across two multi-select prompts; the user selected all eight.

---

## Criterion ID scheme

### Q1 — How are IDs assigned and kept meaningful across spec revisions?

| Option | Description | Selected |
|--------|-------------|----------|
| Positional + content hash | `AC-n` in document order plus a per-criterion `textHash` to detect meaning changes across revisions | ✓ |
| Positional only | `AC-n` by document order, as the research sketches; a cross-revision join can be silently wrong | |
| Author-declared, positional fallback | Author may pin an ID; unstable-by-default remains the default; two code paths | |
| Content-hash IDs only | `AC-7f3a2c`; immune to reorder but unreadable in coverage tables and prompts | |

**User's choice:** Positional + content hash
**Notes:** Framed with the already-locked rule that the normalized spec and `spec_hash` are snapshotted at lease time, so renumbering cannot bite within a run — only across revisions, where detection is desirable.

### Q2 — What is the addressable unit, and does Gherkin get its own namespace?

| Option | Description | Selected |
|--------|-------------|----------|
| Flat `AC-n`, scenario = 1 criterion | One sequence across both formats; `kind` discriminates; steps retained inside the record | ✓ |
| Separate `AC-n` / `SCN-n` | Source format readable from the ID; two sequences to keep unique | |
| Flat `AC-n` + `Then` sub-IDs | `AC-4.T2` for per-assertion coverage; noisier prompts, agents invent sub-IDs | |

**User's choice:** Flat `AC-n`, scenario = 1 criterion
**Notes:** Tester branches on `kind` in the prompt template, never in the loader.

### Q3 — How does a finding with no acceptance criterion satisfy CORE-04?

| Option | Description | Selected |
|--------|-------------|----------|
| Required discriminated ref | `{kind:'criterion', id} | {kind:'global', category}`; never absent, never a magic string | ✓ |
| Required string + reserved sentinel | `criterionId: 'GLOBAL'`; simplest shape, but the sentinel leaks into every join | |
| Optional, validated per gate kind | Matches the research's `criterionId?`; lowest friction for SARIF, weakens the guarantee | |

**User's choice:** Required discriminated ref
**Notes:** Lets the PR coverage table show an untied-findings bucket honestly rather than hiding one.

### Q4 — An agent cites a criterion ID that doesn't exist

| Option | Description | Selected |
|--------|-------------|----------|
| Asymmetric by direction | Finding → repair retry then demote to `global` and flag; `pass` cited coverage → malformed via CORE-06 | ✓ |
| Uniformly strict | Any unknown ID makes the whole verdict malformed; one bad token discards an expensive turn | |
| Uniformly lenient | Always demote and continue; a `pass` can then cite coverage it never had | |

**User's choice:** Asymmetric by direction
**Notes:** Demoting a complaint is safe; accepting fabricated evidence of coverage is the silently-wrong-but-green failure.

---

## Dev escalation exit

### Q1 — Where does the developer's result live in the type system?

| Option | Description | Selected |
|--------|-------------|----------|
| Distinct `DeveloperOutcome` union | `committed | dispute | blocked`; the developer structurally cannot emit `pass` | ✓ |
| Developer is a Stage; dispute rides on `fail` | One interface and parser; needs a runtime guard against self-approval | |
| Generic `Stage<TOutcome>` | Uniform sequencing plus type-level safety; generic threads through the published SDK | |

**User's choice:** Distinct `DeveloperOutcome` union
**Notes:** Self-approval becomes unrepresentable rather than merely forbidden.

### Q2 — What must a dispute carry, and what does it cost?

| Option | Description | Selected |
|--------|-------------|----------|
| Structured, costs no round | Requires `criterionRef` + disputed fingerprint/stage ID + argument; incomplete = malformed | ✓ |
| Free-form, costs no round | Lowest friction; the ImpossibleBench result came from merely offering the exit | |
| Structured, costs a round | Makes disputing non-free; contradicts CORE-01 and restores the pressure to cheat | |

**User's choice:** Structured, costs no round
**Notes:** Arbitration was explicitly off the table — REQUIREMENTS.md puts multi-agent debate out of scope, so a dispute escalates to a human.

### Q3 — How is a human-resolved dispute recorded?

| Option | Description | Selected |
|--------|-------------|----------|
| Waiver is a Phase-1 contract | `{target, reason, actor, at}`; waived gate reports `skip` carrying the waiver | ✓ |
| No waiver — human edits inputs and retries | Zero new contract; repo stays the single source of truth | |
| Defer waiver to Phase 6 | Design it with real usage in hand; becomes a retrofit onto a schema four phases old | |

**User's choice:** Waiver is a Phase-1 contract
**Notes:** Without it, the `escalated → queued` retry edge cannot express what changed.

---

## Green-proof & aggregation

### Q1 — How is the inconclusive-never-green property proven?

| Option | Description | Selected |
|--------|-------------|----------|
| Total fn + exhaustive multiset test | One pure `aggregate()`; enumerate every multiset of six outcomes to max pipeline length | ✓ |
| Total fn + property-based only | fast-check; "proven exhaustively" downgrades to "not falsified in N runs" | |
| Type-level: green unconstructible | Compiler enforces it, but TS can't prove stage coverage, so the runtime check stays anyway | |

**User's choice:** Total fn + exhaustive multiset test
**Notes:** ~1,300 cases at 8 stages — genuinely exhaustive, milliseconds to run. Property tests added for order-independence and the empty list.

### Q2 — What does the aggregation return?

| Option | Description | Selected |
|--------|-------------|----------|
| Discriminated `RoundOutcome` | `green | send_back | escalate | unverified`; keeps "said no" distinct from "couldn't tell" | ✓ |
| `{ green: boolean, … }` | Simplest; every consumer re-derives the classification, `inconclusive` collapses | |
| Round outcome is itself a `Verdict` | Elegant recursion; round-level `skip`/`warn` are meaningless states | |

**User's choice:** Discriminated `RoundOutcome`

### Q3 — Precedence when a round mixes `send_back`, `inconclusive`, and `fail`

| Option | Description | Selected |
|--------|-------------|----------|
| `fail → send_back → inconclusive` | Broken gate short-circuits; actionable findings still reach the developer | ✓ |
| `fail → inconclusive → send_back` | Most conservative; escalates earlier and more often | |
| Per-stage `on_inconclusive` policy | Mirrors `on_send_back`; flexible, but the default is still this question | |

**User's choice:** `fail → send_back → inconclusive`
**Notes:** An `inconclusive` alongside real findings usually resolves once the code changes. Only an `inconclusive` with no `send_back` anywhere escalates.

### Q4 — Must a `pass` cite the criteria it checked (ROLE-04)?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — non-empty cited coverage | `PassVerdict` requires `checked: criterionRef[]`; command gates cite `{kind:'global'}` | ✓ |
| Required for agent stages only | Matches SARIF reality; guarantee weakens to "for stages we classified as agents" | |
| Optional now, enforced in Phase 7 | Keeps the schema loose; adding a required field later invalidates stored verdicts | |

**User's choice:** Yes — non-empty cited coverage

---

## Malformed verdict path

### Q1 — Where does an unparseable verdict sit relative to the six outcomes?

| Option | Description | Selected |
|--------|-------------|----------|
| Separate `StageError`, outside `Verdict` | `{kind, retryable, raw}`; "gate judged" vs "gate broke" stay distinct; LOOP-07 rides it too | ✓ |
| Map to `fail` with a reason code | One type; conflates "harness binary missing" with "ADL couldn't parse the answer" | |
| Map to `inconclusive` | Safe by construction; but the PR then says the *tester* couldn't verify | |

**User's choice:** Separate `StageError`, outside `Verdict`
**Notes:** Matches CORE-06's literal wording, "never as a gate failure".

### Q2 — Repair policy before giving up on parsing

| Option | Description | Selected |
|--------|-------------|----------|
| One repair retry, then `StageError` | Schema-constrained → fenced-JSON extraction → one reprompt with the parse error | ✓ |
| No retry | Parser is deterministic, so a retry is a coin flip; cheapest failure path | |
| Bounded escalating retry (up to 3) | Maximises recovery on weak backends; up to 3× the cost of a failed turn | |

**User's choice:** One repair retry, then `StageError`

### Q3 — Does repair spend count against the budget?

| Option | Description | Selected |
|--------|-------------|----------|
| Recorded and counted, tagged overhead | `costCategory: 'overhead'`; displayed separately, cap stays correct | ✓ |
| Recorded but not counted | ADL's failure shouldn't eat the developer's allowance; cap stops bounding real spend | |
| Separate overhead budget | Clean separation; a second budget concept Phase 6 must enforce and explain | |

**User's choice:** Recorded and counted, tagged overhead

### Q4 — What bounds repeated `StageError`s?

| Option | Description | Selected |
|--------|-------------|----------|
| Bound by error kind via `retryable` | Transient → backoff to wall-clock deadline; non-transient → consecutive counter, escalate at N=2 | ✓ |
| Any `StageError` escalates immediately | Predictable; a single 429 wakes a human for something that clears in 90 seconds | |
| Uniform backoff + wall-clock deadline | One policy; unparseable output isn't transient, so it spends the deadline for nothing | |

**User's choice:** Bound by error kind via `retryable`

---

## Feature folder & spec template

### Q1 — What does a feature look like on disk?

| Option | Description | Selected |
|--------|-------------|----------|
| `features/<id>/` + one entry file | Folder = id = branch suffix; supporting files become `contextRefs`; no manifest | ✓ |
| `features/<id>.md` flat files | Lowest ceremony; nowhere for attachments, loses the id/branch convention | |
| `features/<id>/` + `feature.yml` manifest | Unambiguous and extensible; two files minimum, friction against DIST-01 | |

**User's choice:** `features/<id>/` + one entry file

### Q2 — How is spec format detected?

| Option | Description | Selected |
|--------|-------------|----------|
| By filename, deterministic | `*.feature` → Gherkin, `spec.md` → template; both or neither is a load error | ✓ |
| Content sniffing | Forgiving of any filename; a wrong sniff produces silently wrong criteria | |
| Declared in frontmatter | Maximally explicit; still needs a fallback rule, so you build one of the others anyway | |

**User's choice:** By filename, deterministic

### Q3 — What is ADL's structured spec template?

| Option | Description | Selected |
|--------|-------------|----------|
| Headings-only markdown | Required `# Title` + `## Acceptance Criteria`; optional Intent / Non-Goals / Constraints / Context Files | ✓ |
| Optional frontmatter + headings | Typed home for machine fields; two syntaxes, and YAML errors greet a new maintainer | |
| Fully structured YAML/JSON | Zero ambiguity; nobody wants to write it and it doesn't render on the PR | |

**User's choice:** Headings-only markdown

### Q4 — How are criteria extracted?

| Option | Description | Selected |
|--------|-------------|----------|
| Top-level list items only | Nesting is detail belonging to the parent; empty/absent section fails to load | ✓ |
| Every list item at any depth | Finest granularity; three clarifying sub-bullets silently become three criteria | |
| Any block element, including paragraphs | Most forgiving; this is the free-prose-criteria pitfall by name | |

**User's choice:** Top-level list items only

---

## adl.yml specifics

### Q1 — What shape does the `ready` contract take?

| Option | Description | Selected |
|--------|-------------|----------|
| Discriminated union of probe kinds | `http | tcp | log | exec` + `ready_timeout`; `exec` is the universal escape hatch | ✓ |
| HTTP probe only in v1 | One code path; ROLE-07's "any app" quietly narrows to "any HTTP app" | |
| `http` + log-regex only | Covers most real cases in two paths; no answer for a database | |

**User's choice:** Discriminated union of probe kinds

### Q2 — How does the ADL-allocated port reach the app and the probe?

| Option | Description | Selected |
|--------|-------------|----------|
| `ADL_PORT` + fixed-set interpolation | Config references it explicitly; interpolation restricted to documented ADL variables | ✓ |
| Fixed convention: ADL sets `PORT` | Zero config; apps reading `SERVER_PORT` need an escape hatch anyway | |
| Maintainer declares a fixed port | Simplest to debug; collides at concurrency > 1, which EXEC-05 enables in Phase 3 | |

**User's choice:** `ADL_PORT` + fixed-set interpolation
**Notes:** Explicitly *not* general shell expansion — repo config must gain no execution surface.

### Q3 — Can repo `adl.yml` override daemon config?

| Option | Description | Selected |
|--------|-------------|----------|
| Layered, with daemon-enforced clamps | `limits.*` only lowerable; backend/credential selection daemon-only | ✓ |
| Repo `adl.yml` wins outright | One source of truth; push access then sets the spend cap and picks the backend | |
| Daemon config wins for anything it declares | Maximum operator control; `adl.yml` becomes advisory | |

**User's choice:** Layered, with daemon-enforced clamps
**Notes:** Grounded in the recorded trust boundary — repo config is untrusted input.

### Q4 — Pipeline syntax and third-party gate naming

| Option | Description | Selected |
|--------|-------------|----------|
| String for built-ins, object when configured | `harness:` resolves built-in → npm package → repo path; unknown ids fail validation; `group:` parse-and-reject | ✓ |
| Always objects | Uniform parse path; the most-copied config in the README reads as noise | |
| Strings only + sibling `harnesses:` block | Clean ordered list; two places to look, and they can drift | |

**User's choice:** String for built-ins, object when configured

---

## Repo skeleton & package split

### Q1 — pnpm or npm workspaces?

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm 11.22.0 | Strict `node_modules` makes undeclared cross-package imports fail at resolve; `catalog:` pins versions | ✓ |
| npm workspaces | Ships with Node, nothing to install; hoisting hides exactly the rule you most want enforced | |

**User's choice:** pnpm 11.22.0
**Notes:** Resolves a direct conflict — `research/ARCHITECTURE.md` specifies npm workspaces, `research/STACK.md` and `.claude/CLAUDE.md` specify pnpm. STACK.md wins.

### Q2 — How much of the package tree is scaffolded now?

| Option | Description | Selected |
|--------|-------------|----------|
| Only what Phase 1 delivers | `@adl/core` + `@adl/plugin-sdk` + root tooling; no placeholders | ✓ |
| Full tree with placeholders | Architecture legible from the file listing; thirteen packages that do nothing | |
| `core` only; split `plugin-sdk` later | Smallest surface now; extracting a published boundary after eleven phases is a wide refactor | |

**User's choice:** Only what Phase 1 delivers

### Q3 — Zod or hand-written types as source of truth?

| Option | Description | Selected |
|--------|-------------|----------|
| Zod + generated JSON Schema | `z.infer` for types; JSON Schema published for non-TypeScript command gates (HARN-02) | ✓ |
| Zod source of truth, TypeScript-only | Skip the JSON Schema until a non-TS harness asks; docs prose is the only spec until then | |
| Hand-written types + separate validators | `core` stays dependency-free; every shape defined twice, drift is silent | |

**User's choice:** Zod + generated JSON Schema
**Notes:** Accepts that `@adl/core`'s "zero deps" becomes "one dep".

### Q4 — When do architecture lint rules land?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 1, with the workspace | `no-restricted-imports` written before any adapter exists to break it | ✓ |
| ESLint now, rules as packages appear | Written under delivery pressure alongside the first thing it would have prevented | |
| Defer to Phase 11 | Pairs enforcement with the proof; four packages get free rein first | |

**User's choice:** Phase 1, with the workspace

---

## DB schema scope

### Q1 — Which package owns schema and migrations?

| Option | Description | Selected |
|--------|-------------|----------|
| New `@adl/db` package | Only package touching `better-sqlite3`; `core` stays pure; contains the later Postgres swap | ✓ |
| Inside `@adl/manager/db` | Matches the research sketch; creates `@adl/manager` two phases early | |
| Bare `.sql` files + types in `core` | Lightest; `core` ends up describing a database, DDL unexecuted until Phase 3 | |

**User's choice:** New `@adl/db` package

### Q2 — How much schema does Phase 1 define?

| Option | Description | Selected |
|--------|-------------|----------|
| Phases 1-5 tables + `usage_events` + `model_prices` | The two the roadmap names; the rest arrives with its phase | ✓ |
| Full v1 schema up front | Whole shape consistent at once; outbox/artifact tables designed against zero usage | |
| Absolute minimum | Maximum focus; contradicts the roadmap note, Phase 5 cost recording has nowhere to write | |

**User's choice:** Phases 1-5 tables + `usage_events` + `model_prices`

### Q3 — Do migrations execute in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Execute in CI + checksum guard | Runs against a temp SQLite file; build fails if an applied migration file changes | ✓ |
| Execute in CI, no checksum guard | Proves the DDL applies; editing an applied migration then breaks adopters silently | |
| Reviewed only; first executed in Phase 3 | Keeps the phase literally I/O-free; Phase 3 opens by debugging Phase 1 | |

**User's choice:** Execute in CI + checksum guard
**Notes:** Accepted the purity trade-off on the grounds that the I/O belongs to `@adl/db`, not `core`.

### Q4 — Where do `model_prices` rows come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Seeded by migration, overridable in daemon config | Unknown model records `costSource: 'unknown'` rather than pricing at zero | ✓ |
| Seeded by migration only | One place to look; a price change means waiting for a release | |
| No seed — maintainer supplies prices | Never wrong by default; nobody reaches a first PR without filling in a pricing table | |

**User's choice:** Seeded by migration, overridable in daemon config

---

## Claude's Discretion

The user selected the recommended option in all eight areas — nothing was delegated with "you decide". The items left open to the researcher and planner are listed in CONTEXT.md under `<decisions>` → "Claude's Discretion": fingerprint input set and title normalisation, `adl.yml` timeout units and `version: 1` semantics, Gherkin `Background`/`Scenario Outline`/`Examples` handling, `context.max_bytes` behaviour, tsconfig and Vitest setup, whether `plugin-sdk` re-exports from `core`, where raw unparseable output is retained, and the exact table list for "what Phases 1-5 need".

## Deferred Ideas

No scope creep occurred. Items touched and routed to their own phases: waiver *enforcement* (Phase 6), `on_send_back` fail-fast defaults by cost class (Phase 7), `group:` parallel stages (v2, syntax reserved now), `retryable` backoff execution (Phase 6), and the cost-accounting spike (already tracked in STATE.md as a Phase 6 prerequisite, to be run during Phase 4/5).
