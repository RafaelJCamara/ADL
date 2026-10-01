import { existsSync } from 'node:fs';
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { applyWorkerAccess, resolveGroupId } from '../../src/exec/privilege.js';
import { guardRefWrite } from '../../src/worktree/ref-guard.js';
import {
  attachWorktreeWorkspace,
  worktreeWorkspace,
} from '../../src/worktree/backend.js';
import { fanOutDirectories } from '../../src/worktree/shared-git.js';
import {
  branchNameFor,
  createWorktree,
  destroyWorktree,
} from '../../src/worktree/lifecycle.js';
import {
  linuxOnly,
  posixOnly,
  type LinuxOnlyGate,
} from '../helpers/platform.js';
import { runIn, shIn } from '../helpers/run-in.js';
import { withTempRepo, type TempRepo } from '../helpers/temp-repo.js';

/**
 * The hardening of the privilege-drop patch (D-6-CI-1..8): every case here is a
 * refusal or a repair that a reviewer reproduced as a hole, and each stands on
 * its own so that it is red for exactly one defect.
 *
 * Two families. The ones that only need mode bits and a symlink run wherever
 * POSIX does (`posixOnly`) and use the process's OWN group, so they exercise
 * the walk without a second OS identity. The ones that need the worker are
 * `linuxOnly`: they skip visibly off Linux and FAIL on a Linux runner with no
 * worker provisioned (D-21).
 */

/** The shape of a vitest context, enough to skip from a helper. */
type Skippable = Pick<TestContext, 'skip'>;

function needWorker(
  ctx: Skippable,
  reason: string,
): LinuxOnlyGate & {
  kind: 'run';
} {
  const gate = linuxOnly(
    `the worker user only exists where the privilege drop applies (D-05), so ${reason}`,
  );
  if (gate.kind === 'skip') return ctx.skip(gate.reason);
  return gate;
}

function needPosix(ctx: Skippable, reason: string): void {
  const gate = posixOnly(reason, 'WORK-05');
  if (gate.kind === 'skip') ctx.skip(gate.reason);
}

/** A group file naming this process's own gid, so a chown to it can succeed. */
async function ownGroup(dir: string): Promise<string> {
  const file = join(dir, 'group');
  await writeFile(file, `adl-test-own:x:${process.getgid?.() ?? 0}:\n`);
  return file;
}

