# Walking Skeleton — ADL (Autonomous Delivery Loop)

**Phase:** 1 — Core Contracts
**Generated:** 2026-08-17

> **Scope note, stated plainly.** The Walking Skeleton template assumes a Phase 1 that produces something a user can click. ADL's does not. `.planning/ROADMAP.md` states that "the first four phases build nothing a user can see", and this phase's own notes say "Pure, no I/O." There is no HTTP routing, no UI, and no deployment in Phase 1's scope — the dashboard is Phase 17 and the daemon is Phase 4 onward. The template's routing, UI-interaction, and dev-deployment limbs are therefore **substituted**, not faked. What follows describes the limbs this phase actually has, and the § *Template Limbs That Do Not Exist Yet* table names the phase that owns each missing one.

---

## Capability Proven End-to-End

**A real feature specification becomes a green, persisted round outcome.**

Concretely, in one `pnpm -r test` run: a `features/<id>/spec.md` written to ADL's template — and a `.feature` file written in Gherkin — both load into one `NormalizedSpec` with individually addressable `AC-1`…`AC-n` criteria carrying the author's verbatim text; a real `adl.yml` parses and validates into an `EffectiveConfig` with the daemon's clamps applied; a set of stage verdicts aggregates through a total function to a `RoundOutcome`; and hand-written SQL migrations apply to a real temp SQLite file whose live schema matches the committed `Database` types, with the spec hash and the outcome surviving a write-and-read round trip.

That is the contract spine. Everything Phases 2 through 18 build is bolted to it.

---

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language and compiler | TypeScript 6.0.3, pinned exactly, `module: nodenext`, no bundler | TypeScript 7 is npm `latest` and breaks `typescript-eslint@8.67.0`, whose peer range excludes it. This is the single hardest constraint in the stack, so it is asserted by a test rather than trusted to a config file. `tsc` output runs directly on Node ESM; a server-side daemon has none of the problems a bundler solves. |
| Runtime | Node 24 LTS as the dev target, `engines` floor `>=22.12.0` | The floor is set by dependencies, not preference. CI runs both ends of the range because an OSS tool whose `engines` floor is untested is making a promise it has not checked. |
| Package manager and layout | pnpm 11.22.0 workspaces with a `catalog:` block, provisioned via corepack | Strict `node_modules` makes an undeclared cross-package import fail at resolve time. That is what turns "the worker may not import an adapter" from a review convention into a structural rule — and that rule *is* the vendor-neutrality guarantee. (D-24) |
| Packages in Phase 1 | `@adl/core`, `@adl/plugin-sdk`, `@adl/db` — and no placeholders for the other ~13 | Empty packages rot and make a recursive build a list of no-ops. The core/plugin-sdk split happens now because it is a published package name and a dependency boundary; extracting it after eleven phases have imported from core is a wide mechanical refactor at the worst possible moment. (D-25) |
| Module access | Package **subpath exports** (`@adl/core/verdict`, `/spec`, `/stage`, `/config`, `/state`) with no root barrel file | Each subsystem's barrel is owned by exactly one plan, which is what lets seven plans run in one wave without a shared-file conflict. It also gives the dependency-graph lint rule something precise to restrict. |
| Contract source of truth | Zod 4.4.3; TypeScript types come from inference | One definition per contract. The verdict-file contract is additionally emitted as JSON Schema so a gate written in Python, Go, or shell has a real published spec — a plain command cannot read a TypeScript type. (D-26) |
| Schema constraint discipline | Structural combinators only under `verdict/`; no refinements | Verified: JSON Schema emission drops refinements with no error and no warning, publishing a contract strictly weaker than the enforced one. Enforced by a lint rule and by a 40-fixture equivalence test. |
| Data layer | SQLite via `better-sqlite3` 13.0.3, Kysely 0.29.5, **hand-written** SQL migrations | Zero server for the adopter to run — the database is a file they can inspect. Hand-written DDL because ADL ships schema upgrades into other people's installations and every statement should be one a human chose. |
| Migration integrity | ADL's own checksum table, digests recorded inside each migration's transaction, startup guard | The migration runner records no digest and never compares file contents. Editing an already-applied migration corrupts an *adopter's* database while ADL's own CI stays green, because CI migrates from empty every time. (D-30) |
| Database package boundary | `@adl/db` is the only package touching the driver; `@adl/core` never learns a database exists | Preserves the purity claim where it matters and contains a future driver or engine swap to one package. (D-28) |
| Purity enforcement | ESLint flat config bans filesystem, child-process, and environment access inside `@adl/core/src`, and bans sibling-workspace imports | Architecture rules written alongside the first thing they would have prevented tend to get written. Phase 2's no-direct-spawn rule and Phase 11's no-backend-branching rule slot into a mechanism that already exists and already fails the build. (D-27) |
| Directory layout | `packages/<name>/src/<subsystem>/` with a barrel per subsystem; tests under `packages/<name>/test/` mirroring the source tree; fixtures under `test/fixtures/` | Keeps the purity lint scoped to `src/**` so tests that legitimately read files (the EXEC-07 proof, the migration tests) are not fighting it. |
| Test runner | Vitest 4.1.10, one project per package plus a root project | Worker-process isolation, first-class TypeScript, and a five-second quick-run budget for the pure unit suite. |
| Spec formats | Two, normalized to one shape: an ADL headings-only markdown template and Gherkin | Both produce one flat `AC-n` sequence. Format is a detail of a variant (`sourceFormat`, `kind`), never a second addressing namespace. (D-02) |
| Criterion identity | Positional `AC-n` in document order, with a per-criterion content hash alongside | The readable id is what agents cite, what findings carry, and what the coverage table renders; the hash exists to detect that a criterion's meaning changed between revisions so a stale cross-revision join is invalidated rather than silently mis-joined. (D-01) |
| Lifecycle | One pure total transition function; `gating` is a single state and pipeline position is data | If adding a harness edits the state machine, "pluggable harness" is a claim rather than a property. Proven mechanically, not asserted. (EXEC-07) |
| Trust posture | Repo-supplied `adl.yml` and spec files are untrusted input | Anyone who can write a file into a watched repository can execute code on the ADL host with ADL's credentials. Limits clamp downward only; backend and credential selection is daemon-only; variable substitution is a closed allowlist, never shell expansion; repo-supplied paths cannot express a traversal. (D-21, D-22) |

