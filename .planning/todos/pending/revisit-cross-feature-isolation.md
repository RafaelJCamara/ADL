---
id: revisit-cross-feature-isolation
created: 2026-08-19
source: .planning/phases/02-workspace-the-exec-boundary/deferred-items.md#D-2-R-1
severity: high
status: pending
# Intentionally NO `resolves_phase:` — this must not auto-close when a phase
# completes. It closes only when a uid pool actually ships, or when the risk is
# re-accepted with fresh reasoning.
---

# Revisit: features are not isolated from each other (D-2-R-1)

**Accepted for v1 at the Phase 02 UAT gate (2026-08-19). Not closed.**

ADL runs **one trust domain per daemon**. Every concurrent feature's agent runs
as the same uid in the same group, so feature A's agent can rewrite feature B's
source *after B's reviewer stage passed and before its PR opens* — a supply-chain
path from an untrusted feature spec (D-22) into a human-approved PR.

Group and mode bits cannot fix this: they cannot separate two processes sharing a
uid. The real fix is a pool of distinct uids leased per feature, with lease state
owned by the manager and one sudoers entry per pool member.

## Revisit when ANY of these is true

1. **Phase 3 introduces manager-owned lease state** — the first point at which a
   uid pool is buildable, and the natural home for the fix.
2. **Concurrency > 1 on a shared or multi-tenant host.** Single-feature-at-a-time
   deployments do not hit this.
3. **The mandatory human approval gate before merge is relaxed or automated.**
   That gate is the only remaining control between this and a tampered PR.
4. **Before any public or multi-tenant deployment of ADL is advertised.**

## Still outstanding

The reproduction in D-2-R-1 is marked `[NOT YET REPRODUCED ON A LINUX HOST]` —
argued from the code, never run. That is `02-UAT.md` test 2 and remains open.
Until it runs, the severity is reasoned rather than demonstrated, which is a
lower standard than this phase applied to everything else.

## Full context

`.planning/phases/02-workspace-the-exec-boundary/deferred-items.md` § D-2-R-1 —
carries the disposition, the reasoning, and a runnable reproduction.
`02-REVIEW.md` § CR-03 is where it was found.
