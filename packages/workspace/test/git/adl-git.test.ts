/**
 * 02-REVIEW.md CR-01 and CR-02, reproduced and then closed.
 *
 * `poisoned-config.test.ts` proved the *manager client* beats a poisoned
 * repository. It did not — and could not — say anything about the eight git
 * invocations that never went through a client: `worktree/lifecycle.ts`,
 * `worktree/list.ts` and `worktree/backend.ts` each held a `simpleGit(...)`
 * handle, and every one of those commands reads `<mainRepo>/.git/config`, which
 * is exactly the file the suite next door proves an agent can write. Its own
 * prose spotted the shape and stopped one step short: *"a plain, unremarkable
 * git command run by a process that is not the manager client executed an
 * attacker-planted program … That is the whole threat in one line."* That
 * comment is about `repo.git.raw(['checkout', …])` — the same call shape three
 * production modules were making.
 *
 * So this file is written in the same three parts, for the same reason: a
 * reader who does not accept the premise should be able to watch it happen.
 *
 * 1. **CONTROL.** A bare `simpleGit` handle — the code that shipped — runs an
 *    ordinary `git status` against a poisoned repository. The planted hook
 *    RUNS, and it reports back a credential-shaped variable it found in its own
 *    environment. One case, both findings: CR-01 is that the program ran, CR-02
 *    is what it was holding when it did.
 * 2. **SUBJECT.** The identical operation through {@link adlGit}, and then the
 *    real production entry points — `createWorktree`, `listManagedWorktrees`,
 *    `destroyWorktree`, `snapshot()` — against the same poisoned repository.
 *    Nothing runs.
 * 3. **The environment, measured on the child rather than on the builder.**
 *    `test/exec/credentials.test.ts` measures children launched through
 *    `run()`, which is precisely why it could not observe CR-02: the
 *    `simple-git` children were not launched through `run()`. This part points
 *    ADL's git at a stand-in binary that prints its own environment, so the
 *    assertion is about what the OPERATING SYSTEM handed the process.
 *
 * **On writing the poison straight into `.git/config`.** The suite next door
 * poisons through a real agent `exec`, because the claim it is making is that
 * an agent *can*. That claim is proven there and is not re-proven here; what is
 * under test in this file is the READ side, so the fixture puts the value in the
 * file by the shortest honest route. `simple-git` would refuse it anyway — its
 * `block-unsafe-operations` plugin rejects a `core.hooksPath` write by name.
 */
