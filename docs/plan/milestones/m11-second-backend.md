# M11 — Second Agent Backend: Owned Loop

**Status:** ⬜ Not started
**Depends on:** M10
**Requirements:** BACK-02, BACK-03, BACK-04, BACK-06 (4)

**Goal:** the adapter layer is shown to be vendor-neutral by carrying a maximally different
backend — a raw API where **ADL owns the loop** — before any other breadth is attempted.

> **This is the sole breadth item permitted before the dogfood gate.** An adapter
> interface with one implementation is unfalsifiable. The pairing must span the layer gap:
> Claude plus an OpenAI _CLI_ proves much less, GitHub plus GitLab proves less still.

---

## Done when

- [ ] The same feature runs end to end on Claude Code headless (a _delegated_ loop that
      owns its own tools) **and** on the Anthropic API direct (a loop _ADL_ owns), with
      identical core loop code.
- [ ] One conformance suite runs against both adapter families in CI, and an adapter is
      considered finished only when it passes that suite.
- [ ] The core loop contains **no branch on backend identity** — enforced by a lint rule
      that fails the build on backend-name comparisons outside the adapters directory.
- [ ] Switching a feature's backend by configuration leaves the developer, reviewer and
      tester roles all working unchanged.

---

## Step sketch

_Refine into small steps when this milestone starts._

- [ ] **11.1** — The `ModelBackend` port (raw model APIs, structured output, ADL owns the
      loop). M01 named this as the second of two ports for exactly this moment.
- [ ] **11.2** — A tool loop over the `Workspace` interface: Read / Write / Edit / Bash /
      Grep, permissioning, compaction. ⚠️ **This is the genuinely novel work in the
      milestone — budget a spike.**
- [ ] **11.3** — The Anthropic API direct adapter on 11.1 + 11.2.
- [ ] **11.4** — The backend conformance suite, run against both families in CI.
- [ ] **11.5** — The `adl/no-backend-branching` lint rule: no backend-name comparison
      outside the adapters directory. Add a deliberate-violation fixture under
      `test/lint/fixtures/`, per the house pattern.
- [ ] **11.6** — Backend switching by configuration, proven across all three roles.

## Notes

- **Session resume is an optimisation, never a correctness requirement.** That single rule
  is what stops the core quietly becoming Claude-shaped — Gemini's CLI has no resume at
  all, and Gemini returns one JSON object at completion rather than a JSONL event stream.
  The `AgentEvent` type must already tolerate a backend with no incremental progress.
- Agent Client Protocol is worth spiking as an _implementation_ of delegated-loop
  adapters — **never** as the core contract.
- The lint rule in 11.5 matters more than it looks. It is the only thing that keeps
  criterion 3 true as M16 adds two more backends.
