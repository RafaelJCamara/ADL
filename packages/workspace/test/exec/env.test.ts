import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecSpec } from '@adl/core/stage';
import { buildChildEnv } from '../../src/exec/env.js';
import { WorkspaceError } from '../../src/errors.js';

/**
 * Unit tests over the record `buildChildEnv` returns.
 *
 * These are deliberately NOT the WORK-06 proof. This file checks the object the
 * builder produces; `credentials.test.ts` checks the environment a real child
 * actually receives, which is the only thing the threat model cares about. Both
 * exist because they fail differently: a bug here is a wrong record, a bug there
 * is a right record that Node then modifies on the way to the child.
 */

const SCRATCH = join('/tmp', 'adl-home-unit-fixture');

/** A minimal valid spec. `path` is required by the type (execa#366). */
function specWith(env?: Readonly<Record<string, string>>): ExecSpec {
  return {
    argv: ['node', '-e', ''],
    cwd: '/tmp/worktree',
    path: '/usr/bin:/bin',
    networkPolicy: 'full',
    resources: {},
    ...(env === undefined ? {} : { env }),
  };
}

/**
 * Set in this very process and never named on a spec. The name is unique enough
 * that a match could only come from inheritance.
 */
const PARENT_ONLY_VAR = 'ADL_ENV_UNIT_PARENT_ONLY_5B2C';
const PARENT_ONLY_VALUE = 'must-not-be-inherited-a91f';

afterEach(() => {
  delete process.env[PARENT_ONLY_VAR];
});

describe('env builder: buildChildEnv', () => {
  it('points every neutraliser inside the supplied scratch home', () => {
    const env = buildChildEnv(specWith(), SCRATCH);

    // WORK-07's first half. Each of these is a path INTO the scratch directory
    // rather than a sink, so the configuration the agent writes is readable by
    // the agent and dies when the directory does — no separate wipe step.
    expect(env.HOME).toBe(SCRATCH);
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(SCRATCH, '.gitconfig'));
    expect(env.npm_config_userconfig).toBe(join(SCRATCH, '.npmrc'));
    expect(env.npm_config_cache).toBe(join(SCRATCH, '.npm'));
    expect(env.XDG_CONFIG_HOME).toBe(join(SCRATCH, '.config'));
    expect(env.XDG_CACHE_HOME).toBe(join(SCRATCH, '.cache'));

    // `/etc/gitconfig` is the one lookup that cannot be redirected into the
    // scratch directory, so it is switched off instead.
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');

    // PATH is a distinct ExecSpec field rather than an env entry precisely so
    // that forgetting it is a compile error; check it arrives.
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('sets USERPROFILE only on Windows, where git falls back to it', () => {
    const env = buildChildEnv(specWith(), SCRATCH);

    // Asserted both ways rather than skipped off-Windows: "the branch is
    // absent on Linux" is as much a property as "it is present on Windows",
    // and a skipped test on the deployment target proves nothing.
    if (process.platform === 'win32') {
      expect(env.USERPROFILE).toBe(SCRATCH);
    } else {
      expect(env.USERPROFILE).toBeUndefined();
    }
  });

  it('carries a caller-supplied variable through', () => {
    const env = buildChildEnv(
      specWith({ ANTHROPIC_API_KEY: 'sentinel-value-not-a-real-key' }),
      SCRATCH,
    );

    expect(env.ANTHROPIC_API_KEY).toBe('sentinel-value-not-a-real-key');
  });

  it('inherits nothing the caller did not name', () => {
    process.env[PARENT_ONLY_VAR] = PARENT_ONLY_VALUE;

    const env = buildChildEnv(specWith(), SCRATCH);

    // D-10. The variable is live in this process while the builder runs.
    expect(env[PARENT_ONLY_VAR]).toBeUndefined();
    expect(Object.values(env)).not.toContain(PARENT_ONLY_VALUE);
  });

  it('rejects an undefined value, naming the variable and not the value', () => {
    // The static type forbids `undefined`, but the shape that produces one is
    // the most natural thing a caller writes:
    //   { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
    // Node would silently drop it and the agent CLI would fail authentication
    // ten minutes later, somewhere with no link back to here.
    const spec = specWith({
      ANTHROPIC_API_KEY: undefined,
    } as unknown as Record<string, string>);

    expect(() => buildChildEnv(spec, SCRATCH)).toThrow(WorkspaceError);
    expect(() => buildChildEnv(spec, SCRATCH)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejects two case-colliding caller keys, naming both spellings', () => {
    const spec = specWith({
      MY_TOKEN: 'first-sentinel',
      my_token: 'second-sentinel',
    });

    // Windows would keep one of these and discard the other by sort order
    // (Pitfall 11). Picking a winner here would reproduce that bug politely.
    expect(() => buildChildEnv(spec, SCRATCH)).toThrow(WorkspaceError);

    let message = '';
    try {
      buildChildEnv(spec, SCRATCH);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('MY_TOKEN');
    expect(message).toContain('my_token');
    // T-2-19: a message that carries the value turns an error log into a
    // credential leak.
    expect(message).not.toContain('first-sentinel');
    expect(message).not.toContain('second-sentinel');
  });

  it('refuses to let a caller redirect a workspace-owned variable', () => {
    // D-07 says no caller may opt a child out of the scratch HOME. Merging
    // `spec.env` blindly on top would have made that a matter of call-site
    // discipline rather than construction: `env: { HOME: '/home/real' }` is one
    // line and would look like configuration.
    expect(() =>
      buildChildEnv(specWith({ HOME: '/home/real' }), SCRATCH),
    ).toThrow(/HOME/);
    expect(() =>
      buildChildEnv(specWith({ GIT_CONFIG_GLOBAL: '/etc/evil' }), SCRATCH),
    ).toThrow(/GIT_CONFIG_GLOBAL/);
    // The case-folded spelling is the same variable on Windows, so it is the
    // same rejection — otherwise the rule is bypassable by shift key.
    expect(() =>
      buildChildEnv(specWith({ Home: '/home/real' }), SCRATCH),
    ).toThrow(/Home/);
  });

  it('never puts a credential value in an error message', () => {
    // T-2-19, checked over every rejection path this module has, so a new one
    // added later has to be added here too.
    const value = 'sk-ant-unit-sentinel-2f7d';
    const cases: ExecSpec[] = [
      specWith({ HOME: value }),
      specWith({ ANTHROPIC_API_KEY: value, anthropic_api_key: value }),
    ];

    for (const spec of cases) {
      let message = '';
      try {
        buildChildEnv(spec, SCRATCH);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(value);
    }
  });
});
