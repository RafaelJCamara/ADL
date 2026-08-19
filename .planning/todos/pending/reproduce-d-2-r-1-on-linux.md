---
id: reproduce-d-2-r-1-on-linux
created: 2026-08-19
source: .planning/phases/02-workspace-the-exec-boundary/deferred-items.md#D-2-R-1
severity: medium
status: pending
blocked_by: linux-host
# Intentionally NO `resolves_phase:` — this closes when the reproduction is
# actually RUN, not when some phase happens to finish.
---

# Run the D-2-R-1 cross-feature isolation reproduction on Linux

**Why this is open:** D-2-R-1 (features are not isolated from each other) was
**accepted for v1** at the Phase 02 UAT gate on 2026-08-19. But its reproduction
is still marked `[NOT YET REPRODUCED ON A LINUX HOST]` — it is argued from the
code, never executed.

**Why that matters:** the acceptance was made against a *reasoned* model of the
risk, not a demonstrated one. That is a lower standard than Phase 02 applied to
everything else, and it is exactly the gap that produced three separate CI
surprises during that phase — each time, a property that looked true on Windows
behaved differently on Linux. If the reproduction does not behave as reasoned,
the acceptance was made against a wrong model and must be re-decided.

This cannot be run on the maintainer's Windows development machine: it needs a
provisioned Linux host with the `adl-worker` user (see
`packages/workspace/README.md` for the sudoers drop-in and provisioning).

## The reproduction

No ADL code required — the shell stands in for feature A's agent, which runs as
exactly this identity.

```sh
# Two features, created by the daemon in the ordinary way:
#   /srv/adl/scratch/feat-a   (worktree, group adl-worker, group rwx)
#   /srv/adl/scratch/feat-b

# Act as feature A's agent — the identity EVERY agent runs as:
sudo --preserve-env --non-interactive --user adl-worker -- \
  sh -c 'echo "// planted by A after B was reviewed" >> /srv/adl/scratch/feat-b/src/index.ts'
echo $?          # expected: 0 — the write succeeds

stat -c '%U %G %a' /srv/adl/scratch/feat-b
                 # expected: adl adl-worker 770
```

Also worth confirming while there, since they are the same grant from other
angles:
- A can read/write `<mainRepo>/.git/worktrees/feat-b/**` (B's index and `HEAD`)
- A can enter B's scratch `HOME` and read a `.gitconfig` credential helper,
  an `.npmrc` token, or an agent CLI session file

## What to do with the result

- **Behaves as reasoned (write succeeds):** update D-2-R-1 to drop the
  `[NOT YET REPRODUCED]` marker and record the run. The v1 acceptance stands,
  now on demonstrated rather than argued severity.
- **Does NOT behave as reasoned:** the acceptance was made against a wrong model.
  Re-open the decision and re-record it — the risk may be smaller, or differently
  shaped, than what was accepted.

## Related

- `.planning/todos/pending/revisit-cross-feature-isolation.md` — the standing
  requirement to actually FIX this (uid pool), with its own revisit triggers.
- `02-UAT.md` test 2 — skipped for this reason.
- `02-REVIEW.md` § CR-03 — where it was found.
