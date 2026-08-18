/**
 * The `02-RESEARCH.md § Pitfall 5` proof: the shared-configuration path from an
 * agent's worktree into ADL's own git, demonstrated and then closed.
 *
 * This suite is written to be believed by a reader who does not accept the
 * premise, which is why it is in three parts and why the first two are in that
 * order:
 *
 * 1. **The leak is reproduced, not assumed.** A configuration write performed
 *    from inside a linked worktree is read back out of the *main* repository.
 *    Anyone who thinks a worktree has its own local configuration will believe
 *    this test rather than the paragraph above it.
 * 2. **The planted program is observed running, and then observed not running.**
 *    The neutralised assertion on its own would pass against a hook that never
 *    fires for unrelated reasons — a poisoned key git ignores, a hook name git
 *    does not call, an operation that never refreshes the index. So the control
 *    runs the identical operation *without* the overrides first and requires the
 *    sentinel to appear. Only then does the absence of the second sentinel mean
 *    anything.
 * 3. **Every key is proven individually.** A single aggregate assertion would
 *    still pass with seven of the eight entries deleted from
 *    `NEUTRALISED_CONFIG`. The loop below is driven by the list itself, so a
 *    removed entry removes its own assertion — which is how T-2-37 ("a future
 *    contributor trims the list") is turned from a review problem into a
 *    property of the suite.
 *
 * **On the absence of a platform skip.** Plan `02-08` anticipated needing one
 * here, on the grounds that a platform which cannot make a file executable
 * cannot host a hook. Probed rather than assumed, and the anticipation was
 * wrong: git for Windows runs hook scripts through its own bundled `sh` and does
 * not consult the executable bit, so `chmod(0o755)` is sufficient on POSIX and
 * unnecessary — but harmless — on Windows. The case therefore RUNS everywhere,
 * which is strictly better than skipping visibly. `test/helpers/platform.ts` is
 * deliberately not imported: a gate that can never fire is the decoration D-21
 * and T-2-33 exist to prevent, arriving from the other direction.
 */
import {
  chmod,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Workspace } from '@adl/core/stage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  managerGitClient,
  NEUTRALISED_CONFIG,
  type ManagerGitClient,
} from '../../src/git/manager-git.js';
import { workspaceRegistry } from '../../src/registry.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

let repo: OpenedTempRepo;
/** The agent's workspace — a real linked worktree. */
let feature: Workspace;
/** ADL's own workspace, rooted at the main repository. */
let host: Workspace;
let client: ManagerGitClient;
/** The directory the poisoned `core.hooksPath` points at. */
let hooksDir: string;
/** ADL's own git home. Inside the fixture, so the suite touches no real one. */
let adlHome: string;

/**
 * Git wants forward slashes in configuration values on Windows; a backslash is
 * an escape character in the config format and a path written with them comes
 * back mangled.
 */
const asConfigPath = (path: string): string => path.replaceAll('\\', '/');

