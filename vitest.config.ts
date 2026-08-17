import { defineConfig } from 'vitest/config';

/**
 * Vitest 4 removed the standalone `vitest.workspace.ts` file; projects are
 * declared here instead.
 *
 * Each package owns its own `vitest.config.ts` and names its own project, so
 * `pnpm vitest run --project core` addresses exactly one package's suite
 * (01-VALIDATION.md § Test Infrastructure). Adding a package to the workspace
 * enrols its tests automatically — no edit to this file required, which is what
 * keeps concurrent plans off a shared file.
 */
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
});
