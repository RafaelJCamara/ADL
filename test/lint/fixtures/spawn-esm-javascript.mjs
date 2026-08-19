// DELIBERATE VIOLATION FIXTURE — owned by the 02 Warning B fix.
// Trips: `no-restricted-imports` (the WORK-02 spawn ban) from a `.mjs` file.
//
// This fixture watches the GLOB, not the rule — the same job
// `spawn-esm-extension.mts` does one extension over, for the gap that fix left
// behind. `TS_SOURCE_EXTENSIONS` closed `.mts`/`.cts`/`.tsx` and stopped there,
// so 02-VERIFICATION.md was able to demonstrate at `84d1d16` that
// `packages/db/src/probe.mjs` containing exactly the line below reported ZERO
// architecture errors. Reproduced again at the start of this fix.
//
// `.mjs` rather than `.js` for the same reason the `.mts` fixture gives:
// `execa@10` is ESM-only, so an explicitly-ESM module is the file a contributor
// reaches for when they want to call it. That is the accident this guards, not
// an exotic bypass.
//
// The counter-argument the verifier recorded, and why it did not survive: no
// tsconfig compiles a `.mjs` and the repository contains none today. But "no
// `.mjs` exists yet" is a fact about today's `git ls-files`, not a property of
// the boundary, and the OS process table does not ask what the file was called.
//
// `execa` is not installed at the workspace root and does not need to be: the
// rule is purely syntactic, and this file is inside the global
// `test/lint/fixtures/**` ignore and outside every package's tsconfig include,
// so nothing resolves or compiles it.
// Never compiled, never executed, never imported.
import { execa } from 'execa';

export function launch(command) {
  return execa(command);
}