async function scratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('worker access: the grant walk cannot be redirected (D-6-CI-8)', () => {
  it('does not follow a symlink swapped in for an entry after its directory was listed', async (ctx) => {
    needPosix(
      ctx,
      'the swap is a POSIX symlink and the assertion is on mode bits',
    );
    const root = await scratchDir('adl-swap-');
    const groupFile = await ownGroup(root);
    const tree = join(root, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'victim'), 'v');
    await writeFile(join(tree, 'bystander'), 'b');
    // The daemon-owned file a path-based walk would be steered onto: the stand-in
    // for a repository's `.git/hooks/pre-commit`.
    const target = join(root, 'target');
    await writeFile(target, 'daemon file');
    await chmod(target, 0o644);
    const before = await stat(target);

    let swapped = 0;
    const report = await applyWorkerAccess([tree], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
      // The window between "the directory was read" and "the entry is opened",
      // which is where the worker would race. Opened deterministically instead.
      beforeOpen: async (path) => {
        if (basename(path) !== 'victim') return;
        await rm(join(tree, 'victim'));
        await symlink(target, join(tree, 'victim'));
        swapped += 1;
      },
    });

    expect(swapped, 'the swap must actually have happened').toBe(1);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: 'applied',
    });
    const after = await stat(target);
    expect(
      (after.mode & 0o7777).toString(8),
      'the swapped-in link must not have been chmod-ed through',
    ).toBe((before.mode & 0o7777).toString(8));
    expect(after.gid).toBe(before.gid);
    // ...and the link is still a link, and still points where the worker put it:
    // the walk neither followed nor "repaired" it.
    expect(await readlink(join(tree, 'victim'))).toBe(target);
    // The walk carried on past it.
    expect((await stat(join(tree, 'bystander'))).mode & 0o060).toBe(0o060);
  });

  it('treats an entry that vanishes mid-walk as gone, not as a failed grant (git renames its tmp_obj_* files)', async (ctx) => {
    needPosix(ctx, 'the assertion follows the POSIX walk');
    const root = await scratchDir('adl-churn-');
    const groupFile = await ownGroup(root);
    const tree = join(root, 'tree');
    await mkdir(tree);
    for (const name of ['a', 'b', 'c']) await writeFile(join(tree, name), name);

    const report = await applyWorkerAccess([tree], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
      beforeOpen: async (path) => {
        if (basename(path) === 'b') await rm(join(tree, 'b'));
      },
    });

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: 'applied',
    });
    expect((await stat(join(tree, 'c'))).mode & 0o060).toBe(0o060);
  });

  it('still degrades when a path it was NAMED is missing (only descendants may vanish quietly)', async (ctx) => {
    needPosix(ctx, 'the assertion follows the POSIX walk');
    const root = await scratchDir('adl-missing-');
    const groupFile = await ownGroup(root);

    const report = await applyWorkerAccess([join(root, 'not-there')], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
    });

    expect(report.outcome).toBe('degraded');
  });

  it('removes group and world write from .git/config and .git/hooks even when the grants degrade', async (ctx) => {
    needPosix(ctx, 'the assertion is on mode bits');
    const root = await scratchDir('adl-protect-');
    // A group file the grant cannot resolve a gid from: the grants degrade
    // before touching anything, which is the shape that used to skip `protect`.
    const groupFile = join(root, 'group');
    await writeFile(groupFile, 'adl-test-own:x::\n');

    const config = join(root, 'config');
    await writeFile(config, '[core]\n');
    await chmod(config, 0o666);

    const hooks = join(root, 'hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\n');
    await chmod(hook, 0o777);
    await chmod(hooks, 0o777);
    // A link inside the clamped directory must not be chmod-ed through either.
    const outside = join(root, 'outside');
    await writeFile(outside, 'x');
    await chmod(outside, 0o666);
    await symlink(outside, join(hooks, 'link'));

    const report = await applyWorkerAccess([], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
      protect: [config, hooks, join(root, 'does-not-exist')],
    });

    expect(report.outcome).toBe('degraded');
    for (const path of [config, hooks, hook]) {
      expect(
        (await stat(path)).mode & 0o022,
        `${path} is still group- or world-writable`,
      ).toBe(0);
    }
    // The link's target was never touched.
    expect((await stat(outside)).mode & 0o777).toBe(0o666);
    // Owner bits untouched: the daemon can still run its own hook.
    expect((await stat(hook)).mode & 0o700).toBe(0o700);
  });

  it('grants a sticky directory non-recursively: the directory, never what is in it', async (ctx) => {
    needPosix(ctx, 'the assertion is on mode bits');
    const root = await scratchDir('adl-sticky-');
    const groupFile = await ownGroup(root);
    const fanOut = join(root, 'objects-ab');
    await mkdir(fanOut);
    await chmod(fanOut, 0o755);
    const object = join(fanOut, 'cdef');
    await writeFile(object, 'object');
    await chmod(object, 0o444);

    const report = await applyWorkerAccess([], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
      stickyDirs: [fanOut],
    });

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: 'applied',
    });
    const dir = (await stat(fanOut)).mode & 0o7777;
    expect(dir & 0o070, 'group rwx on the directory').toBe(0o070);
    expect(dir & 0o1000, 'the sticky bit on the directory').toBe(0o1000);
    expect(dir & 0o007, 'no world bit added').toBe(0o005);
    // What is inside is not the grant's to touch: that is the whole point.
    expect((await stat(object)).mode & 0o777).toBe(0o444);
  });
});

describe('worker access: who owns an entry decides whether it is skipped', () => {
  it('degrades loudly over a tree owned by somebody who is neither the daemon nor the worker, and applies once that somebody is the worker', async (ctx) => {
    const gate = needWorker(
      ctx,
      'there is no foreign-owned entry to be waved through here',
    );

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'access-foreign',
        baseRef: 'HEAD',
      });
      try {
        // From the daemon's side the worker is just another user, and a tree
        // that user made at 0755 is a tree the daemon is NOT entitled to widen.
        const made = await shIn(
          workspace,
          'umask 022 && mkdir foreign && echo x > foreign/file.txt',
        );
        expect(made.exitCode, made.output).toBe(0);
        const foreign = join(workspace.root, 'foreign');

        // Not told who the worker is: the entries are somebody else's, nothing
        // can be done about them, and `applied` would be a lie. (It used to be
        // `applied` on "the daemon does not own it".)
        const unknown = await applyWorkerAccess([foreign], {
          mode: 'dropped',
          group: gate.workerGroup,
        });
        expect(unknown.outcome, JSON.stringify(unknown)).toBe('degraded');
        if (unknown.outcome === 'degraded') {
          expect(unknown.reason).toMatch(/EPERM/);
        }

        // Told: the same tree is the worker's own and is left to it.
        const told = await applyWorkerAccess([foreign], {
          mode: 'dropped',
          group: gate.workerGroup,
          workerUser: gate.workerUser,
        });
        expect(told, JSON.stringify(told)).toMatchObject({
          outcome: 'applied',
        });
      } finally {
        // Cleaned up as its owner: the daemon cannot unlink inside a directory
        // the worker made at 0755, which is the point of the case.
        await shIn(workspace, 'rm -rf foreign');
        await workspace.destroy();
      }
    });
  }, 180_000);

  it('degrades, rather than guessing, when the worker user cannot be resolved', async (ctx) => {
    needPosix(ctx, 'the assertion is on the report');
    const root = await scratchDir('adl-nouser-');
    const groupFile = await ownGroup(root);
    const passwdFile = join(root, 'passwd');
    await writeFile(passwdFile, 'someone-else:x:1234:1234::/:/bin/false\n');

    const report = await applyWorkerAccess([root], {
      mode: 'dropped',
      group: 'adl-test-own',
      groupFile,
      workerUser: 'adl-worker',
      passwdFile,
    });

    expect(report.outcome).toBe('degraded');
    if (report.outcome === 'degraded') {
      expect(report.reason).toContain('adl-worker');
    }
  });
});

