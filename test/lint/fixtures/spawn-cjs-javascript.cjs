// DELIBERATE VIOLATION FIXTURE — owned by the 02 Warning B fix.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, `require()` form) from a
// `.cjs` file.
//
// The sibling `spawn-esm-javascript.mjs` covers the static-import layer on the
// JavaScript extensions; this one covers the `require()` layer, because the two
// layers are separate rules over separate globs and widening one without the
// other is exactly the half-fix this file exists to catch.
//
// `.cjs` is not hypothetical here the way `.mjs` is. The repository already
// contains one — `packages/workspace/test/helpers/env-dump-child.cjs`, the real
// child process `test/exec/credentials.test.ts` spawns to dump its own
// environment. It sits inside the workspace exemption, so it is not a
// violation; it is proof that the extension is one this project actually
// writes, which makes an architecture rule that cannot see the extension a
// live gap rather than a theoretical one.
//
// See `spawn-esm-javascript.mjs` for the reproduction of the glob defect both
// fixtures guard against.
// Never compiled, never executed, never imported.
function launch(command, args) {
  const { spawn } = require('node:child_process');
  return spawn(command, args);
}

module.exports = { launch };
