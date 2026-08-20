import { describe, expectTypeOf, it } from 'vitest';

import type { AgentRunner, StageContext } from '../../src/stage/index.js';

/**
 * The compile-time half of `AgentRunner`'s "real interface, not a forward
 * declaration" claim (04-03-PLAN.md must_haves).
 *
 * `packages/core/src/stage/stage.ts` used to declare `AgentRunner` as
 * `{ readonly __adlForwardDeclaration?: never }` — an interface with an
 * optional `never`-typed member is satisfied by **every** non-nullish value,
 * so `agents: 42 as unknown as AgentRunner` typechecked. A runtime test
 * cannot express "this used to be assignable and must no longer be" — only
 * the typechecker can, and only over a file this package's `tsconfig.test.json`
 * program actually compiles (`vitest.config.ts`'s `typecheck.include`).
 *
 * Mirrors `type-boundary.test-d.ts`'s `@ts-expect-error` pattern exactly: if
 * `AgentRunner` ever regresses to a structural placeholder, the assignment
 * below stops erroring, the suppression comment becomes unused, and
 * TypeScript reports *that* as a build failure.
 */
describe('AgentRunner is a real, callable interface (BACK-01)', () => {
  it('does not accept a number where an AgentRunner is required', () => {
    // @ts-expect-error — a bare number satisfies no member of a real AgentRunner.
    const notARunner: AgentRunner = 42;
    void notARunner;

    expectTypeOf<number>().not.toExtend<AgentRunner>();
  });

  it('accepts a real implementation, and StageContext.agents accepts it too', () => {
    const runner: AgentRunner = {
      run: () =>
        Promise.resolve({
          outcome: 'completed',
          durationMs: 0,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        }),
      probe: () =>
        Promise.resolve({
          usable: true,
          installedVersion: '1.0.0',
          expectedVersion: '1.0.0',
        }),
    };

    expectTypeOf(runner).toExtend<AgentRunner>();
    expectTypeOf<AgentRunner>().toExtend<StageContext['agents']>();
  });
});
