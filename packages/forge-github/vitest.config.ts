import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'forge-github',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
