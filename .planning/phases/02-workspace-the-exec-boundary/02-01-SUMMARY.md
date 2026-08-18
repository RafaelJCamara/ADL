---
phase: 02-workspace-the-exec-boundary
plan: 01
subsystem: infra
tags: [supply-chain, dependency-audit, execa, simple-git, worktree, exec-boundary]

# Dependency graph
requires:
  - phase: 01-core-contracts
    provides: "The blocking-human package-legitimacy gate precedent set by plan 01-01, applied here unchanged"
provides:
  - Human-confirmed legitimacy verdict for execa and simple-git
  - Exact pinned versions consumed verbatim by plan 02-03's install command — execa@10.0.1, simple-git@3.36.0
  - Dispositioned [SUS]/too-new verdict on execa recorded as a recency false positive, with the human's own registry-page evidence
  - Confirmation that neither package requires a pnpm-workspace.yaml allowBuilds entry
affects: [02-03, workspace-backend, exec-boundary]

actuals:
  tokens: 2600
  tasks: 1
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Supply-chain gate: a [SUS] registry verdict is never auto-approved on the strength of a researcher's analysis — the human confirms package identity against the public registry page before any manifest names the package"
    - "Exact-version pinning recorded in a SUMMARY and consumed verbatim by the installing plan, so the install command performs no fresh version resolution"

key-files:
  created:
    - .planning/phases/02-workspace-the-exec-boundary/02-01-SUMMARY.md
  modified: []

key-decisions:
  - "APPROVED both gated packages at their printed versions: execa@10.0.1 and simple-git@3.36.0. Neither package replaced; the simple-git alternative (hand-rolled execa git calls) was not taken."
  - "execa's [SUS] / too-new verdict is confirmed by the human as a recency false positive — the signal fired on the release date of 10.0.1, not on package identity. Registry page shows github.com/sindresorhus/execa, maintainer sindresorhus, ~135.8M weekly downloads."
  - "Typosquat check performed against the names in .claude/CLAUDE.md § Technology Stack; no near-miss names found for either package."
  - "T-2-SC-B (install-time script execution) stays accepted, not mitigated by this plan — pnpm-workspace.yaml's allowBuilds allowlist is the standing control, and research verified postinstall: null for both packages."

patterns-established:
  - "Blocking-human supply-chain checkpoint runs as its own wave-1 plan, ahead of the tracer plan that installs, so the install command never exists before the verdict does"

requirements-completed: [WORK-01, WORK-02]

coverage:
  - id: D1
    description: "Legitimacy verdict and exact pinned version recorded for both gated packages (execa, simple-git), against the public npm registry pages"
    requirement: "WORK-02"
    verification:
      - kind: manual_procedural
        ref: "Human opened npmjs.com/package/execa and npmjs.com/package/simple-git, confirmed repository link, latest version, maintainer, and download volume; replied \"approved\". Verdict recorded in §1 below."
        status: pass
    human_judgment: true
    rationale: "A [SUS] registry verdict is a trust judgment about a third party's repository and publish cadence. The plan's own prohibition makes this explicit — a researcher's prose is the input to the human's decision, never a substitute for it."
  - id: D2
    description: "No package installed, no manifest written, and no lockfile change produced during this plan"
    requirement: "WORK-01"
    verification:
      - kind: other
        ref: "git status --porcelain (clean); packages/ contains only core, db, plugin-sdk — no workspace/; grep for execa/simple-git in pnpm-lock.yaml returns no matches"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 01: Package Legitimacy Gate Summary

**Both exec-boundary runtime dependencies APPROVED at exact pinned versions — `execa@10.0.1` and `simple-git@3.36.0` — with execa's `[SUS]`/`too-new` verdict dispositioned by the human as a release-recency false positive, and nothing installed.**

## Performance

- **Duration:** ~3 min (excluding human review time at the blocking gate)
- **Tasks:** 1 (checkpoint:human-verify, `gate="blocking-human"`)
- **Files modified:** 1 (this SUMMARY)
- **Packages installed:** 0

## Accomplishments

- Cleared the `[SUS]` verdict on `execa` with a human confirmation against the public registry page, rather than by deferring to the researcher's analysis — which is precisely what the plan's prohibition forbids.
- Produced the exact, copy-pasteable version list that plan `02-03` installs verbatim, so the tracer plan performs no fresh version resolution.
- Confirmed `simple-git` is the real `steveukx/git-js` package, so the `02-RESEARCH.md § Alternatives Considered` fallback (hand-rolled `execa` git calls in place of `simple-git`) is **not** triggered and `02-03` needs no replanning.

---

## 1. Package Verdicts — the install list for plan 02-03

Both **APPROVED**. Neither package was REPLACED. These are the exact versions to pin.

| Package | Version to pin | Repository (human-confirmed on the registry page) | Verdict |
|---|---|---|---|
| `execa` | `10.0.1` | `github.com/sindresorhus/execa` | **APPROVED** |
| `simple-git` | `3.36.0` | `github.com/steveukx/git-js` | **APPROVED** |

Copy-pasteable for plan `02-03`, in `packages/workspace`:

```
pnpm add execa@10.0.1 simple-git@3.36.0
```

### The human's response, verbatim

> **approved**

### Evidence the human confirmed at the gate

**`execa`**
- Repository link: `github.com/sindresorhus/execa` — matches the canonical source repository named in `02-RESEARCH.md` and in `.claude/CLAUDE.md § Process, config, and HTTP support`.
- Latest version: `10.0.1` — matches the version the research audited and the version `.claude/CLAUDE.md` pins.
- Weekly downloads: ~135,872,185 — hundreds of millions, as the verification step required.
- Maintainer: `sindresorhus`.