---

## Stack Touched in Phase 1

Adapted from the template to the layers this phase actually has.

- [ ] **Project scaffold** — pnpm workspace, TypeScript 6.0.3 build, ESLint flat config with the architecture rules, Prettier, Vitest, CI on Node 22 and 24 *(plans 01-02, 01-03)*
- [ ] **Contract layer** — the six-outcome verdict union, `Finding` with a required criterion reference, `Waiver`, the developer's own union with no self-approval member, and the infrastructure-failure channel outside the verdict union *(plans 01-02, 01-05)*
- [ ] **Aggregation** — one pure total function from a verdict list to a round outcome, with green proven unreachable in the presence of an inconclusive verdict across the complete enumeration *(plan 01-04)*
- [ ] **Published contract** — the verdict JSON Schema emitted from the Zod source, committed, and proven equivalent in accept/reject behaviour across a 40-payload corpus *(plan 01-04)*
- [ ] **Spec intake** — deterministic format detection plus both loaders, producing one flat criterion sequence with byte-exact verbatim text *(plans 01-02, 01-06)*
- [ ] **Target-repo configuration** — the `adl.yml` schema, the merge with daemon clamps, the closed-allowlist substitution, the context-file cascade, and pipeline resolution *(plans 01-07, 01-08)*
- [ ] **Lifecycle** — the pure transition function, covered across the full state-by-event cross product *(plan 01-09)*
- [ ] **Persistence** — hand-written migrations applied to a real temp SQLite file, the live schema matching the committed types, the checksum guard, and a priced-model table whose temporal lookup is exercised by real seeded data *(plans 01-02, 01-10)*
- [ ] **Full-stack run command** — `corepack prepare pnpm@11.22.0 --activate && pnpm install && pnpm -r typecheck && pnpm lint && pnpm -r test`