/**
 * The shared object store, as the worker and the daemon use it together.
 *
 * Run under both umasks a daemon is likely to have: the fan-out directories are
 * created and `chmod`-ed explicitly, so what the worker can do must not depend
 * on which one the daemon started with.
 */
describe.each([0o022, 0o002] as const)(
  'worker access: a commit against the shared object store, daemon umask %o',
  (umask) => {
    async function inUmask<T>(body: () => Promise<T>): Promise<T> {
      const previous = process.umask(umask);
      try {
        return await body();
      } finally {
        process.umask(previous);
      }
    }

    it('lets the worker commit, re-add a blob the daemon already wrote, and be read and packed by the daemon', async (ctx) => {
      needWorker(ctx, 'there is no second identity to commit as here');

      await inUmask(async () =>
        withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const workspace = await worktreeWorkspace({
            mainRepo,
            scratchRoot,
            featureId: `objects-commit-${umask.toString(8)}`,
            baseRef: 'HEAD',
          });
          const branch = branchNameFor(`objects-commit-${umask.toString(8)}`);
          try {
            // The daemon writes a blob first: a duplicate the worker will meet.
            const daemonFile = join(scratchRoot, '..', 'daemon-blob.txt');
            await writeFile(daemonFile, 'shared content\n');
            const daemonBlob = (
              await git.raw(['hash-object', '-w', '--', daemonFile])
            ).trim();

            const wrote = await shIn(
              workspace,
              'echo change > worker-file.txt && printf "shared content\\n" > duplicate.txt',
            );
            expect(wrote.exitCode, wrote.output).toBe(0);
            const added = await runIn(workspace, [
              'git',
              'add',
              'worker-file.txt',
              'duplicate.txt',
            ]);
            expect(added.exitCode, added.output).toBe(0);
            const committed = await runIn(workspace, [
              'git',
              '-c',
              'user.name=ADL',
              '-c',
              'user.email=adl@example.invalid',
              'commit',
              '-m',
              'worker commit',
            ]);
            expect(committed.exitCode, committed.output).toBe(0);

            // The duplicate really was the daemon's object, not a second copy.
            const sha = (await git.raw(['rev-parse', branch])).trim();
            expect(
              (await git.raw(['rev-parse', `${sha}:duplicate.txt`])).trim(),
            ).toBe(daemonBlob);

            // ...the daemon reads what the worker wrote...
            expect(
              await git.raw(['show', '--name-only', '--format=', sha]),
            ).toContain('worker-file.txt');
            // ...packs it (removing the worker-owned loose objects from a
            // directory the daemon owns)...
            await git.raw(['repack', '-a', '-d', '-q']);
            await git.raw(['prune-packed']);
            // ...and the store is whole afterwards.
            await git.raw(['fsck', '--no-dangling']);
            expect(
              await git.raw(['show', '--name-only', '--format=', sha]),
            ).toContain('worker-file.txt');
          } finally {
            await workspace.destroy();
          }
        }),
      );
    }, 180_000);

    it('keeps working across 300 blobs from each side, so a directory that appears later cannot break either', async (ctx) => {
      needWorker(ctx, 'there is no second identity to write blobs as here');

      await inUmask(async () =>
        withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const workspace = await worktreeWorkspace({
            mainRepo,
            scratchRoot,
            featureId: `objects-many-${umask.toString(8)}`,
            baseRef: 'HEAD',
          });
          try {
            const daemonFiles = join(scratchRoot, '..', 'daemon-blobs');
            await mkdir(daemonFiles);
            const names: string[] = [];
            for (let index = 0; index < 300; index += 1) {
              const name = join(daemonFiles, `d${String(index)}.txt`);
              await writeFile(name, `daemon blob ${String(index)}\n`);
              names.push(name);
            }
            await git.raw(['hash-object', '-w', '--', ...names]);

            const workerBlobs = await shIn(
              workspace,
              'i=0; while [ $i -lt 300 ]; do echo "worker blob $i" > "w$i.txt"; i=$((i+1)); done; git hash-object -w -- w*.txt > /dev/null',
            );
            expect(workerBlobs.exitCode, workerBlobs.output).toBe(0);

            const more: string[] = [];
            for (let index = 0; index < 300; index += 1) {
              const name = join(daemonFiles, `e${String(index)}.txt`);
              await writeFile(name, `daemon again ${String(index)}\n`);
              more.push(name);
            }
            await git.raw(['hash-object', '-w', '--', ...more]);
          } finally {
            await workspace.destroy();
          }
        }),
      );
    }, 180_000);
  },
);

