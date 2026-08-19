// DELIBERATE VIOLATION FIXTURE — owned by the 02 verification-gap fix.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, `require()` form) from a
// `.cts` file.
//
// The sibling `spawn-esm-extension.mts` covers the static-import layer on a new
// extension; this one covers the `require()` layer, because the two layers are
// separate rules over separate globs and widening one without the other is
// exactly the half-fix this file exists to catch. `.cts` is where `require()` is
// the idiomatic form rather than a contortion, so the pairing is not arbitrary.
//
// See `spawn-esm-extension.mts` for the reproduction of the glob defect both
// fixtures guard against.
// Never compiled, never executed, never imported.
export function launch(command: string, args: readonly string[]): unknown {
  const { spawn } = require('node:child_process') as {
    spawn: (command: string, args: readonly string[]) => unknown;
  };
  return spawn(command, args);
}
