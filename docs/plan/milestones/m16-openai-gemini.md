# M16 — OpenAI & Gemini Backends

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** BACK-07, BACK-08 (2)

**Goal:** the vendor-neutrality claim becomes literally true — four backends across two
adapter families, all through the same conformance suite.

---

## Done when

- [ ] A feature runs end to end on **OpenAI**, via both the raw API and the Codex CLI.
- [ ] A feature runs end to end on **Gemini**, via both the raw API and the Gemini CLI.
- [ ] Both pass the existing backend conformance suite in CI with **zero new core-loop
      branches**, and each records per-invocation cost or visibly degrades where it cannot.

---

## Step sketch

- [ ] **16.1** — Codex CLI adapter (`codex exec`) on the `AgentBackend` port.
- [ ] **16.2** — OpenAI raw-API adapter on the `ModelBackend` port.
- [ ] **16.3** — Gemini CLI adapter (`gemini -p`).
- [ ] **16.4** — Gemini raw-API adapter.
- [ ] **16.5** — All four through the conformance suite in CI.
- [ ] **16.6** — Per-invocation cost for each, or visible degradation where the backend
      cannot report it.
- [ ] **16.7** — Confirm the `adl/no-backend-branching` lint rule (M11) still passes with
      four backends. **This is the milestone that proves M11's rule was worth writing.**

## Notes

Largely parallelisable with M13, M14, M15 and M17 once the gate passes.

**The asymmetry to design for — and M11 should already have absorbed it:**

|                   | Claude Code                           | Codex CLI                | Gemini CLI                        |
| ----------------- | ------------------------------------- | ------------------------ | --------------------------------- |
| Headless invoke   | `claude -p`                           | `codex exec`             | `gemini -p`                       |
| Event stream      | `--output-format stream-json` (JSONL) | `--json` (JSONL)         | ❌ **one JSON object at the end** |
| Structured result | `--output-format json`                | `--output-schema <file>` | `--output-format json`            |
| Resume            | `--resume <id>`                       | `codex exec resume <id>` | ❌ **none**                       |
| Turn cap          | `--max-turns N`                       | — (budget + timeout)     | —                                 |
| Sandbox           | permission modes / hooks              | `--sandbox`              | —                                 |

Gemini is the one that breaks naive assumptions: no incremental progress and no resume.
If `AgentEvent` cannot already tolerate that, the port was Claude-shaped and M11's
vendor-neutrality claim was false.

**Model IDs are bare aliases with no date suffixes.** Date-suffixed IDs will 404.
