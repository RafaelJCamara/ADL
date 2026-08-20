import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-claude-code',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
