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
 * and T-2-33 exist to prevent, arriving from the other direction. That
 * conclusion survived contact with Linux: reproduced on git 2.43, a
 * `post-index-change` hook at mode `0755` fires during `git status`, and the
 * same hook at `0644` does not. The `chmod` above is load-bearing on POSIX and
 * it is already there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **WHO POISONS THE CONFIGURATION, AND WHY IT IS NOT ALWAYS THE AGENT**
 *
 * Plan `02-08` wrote every poisoning step as `feature.exec` — the agent's own
 * workspace — and that is right on the maintainer's Windows machine and on any
 * deployment without WORK-05's privilege drop. On Linux with the drop active it
 * is not merely inconvenient, it is *false*: the agent cannot write the main
 * repository's configuration at all, for two independent reasons, and the first
 * CI run on Ubuntu turned all eleven of these cases red at once.
 *
 * Both reasons were reproduced on Linux (git 2.43) rather than inferred from an
 * exit code:
 *
 * 1. **Ownership.** The worker is a different OS user from the one that owns the
 *    repository, so git's `safe.directory` check refuses before it looks at a
 *    single permission bit. `git config <key> <value>` inside the worktree exits
 *    **128** with `fatal: not in a git directory`; `git status` in the main
 *    repository exits 128 with `fatal: detected dubious ownership`. Note the
 *    trap in the read path: `git config --get <key>` under the same conditions
 *    exits **1** with no output — byte-for-byte indistinguishable from "that key
 *    is unset".
 * 2. **Permission.** Even with ownership resolved, `applyWorkerAccess` takes
 *    group and world write off `<mainRepo>/.git/config` and never grants the
 *    worker write on `.git` itself, so the lock file cannot be created. That
 *    path exits **255** with `error: could not lock config file … Permission
 *    denied`. This is layer 2 of the very defence this suite is about, working.
 *
 * The 128 seen in CI is therefore reason 1, and reason 2 is standing behind it.
 * Neither is a fault in the suite's subject: **layer 1 — the per-invocation `-c`
 * neutralisation — is what these cases exist to prove, and it must be proven on
 * every platform ADL runs on, including the ones where layer 2 does not exist.**
 *
 * So the poisoning step branches on whether the drop is actually in force, and
 * the branch is an *assertion* rather than a skip:
 *
 * - Drop not in force (Windows, macOS, an unprovisioned Linux host) — the agent
 *   poisons, exactly as `02-08` wrote it, and the write is required to succeed.
 *   That is the threat modelled in its own words.
 * - Drop in force — the agent's write is required to **fail**, which is layer 2
 *   asserted rather than assumed, and then the same write is performed *from the
 *   same linked worktree* by the identity that owns the repository. The claim
 *   under test in `leaks a hooks path …` is that a write performed inside a
 *   linked worktree lands in the MAIN repository; that claim is about git's
 *   worktree semantics and not about which uid ran the command, so it is proven
 *   identically in both branches.
 *
 * Nothing is skipped, no assertion is relaxed, and the drop-in-force branch adds
 * one the suite did not have. `test/helpers/platform.ts` stays unimported for
 * the same reason as before.
 * ─────────────────────────────────────────────────────────────────────────────
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
  privilegeLauncher,
  workerIdentityFromEnv,
} from '../../src/exec/privilege.js';
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
 * Whether WORK-05's privilege drop is actually in force for this run.
 *
 * Decided by the same function the worktree backend uses, against the same
 * environment, rather than by `process.platform === 'linux'`. A Linux host with
 * no `ADL_WORKER_USER` provisioned runs its agents as the daemon user and CAN
 * poison; a platform predicate would get that case wrong in the direction that
 * hides a failure.
 */
let workerIsDropped = false;

/**
 * Git wants forward slashes in configuration values on Windows; a backslash is
 * an escape character in the config format and a path written with them comes
 * back mangled.
 */
const asConfigPath = (path: string): string => path.replaceAll('\\', '/');

/** One invocation's exit code and both of its streams. */
interface Outcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one command through a workspace and keep BOTH streams.
 *
 * `02-08` discarded the output here — "the output is not the subject; the effect
 * on the main repository is" — and that was the reason the first Linux CI run
 * cost a diagnosis instead of reporting one. Eleven cases failed with
 * `expected 128 to be +0` and git's own `fatal:` line, which says exactly what
 * happened, was thrown away one frame from the assertion. Every expectation
 * below is given {@link diagnose} as its message, so a future red run on a
 * platform nobody has in front of them arrives with git's explanation attached.
 */
async function runIn(
  workspace: Workspace,
  argv: readonly string[],
  cwd: string,
): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];

  const result = await workspace.exec(
    {
      argv,
      cwd,
      path: process.env.PATH ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    (chunk) => {
      (chunk.stream === 'stdout' ? out : err).push(chunk.text);
    },
  );

  return {
    exitCode: result.exitCode,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
  };
}

