import { describe, expect, it } from 'vitest';

/**
 * Makes `@adl/manager` testable rather than merely present. This is what
 * `pnpm --filter @adl/manager test` exercises before any real behaviour
 * exists (03-01-PLAN.md Task 2).
 */
describe('@adl/manager barrel', () => {
  // 03-06 adds `./boot/startup.js` to the barrel's import graph, which
  // derives `DAEMON_SCHEMA_VERSION` via `import.meta.resolve('@adl/db')` +
  // a synchronous directory read at module-load time — real, one-time work
  // that can exceed the default 5s under the contention of a full parallel
  // suite run. A longer timeout here, not a change to the derivation's own
  // (deliberately synchronous — see D-37) shape.
  it('resolves', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  }, 30_000);
});
