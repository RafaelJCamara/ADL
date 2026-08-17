// DELIBERATE VIOLATION FIXTURE — owned by plan 01-03.
// Trips: `no-restricted-imports` (D-27's dependency-graph rule — @adl/core
// sits at the bottom of the graph and imports no sibling workspace package).
// Never compiled, never executed, never imported.
import { createDb } from '@adl/db';

export const makeDb = createDb;
