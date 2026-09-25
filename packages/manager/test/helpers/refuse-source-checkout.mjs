// A guard every replay double that commits calls before it writes or commits
// anything (2026-09-25).
//
// The doubles stand in for an agent CLI, and a real agent commits in whatever
// directory it was started in — so the doubles do too: `process.cwd()`, which
// ADL sets to the workspace root. That is faithful, and it has one failure mode
// worth closing: a double started with a working directory inside THIS
// repository's own checkout commits there. On 2026-09-25 exactly that happened —
// three `agent: implement the feature` commits, adding `agent-output.txt` and a
// root `adl.yml`, landed on the developer's own `main` (`docs/plan/HANDOFF.md`
// records it; the process that did it was never identified).
//
// So a double refuses, loudly, to write or commit anywhere inside the checkout
// its own source file lives in. The reference is this file's location rather
// than `os.tmpdir()`: a double runs under ADL's zero-inherit environment, where
// `TEMP`/`TMP` may be absent and the temp directory resolves somewhere other than
// the test process's. Every legitimate workspace is a temporary repository
// outside this checkout (`withTempRepo` creates them under the OS temp
// directory), so the guard costs nothing on the path it protects.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/manager/test/helpers/` → the checkout root. */
const SOURCE_CHECKOUT = realpathSync(
  fileURLToPath(new URL('../../../../', import.meta.url)),
);

/** The exit status a refusing double uses — distinctive, so a test log names the cause. */
export const REFUSED_SOURCE_CHECKOUT_EXIT = 70;

/**
 * Exit the process, before any write, if `dir` is the source checkout or inside it.
 *
 * @param {string} dir the directory the double is about to commit in
 * @param {string} who the double's own name, for the message
 */
export function refuseToCommitInSourceCheckout(dir, who) {
  const here = realpathSync(dir);
  const rel = relative(SOURCE_CHECKOUT, here);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return;
  process.stderr.write(
    `${who}: refusing to write or commit in ${here}, which is inside this ` +
      `repository's own checkout (${SOURCE_CHECKOUT}). A replay double commits ` +
      'in its working directory, and that must be a temporary test repository — ' +
      'never the source tree the tests were run from.\n',
  );
  process.exit(REFUSED_SOURCE_CHECKOUT_EXIT);
}
