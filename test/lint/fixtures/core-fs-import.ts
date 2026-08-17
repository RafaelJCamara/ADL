// DELIBERATE VIOLATION FIXTURE — owned by plan 01-03.
// Trips: `no-restricted-imports` (the @adl/core purity ban on node:fs).
// Never compiled, never executed, never imported. It exists so the rule is
// watched failing rather than merely configured (01-RESEARCH.md § Pitfall 8).
import { readFileSync } from 'node:fs';

export function readSpec(specPath: string): string {
  return readFileSync(specPath, 'utf8');
}
