---
phase: 01-core-contracts
plan: 01
subsystem: infra
tags: [supply-chain, dependency-audit, gherkin, markdown, json-schema, ajv, cucumber, mdast]

# Dependency graph
requires: []
provides:
  - Human-confirmed legitimacy verdict for @cucumber/gherkin, @cucumber/messages, mdast-util-from-markdown, and ajv
  - Exact pinned version for each gated package, consumed verbatim by plan 01-02 Task 1
  - Assumption A6 resolved — scenario-outline: one-criterion-with-examples
  - Conditional pre-approval for ajv-formats in plan 01-04
  - ajv/dist/2020 import carry-forward note for plan 01-04's JSON-Schema equivalence test
affects: [01-02, 01-04, 01-05, spec-parsing, criterion-enumeration]

actuals:
  tokens: 3100
  tasks: 1
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Supply-chain gate: no package outside .claude/CLAUDE.md's pinned Technology Stack is installed until a human has confirmed its source repository against the registry page"
    - "Exact-version pinning recorded in a SUMMARY and consumed verbatim by the installing plan, so the install command carries no fresh resolution"

key-files:
  created:
    - .planning/phases/01-core-contracts/01-01-SUMMARY.md
  modified: []

key-decisions:
  - "APPROVED all four gated packages at their printed versions: @cucumber/gherkin@42.0.1, @cucumber/messages@34.2.1, mdast-util-from-markdown@2.0.3, ajv@8.20.0. No package replaced."
  - "The two SUS/too-new seam verdicts on the Cucumber packages are heuristic false positives — 12-day-old routine releases, millions of weekly downloads, canonical github.com/cucumber/* repositories, no postinstall."
  - "Assumption A6 resolved as `scenario-outline: one-criterion-with-examples` — a Gherkin Scenario Outline becomes ONE criterion retaining its Examples table verbatim; it is NOT expanded per example row."
  - "D-26 trade accepted: @adl/core gains ~34 transitive micromark packages, so 'one dependency: Zod' becomes 'Zod plus two parser families'."
  - "ajv-formats pre-approved for plan 01-04 as a devDependency, conditionally — only if the emitted draft-2020-12 schema carries a `format` keyword that ajv 8 strict mode rejects."

patterns-established:
  - "Blocking-human supply-chain checkpoint: automated registry metadata gathering runs first, the human confirms repository/org and version, and the verdict is recorded before any install command exists"
  - "Research assumptions that become one-way contract decisions (D-01 criterion numbering) are converted to explicit recorded decisions before implementation, never carried into code as assumptions"

requirements-completed: [SPEC-01, SPEC-02]

coverage:
  - id: D1
    description: "Legitimacy verdict and exact pinned version recorded for all four gated packages (@cucumber/gherkin, @cucumber/messages, mdast-util-from-markdown, ajv)"
    requirement: "SPEC-01"
    verification:
      - kind: manual_procedural
        ref: "Human reviewed npm registry pages for each package, confirmed source repository organisation and version; verdict recorded in this SUMMARY"
        status: pass
    human_judgment: true
    rationale: "Package legitimacy is a trust judgment about a third party's repository, maintainers, and publish cadence — no automated check can substitute for it, which is exactly why this plan is a blocking-human gate."
  - id: D2
    description: "Assumption A6 (Scenario Outline handling) resolved as an explicit decision rather than an executor assumption"
    requirement: "SPEC-02"
    verification:
      - kind: manual_procedural
        ref: "Human decision recorded verbatim as `scenario-outline: one-criterion-with-examples` in this SUMMARY"
        status: pass
    human_judgment: true
    rationale: "D-01 makes criterion numbering a one-way door; the choice is a product decision about criterion identity, not something a test can settle."
  - id: D3
    description: "No package installed and no lockfile written during this plan"
    verification:
      - kind: other
        ref: "git status --porcelain (clean — no pnpm-lock.yaml, no package.json, no node_modules change)"
        status: pass
    human_judgment: false

duration: 4min
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 01: Package Legitimacy Gate Summary

**All four research-selected packages APPROVED at exact pinned versions — `@cucumber/gherkin@42.0.1`, `@cucumber/messages@34.2.1`, `mdast-util-from-markdown@2.0.3`, `ajv@8.20.0` — with Scenario Outline resolved to one-criterion-with-examples and nothing installed.**

## Performance

- **Duration:** ~4 min (excluding human review time at the blocking gate)
- **Tasks:** 1 (checkpoint:human-verify, gate="blocking-human")
- **Files modified:** 1 (this SUMMARY)
- **Packages installed:** 0

## Accomplishments

