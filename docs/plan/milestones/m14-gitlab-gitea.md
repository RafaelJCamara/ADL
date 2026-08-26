# M14 — GitLab, then Gitea

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** FORGE-03, FORGE-04 (2)

**Goal:** the forge abstraction survives contact with a genuinely different forge, and with
the narrowest one it was designed around.

---

## Done when

- [ ] A feature runs end to end on **GitLab** — draft merge request opened at round 1,
      sticky per-role notes edited in place, promoted to ready when every gate is green.
- [ ] A feature runs end to end on **Gitea**, with no capability the base interface offers
      that Gitea cannot honour.
- [ ] One forge conformance suite runs against real GitHub _and_ a Dockerised Gitea in CI,
      and a forge adapter is done only when it passes.

---

## Step sketch

- [ ] **14.1** — The forge conformance suite (extract it from M05's GitHub adapter, so the
      suite exists before the second implementation does).
- [ ] **14.2** — GitLab adapter via `@gitbeaker/rest`.
- [ ] **14.3** — GitLab in CI against a real instance.
- [ ] **14.4** — Gitea adapter — a hand-rolled `fetch` client, ~200 LOC.
- [ ] **14.5** — Dockerised Gitea in CI.
- [ ] **14.6** — Confirm no base-interface capability is unhonourable on Gitea. If one is,
      the _interface_ is wrong, not Gitea.

## Notes

**Ordering is deliberate.** GitLab is second because it is genuinely _different_ and forces
the abstraction honest. Gitea is third but the base interface was designed to its floor
back in M05 — top-level comments only, no line-level diff comments, no review updates, no
PR-code-comment webhook. **Gitea should therefore be near-free by the time it is built.**
If it isn't, M05's interface drifted and that is the finding.

⚠️ **Research flagged for GitLab:** `iid` vs `id`, URL-encoded project addressing, the
notes-vs-reviews model, the `Draft:` title-prefix convention, and Standard Webhooks
signing (`X-Gitlab-Token` is a plain shared secret compared verbatim, **not** an HMAC).

`@gitbeaker/rest` is the de-facto Node GitLab client but ships on a slower cadence than
Octokit — check its maintenance state before committing. For Gitea, prefer the hand-rolled
client: `gitea-js` is swagger-generated and stale.
