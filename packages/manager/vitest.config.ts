import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'manager',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
