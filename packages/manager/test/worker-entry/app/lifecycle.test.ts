/**
 * The app lifecycle's own decisions, against a stub workspace (ROLE-07, M08
 * steps 8.2/8.3).
 *
 * `test/scenario/gate-app-lifecycle.test.ts` is the tracer and
 * `test/scenario/app-failure-modes.test.ts` proves the table through a real
 * daemon. Both cost real wall-clock, which is exactly why these two cases are
 * here instead: a configuration warning and a refused interpolation are decided
 * before any process starts, so proving them through a daemon would be paying for
 * a worktree, a fork and a git commit to observe a string comparison.
 *
 * The stub is a `Workspace` and nothing more — `withAppUnderTest` takes the port,
 * not a backend, so there is nothing to mock past it.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecResult,
  ExecSpec,
  RestoreHandle,
  Workspace,
} from '@adl/core/stage';
import type { EffectiveConfig } from '@adl/core/config';
import { withAppUnderTest } from '../../../src/worker-entry/app/lifecycle.js';

/** Every argv the stub was asked to run, in order. */
interface StubWorkspace {
  readonly workspace: Workspace;
  readonly ran: readonly (readonly string[])[];
}

/**
 * A `Workspace` whose `exec` records and answers, and never starts anything.
 *
 * `start` is the interesting case: the real lifecycle does not await it, so the
 * stub returns a promise that only settles when the caller aborts — which is what
 * makes "the app is running" and "the app exited" distinguishable at all.
 */