/** Run a command as the AGENT does — through the feature workspace. */
async function asAgent(argv: readonly string[]): Promise<number | null> {
  const result = await feature.exec(
    {
      argv,
      cwd: feature.root,
      path: process.env.PATH ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    () => {
      // The output is not the subject; the effect on the main repository is.
    },
  );
  return result.exitCode;
}

/**
 * Run a command through ADL's own workspace with NO neutralisation.
 *
 * This is the control, and it is the only place in the repository that builds a
 * git argv without {@link NEUTRALISE_ARGS}. It lives in a test on purpose:
 * `managerGitClient` has no exported route to it, which is the property
 * `manager-git.test.ts` asserts.
 */
async function unneutralised(argv: readonly string[]): Promise<number | null> {
  const result = await host.exec(
    {
      argv,
      cwd: host.root,
      path: process.env.PATH ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    () => {},
  );
  return result.exitCode;
}

/**
 * Plant a `post-index-change` hook that writes `sentinel` when it runs, and
 * give git a reason to refresh the index.
 *
 * `post-index-change` rather than `pre-commit` because the operations this
 * client ships do not commit — and a hook that would only fire on an operation
 * ADL never performs would prove nothing. Verified locally: with the index
 * stale, this hook fires during a plain `git status --porcelain`.
 */
async function plantHook(sentinel: string): Promise<void> {
  const hook = join(hooksDir, 'post-index-change');
  await writeFile(
    hook,
    `#!/bin/sh\necho fired > "${asConfigPath(sentinel)}"\nexit 0\n`,
    'utf8',
  );
  // A no-op on Windows (see the module docblock) and required on POSIX, where
  // git skips a hook without the executable bit.
  await chmod(hook, 0o755);

  // ── Getting git to rewrite the index, reliably ──────────────────────────
  //
  // `post-index-change` fires when git WRITES the index, and `git status`
  // writes it only when a refresh actually updated cached stat data. The
  // obvious setup — dirty the file — is therefore exactly wrong, and produced a
  // control that passed in isolation and failed in the full suite: a file whose
  // CONTENT differs from the index stays "modified", so there is no stat entry
  // to update and nothing to write back.
  //
  // The setup that works is the opposite: content identical to `HEAD`, with an
  // mtime git cannot trust. Git re-reads the file, finds it clean, updates the
  // cached stat data, writes the index, and calls the hook. Verified both ways
  // locally before this was written this way.
  await repo.git.raw(['checkout', '--', 'tracked.txt']);
  const ahead = new Date(Date.now() + 10_000);
  await utimes(join(host.root, 'tracked.txt'), ahead, ahead);

  // ── And then removing the sentinel the SETUP just produced ──────────────
  //
  // The `checkout` above writes the index too, so it fires the hook as well —
  // through the fixture's own git handle, which carries none of ADL's
  // overrides. Leaving that sentinel in place made the neutralised case fail
  // for a reason that had nothing to do with the client under test.
  //
  // Worth stating rather than quietly deleting: this is one more sighting of
  // the thing being defended against. A plain, unremarkable git command run by
  // a process that is not the manager client executed an attacker-planted
  // program, in this suite, by accident. That is the whole threat in one line.
  await rm(sentinel, { force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  repo = await openTempRepo();

  hooksDir = join(repo.scratchRoot, '..', 'evilhooks');
  adlHome = join(repo.scratchRoot, '..', 'adl-git-home');
  await mkdir(hooksDir, { recursive: true });

  const registry = workspaceRegistry({ hostGit: { configHome: adlHome } });

  feature = await registry.resolve('worktree').create({
    featureId: 'feat-poison',
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef: 'HEAD',
  });

  host = await registry.resolve('host-git').create({
    featureId: 'adl-own',
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef: 'HEAD',
  });

  client = managerGitClient(host);
});

afterAll(async () => {
  await feature.destroy();
  await host.destroy();
  await repo.cleanup();
});

describe('the poisoned configuration path a linked worktree opens', () => {
  it('leaks a hooks path written inside the worktree into the MAIN repository', async () => {
    // The write is performed the way an agent would perform it: a git command
    // run inside the workspace ADL handed it, with no privileges beyond that.
    expect(
      await asAgent([
        'git',
        'config',
        'core.hooksPath',
        asConfigPath(hooksDir),
      ]),
    ).toBe(0);

    // Read back from the MAIN repository, which the agent was never given a
    // path to. `repo.git` is the test's own handle on it — deliberately not the
    // manager client, whose whole job is to make this value not apply.
    expect(
      (await repo.git.raw(['config', '--get', 'core.hooksPath'])).trim(),
    ).toBe(asConfigPath(hooksDir));

    // And it is in the file, not merely in some inherited scope: this is the
    // claim that a linked worktree has no local configuration of its own.
    expect(
      await readFile(join(repo.mainRepo, '.git', 'config'), 'utf8'),
    ).toContain('hooksPath');
  });

  it('CONTROL: the planted hook really does execute during an unneutralised status', async () => {
    const sentinel = join(hooksDir, 'FIRED-control');
    await plantHook(sentinel);

    expect(await unneutralised(['git', 'status', '--porcelain=v1', '-z'])).toBe(
      0,
    );

    // If this ever goes red, the interesting question is not "did the test
    // break" but "did git change its behaviour" — in which case the assertion
    // below has quietly stopped proving anything and this suite is the only
    // thing that would say so.
    expect(await exists(sentinel)).toBe(true);
  });

  it('does not execute the planted hook during a manager-side operation', async () => {
    const sentinel = join(hooksDir, 'FIRED-neutralised');
    await plantHook(sentinel);

    // The same operation, the same repository, the same poisoned configuration
    // still sitting in .git/config — only the client differs.
    await expect(client.status()).resolves.toBeInstanceOf(Array);

    expect(await exists(sentinel)).toBe(false);
  });

  it('still sees the poisoned value in the file — the fix is per-invocation, not a cleanup', async () => {
    // Stated as its own case because the alternative implementation people
    // reach for first is "detect and remove the bad key". That would be a
    // race against an agent that can rewrite it at any moment, and it would
    // silently destroy an operator's legitimate configuration. ADL overrides;
    // it does not edit the user's file.
    expect(
      (await repo.git.raw(['config', '--get', 'core.hooksPath'])).trim(),
    ).toBe(asConfigPath(hooksDir));
  });
});

/**
 * Every key is poisoned through the AGENT's workspace — a real `git` subprocess
 * — and not through `repo.git`.
 *
 * That is not a stylistic preference; `simple-git` refuses. Its
 * `block-unsafe-operations` plugin rejects a configuration write to every one of
 * these eight keys by name (`allowUnsafeHooksPath`, `allowUnsafeFsMonitor`,
 * `allowUnsafePager`, `allowUnsafeEditor`, `allowUnsafeSshCommand`,
 * `allowUnsafeCredentialHelper`, `allowUnsafeDiffExternal`,
 * `allowUnsafeProtocolOverride`) unless the caller opts in. Discovered by this
 * suite going red on exactly the eight cases and nothing else.
 *
 * Two things follow, and the second is why this comment is long. The library
 * ADL already depends on classifies precisely this key set as
 * unsafe-to-configure, which is independent corroboration that
 * `NEUTRALISED_CONFIG` is the right list rather than an arbitrary one. And
 * simple-git's refusal protects nobody here: an agent does not use simple-git,
 * it runs `git`. Poisoning through the workspace exec is therefore both the only
 * route that works and the only route that models the threat.
 */
describe('every neutralised key, one at a time', () => {
  // Driven by the list rather than by hand-written cases: this is what makes
  // deleting an entry delete its own proof instead of leaving an aggregate
  // assertion that still passes (T-2-37).
  for (const assignment of NEUTRALISED_CONFIG) {
    const separator = assignment.indexOf('=');
    const key = assignment.slice(0, separator);
    const neutralised = assignment.slice(separator + 1);

    it(`sees ${JSON.stringify(neutralised)} for ${key} however the repository is poisoned`, async () => {
      const poison = `POISONED-${key}`;
      expect(await asAgent(['git', 'config', key, poison])).toBe(0);

      try {
        // The poison really is in the main repository's file — otherwise the
        // assertion below would pass against a key git never read at all.
        expect(
          await readFile(join(repo.mainRepo, '.git', 'config'), 'utf8'),
        ).toContain(poison);

        const effective = await client.effectiveConfig(key);

        expect(effective).toBe(neutralised);
        expect(effective).not.toBe(poison);
      } finally {
        expect(await asAgent(['git', 'config', '--unset-all', key])).toBe(0);
      }
    });
  }
});