import { appendFile, chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The one place in this package's source tree that may name it is
// `src/git/adl-git.ts`'s docblock; a test is not source, and the CONTROL below
// is the entire reason the ban is worth having. See
// `eslint.config.js` § adl/no-simple-git-in-workspace-src.
import { simpleGit } from 'simple-git';
import { adlGit } from '../../src/git/adl-git.js';
import { workspaceRegistry } from '../../src/registry.js';
import {
  createWorktree,
  destroyWorktree,
} from '../../src/worktree/lifecycle.js';
import { listManagedWorktrees } from '../../src/worktree/list.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

/**
 * A credential-shaped variable set on THIS process and never named on any
 * `ExecSpec`.
 *
 * The name matters as much as the value: `WORK-06` is about the daemon's own
 * environment being where a forge token and a model key live, and a probe called
 * `ADL_PROBE_1` would let a reader wonder whether something filters by name.
 */
const LEAK_VAR = 'GITHUB_TOKEN';
const LEAK_VALUE = 'ghp-adl-cr02-must-not-reach-a-git-child-8f13';

/** ADL's own git home for this fixture — never the daemon user's real one. */
let adlHome: string;
let repo: OpenedTempRepo;
/** The directory the poisoned `core.hooksPath` points at. */
let hooksDir: string;
/** Where a hook that ran writes what it saw. */
let sentinel: string;

/** Git wants forward slashes in configuration values; `\` is an escape there. */
const asConfigPath = (path: string): string => path.replaceAll('\\', '/');

const ENV_DUMP_CHILD = fileURLToPath(
  new URL('../helpers/env-dump-child.cjs', import.meta.url),
);

/** Whether the hook left its report behind, and what it said. */
async function sentinelReport(): Promise<string | undefined> {
  try {
    return await readFile(sentinel, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Plant hooks that report both that they ran and what they were holding.
 *
 * Two hook names, because the operations under test refresh the index in two
 * different ways: `post-index-change` is what `git status` fires (verified
 * locally and by `poisoned-config.test.ts`), and `post-checkout` is what
 * `git worktree add` fires (verified against git 2.49 while writing this file).
 * A single hook name would make half the SUBJECT cases pass because git never
 * called anything, which is the shape of a control that proves nothing.
 *
 * The body uses `echo` and a parameter expansion and nothing else — both are sh
 * builtins, so this reports identically under git for Windows' bundled sh and
 * under a Linux `/bin/sh` without depending on `env`, `printenv`, or a PATH the
 * hook may not have.
 */
async function plantHooks(): Promise<void> {
  const body = `#!/bin/sh\necho "FIRED ${LEAK_VAR}=\${${LEAK_VAR}}" > "${asConfigPath(sentinel)}"\nexit 0\n`;

  for (const name of ['post-index-change', 'post-checkout']) {
    const hook = join(hooksDir, name);
    await writeFile(hook, body, 'utf8');
    // A no-op on Windows — git for Windows runs hooks through its own sh and
    // does not consult the executable bit — and load-bearing on POSIX, where
    // git skips a hook without it. Reproduced both ways in the suite next door.
    await chmod(hook, 0o755);
  }
}

/**
 * Give git a reason to rewrite the index, so `post-index-change` can fire.
 *
 * The obvious setup — dirty the file — is exactly wrong: a file whose CONTENT
 * differs from the index stays "modified", so there is no cached stat entry to
 * update and nothing to write back. The setup that works is the opposite:
 * content identical to `HEAD` with an mtime git cannot trust. `poisoned-config.test.ts`
 * establishes this at length; it is reproduced rather than imported because the
 * two suites own their own fixtures.
 *
 * The `checkout` writes the index too, so it fires the hook itself — through the
 * fixture's own handle, which carries none of ADL's overrides. Clearing the
 * sentinel afterwards is not tidying: leaving it would make every SUBJECT case
 * below fail against a report the SETUP produced.
 */
async function primeIndex(): Promise<void> {
  await repo.git.raw(['checkout', '--', 'tracked.txt']);
  const ahead = new Date(Date.now() + 10_000);
  await utimes(join(repo.mainRepo, 'tracked.txt'), ahead, ahead);
  await rm(sentinel, { force: true });
}

beforeAll(async () => {
  repo = await openTempRepo();
  hooksDir = join(repo.scratchRoot, '..', 'cr01-hooks');
  adlHome = join(repo.scratchRoot, '..', 'cr01-adl-home');
  sentinel = join(hooksDir, 'FIRED');
  await mkdir(hooksDir, { recursive: true });
  await mkdir(adlHome, { recursive: true });

  // Straight into the file the agent is able to write. See the module docblock.
  await appendFile(
    join(repo.mainRepo, '.git', 'config'),
    `[core]\n\thooksPath = ${asConfigPath(hooksDir)}\n`,
    'utf8',
  );

  process.env[LEAK_VAR] = LEAK_VALUE;
  await plantHooks();
});

afterAll(async () => {
  delete process.env[LEAK_VAR];
  await repo.cleanup();
});

beforeEach(async () => {
  await primeIndex();
});

describe('CR-01/CR-02: what a bare simple-git handle does to a poisoned repository', () => {
  it('CONTROL: executes the planted hook, holding the daemon’s credentials', async () => {
    // The code that shipped, verbatim: `simpleGit(mainRepo).raw([...])`. No
    // `.env()` call, because none of the three production modules made one —
    // `simple-git@3.36.0` then spawns with `env: this.env`, `this.env` is
    // `undefined`, and `child_process.spawn` with `env: undefined` inherits
    // `process.env` in full.
    await simpleGit(repo.mainRepo).raw(['status', '--porcelain']);

    const report = await sentinelReport();

    expect(
      report,
      'The planted post-index-change hook did not run during an UNNEUTRALISED `git status`, so every SUBJECT case below proves nothing. Either core.hooksPath did not reach the main repository, or git declined to run the hook.',
    ).toBeDefined();

    // CR-01: a program the repository named was executed.
    expect(report).toContain('FIRED');

    // CR-02: and this is what it was holding. The variable is set on THIS
    // process and named on no ExecSpec anywhere — `credentials.test.ts` exists
    // to prove that a workspace child cannot see it, and could not observe this
    // one because this child was never launched through `run()`.
    expect(
      report,
      'the attacker-planted hook did NOT receive the daemon environment — if this is failing, the CR-02 measurement below is no longer measuring anything',
    ).toContain(LEAK_VALUE);
  });
});

describe('CR-01: every ADL-side git invocation carries the neutralisation', () => {
  it('runs the identical status through adlGit with nothing planted executing', async () => {
    // The same operation, the same repository, the same poisoned configuration
    // still sitting in .git/config — only the client differs.
    await adlGit(repo.mainRepo, { home: adlHome }).rawOk([
      'status',
      '--porcelain',
    ]);

    expect(
      await sentinelReport(),
      'The planted hook RAN through adlGit. NEUTRALISE_ARGS did not reach this invocation — 02-RESEARCH.md § Pitfall 5 is open for every worktree operation ADL performs.',
    ).toBeUndefined();
  });

  it('creates and destroys a worktree with nothing planted executing', async () => {
    // `git worktree add` fires `post-checkout`, so this case does not even need
    // a live agent: a poisoned config sits in .git/config and detonates the
    // next time ANY feature's worktree is created.
    const created = await createWorktree(
      repo.mainRepo,
      repo.scratchRoot,
      'cr01-create',
      'HEAD',
    );

    expect(
      await sentinelReport(),
      'the planted post-checkout hook RAN during `git worktree add` — every feature creation detonates a poisoned config (CR-01)',
    ).toBeUndefined();

    await destroyWorktree(repo.mainRepo, created.worktreePath, created.branch);

    expect(
      await sentinelReport(),
      'the planted hook RAN during worktree teardown (CR-01)',
    ).toBeUndefined();
  });

  it('takes a snapshot inside the agent’s own worktree with nothing planted executing', async () => {
    // The worst of the eight, because it runs INSIDE the directory the agent
    // controls: `status`, `stash create`, `rev-parse`, `update-ref`. A linked
    // worktree shares the main repository's configuration, so the poison
    // applies here too.
    const workspace = await workspaceRegistry()
      .resolve('worktree')
      .create({
        featureId: 'cr01-snapshot',
        mainRepo: repo.mainRepo,
        scratchRoot: repo.scratchRoot,
        baseRef: 'HEAD',
      });

    try {
      await rm(sentinel, { force: true });
      const handle = await workspace.snapshot();
      await handle.release();

      expect(
        await sentinelReport(),
        'the planted hook RAN during snapshot() — the git commands ADL runs inside the agent’s own worktree were unneutralised (CR-01)',
      ).toBeUndefined();
    } finally {
      await workspace.destroy();
    }
  });

  it('inventories the repository through the neutralised path', async () => {
    // Stated plainly because the alternative is a case that reads like the
    // three above and cannot fail like them: `git worktree list` does NOT
    // rewrite the index, so neither planted hook fires during it even
    // unneutralised — confirmed by running this file with the prefix removed,
    // where the three cases above went red and this one did not. It is a
    // call-path assertion (the sweep's inventory really does go through
    // `adlGit`, and really does parse), not a discriminating control. The
    // discriminating controls are above; the guard that keeps `list.ts` on the
    // chokepoint at all is the source-tree assertion in
    // `test/contract/workspace-contract.test.ts`.
    await expect(listManagedWorktrees(repo.mainRepo)).resolves.toEqual([]);

    expect(await sentinelReport()).toBeUndefined();
  });
});

describe('CR-02: what ADL’s own git child actually receives', () => {
  /**
   * The child's own view of its environment, read off stdout.
   *
   * `binary` points ADL's git at a stand-in that prints `process.env` and exits
   * — the same device `ManagerGitClientOptions.gitBinary` exists for. The
   * overrides are still spliced in behind it, so this measures the real
   * `adlGit` path rather than a parallel one.
   *
   * Handing this checkout's path to the child is safe here and would not be for
   * an agent's workspace: these children are `owner: 'adl'`, so WORK-05's
   * privilege drop does not apply and there is no second OS identity that
   * cannot read ADL's own files. See the docblock on `env-dump-child.cjs`.
   */
  async function childEnvironment(): Promise<Record<string, string>> {
    const outcome = await adlGit(repo.mainRepo, {
      home: adlHome,
      binary: [process.execPath, ENV_DUMP_CHILD],
    }).raw(['--version']);

    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
    return JSON.parse(outcome.stdout.trim()) as Record<string, string>;
  }

  it('is built from nothing — the daemon’s credentials are not in it', async () => {
    // A positive observation rather than the absence of one: the variable is
    // demonstrably set on the parent at this instant, and the CONTROL above
    // has already shown a git child receiving it.
    expect(process.env[LEAK_VAR]).toBe(LEAK_VALUE);

    const child = await childEnvironment();

    expect(child[LEAK_VAR]).toBeUndefined();
    expect(Object.values(child).join('\n')).not.toContain(LEAK_VALUE);
  });

  it('points HOME and the git config scopes at ADL’s own home (D-08)', async () => {
    const child = await childEnvironment();

    expect(child.HOME).toBe(adlHome);
    expect(child.GIT_CONFIG_GLOBAL).toBe(join(adlHome, '.gitconfig'));
    expect(child.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('forces a stable message locale, whatever the daemon is running in (WR-03)', async () => {
    // WR-03. `worktree/lifecycle.ts` tells "this worktree was already gone"
    // from "this failed" by reading one of git's messages, and git localises
    // them through gettext. Under the old inheriting spawn that comparison was
    // against a message in the host operator's language, so idempotent teardown
    // — the property the GC backstop is built on — stopped working on a
    // non-English deployment and reported every already-collected worktree as a
    // permanent failure.
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = 'fr_FR.UTF-8';

    try {
      const child = await childEnvironment();
      expect(child.LC_ALL).toBe('C');
      expect(child.LANG).toBe('C');
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });
});