/**
 * Each refusal is its own case so that each is red for exactly one defect. A
 * single test that asserts them in sequence is red for the FIRST one that
 * regresses and silent about the rest (the reviewer's finding on the original).
 */
describe('worker access: what the worker still cannot do (each refusal alone)', () => {
  /** A workspace for one refusal, torn down afterwards. */
  async function withWorkspace(
    ctx: Skippable,
    featureId: string,
    body: (
      workspace: Awaited<ReturnType<typeof worktreeWorkspace>>,
      repo: TempRepo,
      gate: LinuxOnlyGate & { kind: 'run' },
    ) => Promise<void>,
    prepare?: (
      repo: TempRepo,
      gate: LinuxOnlyGate & { kind: 'run' },
    ) => Promise<void>,
  ): Promise<void> {
    const gate = needWorker(ctx, 'there is no second identity to refuse here');
    await withTempRepo(async (repo) => {
      await prepare?.(repo, gate);
      const workspace = await worktreeWorkspace({
        mainRepo: repo.mainRepo,
        scratchRoot: repo.scratchRoot,
        featureId,
        baseRef: 'HEAD',
      });
      try {
        await body(workspace, repo, gate);
      } finally {
        await workspace.destroy();
      }
    });
  }

  const gitDir = (repo: TempRepo): string => join(repo.mainRepo, '.git');

  /** The branch a workspace's worktree is on. */
  const branchOf = (workspace: { readonly id: string }): string =>
    branchNameFor(workspace.id);

  /** The path of a loose object, relative to the repository's `.git`. */
  const objectPath = (sha: string): string =>
    `objects/${sha.slice(0, 2)}/${sha.slice(2)}`;

  it('cannot write a hook', async (ctx) => {
    await withWorkspace(ctx, 'refuse-hook', async (workspace, repo) => {
      const hook = join(gitDir(repo), 'hooks', 'pre-commit');
      const wrote = await shIn(workspace, `echo '#!/bin/sh' > '${hook}'`);
      expect(wrote.exitCode, wrote.output).not.toBe(0);
      expect(existsSync(hook)).toBe(false);
    });
  }, 180_000);

  it('cannot write a hook even when the hooks directory started out group-writable', async (ctx) => {
    await withWorkspace(
      ctx,
      'refuse-hook-umask',
      async (workspace, repo) => {
        const hook = join(gitDir(repo), 'hooks', 'pre-commit');
        const wrote = await shIn(workspace, `echo '#!/bin/sh' > '${hook}'`);
        expect(wrote.exitCode, wrote.output).not.toBe(0);
        expect(existsSync(hook)).toBe(false);
      },
      async (repo, gate) => {
        // What a repository made under umask 002, in the shared group, looks
        // like: "we did not widen it" is true and the worker could still write.
        const gid = await resolveGroupId(gate.workerGroup);
        const hooks = join(gitDir(repo), 'hooks');
        await mkdir(hooks, { recursive: true });
        await chown(hooks, -1, gid!);
        await chmod(hooks, 0o775);
      },
    );
  }, 180_000);

  it('cannot write the repository config even when it started out group-writable', async (ctx) => {
    await withWorkspace(
      ctx,
      'refuse-config-umask',
      async (workspace, repo) => {
        const config = join(gitDir(repo), 'config');
        const marker = 'hooksPath = /tmp/adl-must-not-land';
        const wrote = await shIn(workspace, `echo '${marker}' >> '${config}'`);
        expect(wrote.exitCode, wrote.output).not.toBe(0);
        expect(await readFile(config, 'utf8')).not.toContain(marker);
      },
      async (repo, gate) => {
        const gid = await resolveGroupId(gate.workerGroup);
        const config = join(gitDir(repo), 'config');
        await chown(config, -1, gid!);
        await chmod(config, 0o664);
      },
    );
  }, 180_000);

  it('cannot move the default branch', async (ctx) => {
    await withWorkspace(ctx, 'refuse-default', async (workspace, repo) => {
      const defaultBranch = (
        await repo.git.raw(['symbolic-ref', '--short', 'HEAD'])
      ).trim();
      const baseSha = (await repo.git.raw(['rev-parse', 'HEAD'])).trim();

      // A commit of its own to move the branch TO: moving a ref to where it
      // already is would be a no-op the worker could "succeed" at.
      const committed = await shIn(
        workspace,
        'echo x > f.txt && git add f.txt && git -c user.name=w -c user.email=w@example.invalid commit -q -m worker',
      );
      expect(committed.exitCode, committed.output).toBe(0);
      const workerSha = (
        await repo.git.raw(['rev-parse', branchOf(workspace)])
      ).trim();
      expect(workerSha).not.toBe(baseSha);

      const moved = await runIn(workspace, [
        'git',
        'update-ref',
        `refs/heads/${defaultBranch}`,
        workerSha,
      ]);
      expect(moved.exitCode, moved.output).not.toBe(0);
      expect((await repo.git.raw(['rev-parse', defaultBranch])).trim()).toBe(
        baseSha,
      );
    });
  }, 180_000);

  it('cannot write a replace ref', async (ctx) => {
    await withWorkspace(ctx, 'refuse-replace', async (workspace, repo) => {
      const baseSha = (await repo.git.raw(['rev-parse', 'HEAD'])).trim();
      const replaced = await runIn(workspace, [
        'git',
        'update-ref',
        `refs/replace/${baseSha}`,
        baseSha,
      ]);
      expect(replaced.exitCode, replaced.output).not.toBe(0);
      expect(await repo.git.raw(['for-each-ref', 'refs/replace'])).toBe('');
    });
  }, 180_000);

  /**
   * An object the daemon wrote BEFORE the worker's workspace existed -- the
   * shape of every object in a repository's history, and the only shape a
   * recursive grant over `objects/` would reach.
   */
  const daemonObject = (): {
    readonly prepare: (repo: TempRepo) => Promise<void>;
    readonly path: (repo: TempRepo) => string;
    readonly sha: () => string;
  } => {
    let sha = '';
    return {
      prepare: async (repo) => {
        const file = join(repo.scratchRoot, '..', 'victim.txt');
        await writeFile(file, 'daemon owned\n');
        sha = (await repo.git.raw(['hash-object', '-w', '--', file])).trim();
      },
      path: (repo) => join(gitDir(repo), objectPath(sha)),
      sha: () => sha,
    };
  };

  it('cannot delete an object the daemon wrote', async (ctx) => {
    const victim = daemonObject();
    await withWorkspace(
      ctx,
      'refuse-unlink',
      async (workspace, repo) => {
        const removed = await shIn(workspace, `rm -f '${victim.path(repo)}'`);
        expect(removed.exitCode, removed.output).not.toBe(0);
        expect(existsSync(victim.path(repo))).toBe(true);
        expect(await repo.git.raw(['cat-file', '-p', victim.sha()])).toBe(
          'daemon owned\n',
        );
      },
      (repo) => victim.prepare(repo),
    );
  }, 180_000);

  it('cannot replace an object the daemon wrote by renaming another over it', async (ctx) => {
    const victim = daemonObject();
    await withWorkspace(
      ctx,
      'refuse-replace-obj',
      async (workspace, repo) => {
        const object = victim.path(repo);
        const replaced = await shIn(
          workspace,
          `echo junk > '${object}.new' && mv -f '${object}.new' '${object}'`,
        );
        expect(replaced.exitCode, replaced.output).not.toBe(0);
        expect(await repo.git.raw(['cat-file', '-p', victim.sha()])).toBe(
          'daemon owned\n',
        );
      },
      (repo) => victim.prepare(repo),
    );
  }, 180_000);

  it('cannot edit an object the daemon wrote in place', async (ctx) => {
    const victim = daemonObject();
    await withWorkspace(
      ctx,
      'refuse-append',
      async (workspace, repo) => {
        const appended = await shIn(
          workspace,
          `echo junk >> '${victim.path(repo)}'`,
        );
        expect(appended.exitCode, appended.output).not.toBe(0);
        expect(await repo.git.raw(['cat-file', '-p', victim.sha()])).toBe(
          'daemon owned\n',
        );
      },
      (repo) => victim.prepare(repo),
    );
  }, 180_000);

  it('commits with auto-gc armed, and a gc run as the worker cannot start', async (ctx) => {
    await withWorkspace(
      ctx,
      'gc-armed',
      async (workspace, repo) => {
        // 800 loose objects from the daemon and a threshold of one: far past the
        // point at which `git commit` would start a `gc --auto`.
        const wrote = await shIn(
          workspace,
          'for i in 1 2 3 4 5 6 7 8; do echo "n$i" > "f$i.txt"; done; git add . && git -c user.name=w -c user.email=w@example.invalid commit -q -m worker',
        );
        expect(wrote.exitCode, wrote.output).toBe(0);
        // ...and a gc run as the worker (what the commit's auto-gc would be)
        // cannot even take its lock: `gc.pid` lives in the common git directory,
        // which is not the worker's. Explicit, because the auto run's failure is
        // swallowed by `git commit`.
        const collected = await runIn(workspace, ['git', 'gc']);
        expect(collected.exitCode, collected.output).not.toBe(0);
        expect(collected.output).toMatch(/gc\.pid/);
        expect(
          await readdir(join(gitDir(repo), 'objects', 'pack')),
          'a worker-run gc must not have been able to write a pack',
        ).toEqual([]);
        expect(existsSync(join(gitDir(repo), 'gc.log'))).toBe(false);
        // Nothing the daemon wrote went missing.
        await repo.git.raw(['fsck', '--no-dangling']);
      },
      async (repo) => {
        await repo.git.addConfig('gc.auto', '1');
        await repo.git.addConfig('gc.autoDetach', 'false');
        const files: string[] = [];
        for (let index = 0; index < 800; index += 1) {
          const file = join(repo.scratchRoot, '..', `gc-${String(index)}.txt`);
          await writeFile(file, `daemon blob ${String(index)}\n`);
          files.push(file);
        }
        await repo.git.raw(['hash-object', '-w', '--', ...files]);
      },
    );
  }, 180_000);

  it('cannot plant alternates', async (ctx) => {
    await withWorkspace(ctx, 'refuse-alternates', async (workspace, repo) => {
      const alternates = join(gitDir(repo), 'objects', 'info', 'alternates');
      const wrote = await shIn(workspace, `echo /tmp > '${alternates}'`);
      expect(wrote.exitCode, wrote.output).not.toBe(0);
      expect(existsSync(alternates)).toBe(false);
    });
  }, 180_000);

  it('cannot add a pack', async (ctx) => {
    await withWorkspace(ctx, 'refuse-pack', async (workspace, repo) => {
      const pack = join(gitDir(repo), 'objects', 'pack', 'pack-planted.pack');
      const wrote = await shIn(workspace, `echo junk > '${pack}'`);
      expect(wrote.exitCode, wrote.output).not.toBe(0);
      expect(existsSync(pack)).toBe(false);
    });
  }, 180_000);
});