function stubWorkspace(
  exitCodes: Readonly<Record<string, number>> = {},
): StubWorkspace {
  const ran: string[][] = [];
  const workspace: Workspace = {
    id: 'stub',
    root: process.cwd(),
    scratchHome: process.cwd(),
    async exec(spec: ExecSpec): Promise<ExecResult> {
      ran.push([...spec.argv]);
      const key = spec.argv.join(' ');
      if (key === 'STAY_UP') {
        // Settles only on abort, like a real long-lived child.
        await new Promise<void>((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return { exitCode: null, durationMs: 1 };
      }
      return { exitCode: exitCodes[key] ?? 0, durationMs: 1 };
    },
    read: () => Promise.reject(new Error('not used')),
    write: () => Promise.reject(new Error('not used')),
    snapshot: () =>
      Promise.reject(new Error('not used')) as Promise<RestoreHandle>,
    detach: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return { workspace, ran };
}

/** The four commands, with only what a case cares about overridden. */
function commands(
  overrides: Partial<EffectiveConfig['commands']> = {},
): EffectiveConfig['commands'] {
  return {
    build: { argv: ['BUILD'] },
    start: { argv: ['STAY_UP'] },
    test: { argv: ['TEST'] },
    teardown: { argv: ['TEARDOWN'] },
    ...overrides,
  } as EffectiveConfig['commands'];
}

describe('the start.timeout warning (D-8-02-2)', () => {
  it('fires when the app would be killed out from under the gate', async () => {
    const { workspace } = stubWorkspace();
    const result = await withAppUnderTest(
      {
        workspace,
        commands: commands({ start: { argv: ['STAY_UP'], timeout: '1s' } }),
        featureId: 'f',
        path: process.env['PATH'] ?? '',
        onLog: () => {},
        // The gate's own command may run for a minute; the app is capped at one
        // second. `adl-yml.ts`'s worked example used to say exactly this shape.
        gateCommandTimeoutMs: 60_000,
      },
      () => Promise.resolve('judged'),
    );

    expect(result.kind).toBe('ran');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("APP'S WHOLE LIFETIME");
    expect(result.warnings[0]).toContain('1000ms');
    expect(result.warnings[0]).toContain('60000ms');
  });

  it('stays silent when the app outlasts the gate, and when no ceiling is declared', async () => {
    // A warning that fired on a correct configuration would be deleted by the
    // first person it annoyed, which is the line `reviewer-model-warning.ts`
    // draws for itself: actionable, or not at all.
    for (const start of [
      { argv: ['STAY_UP'], timeout: '10m' },
      { argv: ['STAY_UP'] },
    ]) {
      const { workspace } = stubWorkspace();
      const result = await withAppUnderTest(
        {
          workspace,
          commands: commands({ start }),
          featureId: 'f',
          path: process.env['PATH'] ?? '',
          onLog: () => {},
          gateCommandTimeoutMs: 60_000,
        },
        () => Promise.resolve('judged'),
      );
      expect(result.warnings, JSON.stringify(start)).toEqual([]);
    }
  });

  it('stays silent when the caller knows no gate timeout', async () => {
    // An agent gate has no command, so there is no number to compare against —
    // and comparing against a default would be inventing the hazard.
    const { workspace } = stubWorkspace();
    const result = await withAppUnderTest(
      {
        workspace,
        commands: commands({ start: { argv: ['STAY_UP'], timeout: '1s' } }),
        featureId: 'f',
        path: process.env['PATH'] ?? '',
        onLog: () => {},
      },
      () => Promise.resolve('judged'),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe('a command naming a variable ADL does not supply', () => {
  it('is config-invalid, and nothing is run', async () => {
    // D-21: never an empty-string substitution. `ADL_ROUND` is a real ADL
    // variable the app lifecycle deliberately does not supply, so it is the
    // sharpest case — a maintainer could reasonably believe it works.
    const { workspace, ran } = stubWorkspace();
    const result = await withAppUnderTest(
      {
        workspace,
        commands: commands({
          build: { argv: ['BUILD'], env: { R: '${ADL_ROUND}' } },
        }),
        featureId: 'f',
        path: process.env['PATH'] ?? '',
        onLog: () => {},
      },
      () => Promise.resolve('judged'),
    );

    expect(result.kind).toBe('not-judgeable');
    if (result.kind === 'not-judgeable') {
      expect(result.failure.kind).toBe('config-invalid');
      expect(result.failure.detail).toContain('ADL_ROUND');
    }
    // Refused BEFORE anything ran — the whole point of interpolating every
    // command up front rather than each one at its own call site.
    expect(ran).toEqual([]);
  });
});

describe('the phases run in order, and teardown runs last', () => {
  it('builds, starts, judges, then tears down', async () => {
    const { workspace, ran } = stubWorkspace();
    const result = await withAppUnderTest(
      {
        workspace,
        commands: commands(),
        featureId: 'f',
        path: process.env['PATH'] ?? '',
        onLog: () => {},
      },
      () => Promise.resolve('judged'),
    );

    expect(result.kind).toBe('ran');
    // `TEARDOWN` after `STAY_UP`, which the stub only lets settle on abort — so
    // this ordering is also evidence that the reap happened first (M08 step 8.2's
    // watched-failing finding).
    expect(ran.map((argv) => argv.join(' '))).toEqual([
      'BUILD',
      'STAY_UP',
      'TEARDOWN',
    ]);
    if (result.kind === 'ran') {
      expect(result.value).toBe('judged');
      expect(result.teardown.reaped).toBe(true);
      expect(result.teardown.teardownExitCode).toBe(0);
    }
  });

  it('reports a build that exits non-zero without starting anything', async () => {
    const { workspace, ran } = stubWorkspace({ BUILD: 2 });
    const result = await withAppUnderTest(
      {
        workspace,
        commands: commands(),
        featureId: 'f',
        path: process.env['PATH'] ?? '',
        onLog: () => {},
      },
      () => Promise.resolve('judged'),
    );

    expect(result.kind).toBe('not-judgeable');
    if (result.kind === 'not-judgeable') {
      expect(result.failure.kind).toBe('build-failed');
    }
    // No `STAY_UP`, and no `TEARDOWN` either: there was nothing started to tear
    // down, and running a repository's teardown against a world it never built is
    // how a cleanup command gets blamed for a build error.
    expect(ran.map((argv) => argv.join(' '))).toEqual(['BUILD']);
  });
});
