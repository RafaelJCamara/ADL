import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecSpec, LogChunk, Workspace } from '@adl/core/stage';
import {
  applyWorkerAccess,
  createPrivilegeWarner,
  privilegeLauncher,
  privilegeWarning,
  readGroupEntries,
  resolveUserIds,
  type PrivilegeMode,
} from '../../src/exec/privilege.js';
import { worktreeWorkspace } from '../../src/worktree/backend.js';
import { linuxOnly } from '../helpers/platform.js';
import { withTempRepo } from '../helpers/temp-repo.js';

/**
 * WORK-05, measured from inside a real child process.
 *
 * Two of the cases here cannot run on the Windows development machine. They are
 * gated by `linuxOnly`, which writes its reason to standard error so a green
 * local log still says which evidence was not produced — and which FAILS rather
 * than skipping on a Linux runner with no worker user configured, because a
 * gate that quietly declines to run is a decoration (D-21, T-2-33).
 */

/** The modes in which the drop did not happen. Each must announce itself. */
const NON_DROPPED_MODES: readonly PrivilegeMode[] = [
  'unsupported-platform',
  'launcher-missing',
  'worker-user-unset',
];

/** Run a command through the workspace, returning its exit code and output. */
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

describe('privilege: the launcher gate and the honest degraded mode', () => {
  it('is a no-op with an empty prefix on a platform that is not Linux', async () => {
    // The platform is INJECTED rather than read, so this case asserts the OS
    // gate itself on every runner — including the Linux one, where reading
    // process.platform would make it vacuous.
    for (const platform of ['win32', 'darwin', 'freebsd'] as const) {
      const decision = await privilegeLauncher({
        platform,
        worker: { user: 'adl-worker', group: 'adl-worker' },
        path: process.env.PATH ?? '',
        // Would resolve if it were ever consulted. It must not be: the platform
        // gate runs first and returns before anything else is asked.
        resolveLauncher: () => Promise.resolve('/usr/bin/sudo'),
      });

      expect(decision.mode).toBe('unsupported-platform');
      expect(decision.prefix).toEqual([]);
    }
  });

  it('reports launcher-missing and worker-user-unset as distinct causes', async () => {
    const missing = await privilegeLauncher({
      platform: 'linux',
      worker: { user: 'adl-worker', group: 'adl-worker' },
      path: '/nowhere',
      resolveLauncher: () => Promise.resolve(undefined),
    });
    expect(missing.mode).toBe('launcher-missing');
    expect(missing.prefix).toEqual([]);

    // Split from launcher-missing on purpose: the two want different fixes, and
    // a warning that names the wrong one sends the operator to the wrong file.
    const unset = await privilegeLauncher({
      platform: 'linux',
      worker: {},
      path: process.env.PATH ?? '',
      resolveLauncher: () => Promise.resolve('/usr/bin/sudo'),
    });
    expect(unset.mode).toBe('worker-user-unset');
    expect(unset.prefix).toEqual([]);
  });

  it('wraps rather than replaces the command when the drop applies', async () => {
    const decision = await privilegeLauncher({
      platform: 'linux',
      worker: { user: 'adl-worker', group: 'adl-worker' },
      path: '/usr/bin',
      resolveLauncher: () => Promise.resolve('/usr/bin/sudo'),
    });

    expect(decision.mode).toBe('dropped');
    // `--` terminates sudo's own option parsing, so an agent CLI invoked with a
    // leading dash is passed through rather than reinterpreted; `--preserve-env`
    // is what keeps the scratch HOME and the neutralisers alive across sudo's
    // env_reset; `--non-interactive` is what turns a sudoers misconfiguration
    // into a fast failure instead of a hang on a tty the daemon does not have.
    expect(decision.prefix).toEqual([
      '/usr/bin/sudo',
      '--preserve-env',
      '--non-interactive',
      '--user',
      'adl-worker',
      '--',
    ]);
  });

  it('names what is not enforced, once per warner, and never for a drop', () => {
    for (const mode of NON_DROPPED_MODES) {
      const text = privilegeWarning(mode, 'linux');
      expect(text).toBeDefined();
      // The three consequences T-2-32 is about. A banner that merely said
      // "isolation reduced" would not correct the belief this threat is about.
      expect(text).toMatch(/daemon's OWN OS identity/);
      expect(text).toMatch(/\.git\/config/);
      expect(text).toMatch(/Linux deployments only/);
      expect(text).toContain('[ADL][WORK-05]');
    }

    expect(privilegeWarning('dropped')).toBeUndefined();

    const messages: string[] = [];
    const warn = createPrivilegeWarner((message) => messages.push(message));

    // A dropped mode must not CONSUME the one warning: a process whose first
    // workspace dropped and whose second did not still has to hear about it.
    warn('dropped');
    expect(messages).toHaveLength(0);

    warn('launcher-missing');
    warn('worker-user-unset');
    warn('unsupported-platform');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Privilege drop NOT applied/);
  });

  it('changes nothing on disk when the mode is not dropped', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const before = await stat(scratchRoot);

      for (const mode of NON_DROPPED_MODES) {
        const report = await applyWorkerAccess([scratchRoot], {
          mode,
          group: 'adl-worker',
          protect: [join(mainRepo, '.git', 'config')],
        });

        expect(report.outcome).toBe('not-applicable');
      }

      const after = await stat(scratchRoot);
      // Asserted as mode bits rather than "it did not throw": a helper that
      // widened a directory and then reported not-applicable would pass the
      // weaker check (T-2-35).
      expect(after.mode).toBe(before.mode);
      expect(after.gid).toBe(before.gid);
    });
  }, 60_000);

  it('runs a real child successfully whatever the mode turns out to be', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'priv-run',
        baseRef: 'HEAD',
      });

      try {
        // The degraded path must not break the loop — D-05's whole point is
        // that a machine without the drop still runs ADL, loudly.
        const probe = await runIn(workspace, [
          process.execPath,
          '-e',
          'process.stdout.write("ALIVE\\n");',
        ]);
        expect(probe.exitCode).toBe(0);
        expect(probe.output).toContain('ALIVE');
      } finally {
        await workspace.destroy();
      }
    });
  }, 120_000);
});

