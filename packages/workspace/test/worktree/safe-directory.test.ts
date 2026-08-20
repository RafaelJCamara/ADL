import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecSpec, LogChunk, Workspace } from '@adl/core/stage';
import { buildChildEnv } from '../../src/exec/env.js';
import {
  createScratchHome,
  destroyScratchHome,
  SCRATCH_GITCONFIG_FILENAME,
  writeScratchGitConfig,
} from '../../src/exec/scratch-home.js';
import { worktreeWorkspace } from '../../src/worktree/backend.js';
import { posixOnly } from '../helpers/platform.js';
import { withTempRepo } from '../helpers/temp-repo.js';

/**
 * D-2-08-1: on a provisioned Linux deployment the agent could not run git
 * inside its own worktree — `fatal: detected dubious ownership in
 * repository`, exit 128 — because git ≥2.35.2's CVE-2022-24765 mitigation
 * refuses to operate in a repository owned by a different uid than the
 * process running it, which is exactly the state the privilege drop creates
 * on purpose. `writeScratchGitConfig` marks the worktree and the main
 * repository `safe.directory` in the scratch HOME's global git config before
 * any child is launched.
 *
 * These describe blocks prove the writer and the wiring in isolation and
 * end-to-end (runs everywhere). The actual `dubious ownership` reproduction —
 * which needs a real uid mismatch, and therefore the Linux privilege drop — is
 * a separate, linux-only-gated describe block (plan `04-02` task 2).
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Run a command through the workspace, returning its exit code and combined output. */
async function runIn(
  workspace: Workspace,
  argv: readonly string[],
): Promise<{ exitCode: number | null; output: string }> {
  const chunks: LogChunk[] = [];
  const spec: ExecSpec = {
    argv,
    cwd: workspace.root,
    path: process.env.PATH ?? '',
    networkPolicy: 'full',
    resources: {},
  };
  const result = await workspace.exec(spec, (chunk) => chunks.push(chunk));
  return {
    exitCode: result.exitCode,
    output: chunks.map((chunk) => chunk.text).join('\n'),
  };
}

