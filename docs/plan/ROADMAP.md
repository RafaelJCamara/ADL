# ADL Roadmap

**ADL — Autonomous Delivery Loop.** A self-hosted daemon that turns a feature folder
into a reviewed, tested, human-approvable pull request without anyone driving the
handoffs.

**Core value:** a feature folder goes in, and a green, human-approvable PR comes out —
with the whole loop's reasoning visible in the PR.

> New here? Read [`STATUS.md`](./STATUS.md) first. It says exactly where we are and
> what to do next.

---

## Status at a glance

```
M01 ██████████ done        M07 ░░░░░░░░░░ not started
M02 █████████▒ code done   M08 ░░░░░░░░░░ not started
M03 ██████████ done        M09 ░░░░░░░░░░ not started
M04 █████████▒ code done   M10 ░░░░░░░░░░ not started
M05 █████████▒ code done   M11 ░░░░░░░░░░ not started
M06 ░░░░░░░░░░ NEXT  ◀     M12 ░░░░░░░░░░ ⛔ HARD GATE
                           M13–M18 ░░░░░ blocked on M12
```

**5 of 18 milestones delivered. 3 of those carry one deferred check each** (see
[`DEBT.md`](./DEBT.md)) — the code is merged, tested and on `main`; what's outstanding
is an environment precondition, not project work.

---

## The shape of the plan

```
M01–M04   contracts and machinery      ← nothing a user can see yet
M05       the product first exists     ← a feature folder becomes a PR (done)
M06–M11   make the loop safe + complete
M12       ⛔ DOGFOOD — hard gate
M13–M18   breadth, on a validated core
```

**M12 blocks M13–M18 absolutely.** It is a precondition, not a milestone label. A
change to the verdict schema costs roughly 8× more once it has to propagate through
three forge adapters, four backend adapters and a dashboard — so the gate stays in
front of breadth until the loop is proven. The one exception permitted before the
gate is M11 (second agent backend), because an adapter interface with a single
implementation is unfalsifiable.

---

## Milestones

| #       | Milestone                                     | Status               | Depends on | Detail                                               |
| ------- | --------------------------------------------- | -------------------- | ---------- | ---------------------------------------------------- |
| M01     | Core Contracts                                | ✅ done · 2026-08-17 | —          | [m01](./milestones/m01-core-contracts.md)            |
| M02     | Workspace & the Exec Boundary                 | 🟡 code complete     | M01        | [m02](./milestones/m02-workspace-exec-boundary.md)   |
| M03     | Manager Skeleton — State, Leases, API, CLI    | ✅ done · 2026-08-20 | M02        | [m03](./milestones/m03-manager-skeleton.md)          |
| M04     | First Agent Backend & Live Transcripts        | 🟡 code complete     | M03        | [m04](./milestones/m04-agent-backend-transcripts.md) |
| M05     | The Loop Closes                               | 🟡 code complete     | M04        | [m05](./milestones/m05-the-loop-closes.md)           |
| **M06** | **Accountant — Budgets, Stalls, Escalation**  | ◀ **NEXT**           | M05        | [m06](./milestones/m06-accountant.md)                |
| M07     | Code Reviewer on the Gate Plugin Interface    | ⬜ not started       | M06        | [m07](./milestones/m07-code-reviewer-gate.md)        |
| M08     | Behaviour Tester & Committed Regression Tests | ⬜ not started       | M07        | [m08](./milestones/m08-behaviour-tester.md)          |
| M09     | The Pull Request as the Product               | ⬜ not started       | M08        | [m09](./milestones/m09-pr-as-product.md)             |
| M10     | Webhook Detection                             | ⬜ not started       | M09        | [m10](./milestones/m10-webhook-detection.md)         |
| M11     | Second Agent Backend — Owned Loop             | ⬜ not started       | M10        | [m11](./milestones/m11-second-backend.md)            |
| M12     | **DOGFOOD — hard gate**                       | ⛔ gate              | M11        | [m12](./milestones/m12-dogfood-gate.md)              |
| M13     | Reference Harnesses & Third-Party Gates       | 🔒 blocked           | M12        | [m13](./milestones/m13-reference-harnesses.md)       |
| M14     | GitLab, then Gitea                            | 🔒 blocked           | M12        | [m14](./milestones/m14-gitlab-gitea.md)              |
| M15     | Security Hardening & Published Threat Model   | 🔒 blocked           | M12        | [m15](./milestones/m15-security-hardening.md)        |
| M16     | OpenAI & Gemini Backends                      | 🔒 blocked           | M12        | [m16](./milestones/m16-openai-gemini.md)             |
| M17     | HTTP API Completeness & Web Dashboard         | 🔒 blocked           | M12        | [m17](./milestones/m17-api-dashboard.md)             |
| M18     | Distribution & Adoption                       | 🔒 blocked           | M12        | [m18](./milestones/m18-distribution.md)              |