**`simple-git`**
- Repository link: `github.com/steveukx/git-js` — matches the canonical repository named in the research and in `.claude/CLAUDE.md § Git, forge, and workspace`.
- Latest version: `3.36.0`.

**Typosquat check (verification step 3):** performed character-by-character against the package names as written in `.claude/CLAUDE.md § Technology Stack`. No near-miss of a more popular package was found for either name.

### Disposition of the `[SUS]` / `too-new` verdict on `execa`

`02-RESEARCH.md § Package Legitimacy Audit` returned **`[SUS]`** for `execa` with signal `too-new`. The human reviewed and dispositioned this as a **recency false positive**:

- The signal fires on the **publish date of release `10.0.1`**, which is a signal for a *newly created package name* — not for a *new release of a long-established package*.
- Package identity is intact on every independent axis the gate checks: canonical `sindresorhus` repository, ~135.8M weekly downloads, and an explicit naming at `10.0.1` in `.claude/CLAUDE.md`'s blessed stack.

This disposition matches the reasoning already on record in the research, but is recorded here as the human's own conclusion drawn from the registry page — not as an acceptance of the researcher's prose. The plan's prohibition (`MUST NOT auto-approve or skip a package-legitimacy checkpoint on the basis that a researcher already analysed the package`) was honoured: the checkpoint blocked, the human looked, and the human answered.

`simple-git` returned no such flag.

---

## 2. `pnpm-workspace.yaml` — no `allowBuilds` entry required

Research verified `postinstall: null` for both packages, so neither needs an entry in the `allowBuilds` allowlist. No change to `pnpm-workspace.yaml` is required by `02-03` on account of these two dependencies.

The allowlist remains the standing control against a `postinstall` appearing in a *future* release of either package — that is the basis on which threat **T-2-SC-B** stays `accept` rather than becoming this plan's responsibility.

---

## Task Commits

1. **Task 1: Confirm execa and simple-git are the real packages before the first install** — no code commit (checkpoint task; human verdict recorded, nothing installed)

**Plan metadata:** this SUMMARY (docs: complete plan)

## Files Created/Modified

- `.planning/phases/02-workspace-the-exec-boundary/02-01-SUMMARY.md` — the recorded package verdict table, the human's verbatim response, the `[SUS]` disposition, and the pinned install list for plan `02-03`

## Decisions Made

See `key-decisions` in the frontmatter and §1–§2 above. In brief:

1. Both gated packages APPROVED at the printed versions; neither replaced.
2. `execa`'s `[SUS]`/`too-new` verdict is a release-recency false positive, dispositioned by the human against the registry page.
3. No typosquat near-miss found for either name.
4. No `allowBuilds` entry required; `T-2-SC-B` stays accepted with the allowlist as the standing control.

## Deviations from Plan

None — plan executed exactly as written. The checkpoint paused as designed, the human answered "approved", and the verdict was recorded.

## Issues Encountered

None.

## Threat Model Verification

| Threat ID | Disposition | Status |
|---|---|---|
| T-2-SC (Tampering — `pnpm add execa simple-git` in `packages/workspace`) | mitigate | **Mitigated.** The blocking human checkpoint resolved before `02-03` runs any install; registry identity confirmed against the canonical source repository on each public package page, and exact versions pinned in §1. |
| T-2-SC-B (Tampering — install-time script execution) | accept | **Accepted as planned.** Research verified `postinstall: null` for both packages; `pnpm-workspace.yaml`'s `allowBuilds` allowlist is the standing control and needs no change (§2). |

## Verification

Against the plan's `<verification>` block:

- **"The checkpoint is resolved with an explicit human response recorded in the plan SUMMARY."** — Recorded verbatim in §1: **approved**.
- **"`packages/workspace/package.json` does not exist yet and no `pnpm add` has run (this plan modifies no files)."** — Confirmed by read-only checks before writing this SUMMARY:
  - `packages/` contains only `core/`, `db/`, `plugin-sdk/` — there is no `workspace/` directory, and therefore no `packages/workspace/package.json`.
  - `pnpm-lock.yaml` contains no `execa@` or `simple-git@` importer entry.
  - `git status --porcelain` was **clean** — no manifest, no lockfile change, no `node_modules` change was produced by this plan.

Against `<success_criteria>`:

- A human confirmed both package identities against the public registry — neither was rejected. ✅
- Plan `02-03` is unblocked to install `execa@10.0.1` and `simple-git@3.36.0`. ✅

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan `02-03` is UNBLOCKED.** It may run `pnpm add execa@10.0.1 simple-git@3.36.0` in `packages/workspace` with both versions already decided and both identities already human-confirmed. Install the §1 list verbatim; do not re-resolve versions.
- **The `simple-git` fallback is not needed.** `02-RESEARCH.md § Alternatives Considered` (hand-rolled `execa` git calls in place of `simple-git`) stays unexercised — `02-03` plans against `simple-git` as written.
- **No `pnpm-workspace.yaml` change** is required by these two dependencies (§2).
- **Carry-forward for `02-03`:** `.claude/CLAUDE.md` records two consumption details worth honouring at the call sites — `simple-git` is CJS, so import it as a default import (`import simpleGit from 'simple-git'`) under `nodenext`; and it has no dedicated `.worktree()` helper, so worktree creation goes through `git.raw(['worktree', 'add', ...])`.

## Self-Check: PASSED

- `.planning/phases/02-workspace-the-exec-boundary/02-01-SUMMARY.md` — FOUND
- Commit `0d0cab2` — FOUND
- `git status --porcelain` after commit — clean
- `git diff --diff-filter=D HEAD~1 HEAD` — no deletions

---
*Phase: 02-workspace-the-exec-boundary*
*Completed: 2026-08-18*
