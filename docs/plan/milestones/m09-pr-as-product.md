# M09 — The Pull Request as the Product

**Status:** ⬜ Not started
**Depends on:** M08
**Requirements:** FORGE-07…09, FORGE-11, FORGE-12 (5)

**Goal:** a reviewer arriving cold reconstructs the entire run from the pull request alone
in about a minute, and no crash ever duplicates a comment or a pull request.

> **The PR comment _is_ the product.** The value proposition is measured in review time
> saved, but the delivered artefact is _more code to review_. If ADL does not demonstrably
> reduce human review effort, it is negative value regardless of how well the loop works.

---

## Done when

- [ ] The reviewer opens the PR and reads one rollup covering what was built, what was
      challenged, what was redone, and how behaviour was verified — **without opening the
      daemon or reading a log.**
- [ ] The reviewer sees a coverage table mapping every acceptance criterion to the test
      that verified it, with any unverified criterion **visibly** unverified.
- [ ] The reviewer sees what the feature cost.
- [ ] Killing the daemon mid-post and restarting it produces no duplicate comment and no
      duplicate pull request.
- [ ] Under forge rate limiting — including GitHub's _secondary_ limits — ADL backs off
      and completes rather than being throttled into failure.

---

## Step sketch

_Refine into small steps when this milestone starts._

- [ ] **9.1** — The transactional outbox: every forge side effect written in the _same
      transaction_ as the state change that caused it. (M01 deliberately left the outbox
      table out, with a `DEFERRED_TABLES` test asserting its absence — this is where it
      lands.)
- [ ] **9.2** — Outbox drain with idempotency keys. The git commit is the checkpoint;
      at-least-once with idempotency keys is the only honest semantics for nondeterministic
      agent output.
- [ ] **9.3** — The rollup comment: built / challenged / redone / verified.
- [ ] **9.4** — The criterion coverage table, joined on `criterionId` (the join key M01
      shipped precisely so this is possible without re-running every prompt).
- [ ] **9.5** — Cost on the PR.
- [ ] **9.6** — Crash-mid-post test: kill the daemon between the state write and the forge
      call, restart, assert exactly one comment and one PR.
- [ ] **9.7** — Rate-limit backoff, including GitHub's secondary limits.
- [ ] **9.8** — A review-time measurement so "does this actually save time" stops being an
      assumption.

## Notes

- **Unverified must be visibly unverified.** M01 made `inconclusive` structurally
  incapable of producing green; this is where that becomes something a human can _see_.
- Secondary rate limits are the ones that bite: they are triggered by comment volume and
  burst patterns, which is exactly what a multi-role multi-round loop produces. M05's
  sticky-comment model is the primary mitigation; backoff is the backstop.