**Status key** — ✅ done and verified · 🟡 code complete, one deferred check open ·
◀ next up · ⬜ not started · ⛔ hard gate · 🔒 blocked behind the gate

M01→M05 are strictly serial: `@adl/core` has no I/O and everything sits on top of it.
M13–M18 are largely parallel once M12 passes.

---

## Requirements coverage

93 v1 requirements, all mapped, no orphans. Full register with IDs and per-requirement
status: [`REQUIREMENTS.md`](./REQUIREMENTS.md).

| Category                | Count | Where                                                 |
| ----------------------- | ----- | ----------------------------------------------------- |
| Core Contracts          | 6     | M01 ✅                                                |
| Feature Intake          | 6     | M01 ✅ (5) · M05 ✅ (1)                               |
| Detection & Scheduling  | 5     | M05 ✅ (3) · M10 (2)                                  |
| The Loop                | 9     | M05 ✅ (2) · M06 (6) · M07 (1)                        |
| Agent Roles             | 11    | M05 ✅ (3) · M07 (2) · M08 (6)                        |
| Harness Extensibility   | 6     | M07 (4) · M13 (2)                                     |
| Model Backends          | 10    | M04 ✅ (2) · M05 ✅ (1) · M06 (1) · M11 (4) · M16 (2) |
| Forge Integration       | 12    | M05 🟡 (5) · M09 (5) · M14 (2)                        |
| Execution & State       | 7     | M01 ✅ (1) · M03 ✅ (6)                               |
| Workspace & Trust       | 10    | M02 (7) · M15 (3)                                     |
| Observability & Control | 8     | M03 ✅ (3) · M04 ✅ (1) · M06 (1) · M17 (2) · M18 (1) |
| Distribution & Adoption | 3     | M18                                                   |

**Deferred to v2** (tracked, not planned): multi-repo fleet management, container-per-feature
isolation, concurrency > 1 as a supported configuration, remote workers, issue-to-spec
bridging, harness registry, cost prediction, autonomous merge.

---

## Working agreement

- **One milestone at a time**, in order. Steps inside a milestone can be reordered
  freely; the milestone boundary is the thing that holds.
- **Every step is one commit**, small enough to finish in a sitting. If a step turns
  out to be two things, split it in the milestone file rather than growing the commit.
- **A milestone is done when its "Done when" boxes are all ticked** — not when the
  steps are. The steps are a route; the acceptance criteria are the destination.
- **Anything discovered and not fixed goes in [`DEBT.md`](./DEBT.md)** with an owner
  milestone. Deferred is not done.
- **Decisions already taken live in [`DECISIONS.md`](./DECISIONS.md)** — read it before
  proposing an architecture change, so settled questions stay settled.

---

_Derived from the GSD planning corpus on 2026-08-24. The historical record — phase
plans, code reviews, verification reports, and the full reasoning behind every accepted
risk — is preserved read-only in [`.planning/`](../../.planning/ARCHIVED.md)._
