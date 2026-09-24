/**
 * A plain-command gate that reports what it can actually see (M08 step 8.1).
 *
 * The point of this double is that it answers ROLE-06 **from outside ADL** —
 * 7.5's and 7.9's pattern. It walks its own working directory with its own
 * process and writes what it found to a file OUTSIDE the workspace, so a
 * teardown cannot take the evidence with it.
 *
 * It measures the git question by walking its ANCESTORS for a `.git`, rather
 * than by running git. Two reasons, and the second is the load-bearing one.
 * `adl/no-direct-spawn` bans `node:child_process` outside `packages/workspace`
 * and a test double is not worth an exemption in a rule that exists to keep the
 * exemption count at one. And the ancestor walk measures the *mechanism* —
 * `git rev-parse` finds a repository by walking up, which is precisely why M08
 * step 8.0 found that a `.git`-less copy inside `<repo>/.adl/scratch` leaks
 * anyway. That git itself then refuses is proven where it can be asked
 * properly: `packages/workspace/test/visible/compose.test.ts` runs the real
 * `cat-file`, `show`, `log` and `sparse-checkout disable` through `adlGit`.
 *
 * Doing it here would also have been vacuous by the time the assertion ran: the
 * composed workspace is destroyed when the dispatch ends, so a test that shelled
 * out to git afterwards would be measuring a directory that no longer exists.
 *
 * Nothing here asks ADL what it composed. If ADL's own bookkeeping were wrong,
 * this file would still be right.
 *
 * argv[2] — where to write the report.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const reportPath = process.argv[2];
const root = process.cwd();

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, acc);
    else acc.push(relative(root, absolute).split('\\').join('/'));
  }
  return acc;
}

const files = walk(root).sort();

// Every file the gate can read, concatenated — so the assertion can be "the
// marker appears nowhere", not "the marker is not in the file I thought of".
let contents = '';
for (const file of files) {
  try {
    contents += readFileSync(join(root, file), 'utf8');
  } catch {
    /* binary or unreadable — it cannot carry the marker as text either way */
  }
}

/**
 * Every ancestor of the working directory (and it itself) that contains a
 * `.git`.
 *
 * Empty is the answer ROLE-06 needs. Non-empty means git, run from here, would
 * resolve a repository and read the implementation out of its object store —
 * the exact door a sparse checkout leaves open.
 */
function repositoriesAbove() {
  const found = [];
  let dir = root;
  for (;;) {
    if (existsSync(join(dir, '.git'))) found.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

writeFileSync(
  reportPath,
  JSON.stringify(
    {
      cwd: root,
      files,
      contents,
      repositoriesAbove: repositoriesAbove(),
    },
    null,
    2,
  ),
  'utf8',
);

// Exit 0 — this gate passes. It is measuring its own workspace, not judging
// the feature, and a send-back would start a second round with nothing further
// to observe.
process.exit(0);