- Converted three `[ASSUMED]` research selections (Assumptions A1, A2, and Sources § Tertiary) into recorded human decisions before a single `pnpm add` exists in the phase.
- Produced the exact, copy-pasteable package/version list that plan 01-02 Task 1 installs verbatim.
- Resolved Assumption A6, the Scenario Outline expansion question, which D-01 makes a one-way door.
- Pre-approved `ajv-formats` under one narrow condition so plan 01-04 does not have to return to a human gate for it.
- Recorded the `ajv/dist/2020` import requirement that plan 01-04's equivalence test depends on.

---

## 1. Package Verdicts — the install list for plan 01-02

All four **APPROVED**. No package was REPLACED. These are the exact versions to pin; plan 01-02 Task 1 installs this list verbatim and performs no fresh version resolution.

| Package | Version to pin | Repository | Verdict |
|---|---|---|---|
| `@cucumber/gherkin` | `42.0.1` | `git+https://github.com/cucumber/gherkin.git` | **APPROVED** |
| `@cucumber/messages` | `34.2.1` | `git://github.com/cucumber/messages.git` | **APPROVED** |
| `mdast-util-from-markdown` | `2.0.3` | `git+https://github.com/syntax-tree/mdast-util-from-markdown.git` | **APPROVED** |
| `ajv` | `8.20.0` | `git+https://github.com/ajv-validator/ajv.git` | **APPROVED** (devDependency) |

Copy-pasteable for plan 01-02:

```
@cucumber/gherkin@42.0.1
@cucumber/messages@34.2.1
mdast-util-from-markdown@2.0.3
ajv@8.20.0        # devDependency only — see §4
```

**`ajv` resolved version: `8.20.0`.** Recorded explicitly because plan 01-04's JSON-Schema equivalence test has no other way to be independent of Zod — the validator must be a third party that never saw the Zod schema object.

### Note on the `@cucumber/messages` repository URL

`@cucumber/messages` declares its repository with the legacy `git://` protocol (`git://github.com/cucumber/messages.git`) rather than `git+https://`. The **host and organisation are still `github.com/cucumber`**, matching the expected Cucumber organisation. This is stale package metadata, not a security signal, and it does not affect how pnpm resolves or fetches the tarball (which comes from the registry, not the repository field). Dispositioned as benign against threat **T-1-SC3** (look-alike package names / wrong organisation): the organisation check passes.

### Note on the `SUS` / `too-new` seam verdicts

The read-only legitimacy seam returned `SUS` with a `too-new` reason string for both Cucumber packages. Reviewed and dispositioned as **heuristic false positives**, matching the analysis already on record in `01-RESEARCH.md` § Package Legitimacy Audit:

- Both are **12-day-old routine releases** of long-established packages, not new package names.
- Both have **millions of weekly downloads**.
- Both resolve to the **canonical `github.com/cucumber/*` repositories**.
- Neither declares a `postinstall` script.

The `too-new` heuristic fires on publish recency, which is a signal for a *newly created package name* and not for a *new release of an established one*. `ajv` returned no such flag.

---

## 2. Assumption A6 — Scenario Outline handling

**Decision, recorded verbatim: `scenario-outline: one-criterion-with-examples`**

A Gherkin `Scenario Outline` becomes **ONE** criterion that retains its `Examples` table verbatim:

- `steps[]` keep their `<placeholder>` tokens exactly as written.
- `examples?: { headers, rows }` is retained beside them.
- It is **NOT** expanded into one criterion per example row.

**Rationale:** expansion multiplies the `AC-n` count by the row count and couples criterion IDs to test data. `D-01` makes criterion numbering a one-way door, so a criterion ID that shifts when someone adds an example row is a permanent liability.

---

## 3. D-26 trade — accepted

Accepting `mdast-util-from-markdown` means `@adl/core` gains roughly **34 transitive micromark packages**. `D-26`'s framing therefore changes:

> **before:** "one dependency: Zod"
> **after:** "Zod plus two parser families"

**Rationale on record for accepting it:** the two fallbacks — `marked` and a hand-rolled scanner — both lose the **byte offsets** that make `CORE-05`'s verbatim retention and `D-01`'s `textHash` *exact* rather than *approximate*. An approximate `textHash` on a one-way criterion identifier is a worse cost than a wider transitive tree in a package whose consumers are already installing a Node daemon.

This is a deliberate, recorded amendment to D-26, not an oversight. Any future audit that reads D-26's "one dependency" phrasing should read this section alongside it.

---

## 4. Carry-forward notes for plan 01-04

### 4a. `ajv` must be imported from `ajv/dist/2020`

`ajv`'s default entrypoint (`import Ajv from 'ajv'`) is the **draft-07** class. The schema under test is **draft-2020-12**, per:

