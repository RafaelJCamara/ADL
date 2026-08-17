import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'plugin-sdk',
    include: ['test/**/*.test.ts'],
    // The package is a deliberately empty stub until plan 01-05 fills it, so
    // it collects zero tests. Failing on that would make the workspace red for
    // a package that is correct.
    passWithNoTests: true,
    environment: 'node',
  },
});
