# M18 — Distribution & Adoption

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** DIST-01, DIST-02, DIST-03, OBS-08 (4)

**Goal:** someone who has never seen ADL installs it and reaches a first pull request
without a security-review conversation stalling them or a broken installation surprising
them mid-run.

---

## Done when

- [ ] A new maintainer installs ADL and reaches a first pull request **without reading past
      the top of the README**.
- [ ] The maintainer runs ADL in **observe-only mode** and sees exactly what it _would_ do,
      without it writing to a repository, a forge, or a model provider.
- [ ] `adl doctor` diagnoses a broken installation — missing forge token, absent backend
      CLI, invalid `adl.yml`, unusable git — **before** any feature is run through it.
- [ ] The README states which forge, backend and runtime versions ADL is tested against.

---

## Step sketch

- [ ] **18.1** — `adl init` (interactive, `@clack/prompts`).
- [ ] **18.2** — **Observe-only mode.** No writes to repo, forge, or provider — it prints
      the plan.
- [ ] **18.3** — `adl doctor`: forge token, backend CLI presence + version, `adl.yml`
      validity, git usability.
- [ ] **18.4** — README rewritten for install-to-first-PR above the fold.
- [ ] **18.5** — The tested-version matrix (forge / backend / runtime).
- [ ] **18.6** — systemd unit + Dockerfile. **The manager _is_ the worker supervisor; the
      OS init system supervises the manager** — no pm2, no forever, no node-windows.
- [ ] **18.7** — A real install-from-scratch rehearsal on a clean machine, timed.

## Notes

**Observe-only mode is the single best adoption lever** and the direct answer to the
security-review conversation M15's threat model opens. A maintainer who can watch ADL
narrate what it _would_ do, touching nothing, will say yes far more often than one asked
to grant repo write access on trust.

ADL is installed into _someone else's_ repository — so extension points, configuration
surface and documentation are v1 concerns, not afterthoughts. This milestone is where
that constraint gets paid.

Criterion 1 is measurable and should be measured: hand the README to someone who has never
seen the project and watch where they stop.
