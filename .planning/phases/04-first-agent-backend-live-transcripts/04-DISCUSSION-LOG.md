# Phase 4: First Agent Backend & Live Transcripts - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-20
**Phase:** 4-First Agent Backend & Live Transcripts
**Areas discussed:** Preflight failure behavior, How this phase gets demoed, Cost-accounting spike scope, Live transcript content

---

## Preflight failure behavior

| Question | Options | Selected |
|---|---|---|
| What should happen when the installed `claude` CLI version doesn't match ADL's pinned version? | Hard block (refuse dispatch, "broken installation" error) / Warn and continue | **Hard block** ✓ |
| How strict should the version pin be? | Exact pin / Minimum-version floor | **Exact pin** ✓ |

**User's choice:** Exact-pin version, hard-blocks dispatch on mismatch, surfaced as "broken installation" naming expected vs. installed version.
**Notes:** Matches success criterion 3's wording verbatim and OBS-08.

---

## How this phase gets demoed

| Question | Options | Selected |
|---|---|---|
| How should a real Claude Code commit get exercised, with no Phase 5 loop yet? | New CLI verb (`adl dev-run`) / Automated test only | **New CLI verb** ✓ |
| Should it go through the full manager/worker/lease path, or call the stage directly in-process? | Full manager/worker path / Direct in-process call | **Full manager/worker path** ✓ |
| What does it take as input? | Real feature folder (`features/<id>/`) / Synthetic inline prompt | **Real feature folder** ✓ |

**User's choice:** `adl dev-run <feature-id>` — a new CLI verb that runs a real single-stage pipeline through the full manager→worker→lease→IPC path against a real feature folder.
**Notes:** Becomes the bridge Phase 5's loop dispatch later wires into, rather than throwaway scaffolding.

---

## Cost-accounting spike scope

| Question | Options | Selected |
|---|---|---|
| Should Phase 4 close the STATE.md cost-accounting blocker now, or defer to Phase 5? | Close it in Phase 4 / Defer to Phase 5 | **Close it in Phase 4** ✓ |

**User's choice:** `adl dev-run`'s real agent turn is used as the vehicle to close the blocker — record real `total_cost_usd`/token data into `usage_events`, verify `costSource` classification, update STATE.md.
**Notes:** No separate throwaway spike script; the recorded row from the real run is the evidence.

---

## Live transcript content

| Question | Options | Selected |
|---|---|---|
| Should `adl logs -f` show full event detail or a curated view? | Full detail / Curated view (thinking hidden by default) | **Full detail** ✓ |

**User's choice:** Full `AgentEvent` detail streams to both the NDJSON file and the live view — no curation layer in this phase.
**Notes:** Matches PROJECT.md's "the whole loop's reasoning visible" core value.

---

## Claude's Discretion

- Exact `AgentEvent`/`AgentTask`/`AgentCapabilities` field shapes beyond `ARCHITECTURE.md` §4's sketch.
- Whether the `artifacts` table needs to land in this phase's migrations for persisted rendered prompts.
- `adl logs -f` reconnect implementation detail (SSE route, byte-offset seek-then-follow) — shape already specified by prior research, this phase implements it.
- Exact `--bare`-equivalent flag mechanism for disabling repo-level config auto-discovery.
- The D-2-08-1 Linux git `safe.directory` fix — a known bug, not a design choice.
- Storage mechanism for `PromptBuilder`'s per-role templates (file vs. DB vs. inline).

## Deferred Ideas

No scope creep occurred — discussion stayed inside the phase boundary throughout.

- The full developer→review→harness→test loop — Phase 5.
- A second agent backend and the `ModelBackend` port — Phase 11.
- Budget enforcement consuming this phase's recorded `usage_events` — Phase 6.
- Reviewed-but-not-folded todos: `reproduce-d-2-r-1-on-linux.md`, `revisit-cross-feature-isolation.md` (noting its Phase-3 revisit trigger already fired), `phase-15-needs-config-neutralisation-criterion.md` — none are this phase's scope.
