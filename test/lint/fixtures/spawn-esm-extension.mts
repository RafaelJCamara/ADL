// DELIBERATE VIOLATION FIXTURE — owned by the 02 verification-gap fix.
// Trips: `no-restricted-imports` (the WORK-02 spawn ban) from a `.mts` file.
//
// This fixture watches the GLOB, not the rule. The three `.ts` spawn fixtures
// beside it cannot detect the defect this one exists for: every architecture
// entry in `eslint.config.js` was registered with `files: ['**/*.ts']`, which
// does not match `.mts` — so this exact content outside `packages/workspace`
// linted clean while the four `.ts` fixtures stayed green and the rule table
// still claimed success criterion 2 was enforced. Reproduced before the fix
// (`packages/db/src/probe.mts`: zero architecture errors, while
// `@typescript-eslint/no-unused-vars` fired on the same file, proving ESLint had
// processed it and the rule had simply never matched) and after it (the same
// file, one `no-restricted-imports` error at severity 2).
//
// `.mts` rather than an arbitrary extension because `execa@10` is ESM-only, so
// an explicitly-ESM module is the file a contributor reaches for when they want
// to call it — this is the accident, not an exotic bypass.
//
// `execa` is not installed at the workspace root and does not need to be: the
// rule is purely syntactic, and this file is inside the global
// `test/lint/fixtures/**` ignore and outside every package's tsconfig include,
// so nothing resolves or compiles it.
// Never compiled, never executed, never imported.
import { execa } from 'execa';

export function launch(command: string): unknown {
  return execa(command);
}
