# M10 — Webhook Detection

**Status:** ⬜ Not started
**Depends on:** M09
**Requirements:** DETECT-02, DETECT-04 (2)

**Goal:** features are picked up within seconds wherever webhooks reach, without ever
producing a second run.

> Pure latency improvement — polling already works, so this can block nothing. That is
> why it sits *after* the loop closes rather than before it.

---

## Done when

- [ ] A feature folder pushed to a repository with a webhook configured starts ADL within
      seconds instead of at the next poll, **with polling still working** when the webhook
      is unreachable.
- [ ] A mis-signed or replayed webhook payload is rejected **before it is parsed**,
      verified over the *raw request body*.
- [ ] Webhook and polling detecting the same new feature simultaneously produce exactly
      one run, and webhook health is visible in `adl status`.

---

## Step sketch

*Refine into small steps when this milestone starts.*

- [ ] **10.1** — The webhook route on the manager's Hono app, reading the raw body via
      `await c.req.arrayBuffer()`.
- [ ] **10.2** — HMAC verification over the raw bytes with `timingSafeEqual`, per-forge.
- [ ] **10.3** — Replay rejection.
- [ ] **10.4** — Webhook → "re-evaluate repository state" trigger. **The webhook must not
      carry state** — it triggers the same pure detection function M05 built (DETECT-01).
      That is what makes double-detection harmless.
- [ ] **10.5** — Prove exactly-one-run under simultaneous webhook + poll.
- [ ] **10.6** — Webhook health in `adl status`.

## Notes

**HMAC over the raw request body bytes — never over re-serialized JSON.** Key ordering and
whitespace differ from what the forge signed, and every signature silently fails. Hono was
chosen partly because `await c.req.arrayBuffer()` makes this trivial.

Per-forge signing schemes (relevant now, and again in M14):

| Forge | Header | Scheme |
|-------|--------|--------|
| GitHub | `X-Hub-Signature-256` | `sha256=` + HMAC-SHA256 hex of the raw body |
| Gitea / Forgejo | `X-Gitea-Signature` (also sends the GitHub-compatible header) | lowercase hex HMAC-SHA256 of the raw body, **no prefix** |
| GitLab | `X-Gitlab-Token` | **a plain shared secret compared verbatim — not an HMAC** |

`@octokit/webhooks` does constant-time verification and typed payloads for GitHub;
the other two are small enough to hand-roll.
