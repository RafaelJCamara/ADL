// DELIBERATE VIOLATION FIXTURE — owned by plan 02-02.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, require() form, over
// the BARE specifier — proving both spellings are covered). `no-restricted-
// imports` is blind to this form: 02-RESEARCH.md § Pitfall 2 reproduced it
// reporting the static import and neither of the other two.
// Never compiled, never executed, never imported.
const childProcess = require('child_process');

export function launch(command: string): unknown {
  return childProcess.spawn(command);
}