describe('worker access: the fan-out directories are restored on every attach', () => {
  it('repairs a directory the daemon made later, one git pruned, and one that lost its group bits', async (ctx) => {
    const gate = needWorker(ctx, 'there is no worker to restore the grant for');

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const spec = {
        mainRepo,
        scratchRoot,
        featureId: 'fanout-repair',
        baseRef: 'HEAD',
      };
      const first = await worktreeWorkspace(spec);
      const fanOut = fanOutDirectories(join(mainRepo, '.git'));
      const gid = await resolveGroupId(gate.workerGroup);
      // Three EMPTY directories: a fresh repository has a handful of loose
      // objects, and removing a directory that holds one would corrupt it.
      const empty: number[] = [];
      for (
        let index = 0;
        index < fanOut.length && empty.length < 3;
        index += 1
      ) {
        if ((await readdir(fanOut[index]!)).length === 0) empty.push(index);
      }
      expect(empty).toHaveLength(3);
      const [pruned, later, lost] = empty as [number, number, number];
      try {
        // `git gc` prunes empty ones...
        await rmdir(fanOut[pruned]!);
        // ...a daemon creating one later (umask 022) makes it unwritable...
        await rmdir(fanOut[later]!);
        await mkdir(fanOut[later]!, { mode: 0o755 });
        await chmod(fanOut[later]!, 0o755);
        // ...and a chmod/chgrp by anything else loses the bits.
        await chmod(fanOut[lost]!, 0o700);

        await first.detach();
        const second = await attachWorktreeWorkspace(spec);
        expect(second).toBeDefined();
        try {
          for (const index of [pruned, later, lost]) {
            const info = await stat(fanOut[index]!);
            expect(info.mode & 0o1070, fanOut[index]).toBe(0o1070);
            expect(info.gid, fanOut[index]).toBe(gid);
          }
          // Behaviourally: the worker can write into each of the three.
          for (const index of [pruned, later, lost]) {
            const name = index.toString(16).padStart(2, '0');
            const wrote = await shIn(
              second!,
              `touch '${join(fanOut[index]!, 'tmp_probe')}' && rm '${join(fanOut[index]!, 'tmp_probe')}' && echo ${name}`,
            );
            expect(wrote.exitCode, wrote.output).toBe(0);
          }
        } finally {
          await second?.destroy();
        }
      } finally {
        await first.destroy().catch(() => undefined);
      }
    });
  }, 180_000);
});

