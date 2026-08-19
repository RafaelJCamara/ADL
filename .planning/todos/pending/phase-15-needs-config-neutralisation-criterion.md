---
id: phase-15-needs-config-neutralisation-criterion
created: 2026-08-19
source: .planning/phases/02-workspace-the-exec-boundary/deferred-items.md#D-2-R-4
severity: medium
status: pending
resolves_phase: 15
---

# Phase 15 needs an explicit git-config-neutralisation criterion

D-2-R-4 (an attacker-named `filter.<driver>.clean` executes during ADL's own
`snapshot()`) was **accepted for v1 at the Phase 02 UAT gate on 2026-08-19**,
with **Phase 15 named as its owner**.

**The problem this todo exists to prevent:** Phase 15's stated success criteria
are about write auditing, secret scanning, egress, and a published threat model.
**None of them mentions git-config neutralisation.** The verifier flagged this
when it accepted the assignment. If Phase 15 is planned against its criteria as
written, D-2-R-4 lands in a phase with no acceptance point for it, and a
knowingly-accepted arbitrary-execution residual becomes invisible instead of
being re-decided.

## What to do when planning Phase 15

Add an explicit success criterion covering the residual, so it has somewhere to
be either closed or re-accepted with reasoning. Something of the shape:

> The published threat model names the `filter.<driver>` / `diff.<driver>`
> wildcard git-config execution path, states whether it is closed or accepted,
> and — if accepted — what bounds it.

## Why it cannot be closed by the Phase 02 approach

`NEUTRALISED_CONFIG` neutralises keys **by name**. `filter.<driver>.clean` /
`.smudge` and `diff.<driver>.textconv` / `.command` cannot be neutralised that
way, because `<driver>` is chosen by whoever writes the `.gitattributes`.

## Live evidence

`packages/workspace/test/git/neutralisation-residual-risk.test.ts` demonstrates
the path with full neutralisation in force, and passes today. If that test goes
red, the residual closed by accident. If it is ever deleted or weakened, this
acceptance stops being observable.

## Related

- `deferred-items.md` § D-2-R-4 — the disposition, bounds, and three triggers
  for revisiting earlier than Phase 15.
- `02-UAT.md` test 3 — where it was accepted.
- `02-REVIEW.md` § WR-12 — where it was found.
