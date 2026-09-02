import { describe, expect, it } from 'vitest';

import {
  AGENT_ROLES,
  BACKEND_DEFAULT_MODEL,
  DAEMON_ONLY_FIELDS,
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  EffectiveConfigSchema,
  mergeConfig,
  type DaemonConfig,
} from '../../src/config/effective-config.js';
import { AdlYmlSchema, type AdlYml } from '../../src/config/adl-yml.js';

/** A minimal, valid `adl.yml`, with every `limits` field at its default. */
function baseRepo(overrides: Record<string, unknown> = {}): AdlYml {
  const raw = {
    version: 1,
    commands: {
      build: { argv: ['npm', 'ci'] },
      start: { argv: ['npm', 'run', 'dev'] },
      test: { argv: ['npm', 'test'] },
      teardown: { argv: ['docker', 'compose', 'down'] },
    },
    pipeline: ['develop', 'review', 'test'],
    ...overrides,
  };
  const result = AdlYmlSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `fixture failed to parse: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return result.data;
}

function emptyDaemon(): DaemonConfig {
  const result = DaemonConfigSchema.safeParse({});
  if (!result.success) throw new Error('empty daemon config failed to parse');
  return result.data;
}

describe('mergeConfig — limits clamp down, never up', () => {
  it('clamps a repo value that raises max_rounds above the daemon ceiling', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 4 } });
    const repo = baseRepo({ limits: { max_rounds: 10 } });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.limits.max_rounds).toBe(4);
    expect(report.clamped).toContainEqual({
      field: 'limits.max_rounds',
      requested: 10,
      ceiling: 4,
    });
  });

  it('preserves a repo value that lowers max_rounds below the daemon ceiling', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 10 } });
    const repo = baseRepo({ limits: { max_rounds: 3 } });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.limits.max_rounds).toBe(3);
    expect(report.clamped).toHaveLength(0);
  });

  it('clamps budget_usd the same way, asserted independently of max_rounds', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { budget_usd: 5 } });
    const repo = baseRepo({ limits: { budget_usd: 50 } });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.limits.budget_usd).toBe(5);
    expect(report.clamped).toContainEqual({
      field: 'limits.budget_usd',
      requested: 50,
      ceiling: 5,
    });
  });

  it('clamps repeat_finding_threshold the same way, asserted independently', () => {
    const daemon = DaemonConfigSchema.parse({
      limits: { repeat_finding_threshold: 1 },
    });
    const repo = baseRepo({ limits: { repeat_finding_threshold: 5 } });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.limits.repeat_finding_threshold).toBe(1);
    expect(report.clamped).toContainEqual({
      field: 'limits.repeat_finding_threshold',
      requested: 5,
      ceiling: 1,
    });
  });

  it('a field absent from both the daemon and the repo takes the documented default', () => {
    const daemon = emptyDaemon();
    const repo = baseRepo();
    const { config } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.limits).toEqual(DEFAULT_CONFIG.limits);
  });

  it('a field present only in the daemon config takes the daemon value as the ceiling', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 2 } });
    const repo = baseRepo();
    const { config } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    // Repo did not specify max_rounds, so AdlYmlSchema filled in its own
    // default (6) — the daemon ceiling of 2 must still clamp it down.
    expect(config.limits.max_rounds).toBe(2);
  });
});

describe('mergeConfig — backend and model are daemon-only', () => {
  it('discards a repo-supplied backend, uses the daemon value, and reports the discard', () => {
    const daemon = DaemonConfigSchema.parse({
      agents: { developer: { backend: 'claude-code', model: 'default' } },
    });
    const repo = baseRepo({
      agents: { developer: { backend: 'codex', model: 'gpt-5' } },
    });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.agents.developer.backend).toBe('claude-code');
    expect(config.agents.developer.model).toBe('default');
    expect(report.discarded).toContainEqual({
      field: 'agents.developer.backend',
      requested: 'codex',
    });
    expect(report.discarded).toContainEqual({
      field: 'agents.developer.model',
      requested: 'gpt-5',
    });
  });

  it('asserted per role: reviewer and tester are independently daemon-only', () => {
    const daemon = DaemonConfigSchema.parse({});
    const repo = baseRepo({
      agents: {
        reviewer: { backend: 'codex', model: 'x' },
        tester: { backend: 'gemini', model: 'y' },
      },
    });
    const { config, report } = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(config.agents.reviewer.backend).toBe(
      DEFAULT_CONFIG.agents.reviewer.backend,
    );
    expect(config.agents.tester.backend).toBe(
      DEFAULT_CONFIG.agents.tester.backend,
    );
    expect(report.discarded.map((d) => d.field)).toEqual(
      expect.arrayContaining([
        'agents.reviewer.backend',
        'agents.reviewer.model',
        'agents.tester.backend',
        'agents.tester.model',
      ]),
    );
  });

  it('DAEMON_ONLY_FIELDS is non-empty and includes the agent backend and model fields', () => {
    expect(DAEMON_ONLY_FIELDS.length).toBeGreaterThan(0);
    for (const role of AGENT_ROLES) {
      expect(DAEMON_ONLY_FIELDS).toContain(`agents.${role}.backend`);
      expect(DAEMON_ONLY_FIELDS).toContain(`agents.${role}.model`);
    }
  });
});

describe('mergeConfig — the result is deeply frozen', () => {
  it('a nested property assignment throws in strict mode', () => {
    const { config } = mergeConfig(DEFAULT_CONFIG, emptyDaemon(), baseRepo());

    expect(() => {
      // @ts-expect-error — intentionally violating the frozen contract to prove it throws
      config.limits.max_rounds = 999;
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error — same, at the top level
      config.version = 2;
    }).toThrow(TypeError);
  });
});

describe('mergeConfig — purity', () => {
  it('produces deeply equal results across repeated calls with the same inputs', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 4 } });
    const repo = baseRepo({ limits: { max_rounds: 10 } });

    const first = mergeConfig(DEFAULT_CONFIG, daemon, repo);
    const second = mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(first.config).toEqual(second.config);
    expect(first.report).toEqual(second.report);
  });

  it('mutates neither the daemon nor the repo input', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 4 } });
    const repo = baseRepo({ limits: { max_rounds: 10 } });
    const daemonBefore = structuredClone(daemon);
    const repoBefore = structuredClone(repo);

    mergeConfig(DEFAULT_CONFIG, daemon, repo);

    expect(daemon).toEqual(daemonBefore);
    expect(repo).toEqual(repoBefore);
  });
});

describe('mergeConfig — the result validates against EffectiveConfigSchema', () => {
  it('a plain merge with no overrides validates', () => {
    const { config } = mergeConfig(DEFAULT_CONFIG, emptyDaemon(), baseRepo());
    expect(EffectiveConfigSchema.safeParse(config).success).toBe(true);
  });

  it('a merge with clamps and discards still validates', () => {
    const daemon = DaemonConfigSchema.parse({ limits: { max_rounds: 2 } });
    const repo = baseRepo({
      limits: { max_rounds: 10 },
      agents: { developer: { backend: 'codex', model: 'x' } },
    });
    const { config } = mergeConfig(DEFAULT_CONFIG, daemon, repo);
    expect(EffectiveConfigSchema.safeParse(config).success).toBe(true);
  });
});

/**
 * BACK-10 (M06 step 6.9) — the sentinel that means "ADL selected no model".
 *
 * `DEFAULT_AGENT_BLOCK.model` and `@adl/manager`'s omission check have to be
 * the same string, and rule 8 says derived rather than transcribed. This is
 * the assertion that the export and the default cannot drift apart: a second
 * literal typed into either would make the manager's omission silently stop
 * working while every other test still passed, because the sentinel would
 * simply flow through to the CLI as though a human had chosen a model
 * genuinely named `default`.
 */
describe('BACKEND_DEFAULT_MODEL (BACK-10, M06 step 6.9)', () => {
  it('is what every role defaults to when neither the daemon nor the repo names a model', () => {
    for (const role of AGENT_ROLES) {
      expect(DEFAULT_CONFIG.agents[role].model).toBe(BACKEND_DEFAULT_MODEL);
    }
  });

  it('survives a merge in which nobody names a model', () => {
    const daemon = DaemonConfigSchema.parse({});
    const { config } = mergeConfig(DEFAULT_CONFIG, daemon, baseRepo({}));

    // The value the manager tests for before deciding to omit `AgentTask.model`
    // — reached through the real merge rather than read off the default
    // object, because the merge is what actually produces it at dispatch time.
    expect(config.agents.developer.model).toBe(BACKEND_DEFAULT_MODEL);
  });

  it('is displaced by a daemon-configured model, which is what then reaches the backend', () => {
    const daemon = DaemonConfigSchema.parse({
      agents: {
        developer: { backend: 'claude-code', model: 'claude-haiku-4-5' },
      },
    });
    const { config } = mergeConfig(DEFAULT_CONFIG, daemon, baseRepo({}));

    expect(config.agents.developer.model).toBe('claude-haiku-4-5');
    expect(config.agents.developer.model).not.toBe(BACKEND_DEFAULT_MODEL);
  });
});
