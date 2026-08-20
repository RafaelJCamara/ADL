# Deferred Items

Out-of-scope discoveries logged during plan execution — not fixed, per the
executor's scope-boundary rule (only auto-fix issues directly caused by the
current task's changes).

## From 03-10 (G-03-3 gap closure)

- **`packages/cli/src/render/status-table.ts`** and
  **`packages/manager/src/scheduler/dispatcher.ts`** fail `pnpm format`
  (`prettier --check .`). Both predate this plan (introduced in earlier
  Phase 3 commits — `048ad85`, `3064a60`) and neither file is in 03-10's
  `files_modified` list. Not fixed here; a future formatting-cleanup pass
  should pick these up.
