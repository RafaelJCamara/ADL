# ⛔ ARCHIVED — historical record only

**This directory is no longer the project's plan. Do not update anything in it.**

As of **2026-08-24** this project stopped using the GSD planning framework. The live plan
is:

### → [`docs/plan/STATUS.md`](../docs/plan/STATUS.md) ←

with the roadmap, milestones, decisions and debt ledger alongside it in
[`docs/plan/`](../docs/plan/README.md).

---

## Why this directory still exists

Because the detail in it is genuinely load-bearing and expensive to reproduce:

- **`phases/*/`** — 38 plan summaries, 4 verification reports, code reviews, UAT records,
  and `deferred-items.md` files carrying the full reasoning, reproduction steps and
  acceptance decisions behind every known risk. This is the substantive archive.
- **`research/`** — the original stack, architecture, features and pitfalls research.
- **`todos/pending/`** — three open items, all now carried in
  [`docs/plan/DEBT.md`](../docs/plan/DEBT.md).
- **`WINDOWS.md`** — the unrun-verification and deviation ledger; also carried into `DEBT.md`.
- **`ROADMAP.md` / `PROJECT.md` / `REQUIREMENTS.md` / `STATE.md`** — superseded by their
  `docs/plan/` counterparts. **Their status fields are frozen at 2026-08-21 and are now
  wrong.** Read `docs/plan/` for anything current.

## How to use it

Everything carried forward kept its original identifier, so the archive stays greppable:

```bash
grep -rn "D-2-R-1"  .planning/     # cross-feature isolation, accepted with revisit triggers
grep -rn "D-2-R-4"  .planning/     # the git-filter residual, demonstrated by a passing test
grep -rn "WR-03"    .planning/     # open code-review warnings
grep -rn "G-03-3"   .planning/     # the M03 verification gap, since closed
```

`docs/plan/DEBT.md` cites these identifiers throughout and is the current, authoritative
list. This directory is where you go for the *why*, not the *what*.

## Mapping

GSD "phases" are now "milestones", same numbers:

| Was | Is now |
|-----|--------|
| `.planning/ROADMAP.md` | [`docs/plan/ROADMAP.md`](../docs/plan/ROADMAP.md) |
| `.planning/STATE.md` | [`docs/plan/STATUS.md`](../docs/plan/STATUS.md) |
| `.planning/PROJECT.md` § Key Decisions | [`docs/plan/DECISIONS.md`](../docs/plan/DECISIONS.md) |
| `.planning/REQUIREMENTS.md` | [`docs/plan/REQUIREMENTS.md`](../docs/plan/REQUIREMENTS.md) |
| `.planning/phases/NN-*/` | [`docs/plan/milestones/mNN-*.md`](../docs/plan/milestones/) |
| `deferred-items.md` + `WINDOWS.md` + `todos/pending/` | [`docs/plan/DEBT.md`](../docs/plan/DEBT.md) |

Safe to delete this directory whenever you want the tree tidier — everything actionable has
been carried forward, and git history retains the rest.
