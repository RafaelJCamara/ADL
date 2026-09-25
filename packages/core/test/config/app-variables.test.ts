/**
 * The interpolation values the app lifecycle supplies (ROLE-07, M08 step 8.2).
 *
 * `interpolate.test.ts` covers the substitution engine — this covers the *closed
 * set* the app lifecycle calls it with, which is the security-relevant half: a
 * caller that supplied `process.env` instead of a named record would pass every
 * test in that file and fail every test in this one.
 */
import { describe, expect, it } from 'vitest';
import {
  ADL_VARIABLES,
  AdlYmlSchema,
  APP_LIFECYCLE_VARIABLES,
  appVariables,
  interpolateCommandEnv,
  interpolateReadyProbe,
  resolvePipeline,
  type ReadyProbe,
} from '../../src/config/index.js';
import { LoadError } from '../../src/errors.js';

const VALUES = appVariables({ port: 41234, featureId: 'my-feature' });

describe('the app lifecycle variable set', () => {
  it('names only variables adl.yml documents', () => {
    // The runtime half of the `satisfies` clause: a name here that is not one of
    // ADL's documented variables would resolve to a value the reference
    // documentation never promised. The build already refuses it; this refuses a
    // future edit that widened `ADL_VARIABLES` to accommodate a typo instead.
    for (const name of APP_LIFECYCLE_VARIABLES) {
      expect(Object.keys(ADL_VARIABLES)).toContain(name);
    }
  });

  it('deliberately does NOT supply ADL_ROUND or ADL_VERDICT_FILE', () => {
    // Their absence is the behaviour, not an omission — see the module docblock.
    // `ADL_ROUND` is not on the worker's wire (only the round id is), and
    // `ADL_VERDICT_FILE` belongs to the command-gate verdict contract.
    expect(Object.keys(VALUES).sort()).toEqual(['ADL_FEATURE_ID', 'ADL_PORT']);
  });

  it('renders the port as a string, because an env value is a string', () => {
    expect(VALUES.ADL_PORT).toBe('41234');
    expect(VALUES.ADL_FEATURE_ID).toBe('my-feature');
  });
});