describe('safe-directory: writeScratchGitConfig', () => {
  it('creates a file that parses as a git config with an empty [safe] section', async () => {
    const home = await createScratchHome();
    try {
      await writeScratchGitConfig(home.path, { safeDirectories: [] });

      const path = join(home.path, SCRATCH_GITCONFIG_FILENAME);
      expect(await exists(path)).toBe(true);

      const contents = await readFile(path, 'utf8');
      expect(contents).toMatch(/^\[safe\]/);
      expect(contents).not.toContain('directory');
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('writes one directory entry per path, in the order given', async () => {
    const home = await createScratchHome();
    try {
      // Plain forward-slash identifiers, deliberately not `join()`-built OS
      // paths: on Windows those contain backslashes, which the writer escapes
      // in the file. This case is about ORDER, not escaping — the
      // "worktreeWorkspace wiring" describe block below proves the verbatim
      // round trip against real (and, on Windows, backslash-laden) paths by
      // reading them back through git itself.
      const first = '/some/worktree/path';
      const second = '/some/main-repo/path';

      await writeScratchGitConfig(home.path, {
        safeDirectories: [first, second],
      });

      const contents = await readFile(
        join(home.path, SCRATCH_GITCONFIG_FILENAME),
        'utf8',
      );
      const firstIndex = contents.indexOf(first);
      const secondIndex = contents.indexOf(second);

      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('replaces rather than appends on a second call over the same home', async () => {
    const home = await createScratchHome();
    try {
      await writeScratchGitConfig(home.path, {
        safeDirectories: ['/one', '/two', '/three'],
      });
      await writeScratchGitConfig(home.path, { safeDirectories: ['/only'] });

      const contents = await readFile(
        join(home.path, SCRATCH_GITCONFIG_FILENAME),
        'utf8',
      );
      const entries = contents
        .split('\n')
        .filter((line) => line.trim().startsWith('directory'));

      // Exactly as many directory entries as the SECOND call supplied — a
      // reused home must not accumulate duplicates from the first call.
      expect(entries).toHaveLength(1);
      expect(contents).toContain('/only');
      expect(contents).not.toContain('/two');
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('names both the worktree root and the main repository', async () => {
    const home = await createScratchHome();
    try {
      const worktreePath = '/some/scratch-root/feature-1';
      const mainRepo = '/some/main/repo';

      await writeScratchGitConfig(home.path, {
        safeDirectories: [worktreePath, mainRepo],
      });

      const contents = await readFile(
        join(home.path, SCRATCH_GITCONFIG_FILENAME),
        'utf8',
      );
      expect(contents).toContain(worktreePath);
      expect(contents).toContain(mainRepo);
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('writes a mode that permits the dropped worker identity to read and write it', async (ctx) => {
    const gate = posixOnly(
      'the worker-write mode is POSIX permission bits, and fs.Stats.mode on Windows reports the read-only attribute rather than permissions',
      'D-2-08-1',
    );
    if (gate.kind === 'skip') {
      ctx.skip(gate.reason);
      return;
    }

    const home = await createScratchHome();
    try {
      await writeScratchGitConfig(home.path, { safeDirectories: [] });

      const info = await stat(join(home.path, SCRATCH_GITCONFIG_FILENAME));
      const mode = info.mode & 0o777;

      // Owner and group read/write; no world bit. `recordOwner`'s 0o600 would
      // leave the shared worker group — chowned onto this file separately by
      // `applyWorkerAccess` — with nothing to widen into.
      expect(mode & 0o600, 'owner read/write').toBe(0o600);
      expect(mode & 0o060, 'group read/write').toBe(0o060);
      expect(mode & 0o007, 'no world bits').toBe(0);
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it("builds env.ts's GIT_CONFIG_GLOBAL from the same SCRATCH_GITCONFIG_FILENAME constant", () => {
    const scratch = join('tmp', 'adl-home-unit-fixture');
    const env = buildChildEnv(
      {
        argv: ['node', '-e', ''],
        cwd: '/tmp/worktree',
        path: '/usr/bin:/bin',
        networkPolicy: 'full',
        resources: {},
      },
      scratch,
    );

    expect(env.GIT_CONFIG_GLOBAL).toBe(
      join(scratch, SCRATCH_GITCONFIG_FILENAME),
    );
    expect(env.GIT_CONFIG_GLOBAL?.endsWith(SCRATCH_GITCONFIG_FILENAME)).toBe(
      true,
    );
  });
});

describe('safe-directory: worktreeWorkspace wiring', () => {
  it('has the config file in place before any exec call is made', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'safe-dir-wiring',
        baseRef: 'HEAD',
      });

      try {
        // Asserted immediately after `worktreeWorkspace()` resolves and
        // BEFORE the first `workspace.exec()` call in this test — the
        // ordering is the entire point (the file must exist before any
        // child is launched).
        const path = join(workspace.scratchHome, SCRATCH_GITCONFIG_FILENAME);
        expect(await exists(path)).toBe(true);

        const contents = await readFile(path, 'utf8');
        expect(contents).toContain('[safe]');
      } finally {
        await workspace.destroy();
      }
    });
  });

  it('marks both the worktree root and the main repository, reported by git itself', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'safe-dir-reported',
        baseRef: 'HEAD',
      });

      try {
        const reported = await runIn(workspace, [
          'git',
          'config',
          '--get-all',
          'safe.directory',
        ]);

        expect(reported.exitCode, reported.output).toBe(0);
        expect(reported.output).toContain(workspace.root);
        expect(reported.output).toContain(mainRepo);
      } finally {
        await workspace.destroy();
      }
    });
  });

  it('lets a real child run git status inside the worktree', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'safe-dir-status',
        baseRef: 'HEAD',
      });

      try {
        const status = await runIn(workspace, ['git', 'status', '--porcelain']);

        expect(status.exitCode, status.output).toBe(0);
        expect(status.output).not.toMatch(/dubious ownership/i);
      } finally {
        await workspace.destroy();
      }
    });
  });
});