---

## Template Limbs That Do Not Exist Yet

The Walking Skeleton template asks for routing, a UI interaction, and a deployment. Phase 1 has none of them, by design. Naming the owner of each prevents a later phase from re-litigating this phase's minimalism.

| Template limb | Status in Phase 1 | Phase that owns it |
|---|---|---|
| Routing — at least one real route | Absent. No HTTP surface exists. | Phase 3 (manager HTTP API and CLI); Phase 17 (API completeness) |
| UI — an interactive element wired to an API | Absent. No UI exists. | Phase 17 (web dashboard, deliberately last) |
| Deployment to a dev environment | Absent. Nothing is deployed; the artifact is a library set. | Phase 18 (distribution and adoption) |
| Auth | Absent. No authentication surface exists in a pure contract phase. | Phase 3 (HTTP API authn); Phase 15 (published threat model) |
| A real user-visible capability | Absent by ROADMAP design — "the first four phases build nothing a user can see". The first user-visible outcome is a draft pull request. | Phase 5 (the loop closes) |
| Process execution | Absent. `@adl/core` is lint-enforced to import no child-process builtin. | Phase 2 (workspace and the exec boundary) |
| Agent invocation | Absent. No backend adapter exists. | Phase 4 (first agent backend) |

---

## Out of Scope (Deferred to Later Slices)

Explicit, so a future phase does not quietly pull these back in.

- **Waiver enforcement** — the shape and its persistence land here; the escalation and human-retry path that consumes it is Phase 6.
- **Fail-fast policy by cost class** — the configuration fields exist and validate here; the policy that reads them is Phase 7.
- **Parallel pipeline stages** — the syntax parses and is then rejected with a message naming it as a future capability, so the file format does not have to change later. The mutation flag and workspace snapshotting that unlock it are Phase 2 and beyond.
- **Retry backoff execution** — the error kinds, the retryable flag, and the escalation threshold are defined here; the backoff loop and wall-clock deadline are Phase 6.
- **Cost-accounting reconciliation** — Phase 1's job is only to make sure the usage ledger can hold whatever the spike finds. The spike itself runs against a real agent turn during Phase 4 or 5 and blocks Phase 6 planning.
- **Outbox, forge-event dedupe, and artifact tables** — they arrive with the phases that use them; additive migrations are the normal path.
- **Prompt injection defence through spec content** — Phase 1's structural contribution is that raw text is retained and never executed and criteria are enumerated structurally; the rest is Phase 15.
- **Structured-output compatibility of the emitted schema** — whether a backend's structured-output mode accepts the emitted union shape is a Phase 4 research input, recorded rather than pre-empted.

---

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this spine without altering its architectural decisions.

- **Phase 2** — every process launch routes through one swappable workspace, with the worker's blast radius bounded.
- **Phase 3** — a crash-surviving control plane the maintainer can watch, pause, and kill.
- **Phase 4** — a real agent CLI makes a commit through the workspace, streamed live.
- **Phase 5** — a feature folder becomes a draft pull request after a gate failed and sent the developer back. *First user-visible outcome.*
- **Phase 6** — unattended running becomes safe: caps enforced before dispatch, stalemates caught, limits escalated.
- **Phase 7** — the reviewer lands on the same plugin gate interface a third party would use.
- **Phase 8** — a structurally code-blind tester verifies behaviour against an app ADL owns the lifecycle of.
- **Phase 9** — the pull request becomes the product: one rollup, a coverage table, the cost, and no duplicates after a crash.
- **Phase 10** — webhook detection, without ever producing a second run.
- **Phase 11** — a second agent backend proves the adapter layer is vendor-neutral.
- **Phase 12** — **DOGFOOD gate.** Everything below is blocked on it.
- **Phases 13-18** — reference harnesses, GitLab and Gitea, security hardening, remaining backends, API and dashboard, distribution.