```ts
z.toJSONSchema(Verdict, { target: 'draft-2020-12', reused: 'ref' })
```

Plan 01-04's equivalence test must therefore import from the 2020 build:

```ts
import Ajv2020 from 'ajv/dist/2020';
```

This path is reachable because **`ajv` ships no `exports` map**, so deep subpath imports into `dist/` are not blocked by Node's export-map enforcement. Using the default import against a draft-2020-12 schema produces confusing strict-mode and `$schema` errors that look like schema bugs rather than an import bug — this note exists to prevent that dead end.

### 4b. `ajv` is a devDependency — D-26 is unaffected by it

`ajv` is used only by a test. Unlike `mdast-util-from-markdown`, it does **not** appear in `@adl/core`'s published dependency claim and does not enter any adopter's dependency graph. The D-26 amendment in §3 is caused by the markdown parser alone.

### 4c. `ajv-formats` — PRE-APPROVED, conditionally

Plan 01-04 is authorized to add **`ajv-formats`** as a devDependency **without returning to a human gate**, subject to one condition:

- **Condition:** ONLY IF the emitted draft-2020-12 schema actually carries a `format` keyword that `ajv` 8 strict mode rejects.
- **If no `format` keyword is emitted: do not add it.**
- Same publisher organisation as the approved `ajv` (`ajv-validator`), which is why it can be pre-approved at all.

This pre-approval is **scoped to `ajv-formats` alone and to that single condition**. Any other package — including any other `ajv-*` plugin — still requires a fresh human gate.

---

## Task Commits

1. **Task 1: Confirm parser and validator package legitimacy before the first install** — no code commit (checkpoint task; automated registry metadata gathering + human verdict, nothing installed)

**Plan metadata:** this SUMMARY (docs: complete plan)

## Files Created/Modified

- `.planning/phases/01-core-contracts/01-01-SUMMARY.md` — the recorded package verdict table, the A6 decision, the D-26 amendment, and the plan 01-04 carry-forward notes

## Decisions Made

See `key-decisions` in the frontmatter and sections §1–§4 above. In brief:

1. All four gated packages APPROVED at the printed versions; none replaced.
2. `@cucumber/messages`' `git://` repository URL is stale metadata, not a security signal — organisation check passes.
3. The `SUS`/`too-new` seam verdicts on the Cucumber packages are heuristic false positives, dispositioned with reasons.
4. `scenario-outline: one-criterion-with-examples`.
5. D-26 amended from "one dependency: Zod" to "Zod plus two parser families", for byte-offset exactness.
6. `ajv-formats` conditionally pre-approved for plan 01-04.

## Deviations from Plan

None — plan executed exactly as written. The checkpoint paused as designed, the human answered "approved", and the verdicts were recorded.

## Issues Encountered

None.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-1-SC (Tampering — npm installs into `@adl/core`) | mitigate | **Mitigated.** Blocking human checkpoint ran before any install; exact versions pinned in §1 and consumed by plan 01-02. |
| T-1-SC2 (Tampering — `ajv` never legitimacy-checked) | mitigate | **Mitigated.** `npm view` metadata printed, human-confirmed against the registry page; resolved version `8.20.0`, repository `github.com/ajv-validator/ajv`, no `postinstall`. |
| T-1-SC3 (Spoofing — look-alike package names) | mitigate | **Mitigated.** Source repository organisation confirmed for each of the four packages, not just the package name. The `@cucumber/messages` protocol anomaly was examined and dispositioned (§1). |

## Verification

- `git status --porcelain` — **clean**. No `package.json`, no `pnpm-lock.yaml`, and no `node_modules` change was produced by this plan. Nothing was installed.
- All four gated packages have a version string and a verdict recorded in §1.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 01-02 is unblocked.** It can run `pnpm add` with every version already decided and every non-CLAUDE.md package already human-confirmed. Install the §1 list verbatim.
- **Plan 01-04 is unblocked** on the validator: `ajv@8.20.0` as a devDependency, imported from `ajv/dist/2020`, with `ajv-formats` conditionally pre-approved.
- **Plan 01-05 (and any plan enumerating criteria)** must implement A6 as `one-criterion-with-examples`: `steps[]` retain `<placeholder>` tokens, `examples?: { headers, rows }` sits beside them, no per-row expansion.
- **Open follow-up for documentation:** `D-26` in `01-CONTEXT.md` still reads "one dependency: Zod". The amendment is recorded here in §3; whichever plan touches the dependency-claim documentation should reconcile the wording.

---
*Phase: 01-core-contracts*
*Completed: 2026-08-17*
