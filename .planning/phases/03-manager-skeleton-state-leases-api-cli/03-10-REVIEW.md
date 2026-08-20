---
phase: 03-manager-skeleton-state-leases-api-cli
reviewed: 2026-08-20T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - packages/manager/test/control/pause-persistence.test.ts
  - packages/db/src/repository/meta.ts
  - packages/db/src/repository/index.ts
  - packages/db/test/repos-meta.test.ts
  - packages/manager/src/control/state.ts
  - packages/manager/src/boot/startup.ts
  - packages/manager/src/daemon.ts
  - packages/manager/src/api/routes/control.ts
  - packages/manager/src/index.ts
  - packages/manager/test/control/pause.test.ts
  - packages/manager/test/control/kill.test.ts
  - packages/manager/README.md
findings:
  critical: 0
  warning: 1
  info: 2
  total: 3
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-08-20T00:00:00Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

This is a focused gap-closure change (G-03-3): persist the daemon's global
pause flag across a restart via a new `meta` row, a write-through in
`control/state.ts`, and a boot-time restore in `boot/startup.ts`. The core
logic that this review was asked to scrutinize is correct:

- **Persist-then-flip ordering** (`control/state.ts`'s `setGlobalPause`): the
  write to `meta` happens first, `globalPaused` is only mutated after the
  `await` resolves without throwing, and a failed write throws
  `GlobalPausePersistError` while leaving the in-memory flag untouched. This
  matches the documented contract exactly, and is exercised against a real
  failing write (an unmigrated `:memory:` database), not a stub.
- **Boot-time restore** (`boot/startup.ts`'s `restoreGlobalPause`): the three
  discriminated cases (`absent` → `false`, silent; `valid` → the stored
  boolean, `warn`-logged only when `true`; `invalid` → `true`, `error`-logged
  with the raw value) are each handled distinctly and match both the tests
  and the README's documented policy. No code path coerces an unreadable
  value into a falsy pass-through.
- **Boot ordering** (`daemon.ts`): `restoreGlobalPause` runs after the schema
  gate and repo reconciliation and before `createSupervisor`, the API bind,
  and the first `setInterval` dispatch tick — satisfying the stated
  requirement.
- All production and test call sites of `createControlState` were updated
  consistently for the new required `db` dependency (verified via a
  repo-wide grep) — no stale callers left passing zero arguments.

One real robustness gap was found in the write-failure error handling on the
API surface (see WR-01 below), plus two minor code-quality notes. No
security issues, no debug artifacts, and no correctness bugs in the ordering
or discrimination logic itself.

## Warnings

### WR-01: `GlobalPausePersistError` is caught and answered with a 500, but never logged server-side

**File:** `packages/manager/src/api/routes/control.ts:333-346` and `:364-378`

**Issue:** Both `POST /control/pause` and `POST /control/resume` catch
`GlobalPausePersistError` and respond with a generic 500 body
(`"the pause/resume flag was not persisted — dispatch is unchanged"`), but
neither handler calls `deps.logger` (or anything else) before returning.
The underlying cause carried on the error (`GlobalPausePersistError`'s
`cause`, e.g. the real SQLite/Kysely failure such as "database is locked" or
"disk I/O error") is discarded entirely. `ControlRoutesDeps.logger` is
available in this closure (it is destructured and used by the neighbouring
`/control/kill` route, and `daemon.ts` always supplies a real `logger` in
production), so this isn't a missing dependency — the call is simply absent.

This is exactly the situation where server-side visibility matters most: an
operator's emergency stop (`adl pause`) failed, the response tells them
"dispatch is unchanged" but gives no indication of *why* persistence failed,
and there is no log line anywhere in this code path to correlate against.
Every other structured-failure path in this phase (`SchemaVersionRefusalError`
in `boot/startup.ts`, `recordLeaseOwnerOnReady` in `daemon.ts`) logs the
error with `logger.error({ err: error }, ...)` before returning/continuing;
this path is the one inconsistency.

**Fix:**
```typescript
} catch (error) {
  if (error instanceof GlobalPausePersistError) {
    deps.logger?.error(
      { err: error },
      'global pause persistence failed — dispatch is unchanged',
    );
    return c.json(
      { error: 'the pause flag was not persisted — dispatch is unchanged' },
      500,
    );
  }
  throw error;
}
```
(mirror for the `/control/resume` handler's catch block)

## Info

### IN-01: Duplicated discriminated get/set pattern in `meta.ts`

**File:** `packages/db/src/repository/meta.ts:100-131`

**Issue:** `getSchemaVersion`/`setSchemaVersion` and
`getGlobalPause`/`setGlobalPause` are structurally identical (read the raw
string, discriminate `absent`/`valid`/`invalid`, write back a stringified
form). This is not wrong, but a third `meta` key added on the same pattern
(e.g. a future flag) would triple the copy-pasted shape rather than reuse it.

**Fix:** Consider a small generic helper, e.g.
`getDiscriminated<T>(key, parse: (raw: string) => T | undefined)`, that both
`getSchemaVersion` and `getGlobalPause` delegate to. Not urgent — two
instances is a reasonable point to leave as-is, but worth extracting before
a third.

### IN-02: Boot-order comment in `daemon.ts` is incomplete relative to actual execution order

**File:** `packages/manager/src/daemon.ts:185-190`

**Issue:** The comment above `restoreGlobalPause` says the restore runs
"after the schema gate and repo reconciliation and before the supervisor is
created, the API binds, or the first dispatch tick runs." That's true but
incomplete: it also runs after `killBootOrphans` and
`expireAllLeasesAtBoot` (lines 181-182), which the comment doesn't mention.
Since those two steps don't interact with the `meta` table, this is harmless
today, but a future maintainer skimming only this comment while reordering
boot steps could miss that dependency.

**Fix:** Expand the comment to name all four steps that precede the restore
(schema gate, repo reconciliation, boot orphan kill, lease expiry), or
simply say "after every other boot-time database write" to stay correct
regardless of future reordering.

---

_Reviewed: 2026-08-20T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
