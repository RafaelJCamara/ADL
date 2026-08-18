import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'workspace',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
