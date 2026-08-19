// DELIBERATE VIOLATION FIXTURE — owned by plan 03-04.
// Trips: `no-restricted-imports` (D-01's worker-entry ban — the manager is
// the only writer to the database, and the worker must never open it
// directly; every state change is reported over the fork() IPC channel
// instead). This is the guarantee `03-CONTEXT.md` flags as needing its own
// lint rule, "in the spirit of D-27", now that D-21 fixes the package count
// at two and pnpm's strict node_modules can no longer enforce it structurally
// on its own.
// Never compiled, never executed, never imported.
import { createDb } from '@adl/db';

export const makeDb = createDb;