describe('worker access: a ref the worker made cannot redirect a daemon-side write (D-6-CI-7)', () => {
  const gitDir = (repo: TempRepo): string => join(repo.mainRepo, '.git');

  async function onBranch(
    ctx: Skippable,
    featureId: string,
    body: (
      workspace: Awaited<ReturnType<typeof worktreeWorkspace>>,
      repo: TempRepo,
      branch: string,
    ) => Promise<void>,
  ): Promise<void> {
    needWorker(ctx, 'there is no second identity to plant a ref as here');
    await withTempRepo(async (repo) => {
      const workspace = await worktreeWorkspace({
        mainRepo: repo.mainRepo,
        scratchRoot: repo.scratchRoot,
        featureId,
        baseRef: 'HEAD',
      });
      try {
        await body(workspace, repo, branchNameFor(featureId));
      } finally {
        await workspace.destroy();
      }
    });
  }

  it('lets an untouched branch through, and removes nothing', async (ctx) => {
    await onBranch(ctx, 'guard-clean', async (workspace, _repo, branch) => {
      const committed = await shIn(
        workspace,
        'echo x > f.txt && git add f.txt && git -c user.name=w -c user.email=w@example.invalid commit -q -m worker',
      );
      expect(committed.exitCode, committed.output).toBe(0);
      expect(await guardRefWrite(workspace.root, branch)).toEqual({ ok: true });
    });
  }, 180_000);

  it('removes a symlink ref the worker planted over its own branch, so a daemon commit cannot move the default branch', async (ctx) => {
    await onBranch(ctx, 'guard-link', async (workspace, repo, branch) => {
      const defaultBranch = (
        await repo.git.raw(['symbolic-ref', '--short', 'HEAD'])
      ).trim();
      const mainBefore = (
        await repo.git.raw(['rev-parse', defaultBranch])
      ).trim();
      const ref = join(gitDir(repo), 'refs', 'heads', branch);

      // The worker replaces its own branch ref with a link to the default
      // branch: git's files backend reads that as a symbolic ref.
      const planted = await shIn(
        workspace,
        `rm -f '${ref}' && ln -s refs/heads/${defaultBranch} '${ref}'`,
      );
      expect(planted.exitCode, planted.output).toBe(0);

      const verdict = await guardRefWrite(workspace.root, branch);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail).toContain('not a regular ref');

      // What a careless caller would do next. The link is gone, so this commit
      // can only land on the (now unborn) feature branch, never on the default.
      await writeFile(join(workspace.root, 'daemon.txt'), 'daemon\n');
      await repo.git.raw(['-C', workspace.root, 'add', 'daemon.txt']);
      await repo.git.raw([
        '-C',
        workspace.root,
        '-c',
        'user.name=ADL',
        '-c',
        'user.email=adl@example.invalid',
        'commit',
        '-q',
        '-m',
        'ADL commit',
      ]);
      expect((await repo.git.raw(['rev-parse', defaultBranch])).trim()).toBe(
        mainBefore,
      );
    });
  }, 180_000);

  it('holds the default branch by permission, not by the guard: a worker-run commit through a link to it fails and moves nothing', async (ctx) => {
    // ADL's own commit/add/push (`ManagerGitClient`) go through `Workspace.exec()`
    // and so run AS THE WORKER under the drop. The link redirect therefore lands
    // in an identity that cannot write the default branch -- this is the half of
    // the argument in `ref-guard.ts` that is the OS's, asserted rather than assumed.
    await onBranch(ctx, 'guard-perm', async (workspace, repo, branch) => {
      const defaultBranch = (
        await repo.git.raw(['symbolic-ref', '--short', 'HEAD'])
      ).trim();
      const mainBefore = (
        await repo.git.raw(['rev-parse', defaultBranch])
      ).trim();
      const ref = join(gitDir(repo), 'refs', 'heads', branch);

      const planted = await shIn(
        workspace,
        `rm -f '${ref}' && ln -s refs/heads/${defaultBranch} '${ref}'`,
      );
      expect(planted.exitCode, planted.output).toBe(0);

      const committed = await shIn(
        workspace,
        'echo x > f.txt && git add f.txt && git -c user.name=w -c user.email=w@example.invalid commit -q -m worker',
      );
      expect(committed.exitCode, committed.output).not.toBe(0);
      expect(committed.output).toMatch(/Permission denied|cannot lock ref/);
      expect((await repo.git.raw(['rev-parse', defaultBranch])).trim()).toBe(
        mainBefore,
      );
    });
  }, 180_000);

  it('leaves the default branch alone when the daemon-identity ref writers meet a planted link: branch -D deletes the link only, worktree add -b refuses the name', async (ctx) => {
    // The two writers ADL runs as itself (`adlGit`) in this namespace. Asserted,
    // because `ref-guard.ts` and `DEBT.md` D-6-CI-7 rest on both being harmless.
    await onBranch(ctx, 'guard-daemon-writers', async (workspace, repo) => {
      const defaultBranch = (
        await repo.git.raw(['symbolic-ref', '--short', 'HEAD'])
      ).trim();
      const mainBefore = (
        await repo.git.raw(['rev-parse', defaultBranch])
      ).trim();
      const refs = join(gitDir(repo), 'refs', 'heads', 'adl');

      const planted = await shIn(
        workspace,
        `ln -s refs/heads/${defaultBranch} '${join(refs, 'planted-delete')}' && ln -s refs/heads/${defaultBranch} '${join(refs, 'planted-create')}'`,
      );
      expect(planted.exitCode, planted.output).toBe(0);

      // GC's path: the worktree is gone, then `branch -D`.
      const destroyed = await destroyWorktree(
        repo.mainRepo,
        join(repo.scratchRoot, 'planted-delete'),
        'adl/planted-delete',
      );
      expect(destroyed).toBe('already-absent');
      expect(existsSync(join(refs, 'planted-delete'))).toBe(false);
      expect((await repo.git.raw(['rev-parse', defaultBranch])).trim()).toBe(
        mainBefore,
      );

      // Creation: a name that is already a link is refused, and moves nothing.
      await expect(
        createWorktree(
          repo.mainRepo,
          repo.scratchRoot,
          'planted-create',
          'HEAD',
        ),
      ).rejects.toThrow();
      expect((await repo.git.raw(['rev-parse', defaultBranch])).trim()).toBe(
        mainBefore,
      );
    });
  }, 180_000);

  it('refuses when the worker repointed the worktree HEAD at another branch', async (ctx) => {
    await onBranch(ctx, 'guard-head', async (workspace, repo, branch) => {
      const defaultBranch = (
        await repo.git.raw(['symbolic-ref', '--short', 'HEAD'])
      ).trim();
      const adminDir = (
        await repo.git.raw([
          '-C',
          workspace.root,
          'rev-parse',
          '--absolute-git-dir',
        ])
      ).trim();

      const repointed = await shIn(
        workspace,
        `echo 'ref: refs/heads/${defaultBranch}' > '${join(adminDir, 'HEAD')}'`,
      );
      expect(repointed.exitCode, repointed.output).toBe(0);

      const verdict = await guardRefWrite(workspace.root, branch);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail).toContain('HEAD');
    });
  }, 180_000);
});

describe('exec under the drop: a command the daemon cannot see into is not a missing command', () => {
  it('runs a tool the worker built in a directory only the worker can enter', async (ctx) => {
    needWorker(ctx, 'there is no worker-private directory to be blind to here');

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'exec-private',
        baseRef: 'HEAD',
      });
      try {
        const built = await shIn(
          workspace,
          'umask 077 && mkdir build && printf "#!/bin/sh\\necho built-by-worker\\n" > build/tool && chmod 700 build/tool',
        );
        expect(built.exitCode, built.output).toBe(0);

        // The daemon cannot even stat it (EACCES on `build`), which is not the
        // same thing as it not existing.
        const result = await runIn(workspace, ['./build/tool']);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toContain('built-by-worker');
      } finally {
        await shIn(workspace, 'rm -rf build');
        await workspace.destroy();
      }
    });
  }, 180_000);
});
