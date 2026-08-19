// DELIBERATE VIOLATION FIXTURE — owned by plan 03-03.
// Trips: `no-restricted-imports` (the WORK-02 spawn ban, static-import form),
// in the specific `fork`-shaped form a manager author would reach for if they
// bypassed `forkWorker` (`@adl/workspace`) and imported `node:child_process`
// directly. It stands for the shape `@adl/manager` would take if the Phase 3
// fork() seam had been implemented as a second lint exemption instead of a
// named export — this fixture is the proof that it was not.
// Never compiled, never executed, never imported.
import { fork } from 'node:child_process';

export function launchWorker(entryPath: string): unknown {
  return fork(entryPath);
}
