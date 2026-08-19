---
phase: 02
slug: workspace-the-exec-boundary
status: secured
# threats_open = count of OPEN threats at or above workflow.security_block_on (high)
threats_open: 0
asvs_level: 1
created: 2026-08-19
---

# Phase 02 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

**Verdict: THREAT-SECURE.** 45 threats declared at plan time; 45 resolved —
43 verified mitigated against code, 2 closed via documented maintainer
acceptance. No open threat at or above the `high` block threshold.

Audited by `gsd-security-auditor` at ASVS L1, register authored at plan time,
so the audit verified mitigations rather than scanning for new threats. Every
threat was traced to code, not to prose.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| daemon OS identity → agent OS identity | Without a privilege drop these are one identity, so the daemon's credentials, configuration and home are reachable by anything the agent runs. | Forge tokens, model API keys, the operator's `~/.gitconfig` |
| worker user → main repository administrative files | The worker must write its own worktree and per-worktree git admin dir, and must NOT write the repository configuration that decides which programs git executes. | `core.hooksPath`, `core.pager`, `*.sshCommand` — i.e. arbitrary code |
| ADL manager → agent-controlled repository | ADL runs `git` inside a tree an agent has written to. Git configuration in that tree names programs git will execute. | `.git/config`, `.gitattributes` |
| npm registry → developer machine | A manifest resolves a name to code that executes inside `packages/workspace`, the one module permitted to launch processes. | Package tarballs |
| feature spec (untrusted, D-22) → the loop | Anyone who can push writes the spec. | Arbitrary text, and via the repo, arbitrary committed files |

---

## Threat Register

45 unique IDs across the 8 plan threat models (`T-2-01` … `T-2-42`, plus
`T-2-02b`, `T-2-SC`, `T-2-SC-B`). `T-2-SC` appears in both `02-01` and `02-03`
and is deduplicated here.

Full per-threat evidence — file and line for every mitigation — is recorded in
the audit trail below rather than duplicated here. Summary by disposition:

| Disposition | Count | Status |
|---|---|---|
| mitigate — verified present in code | 39 | closed |
| accept — documented at plan time | 4 (`T-2-SC-B`, `T-2-15`, `T-2-27`, `T-2-42`) | closed |
| accept — documented post-review by maintainer | 2 (`CR-03`/`D-2-R-1`, `D-2-R-4`) | closed |
| **open at or above `high`** | **0** | — |

### Load-bearing controls, and why they hold

These carry the phase's weight, and each was checked for whether it could
actually fail rather than merely being green:

| Threat | Control | Why it is falsifiable |
|---|---|---|
| T-2-30 | Supplementary-group relinquish | `privilege.test.ts:604-614` compares group **lists**, with a vacuity guard at `:566-569` that fails the case when the runner's daemon carries no group the worker lacks. A uid-only check does not pass this. |
| T-2-31 | Worker cannot write main repo config | Asserted from both sides — child exit code **and** file contents — via a plain shell redirect, so `D-2-08-1`'s `safe.directory` refusal cannot mask it. |
| T-2-36 | Git-config neutralisation on every ADL-side invocation | `adl-git.test.ts:182` CONTROL *requires* the planted hook to fire through a bare `simpleGit` handle before the negative cases mean anything. |
| T-2-40 | Exactly one exec primitive in the package | `workspace-contract.test.ts` scans the **whole package** for `execa` and `node:child_process` on comment-stripped source, with anti-vacuity assertions. Mutation-verified. |
| T-2-33 | Linux privilege evidence is produced, not skipped | `test/helpers/platform.ts:75-89` **throws** on Linux when the worker user is unset, so a misprovisioned runner fails instead of quietly skipping. |

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| D-2-R-1 | CR-03 (EoP, high) | One trust domain per daemon. Concurrent features share a uid, so feature A's agent can write feature B's worktree after B's review passed. Group/mode bits cannot separate processes sharing a uid; the real fix needs a uid pool plus manager-owned lease state that does not exist until Phase 3. Narrowed: scratch homes into a daemon-owned `0700` root with an `--x`-only group grant. WORK-05's wording (a dedicated user, singular per deployment, per-run scratch home) is satisfied. Human approval before merge remains as a control. | maintainer (`02-UAT.md` test 1) | 2026-08-19 |
| D-2-R-4 | WR-12 residual (EoP, medium) | An attacker-named `filter.<driver>.clean` executes during ADL's own `snapshot()` with full neutralisation in force. Cannot be closed by name-based neutralisation because `<driver>` is attacker-chosen. Bounded: `git status` does not reach it, `git stash create` does; requires a committed `.gitattributes`. The six remaining fixed-name keys are unreachable through any shipped operation. Owner: Phase 15. | maintainer (`02-UAT.md` test 3) | 2026-08-19 |
| T-2-SC-B | Tampering, medium | Install-time script execution. Research verified `postinstall: null` for both new packages; `pnpm-workspace.yaml` `allowBuilds` is the standing control and contains only `better-sqlite3` and `esbuild`. | plan-time | 2026-08-18 |
| T-2-15 | EoP, low | GC feature-state lookup. `GcDeps.lookupFeatureState` is a **required** field, so a caller cannot omit it and get a permissive default. | plan-time | 2026-08-18 |
| T-2-27 | Tampering, low | Stub backend selected in a real deployment by misconfiguration. **Acceptance re-argued 2026-08-19** — see audit trail; the original grounds were falsified. | plan-time, re-argued | 2026-08-19 |
| T-2-42 | DoS, low | Neutralisation override table. Drift assertion keeps the acceptance discoverable. | plan-time | 2026-08-18 |

Both maintainer acceptances carry DISPOSITION blocks in `deferred-items.md`
with named revisit triggers, and open todos under `.planning/todos/pending/`
that deliberately carry no `resolves_phase:` so no phase completion can
auto-close them.

---

## Audit Trail

### Security Audit 2026-08-19

| Metric | Count |
|--------|-------|
| Threats in register | 45 |
| Closed | 45 |
| Open (blocking, ≥ high) | 0 |
| Open (non-blocking) | 0 |

**Register correction.** The register carries **45** unique IDs, not the 44 an
initial grep suggested — `T-2-02b` (`02-02-PLAN.md`, high, mitigate) sits
outside the `T-2-01…T-2-42` run and was missed by a pattern assuming a
contiguous numeric sequence.

**Register predates the code review.** The plan threat models were written
before a post-execution review found three critical boundary escapes. All three
were fixed, so several dispositions describe enforcement points that have since
moved. The audit verified the **property**, not the filename — notably
`T-2-36`…`T-2-42`, whose mitigations name `manager-git.ts` but are now satisfied
via `src/git/adl-git.ts`.

#### Findings and remediation

**T-2-40 (high) — opened by the audit, now closed.** The declared mitigation
promised "the repository still has exactly one file importing the process-launch
library." No such assertion existed. `02-08-SUMMARY.md:329` recorded it as
*"Mitigated. One file in `packages/workspace/src` imports `execa`"* — a true
observation, not an enforced invariant. The threat T-2-40 names is a **future
second primitive appearing invisibly**, which is exactly what happened once as
CR-01.

A new `packages/workspace/src/git/fast-git.ts` importing `execa` would have
passed every gate: `adl/no-direct-spawn` is disabled package-wide by
`WORKSPACE_EXEMPTION`; `adl/no-simple-git-in-workspace-src` re-bans `simple-git`
only; and all three contract source-scans look elsewhere. The `exec/run.js`
importer pin reads like coverage of "who reaches the exec primitive" and is not
— it enumerates who reaches the *sanctioned wrapper*, which a bypass by
construction does not. That is a contract assertion satisfied by a neighbouring
resource: this phase's recurring defect, sixth confirmed instance.