describe('interpolateCommandEnv', () => {
  it('substitutes every env value and leaves argv alone', () => {
    const command = interpolateCommandEnv(
      {
        argv: ['node', 'server.mjs', '${ADL_PORT}'],
        env: { PORT: '${ADL_PORT}', TAG: 'f-${ADL_FEATURE_ID}-x' },
      },
      VALUES,
    );

    expect(command.env).toEqual({ PORT: '41234', TAG: 'f-my-feature-x' });
    // argv is deliberately NOT an interpolation site: it is the injection-
    // sensitive surface the no-shell rule protects, and an app that needs its
    // port can be told through its environment.
    expect(command.argv).toEqual(['node', 'server.mjs', '${ADL_PORT}']);
  });

  it('returns a command with no env by identity', () => {
    // What makes it safe to apply unconditionally to every command the lifecycle
    // touches, including the three that usually reference nothing.
    const command = { argv: ['npm', 'ci'] };
    expect(interpolateCommandEnv(command, VALUES)).toBe(command);
  });

  it('keeps the fields a StartCommandSpec has beyond a CommandSpec', () => {
    // Generic over the command shape rather than narrowing to `CommandSpec`: a
    // `start` whose `ready` block was dropped on the way through would be a
    // readiness contract silently deleted by an interpolation helper.
    const start = interpolateCommandEnv(
      {
        argv: ['npm', 'run', 'dev'],
        env: { PORT: '${ADL_PORT}' },
        ready: { kind: 'log', pattern: 'listening' } as const,
        ready_timeout: '30s',
      },
      VALUES,
    );

    expect(start.ready).toEqual({ kind: 'log', pattern: 'listening' });
    expect(start.ready_timeout).toBe('30s');
  });

  it('refuses a variable ADL does not supply, naming it', () => {
    // D-21's whole point, and the reason the `values` key set is the allowlist
    // rather than `ADL_VARIABLES`: `ADL_ROUND` IS one of ADL's variables and is
    // still an error here, because the app lifecycle has no round number to
    // supply and an empty string would be a silent lie.
    expect(() =>
      interpolateCommandEnv(
        { argv: ['true'], env: { R: '${ADL_ROUND}' } },
        VALUES,
      ),
    ).toThrow(LoadError);
    expect(() =>
      interpolateCommandEnv({ argv: ['true'], env: { P: '${PATH}' } }, VALUES),
    ).toThrow(/PATH/);
    expect(() =>
      interpolateCommandEnv(
        { argv: ['true'], env: { K: '${ANTHROPIC_API_KEY}' } },
        VALUES,
      ),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('interpolateReadyProbe', () => {
  it('substitutes the http probe url', () => {
    expect(
      interpolateReadyProbe(
        {
          kind: 'http',
          url: 'http://127.0.0.1:${ADL_PORT}/health',
          expect: 200,
        },
        VALUES,
      ),
    ).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:41234/health',
      expect: 200,
    });
  });

  it('returns log and exec by identity', () => {
    // Not a `default` branch that happens to pass them through: each is returned
    // unchanged because the schema documents exactly two interpolatable probe
    // fields, so a fifth kind cannot silently acquire interpolation it was never
    // given.
    const others: readonly ReadyProbe[] = [
      { kind: 'log', pattern: 'listening on ${ADL_PORT}' },
      { kind: 'exec', argv: ['pg_isready'] },
    ];
    for (const probe of others) {
      expect(interpolateReadyProbe(probe, VALUES)).toBe(probe);
    }
  });

  it('resolves a tcp probe declaring ${ADL_PORT} to a number', () => {
    // D-8-02-1, closed by M08 step 8.3. Before this, `TcpReadyProbeSchema.port`
    // was an `int`, so an app with no HTTP surface could not be probed on the port
    // ADL allocated at all — it had to hardcode one, which defeats the allocation.
    expect(
      interpolateReadyProbe({ kind: 'tcp', port: '${ADL_PORT}' }, VALUES),
    ).toEqual({ kind: 'tcp', port: 41234 });
  });

  it('passes a literal tcp port through unchanged', () => {
    expect(interpolateReadyProbe({ kind: 'tcp', port: 8080 }, VALUES)).toEqual({
      kind: 'tcp',
      port: 8080,
    });
  });

  it('refuses a variable that does not resolve to a port, naming it', () => {
    // The whole reason the resolved form is a distinct type: a caller typed
    // against `ResolvedReadyProbe` cannot be handed a feature id to connect to.
    // `${ADL_FEATURE_ID}` is a legitimate ADL variable and is still an error here.
    expect(() =>
      interpolateReadyProbe({ kind: 'tcp', port: '${ADL_FEATURE_ID}' }, VALUES),
    ).toThrow(/not a port in 1–65535/);
    expect(() =>
      interpolateReadyProbe({ kind: 'tcp', port: '${ADL_FEATURE_ID}' }, VALUES),
    ).toThrow(LoadError);
  });

  it('refuses an unknown variable in a tcp port', () => {
    expect(() =>
      interpolateReadyProbe({ kind: 'tcp', port: '${PORT}' }, VALUES),
    ).toThrow(/PORT/);
  });
});

describe('the tcp probe schema (D-8-02-1)', () => {
  function parse(port: unknown): boolean {
    return AdlYmlSchema.safeParse({
      version: 1,
      // `pipeline` is required, and omitting it made an earlier draft of this
      // block pass vacuously: every case failed, including the ones asserting
      // success, and only the positive case noticed.
      pipeline: ['develop'],
      commands: {
        build: { argv: ['true'] },
        test: { argv: ['true'] },
        teardown: { argv: ['true'] },
        start: {
          argv: ['true'],
          ready: { kind: 'tcp', port },
          ready_timeout: '30s',
        },
      },
    }).success;
  }

  it('accepts a literal and a bare variable reference', () => {
    expect(parse(8080)).toBe(true);
    expect(parse('${ADL_PORT}')).toBe(true);
  });

  it('refuses anything else, including concatenation', () => {
    // Deliberately only a BARE reference. A port is a number, and the one
    // legitimate thing to say is "the port ADL allocated" — admitting
    // concatenation would turn a numeric field into a small expression language.
    for (const bad of [
      '8080',
      '${ADL_PORT}1',
      'port-${ADL_PORT}',
      '${ADL PORT}',
      0,
      70_000,
    ]) {
      expect(parse(bad), `${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });
});

describe('needs_app reaches ResolvedStage (ROLE-07)', () => {
  it('is carried onto the resolved stage when declared', () => {
    const [stage] = resolvePipeline([{ harness: 'test', needs_app: true }]);
    expect(stage?.needsApp).toBe(true);
  });

  it('is absent when the entry does not declare it, and absent means false', () => {
    // Unlike `visible_paths`, absent and `false` mean the same thing here — there
    // is no third state to preserve, because `commands.build`/`start`/`teardown`
    // are required by schema whether or not any gate declares this. What matters
    // is that an existing pipeline gets NO app: every pre-M08 fixture declares
    // `start: { argv: ['true'] }`, which would otherwise read as an app that died
    // instantly.
    const [plain] = resolvePipeline(['test']);
    expect(plain?.needsApp).toBeUndefined();
    expect('needsApp' in (plain ?? {})).toBe(false);

    const [entry] = resolvePipeline([{ harness: 'review' }]);
    expect(entry?.needsApp).toBeUndefined();
  });

  it('round-trips through the adl.yml schema, and refuses a non-boolean', () => {
    const base = {
      version: 1,
      commands: {
        build: { argv: ['true'] },
        start: { argv: ['true'] },
        test: { argv: ['true'] },
        teardown: { argv: ['true'] },
      },
    };
    expect(
      AdlYmlSchema.safeParse({
        ...base,
        pipeline: ['develop', { harness: 'test', needs_app: true }],
      }).success,
    ).toBe(true);
    // `z.strictObject` plus a `boolean` schema, so `'yes'` is a boot-time refusal
    // naming the key rather than a truthy string a maintainer believes is off.
    expect(
      AdlYmlSchema.safeParse({
        ...base,
        pipeline: ['develop', { harness: 'test', needs_app: 'yes' }],
      }).success,
    ).toBe(false);
  });
});
