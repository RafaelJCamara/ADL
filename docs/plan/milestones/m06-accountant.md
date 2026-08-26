# M06 — Accountant: Budgets, Stalls, Escalation

**Status:** ⬜ Not started
**Depends on:** M05
**Requirements:** LOOP-03…08, OBS-05 (7)

**Goal:** an unattended run cannot spend without limit, loop without progress, or fail
silently — every limit reached ends in a human being told where they will see it.

> ⚠️ **Prerequisite: the cost-accounting spike must close before this is planned.**
> Cross-backend usage reporting reliability is unverified. Claude Code's `total_cost_usd`
> is a client-side estimate that can differ from the bill; Codex and Gemini report
> differently; raw APIs return tokens you must price yourself. Run a real agent turn,
> reconcile the reported cost against the actual bill, and decide the
> `cost_source: 'unknown'` degradation path. **The natural place to do this is during
> M05.** See [`DEBT.md`](../DEBT.md).

---

## Done when

- [ ] A per-feature round cap and a per-feature token/cost budget both exist, and whichever
      is hit first stops the feature — **checked before the next agent turn is dispatched,
      never after it has been paid for.**
- [ ] A global spend cap above the per-feature caps halts new dispatch across every
      feature once reached, and where a backend's usage reporting is unreliable the budget
      **visibly degrades** to round and wall-clock caps rather than silently ceasing to enforce.
- [ ] A developer/reviewer stalemate is caught by repeated finding fingerprints and
      escalated _before_ the round cap is reached.
- [ ] A provider outage, rate limit, or auth failure consumes neither a round nor budget,
      and the feature resumes rather than being marked failed.
- [ ] Hitting any limit posts the full transcript and the disagreement to the pull request
      where a human will see it, and spend is visible broken down per feature and per role.

---

## Step sketch

_Refine into small steps when this milestone starts._

- [ ] **6.1** — Close the cost-accounting spike: one real agent turn, reported cost
      reconciled against the provider's billed usage, degradation path decided.
- [ ] **6.2** — Per-feature round cap, enforced at the dispatch gate.
- [ ] **6.3** — Per-feature token/cost budget at the same gate. **Extend
      `dispatchOnce`'s existing check-before-dispatch cap — do not restructure it.** M03
      built that shape deliberately as this milestone's template.
- [ ] **6.4** — Global spend cap halting new dispatch across all features.
- [ ] **6.5** — Visible degradation: when `cost_source` is `unknown`, fall back to round
      and wall-clock caps and _say so_ in status and on the PR.
- [ ] **6.6** — Stalemate detection over repeated finding fingerprints, independent of the
      round and budget caps. (This is where M01's deferred question about fingerprint
      _strength_ finally gets real evidence — see [`DEBT.md`](../DEBT.md).)
- [ ] **6.7** — Provider-failure classification (429 / 5xx / auth) that consumes neither a
      round nor budget, and resumes rather than failing.
- [ ] **6.8** — Escalation: full transcript + the disagreement posted to the PR.
- [ ] **6.9** — Spend breakdown per feature and per role in `adl status` (OBS-05).
- [ ] **6.10** — `budget.warn` at 80% so escalation is never a surprise.

## Notes

- **Check the budget before dispatch, never after.** A check-after design overshoots by
  one full agent run; at Opus rates on a long turn that is real money, and it will be the
  first bug a user reports.
- **Model prices live in a versioned table with `effective_from`, never in code** — that
  table already exists (`model_prices`, seeded in migration `0003`). A price change in code
  silently rewrites historical spend.
- **Prefer the backend's reported cost over your own arithmetic**, and record
  `cost_source ∈ {reported, computed, unknown}` so you can tell later which numbers you trust.
- **Never use `tiktoken` / `gpt-tokenizer` to estimate Anthropic tokens** — wrong
  tokenizer, undercounts by ~15–20% on prose and far more on code. Use backend-reported
  usage or `messages.countTokens()`.
- Budget is a hard gate, so this is core-loop code, not observability.