*Closed by* `933c372`: a whole-package scan in
`test/contract/workspace-contract.test.ts` over `MODULE_SOURCE` extensions,
covering `execa` **and** `node:child_process` (widened beyond the audit's spec —
covering only the library would have reproduced the defect one specifier over),
bare-identifier matched on comment-stripped source so `createRequire`/re-export
evasions are caught, with anti-vacuity assertions that the walk reaches `src/`,
`test/` and the package root.

*Mutation-verified* with three probes planted simultaneously — `src/git/fast-git.ts`,
`src/git/faster-git.mjs` (extension evasion), `test/helpers/evil-spawn.ts` (path
evasion): contract file 45 pass → **42 pass / 3 fail** → 45 pass on removal, each
evasion named individually. Critically, **`pnpm lint` stayed green with all three
planted** — proof no lint rule catches them. The inverse mutation (narrowing the
scan back to `src/`) turns all five new assertions red, so the guard cannot be
silently reduced to its original defective shape. Independently re-confirmed by
the orchestrator: 45 → 2 failed → 45.

*An ESLint layer was deliberately rejected.* `no-restricted-imports` cannot
express "this package except `src/exec/run.ts`" in one flat-config entry; it
needs a second entry overlapping `packages/workspace/src/**`, and flat config
**replaces** rather than merges — that entry would silently delete the
`simple-git` carve-out from every other source file while lint stayed green.
`eslint.config.js:539-546` records this exact failure happening once already.
Buying a lint layer for T-2-40 at the price of reopening CR-01 is a bad trade.

**T-2-27 (low) — acceptance argument falsified, re-argued.** The acceptance
rested on *"the stub uses the same real exec path… not a weaker security
posture, only a weaker durability one."* False: `stub/backend.ts:143` calls
`run()` with no worker identity and default `owner: 'agent'`, which resolves to
`worker-user-unset`, so on a provisioned Linux deployment the stub runs agent
children **undropped**. Disposition and severity unchanged; grounds replaced
(`9993799`) with three accurate ones — the scenario has no mechanism in v1
(`workspaceRegistry().resolve()` has no production caller), the residual is the
privilege drop alone rather than a class of controls, and it is loud in both
dimensions because the WORK-05 banner fires on the first non-dropped exec.

**T-2-37 — closed, but by an undeclared mechanism.** Its stated control (the
per-key neutralisation loop) **cannot fail**: trimming a key shrinks the loop
and stays green. It is closed only because the README-drift assertion at
`test/git/manager-git.test.ts:367` exists. Re-verified by removing
`core.fsmonitor=false`: one test **vanished** (the per-key case) and exactly one
turned red (the README equality) — nothing else in the repository noticed.
Recorded as load-bearing at that assertion (`3de31f2`) so a future reader does
not delete it as redundant.

#### Linux evidence

`T-2-29`…`T-2-35` are Linux-only and cannot execute on the maintainer's Windows
machine. CI run **32184817674** is green on both matrix legs at the merge commit
with `packages/workspace` at **205 passed / 0 skipped** and **zero
`[ADL][SKIPPED]` lines**, so the privilege assertions genuinely executed rather
than skipping. `platform.ts` throws rather than skips when a Linux runner lacks
the worker user, so a misprovisioned run fails loudly.

#### Unregistered threat flags

None. All eight summaries were read; six carry an explicit `## Threat Flags`
section reading "None". `02-01-SUMMARY.md` and `02-07-SUMMARY.md` use variant
headings and were read in full — neither declares new surface.

#### Known residual, tracked

`.planning/todos/pending/reproduce-d-2-r-1-on-linux.md` — D-2-R-1's reproduction
is still `[NOT YET REPRODUCED ON A LINUX HOST]`. Until it runs, that acceptance
rests on argued rather than demonstrated severity.
