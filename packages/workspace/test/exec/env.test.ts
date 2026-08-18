import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecSpec } from '@adl/core/stage';
import {
  buildChildEnv,
  GIT_EXECUTION_ENV_PREFIXES,
} from '../../src/exec/env.js';
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

  it('refuses every git-configuration and git-invoked-program variable (WR-02)', () => {
    // Driven off the exported prefix list rather than a hand-written copy, so
    // deleting an entry deletes its own proof instead of leaving an aggregate
    // assertion that still passes — the same shape `poisoned-config.test.ts`
    // uses for NEUTRALISED_CONFIG.
    const refused: string[] = [];
    for (const prefix of GIT_EXECUTION_ENV_PREFIXES) {
      // The bare prefix, and the prefix wearing a suffix — because these are
      // matched as a family and `GIT_SSH` and `GIT_SSH_COMMAND` are both real
      // variables that both name a program.
      for (const name of [prefix, `${prefix}_COMMAND`]) {
        try {
          buildChildEnv(specWith({ [name]: 'x' }), SCRATCH);
          refused.push(`${name}: ACCEPTED`);
        } catch (error) {
          if (!(error instanceof WorkspaceError)) {
            refused.push(`${name}: threw ${String(error)}`);
          }
        }
      }
    }
    expect(
      refused,
      'every entry in GIT_EXECUTION_ENV_PREFIXES must be refused as a family, in both its bare and suffixed spelling',
    ).toEqual([]);
  });

  it('refuses the INDEXED git-config pairs at any index, not just index 0', () => {
    // The reason the check is a prefix match and not a list of names. A fixed
    // list containing GIT_CONFIG_KEY_0 and GIT_CONFIG_VALUE_0 is not a control:
    // the caller picks 17. `GIT_CONFIG_COUNT` is what makes git read them, and
    // it is refused for the same reason.
    for (const name of [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_17',
      'GIT_CONFIG_VALUE_17',
      // Case-folded: environment keys are case-insensitive on Windows, so a
      // rule evadable with the shift key is not a rule (Pitfall 11).
      'git_config_key_0',
      'Git_Config_Count',
    ]) {
      expect(
        () => buildChildEnv(specWith({ [name]: 'user.name' }), SCRATCH),
        `${name} must be refused — GIT_CONFIG_COUNT with an indexed key/value pair sets ANY git config, and git config names programs git executes (WR-02)`,
      ).toThrow(WorkspaceError);
    }
  });

  it('POSITIVE CONTROL: still carries git variables that are data, not programs', () => {
    // Without this, the two cases above would be satisfied by refusing the whole
    // `GIT_` namespace — which would be over-refusal dressed as security, and
    // would push a stage that legitimately needs a committer identity into
    // configuring git some other and worse way. The line is configuration
    // injection and names of programs, not the prefix `GIT_`.
    const env = buildChildEnv(
      specWith({
        GIT_AUTHOR_NAME: 'ADL',
        GIT_COMMITTER_EMAIL: 'adl@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
      }),
      SCRATCH,
    );

    expect(env.GIT_AUTHOR_NAME).toBe('ADL');
    expect(env.GIT_COMMITTER_EMAIL).toBe('adl@example.invalid');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('keeps the workspace-owned message for the two the workspace owns', () => {
    // `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` are in the reserved set AND
    // in the git-execution family, and the ordering of the two checks decides
    // which message a caller reads. The workspace-owned one is the more useful:
    // it says the variable already has a value doing a job. Asserted so the
    // ordering is a property rather than an accident of line order.
    expect(() =>
      buildChildEnv(specWith({ GIT_CONFIG_GLOBAL: '/etc/evil' }), SCRATCH),
    ).toThrow(/owned by the Workspace instance/);
    expect(() =>
      buildChildEnv(specWith({ GIT_CONFIG_NOSYSTEM: '0' }), SCRATCH),
    ).toThrow(/owned by the Workspace instance/);
  });

  it('never puts a credential value in an error message', () => {
    // T-2-19, checked over every rejection path this module has, so a new one
    // added later has to be added here too.
    const value = 'sk-ant-unit-sentinel-2f7d';
    const cases: ExecSpec[] = [
      specWith({ HOME: value }),
      specWith({ ANTHROPIC_API_KEY: value, anthropic_api_key: value }),
      // The WR-02 path. Added here because this case's whole contract is that
      // it covers EVERY rejection this module has — and the git-execution
      // refusal is the newest one. `GIT_ASKPASS` is the pointed example: the
      // program it names is handed a credential, so a message that echoed the
      // value would be leaking exactly where it hurts most.
      specWith({ GIT_CONFIG_VALUE_0: value }),
      specWith({ GIT_ASKPASS: value }),
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
