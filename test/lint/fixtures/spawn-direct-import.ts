// DELIBERATE VIOLATION FIXTURE — owned by plan 02-02.
// Trips: `no-restricted-imports` (the WORK-02 spawn ban, static-import form).
// Never compiled, never executed, never imported. It exists so the rule is
// watched failing rather than merely configured (01-RESEARCH.md § Pitfall 8).
import { spawn } from 'node:child_process';

export function launch(command: string, args: readonly string[]): unknown {
  return spawn(command, [...args]);
}
