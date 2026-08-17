import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    environment: 'node',

    /**
     * Type-level tests run alongside the runtime suite.
     *
     * `packages/core/test/stage/type-boundary.test-d.ts` asserts that
     * `StageError` and `Verdict` are mutually non-assignable (D-12, CORE-06).
     * That property cannot be checked at runtime: a refactor unifying the two
     * types would leave every runtime assertion passing while making a broken
     * gate assignable to a judging one. Enabling the typechecker here is what
     * turns that assertion into a failing build.
     *
     * `tsconfig.test.json` is a separate non-emitting program, so the build
     * config keeps shipping only `src/`.
     */
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
      /**
       * Errors *inside* the type-test files are always reported — this only
       * suppresses errors in the surrounding source, which
       * `pnpm --filter @adl/core typecheck` already owns. Keeping them separate
       * means a half-written module elsewhere in the package cannot mask, or be
       * masked by, the boundary proof.
       */
      ignoreSourceErrors: true,
    },
  },
});