describe('privilege: the drop, as a child process reports it', () => {
  it('gives the child the worker identity and none of the daemon-only groups', async (ctx) => {
    const gate = linuxOnly(
      'the launcher-based privilege drop is Linux-only in v1 (D-05), so a child cannot report a worker uid here',
    );
    if (gate.kind === 'skip') {
      ctx.skip(gate.reason);
      return;
    }

    const workerIds = await resolveUserIds(gate.workerUser);
    expect(
      workerIds,
      `worker user ${gate.workerUser} is not in /etc/passwd`,
    ).toBeDefined();

    // Resolved at test time from the configured NAME, never hardcoded — the
    // numbers differ between runners.
    const groups = await readGroupEntries();
    const workerGids = new Set<number>([
      workerIds!.gid,
      ...groups
        .filter((entry) => entry.members.includes(gate.workerUser))
        .map((entry) => entry.gid),
    ]);

    const daemonGids = process.getgroups?.() ?? [];
    const daemonOnly = daemonGids.filter((gid) => !workerGids.has(gid));

    // If the daemon carries no group the worker lacks, the supplementary-group
    // assertion below proves nothing — and a vacuous pass is the exact failure
    // D-21 exists to prevent, so it is stated as a requirement on the
    // environment rather than silently tolerated.
    expect(
      daemonOnly.length,
      `this runner's user carries no supplementary group that ${gate.workerUser} lacks, so the T-2-30 assertion would be vacuous`,
    ).toBeGreaterThan(0);

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'priv-identity',
        baseRef: 'HEAD',
      });

      try {
        const reported = await runIn(workspace, [
          '/bin/sh',
          '-c',
          'echo UID:$(id -u); echo GID:$(id -g); echo GROUPS:$(id -G)',
        ]);
        expect(reported.exitCode, reported.output).toBe(0);

        const line = (label: string): string =>
          reported.output
            .split('\n')
            .map((text) => text.trim())
            .find((text) => text.startsWith(`${label}:`))
            ?.slice(label.length + 1)
            .trim() ?? '';

        expect(Number(line('UID'))).toBe(workerIds!.uid);
        expect(Number(line('GID'))).toBe(workerIds!.gid);

        // ── T-2-30, and the reason this is a GROUP LIST comparison ────────
        //
        // `execa({ uid, gid })` sets the uid and the gid and does NOT call
        // setgroups, so the child keeps every supplementary group the daemon
        // had. A uid assertion passes cleanly on that broken implementation.
        // This one does not.
        const childGids = new Set(
          line('GROUPS')
            .split(/\s+/)
            .filter((text) => text !== '')
            .map(Number),
        );
        const leaked = daemonOnly.filter((gid) => childGids.has(gid));
        expect(
          leaked,
          `the child kept supplementary group(s) the daemon carries and ${gate.workerUser} is not a member of — the launcher did not relinquish groups (T-2-30)`,
        ).toEqual([]);
      } finally {
        await workspace.destroy();
      }
    });
  }, 180_000);

  it('lets the worker write its HOME and its worktree, and not the main repository config', async (ctx) => {
    const gate = linuxOnly(
      'the worker user only exists where the privilege drop applies (D-05), so there is no second identity to deny here',
    );
    if (gate.kind === 'skip') {
      ctx.skip(gate.reason);
      return;
    }

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'priv-access',
        baseRef: 'HEAD',
      });

      try {
        // ── What the worker MUST be able to do ────────────────────────────
        const wroteHome = await runIn(workspace, [
          '/bin/sh',
          '-c',
          'echo probe > "$HOME/worker-probe"',
        ]);
        expect(wroteHome.exitCode, wroteHome.output).toBe(0);

        const wroteWorktree = await runIn(workspace, [
          '/bin/sh',
          '-c',
          'echo probe > ./worker-probe',
        ]);
        expect(wroteWorktree.exitCode, wroteWorktree.output).toBe(0);

        // ── What it MUST NOT ──────────────────────────────────────────────
        //
        // A linked worktree shares the main repository's config, and git config
        // names programs git executes during ADL's OWN operations (Pitfall 5,
        // T-2-31). Asserted by having the child attempt the write and checking
        // the attempt failed, rather than by inspecting mode bits: mode bits are
        // what we set, and what we set is not evidence of what the OS enforces.
        const config = join(mainRepo, '.git', 'config');
        const marker = 'hooksPath = /tmp/adl-0207-must-not-land';
        const wroteConfig = await runIn(workspace, [
          '/bin/sh',
          '-c',
          `echo ${JSON.stringify(marker)} >> ${JSON.stringify(config)}`,
        ]);
        expect(wroteConfig.exitCode, wroteConfig.output).not.toBe(0);

        // Asserted from both sides. A shell that reports a redirect failure
        // differently, or a `>>` that partially succeeded, would satisfy the
        // exit-code check alone — and the thing that actually matters is
        // whether the bytes reached the file git reads.
        expect(await readFile(config, 'utf8')).not.toContain(marker);
      } finally {
        await workspace.destroy();
      }
    });
  }, 180_000);
});
