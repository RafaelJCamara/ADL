/**
 * `05-0b`'s TRACER — the thinnest end-to-end path M05's opener exists to
 * prove: a feature folder committed to a repository is DETECTED (5.1) →
 * pushed to a remote → a DRAFT change request appears through a real
 * `ForgeAdapter` (5.8) implemented against a real GitHub App auth flow
 * (5.9). "Real" here means the same thing it meant for `04-06`'s tracer:
 * every non-external piece is production code exercised for real (a real
 * git repository, a real worktree, a real commit, a real bare remote, a
 * real signed App-auth JWT really exchanged over HTTP for an installation
 * token) — GitHub itself is a local mock server, because live credentials
 * were deliberately deferred to the end-of-project batch (`docs/plan/DEBT.md`
 * item 1.7), matching `04-06`'s own precedent for the agent CLI.
 *
 * **What this tracer does NOT prove**, deliberately: the round-loop runner
 * (5.13), gates, and send-back do not exist yet — that is groups C and D,
 * out of scope for the opener. "The developer's work" here is therefore a
 * direct commit made through `Workspace.exec()`, not a real agent CLI
 * invocation — `04-06`'s tracer already proves an agent produces a real
 * commit through the exact same exec boundary; re-driving that machinery
 * here would duplicate a proof this milestone doesn't need to repeat. What
 * IS new here, and is what this tracer exists to prove, is everything
 * downstream of a commit existing: push, and the forge side.
 *
 * Also deliberately NOT wired into `daemon.ts`'s automatic dispatch loop —
 * that automatic wiring (draft-at-round-1, promote-when-green) is 5.10 and
 * 5.13's job. This tracer chains 5.1 → `ManagerGitClient.push` → 5.8/5.9 by
 * calling each directly, proving the pieces compose, before any of them is
 * wired behind a scheduler nobody can single-step through yet.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managerGitClient, workspaceRegistry } from '@adl/workspace';
import { githubForgeAdapter } from '@adl/forge-github';
import { listFeatureFolders } from '../../src/detect/scanner.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

const COMMIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'ADL (claude-code)',
  GIT_AUTHOR_EMAIL: 'adl+claude-code@noreply.local',
  GIT_COMMITTER_NAME: 'ADL (claude-code)',
  GIT_COMMITTER_EMAIL: 'adl+claude-code@noreply.local',
};

describe('tracer: a committed feature folder is detected, published, and opens a real draft change request', () => {
  it('features/dark-mode -> scanner finds it -> a real commit -> a real push -> a real draft CR', async () => {
    await withTempRepo(async (ctx) => {
      // ── 1. A feature folder is committed, exactly as a team would. ──
      const featureDir = join(ctx.mainRepo, 'features', 'dark-mode');
      await mkdir(featureDir, { recursive: true });
      await writeFile(
        join(featureDir, 'spec.md'),
        '# Dark mode\n\n## Acceptance Criteria\n\n- A dark theme toggle appears.\n',
        'utf8',
      );
      await ctx.git.add('features/dark-mode/spec.md');
      await ctx.git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await ctx.git.raw(['branch', '--show-current'])
      ).trim();

      // ── 2. DETECT (5.1) — the real scanner, reading committed state ──
      // through the real ManagerGitClient chokepoint, not a worktree.
      const hostWorkspace = await workspaceRegistry({
        hostGit: {
          configHome: join(ctx.scratchRoot, '..', 'adl-home-tracer-host'),
        },
      })
        .resolve('host-git')
        .create({
          featureId: 'adl-tracer-host',
          mainRepo: ctx.mainRepo,
          scratchRoot: ctx.scratchRoot,
          baseRef: defaultBranch,
        });

      let discovered: readonly string[];
      try {
        discovered = await listFeatureFolders(
          managerGitClient(hostWorkspace),
          defaultBranch,
          'features',
        );
      } finally {
        await hostWorkspace.destroy();
      }
      expect(discovered).toEqual(['dark-mode']);

      // ── 3. "The developer's work" — a real commit through the real ──
      // exec boundary (04-06 already proves a real agent CLI makes it
      // through this same path; see this file's own docblock).
      const featureId = discovered[0];
      if (featureId === undefined) {
        throw new Error('unreachable: discovered[0] just asserted equal');
      }

      const featureWorkspace = await workspaceRegistry({
        hostGit: {
          configHome: join(ctx.scratchRoot, '..', 'adl-home-tracer-feature'),
        },
      })
        .resolve('worktree')
        .create({
          featureId,
          mainRepo: ctx.mainRepo,
          scratchRoot: ctx.scratchRoot,
          baseRef: defaultBranch,
        });

      const branch = `adl/${featureId}`;
      const bareRemote = join(ctx.scratchRoot, '..', 'origin.git');

      try {
        await featureWorkspace.write(
          'features/dark-mode/implementation-note.md',
          '# Implemented\n\nThe dark theme toggle now appears in settings.\n',
        );

        const execArgs = {
          cwd: featureWorkspace.root,
          path: process.env['PATH'] ?? '',
          env: COMMIT_IDENTITY_ENV,
          networkPolicy: 'full' as const,
          resources: {},
        };
        await featureWorkspace.exec(
          {
            argv: ['git', 'add', 'features/dark-mode/implementation-note.md'],
            ...execArgs,
          },
          () => {},
        );
        const commitResult = await featureWorkspace.exec(
          {
            argv: ['git', 'commit', '-m', 'implement dark mode toggle'],
            ...execArgs,
          },
          () => {},
        );
        expect(commitResult.exitCode).toBe(0);

        // ── 4. Push (the ManagerGitClient extension) — while the branch ──
        // still exists; Workspace.destroy() reclaims the worktree AND
        // its branch (packages/workspace/src/worktree/backend.ts), so
        // publishing has to happen before teardown, never after.
        //
        // `-C <path>` on the already-constructed `ctx.git` handle, never
        // a fresh `simple-git` import: `adl/no-direct-spawn` bans that
        // specifier outside `packages/workspace/**`, matching the same
        // discipline `crash-recovery.test.ts` documents.
        await mkdir(bareRemote, { recursive: true });
        await ctx.git.raw(['-C', bareRemote, 'init', '--bare']);
        await managerGitClient(featureWorkspace).push(
          bareRemote,
          `HEAD:refs/heads/${branch}`,
        );
      } finally {
        await featureWorkspace.destroy();
      }

      const pushedSha = (
        await ctx.git.raw([
          '-C',
          bareRemote,
          'rev-parse',
          `refs/heads/${branch}`,
        ])
      ).trim();
      expect(pushedSha).toMatch(/^[0-9a-f]{40}$/);

      // ── 5. The forge side (5.8/5.9) — a real draft CR, through a real ──
      // GitHub App auth flow, against a local mock GitHub server.
      const githubServer = await startMockGithubServer();
      try {
        const forge = githubForgeAdapter({
          appId: 'adl-tracer-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: githubServer.url,
          disablePacingForTests: true,
        });

        const changeRequest = await forge.openChangeRequest({
          repo: { owner: 'adl-demo-org', repo: 'demo-repo' },
          head: branch,
          base: defaultBranch,
          title: 'Dark mode',
          body: 'Implements the dark theme toggle described in features/dark-mode/spec.md.',
          draft: true,
        });

        // Draft, at round 1 — FORGE-05's shape, even though the round
        // loop itself (5.10, 5.13) does not exist yet.
        expect(changeRequest.draft).toBe(true);
        expect(changeRequest.state).toBe('draft');
        expect(changeRequest.url).toContain('/pull/');
        expect(changeRequest.number).toBeGreaterThan(0);

        // The App-auth JWT exchange really happened over real HTTP.
        expect(
          githubServer.state.authorizationHeadersSeen.some((header) =>
            /^bearer [^.]+\.[^.]+\.[^.]+$/i.test(header),
          ),
        ).toBe(true);

        // And the mock forge really recorded the branch this run pushed.
        const stored = githubServer.state.pulls.find(
          (pr) => pr.number === changeRequest.number,
        );
        expect(stored?.head).toBe(branch);
        expect(stored?.base).toBe(defaultBranch);
      } finally {
        await githubServer.close();
      }
    });
  }, 30_000);
});
