import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managerGitClient, workspaceRegistry } from '@adl/workspace';
import { listFeatureFolders } from '../../src/detect/scanner.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';

describe('listFeatureFolders', () => {
  it('reads feature folders from the default branch, through ManagerGitClient', async () => {
    await withTempRepo(async (ctx) => {
      await mkdir(join(ctx.mainRepo, 'features', 'dark-mode'), {
        recursive: true,
      });
      await writeFile(
        join(ctx.mainRepo, 'features', 'dark-mode', 'spec.md'),
        '# Dark mode\n',
        'utf8',
      );
      await ctx.git.add('features/dark-mode/spec.md');
      await ctx.git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await ctx.git.raw(['branch', '--show-current'])
      ).trim();

      const host = await workspaceRegistry({
        hostGit: {
          configHome: join(ctx.scratchRoot, '..', 'adl-home-scanner'),
        },
      })
        .resolve('host-git')
        .create({
          featureId: 'adl-scanner',
          mainRepo: ctx.mainRepo,
          scratchRoot: ctx.scratchRoot,
          baseRef: 'HEAD',
        });

      try {
        const folders = await listFeatureFolders(
          managerGitClient(host),
          defaultBranch,
          'features',
        );
        expect(folders).toEqual(['dark-mode']);
      } finally {
        await host.destroy();
      }
    });
  });

  it('re-running against an unchanged repository returns the identical answer', async () => {
    await withTempRepo(async (ctx) => {
      await mkdir(join(ctx.mainRepo, 'features', 'export-widgets'), {
        recursive: true,
      });
      await writeFile(
        join(ctx.mainRepo, 'features', 'export-widgets', 'spec.md'),
        '# Export widgets\n',
        'utf8',
      );
      await ctx.git.add('features/export-widgets/spec.md');
      await ctx.git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await ctx.git.raw(['branch', '--show-current'])
      ).trim();

      const host = await workspaceRegistry({
        hostGit: {
          configHome: join(ctx.scratchRoot, '..', 'adl-home-scanner-idem'),
        },
      })
        .resolve('host-git')
        .create({
          featureId: 'adl-scanner-idem',
          mainRepo: ctx.mainRepo,
          scratchRoot: ctx.scratchRoot,
          baseRef: 'HEAD',
        });

      try {
        const git = managerGitClient(host);
        const first = await listFeatureFolders(git, defaultBranch, 'features');
        const second = await listFeatureFolders(git, defaultBranch, 'features');
        expect(first).toEqual(second);
        expect(first).toEqual(['export-widgets']);
      } finally {
        await host.destroy();
      }
    });
  });

  it('returns empty when featuresDir has no committed folders', async () => {
    await withTempRepo(async (ctx) => {
      const defaultBranch = (
        await ctx.git.raw(['branch', '--show-current'])
      ).trim();

      const host = await workspaceRegistry({
        hostGit: {
          configHome: join(ctx.scratchRoot, '..', 'adl-home-scanner-empty'),
        },
      })
        .resolve('host-git')
        .create({
          featureId: 'adl-scanner-empty',
          mainRepo: ctx.mainRepo,
          scratchRoot: ctx.scratchRoot,
          baseRef: 'HEAD',
        });

      try {
        await expect(
          listFeatureFolders(managerGitClient(host), defaultBranch, 'features'),
        ).resolves.toEqual([]);
      } finally {
        await host.destroy();
      }
    });
  });
});
