# M15 — Security Hardening & Published Threat Model

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** WORK-08, WORK-09, WORK-10 (3)

**Goal:** a prospective maintainer can read exactly where the trust boundary sits, and see
that agent output cannot carry secrets out or writes escape unnoticed.

> **Security posture is an adoption gate, not a hardening afterthought.** "Install a daemon
> with repo write access and our model API keys" is a security-review conversation, and
> that conversation is where adoption dies.

---

## Done when

- [ ] Writes outside expected paths during a round are detected and surfaced to the
      maintainer *after that round*, rather than discovered later.
- [ ] Agent output is secret-scanned and size-capped before it can reach a forge — a
      credential planted in agent output never appears in a PR comment.
- [ ] The maintainer reads a published threat model and `SECURITY.md` stating plainly that
      **anyone who can write a file into a watched repository can execute code on the ADL
      host with ADL's credentials**, before deciding to install.
- [ ] Egress is restricted by allowlist with the cloud metadata endpoint explicitly
      blocked, transcripts are redacted at the logger, and branch protection is verified at
      startup.
- [ ] ⚠️ **Added criterion — do not plan this milestone without it:** the threat model
      explicitly covers **git-configuration neutralisation**, including the accepted
      residual D-2-R-4. See below.

---

## Step sketch

- [ ] **15.1** — Post-round write auditing outside expected paths (WORK-08).
- [ ] **15.2** — Secret scanning of agent output before it reaches a forge (WORK-09).
- [ ] **15.3** — Output size cap (deliberately deferred from M02 to here).
- [ ] **15.4** — Egress allowlist, with the cloud metadata endpoint explicitly blocked.
- [ ] **15.5** — Transcript redaction at the logger (pino's built-in `redact`).
- [ ] **15.6** — Branch-protection verification at startup.
- [ ] **15.7** — `SECURITY.md` and the published threat model (WORK-10).
- [ ] **15.8** — **The git-config-neutralisation section of the threat model**, carrying
      D-2-R-4 with its reasoning. See the note below.
- [ ] **15.9** — Re-decide, or re-accept with fresh reasoning, D-2-R-1 (cross-feature
      isolation) and D-2-R-3 (the `assertWithinRoot` TOCTOU).

## ⚠️ The criterion this milestone must gain

M02 accepted **D-2-R-4** for v1 and named M15 as its owner: an attacker-named
`filter.<driver>.clean`, selected by a committed `.gitattributes`, executes an arbitrary
program during ADL's own `snapshot()` — **with full config neutralisation in force.** This
is not argued; there is a *passing* test demonstrating it
(`packages/workspace/test/git/neutralisation-residual-risk.test.ts`).

**The problem:** this milestone's success criteria, as originally written, are about write
auditing, secret scanning, egress and the threat model. **None of them mentions git-config
neutralisation.** If M15 is planned against those criteria as written, a knowingly-accepted
arbitrary-execution residual lands in a milestone with no acceptance point for it and
becomes invisible instead of being re-decided.

Criterion 5 above exists to prevent exactly that. Full detail in [`DEBT.md`](../DEBT.md).

## Notes

This milestone is the **remainder**, not the whole story. The cheap parts already landed:
unprivileged user and scoped `HOME` (M02), manager-only credentials (M02/M03), trusted-path
spec detection and protected paths (M05).
