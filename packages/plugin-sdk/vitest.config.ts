import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'plugin-sdk',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
