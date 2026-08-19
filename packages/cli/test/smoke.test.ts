import { describe, expect, it } from 'vitest';

/**
 * Makes `@adl/cli` testable rather than merely present. This is what
 * `pnpm --filter @adl/cli test` exercises before any real behaviour exists
 * (03-01-PLAN.md Task 2).
 */
describe('@adl/cli barrel', () => {
  it('resolves', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
