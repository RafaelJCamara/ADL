/**
 * Dumps its own environment to stdout and exits 0.
 *
 * This is the instrument the WORK-06 assertion reads. It exists as a real file
 * a real child process runs, rather than as a `node -e` string, because the
 * thing under test is what the OPERATING SYSTEM handed the child — not what
 * `buildChildEnv` returned. Node modifies the environment on the way across
 * (it injects eleven variables on Windows, drops `undefined` values, and
 * collapses case-colliding keys), so a test that inspects the builder's return
 * value measures the wrong side of the boundary.
 *
 * `.cjs` on purpose: it runs under Node with no transform, no loader flag, and
 * no participation in the package's TypeScript build, so nothing about the
 * build configuration can change what this observes.
 *
 * **Do not hand this path to a workspace child directly.** Under WORK-05 the
 * child is a different OS user which cannot read ADL's own checkout — by
 * design. `test/exec/credentials.test.ts` copies this file into the workspace's
 * scratch `HOME` first; see `stageEnvDumpChild` there for the full reasoning.
 *
 * One JSON object on one line. Values may contain anything an agent's
 * environment can contain, including newlines, and `LogChunk`s arrive
 * line-split — so a key=value-per-line format would silently split a
 * multi-line value across chunks and make the parse ambiguous exactly where a
 * leak would be interesting.
 */
process.stdout.write(JSON.stringify(process.env) + '\n');