/** The assertion message an unexpected exit code should have carried. */
function diagnose(what: string, outcome: Outcome): string {
  return [
    `${what} exited ${String(outcome.exitCode)}.`,
    `git stderr: ${outcome.stderr.trim() || '(none)'}`,
    `git stdout: ${outcome.stdout.trim() || '(none)'}`,
    `privilege drop in force: ${String(workerIsDropped)}`,
  ].join('\n');
}

/** Run a command as the AGENT does — through the feature workspace. */
function asAgent(argv: readonly string[]): Promise<Outcome> {
  return runIn(feature, argv, feature.root);
}

/**
 * Run a command inside the agent's worktree as the identity that OWNS the
 * repository — ADL's own workspace, pointed at the feature's root.
 *
 * The cwd is the linked worktree and only the uid differs from
 * {@link asAgent}, which is what makes this a faithful stand-in for the
 * poisoning step when the privilege drop is in force: the property being
 * demonstrated is that a configuration write performed *inside a linked
 * worktree* lands in the *main* repository, and that is a fact about git's
 * worktree layout rather than about who ran the command.
 */
function inWorktreeAsOwner(argv: readonly string[]): Promise<Outcome> {
  return runIn(host, argv, feature.root);
}

/**
 * Run a command through ADL's own workspace with NO neutralisation.
 *
 * This is the control, and it is the only place in the repository that builds a
 * git argv without {@link NEUTRALISE_ARGS}. It lives in a test on purpose:
 * `managerGitClient` has no exported route to it, which is the property
 * `manager-git.test.ts` asserts.
 */
function unneutralised(argv: readonly string[]): Promise<Outcome> {
  return runIn(host, argv, host.root);
}

/**
 * Put `value` at `key` in the MAIN repository, by writing it from inside the
 * agent's linked worktree — and assert what the agent was able to do.
 *
 * See the module docblock for why this branches. In short: with the privilege
 * drop in force the agent's write MUST be refused, and that refusal is layer 2
 * of the § Pitfall 5 defence being asserted rather than assumed; without it the
 * agent's write MUST succeed, which is the threat in its own words. Either way
 * the value ends up in `<mainRepo>/.git/config`, which is what the rest of the
 * suite is about.
 */
async function poisonFromWorktree(key: string, value: string): Promise<void> {
  const agent = await asAgent(['git', 'config', key, value]);

  if (!workerIsDropped) {
    expect(
      agent.exitCode,
      diagnose(`the agent's \`git config ${key}\``, agent),
    ).toBe(0);
    return;
  }

  // Deliberately `not.toBe(0)` and not a specific code. Today this is git's
  // ownership refusal (128); once a deployment teaches git to trust a
  // daemon-owned repository it becomes the permission refusal (255). Both are
  // the worker being unable to write the main repository's configuration, which
  // is the property worth asserting, and pinning either number would turn the
  // eventual fix into a spurious failure here.
  expect(
    agent.exitCode,
    diagnose(
      `the agent's \`git config ${key}\` was expected to be REFUSED under the privilege drop (layer 2, T-2-31) and`,
      agent,
    ),
  ).not.toBe(0);

  const owner = await inWorktreeAsOwner(['git', 'config', key, value]);
  expect(
    owner.exitCode,
    diagnose(
      `\`git config ${key}\` inside the worktree, as the repository owner,`,
      owner,
    ),
  ).toBe(0);
}

/** Undo {@link poisonFromWorktree}, through whichever identity performed it. */
async function unpoisonFromWorktree(key: string): Promise<void> {
  const argv = ['git', 'config', '--unset-all', key];
  const outcome = workerIsDropped
    ? await inWorktreeAsOwner(argv)
    : await asAgent(argv);
  expect(
    outcome.exitCode,
    diagnose(`\`git config --unset-all ${key}\``, outcome),
  ).toBe(0);
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

  // The same decision the worktree backend made when it created `feature`,
  // against the same environment and the same PATH.
  workerIsDropped =
    (
      await privilegeLauncher({
        worker: workerIdentityFromEnv(),
        path: process.env.PATH ?? '',
      })
    ).mode === 'dropped';

  // `poisonFromWorktree` asserts that a DROPPED agent's config write is
  // refused, and "refused" is satisfied by any non-zero exit — including a
  // launcher that could not start, or a `git` the worker cannot execute. Both
  // would make the assertion pass while proving nothing about layer 2, so the
  // drop is proven functional here, once, before anything relies on it.
  if (workerIsDropped) {
    const probe = await asAgent(['git', '--version']);
    if (probe.exitCode !== 0) {
      throw new Error(
        'The privilege drop is in force but the worker could not run `git` at all, so this suite cannot tell a ' +
          'layer-2 refusal from a broken launcher. Fix the drop before reading anything below as evidence.\n' +
          diagnose('`git --version` as the dropped worker', probe),
      );
    }
  }
});

afterAll(async () => {
  await feature.destroy();
  await host.destroy();
  await repo.cleanup();
});

describe('the poisoned configuration path a linked worktree opens', () => {
  it('leaks a hooks path written inside the worktree into the MAIN repository', async () => {
    // The write is performed from inside the workspace ADL handed the agent,
    // with no privileges beyond that — by the agent itself wherever the agent
    // is able to, and by the repository's owner where WORK-05's drop stops it.
    // See the module docblock; the branch is asserted, not skipped.
    await poisonFromWorktree('core.hooksPath', asConfigPath(hooksDir));

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

    const status = await unneutralised([
      'git',
      'status',
      '--porcelain=v1',
      '-z',
    ]);
    expect(
      status.exitCode,
      diagnose('the unneutralised `git status`', status),
    ).toBe(0);

    // If this ever goes red, the interesting question is not "did the test
    // break" but "did git change its behaviour" — in which case the assertion
    // below has quietly stopped proving anything and this suite is the only
    // thing that would say so.
    //
    // The message names the two things that have actually caused it: the hook
    // was never reachable because `core.hooksPath` did not get poisoned (which
    // is what happened on the first Linux CI run), or it was reachable and git
    // declined to run it. `git status` prints an `advice.ignoredHook` hint in
    // the second case, so the stderr above tells the two apart.
    const effective = (
      await repo.git.raw(['config', '--get', 'core.hooksPath'])
    ).trim();
    expect(
      await exists(sentinel),
      `The planted post-index-change hook did not run during an UNNEUTRALISED git status, so the ` +
        `neutralised case below proves nothing.\n` +
        `core.hooksPath in the main repository: ${effective === '' ? '(unset — the poisoning step did not take)' : effective}\n` +
        diagnose('that status', status),
    ).toBe(true);
  });

  it('does not execute the planted hook during a manager-side operation', async () => {
    const sentinel = join(hooksDir, 'FIRED-neutralised');
    await plantHook(sentinel);

    // The same operation, the same repository, the same poisoned configuration
    // still sitting in .git/config — only the client differs.
    await expect(client.status()).resolves.toBeInstanceOf(Array);

    expect(
      await exists(sentinel),
      'The planted hook RAN during a manager-side operation. NEUTRALISE_ARGS did not reach this ' +
        'invocation — 02-RESEARCH.md § Pitfall 5 is open.',
    ).toBe(false);
  });

  it('still sees the poisoned value in the file — the fix is per-invocation, not a cleanup', async () => {
    // Stated as its own case because the alternative implementation people
    // reach for first is "detect and remove the bad key". That would be a
    // race against an agent that can rewrite it at any moment, and it would
    // silently destroy an operator's legitimate configuration. ADL overrides;
    // it does not edit the user's file.
    //
    // The empty string is called out by name in the message because it is the
    // ambiguous answer: `git config --get` on an unset key exits 1 with no
    // output, and simple-git resolves rather than rejects on an exit-1-with-no-
    // stderr, so "the manager cleaned it up" and "it was never written" arrive
    // here looking identical.
    const inFile = (
      await repo.git.raw(['config', '--get', 'core.hooksPath'])
    ).trim();
    expect(
      inFile,
      inFile === ''
        ? 'core.hooksPath is absent from the main repository. Either something removed it — which is the ' +
            'behaviour this case exists to forbid — or the poisoning step never took, in which case every ' +
            'assertion above it was vacuous. Check the CONTROL case first.'
        : 'core.hooksPath in the main repository is not the value that was planted.',
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
 *
 * `poisonFromWorktree` is a workspace exec in both of its branches, so that
 * remains true where the drop is in force — what changes there is the uid, not
 * the mechanism, and the branch asserts the agent's own attempt was refused
 * before it falls back. See the module docblock.
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
      await poisonFromWorktree(key, poison);

      try {
        // The poison really is in the main repository's file — otherwise the
        // assertion below would pass against a key git never read at all.
        expect(
          await readFile(join(repo.mainRepo, '.git', 'config'), 'utf8'),
        ).toContain(poison);

        const effective = await client.effectiveConfig(key);
        const seen = `the manager client saw ${JSON.stringify(effective)} for ${key}`;

        expect(effective, `${seen}, not the neutralised value.`).toBe(
          neutralised,
        );
        expect(
          effective,
          `${seen} — the agent's poison reached ADL's own git.`,
        ).not.toBe(poison);
      } finally {
        await unpoisonFromWorktree(key);
      }
    });
  }
});
