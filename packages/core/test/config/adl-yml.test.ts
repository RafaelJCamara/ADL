import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ADL_YML_VERSION,
  AdlYmlSchema,
  CommandSpecSchema,
  ContextConfigSchema,
  LimitsSchema,
  parseAdlYml,
  PipelineEntrySchema,
  ReadyProbeSchema,
} from '../../src/config/adl-yml.js';
import { LoadError } from '../../src/errors.js';

/**
 * `node:fs` appears here and nowhere in `packages/core/src/` — reading fixture
 * files is the caller's job (test harness), never the schema's.
 */
function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/adl-yml/${name}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

/** The module's own source, used to extract and re-validate its worked example. */
const MODULE_PATH = fileURLToPath(new URL('../../src/config/adl-yml.ts', import.meta.url));
const MODULE_SOURCE = readFileSync(MODULE_PATH, 'utf8');

/**
 * Pulls the fenced ` ```yaml ` block out of a JSDoc comment and strips the
 * ` * ` line prefix each line carries inside the comment. Task 3's action is
 * explicit that this must extract the *same* block the test asserts against,
 * rather than duplicating the example — a duplicated example is exactly the
 * documentation drift `.describe()` exists to prevent.
 */
function extractYamlExample(source: string): string {
  const fenceStart = source.indexOf('```yaml');
  if (fenceStart === -1) throw new Error('no ```yaml fence found in module header');
  const bodyStart = source.indexOf('\n', fenceStart) + 1;
  const fenceEnd = source.indexOf('```', bodyStart);
  if (fenceEnd === -1) throw new Error('```yaml fence is not closed');
  return source
    .slice(bodyStart, fenceEnd)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n');
}

/** Parses a fixture and asserts it validated, returning the config. */
function parseValid(name: string) {
  const result = parseAdlYml(fixture(name));
  if (result instanceof LoadError) {
    throw new Error(`expected ${name} to validate, got LoadError: ${result.message}`);
  }
  return result;
}

/** Parses a fixture and asserts it failed, returning the LoadError. */
function parseInvalid(name: string): LoadError {
  const result = parseAdlYml(fixture(name));
  if (!(result instanceof LoadError)) {
    throw new Error(`expected ${name} to fail, got a validated config`);
  }
  return result;
}

describe('parseAdlYml: the four valid fixtures', () => {
  it.each([
    ['valid-http-ready.yml', 'http'],
    ['valid-tcp-ready.yml', 'tcp'],
    ['valid-log-ready.yml', 'log'],
    ['valid-exec-ready.yml', 'exec'],
  ] as const)('validates %s with a %s readiness probe', (file, kind) => {
    const config = parseValid(file);
    expect(config.version).toBe(1);
    expect(config.commands.start.ready?.kind).toBe(kind);
  });
});

describe('parseAdlYml: the three invalid fixtures', () => {
  it('fails the shell-string fixture with an issue path naming the offending command', () => {
    const error = parseInvalid('invalid-shell-string.yml');
    expect(error.message).toMatch(/commands.*build.*argv|argv.*commands.*build/i);
  });

  it('fails the unknown-key fixture naming the offending key', () => {
    const error = parseInvalid('invalid-unknown-key.yml');
    expect(error.message).toMatch(/limitz/);
  });

  it('fails the missing-readiness-timeout fixture stating both are required together', () => {
    const error = parseInvalid('invalid-missing-ready-timeout.yml');
    expect(error.message).toMatch(/ready_timeout/);
    expect(error.message).toMatch(/together|both|required/i);
  });
});

describe('parseAdlYml: version', () => {
  it('fails when version is 2', () => {
    const source = fixture('valid-http-ready.yml').replace('version: 1', 'version: 2');
    expect(parseAdlYml(source)).toBeInstanceOf(LoadError);
  });

  it('validates when version is 1', () => {
    const config = parseValid('valid-http-ready.yml');
    expect(config.version).toBe(1);
  });
});

describe('ADL_YML_VERSION', () => {
  it('is the literal 1', () => {
    expect(ADL_YML_VERSION).toBe(1);
  });
});

describe('CommandSpecSchema: argv', () => {
  it('rejects a shell string in place of an argv array', () => {
    expect(CommandSpecSchema.safeParse({ argv: 'npm ci' }).success).toBe(false);
  });

  it('rejects an empty argv array', () => {
    expect(CommandSpecSchema.safeParse({ argv: [] }).success).toBe(false);
  });

  it("rejects an argv array whose first element is an empty string", () => {
    expect(CommandSpecSchema.safeParse({ argv: ['', 'ci'] }).success).toBe(false);
  });

  it('accepts a well-formed argv array', () => {
    expect(CommandSpecSchema.safeParse({ argv: ['npm', 'ci'] }).success).toBe(true);
  });

  it('rejects a bare-integer timeout, and accepts a duration-string timeout', () => {
    expect(CommandSpecSchema.safeParse({ argv: ['npm', 'ci'], timeout: 600 }).success).toBe(
      false,
    );
    expect(CommandSpecSchema.safeParse({ argv: ['npm', 'ci'], timeout: '10m' }).success).toBe(
      true,
    );
  });

  it('validates cwd through the shared repo-relative path guard', () => {
    expect(CommandSpecSchema.safeParse({ argv: ['npm', 'ci'], cwd: '../escape' }).success).toBe(
      false,
    );
    expect(CommandSpecSchema.safeParse({ argv: ['npm', 'ci'], cwd: 'packages/api' }).success).toBe(
      true,
    );
  });
});

describe('ReadyProbeSchema', () => {
  it('declares exactly four union members', () => {
    expect(ReadyProbeSchema.options).toHaveLength(4);
  });

  it('fails an unrecognised probe kind', () => {
    const result = ReadyProbeSchema.safeParse({ kind: 'carrier-pigeon' });
    expect(result.success).toBe(false);
  });

  it('validates each of the four probe kinds', () => {
    expect(ReadyProbeSchema.safeParse({ kind: 'http', url: 'http://x/health' }).success).toBe(
      true,
    );
    expect(ReadyProbeSchema.safeParse({ kind: 'tcp', port: 5432 }).success).toBe(true);
    expect(ReadyProbeSchema.safeParse({ kind: 'log', pattern: 'ready' }).success).toBe(true);
    expect(ReadyProbeSchema.safeParse({ kind: 'exec', argv: ['pg_isready'] }).success).toBe(true);
  });

  it('accepts a URL carrying the ADL_PORT interpolation placeholder', () => {
    expect(
      ReadyProbeSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:${ADL_PORT}/health' })
        .success,
    ).toBe(true);
  });

  it('validates an http probe at its expected-status ceiling and fails one step above', () => {
    expect(
      ReadyProbeSchema.safeParse({ kind: 'http', url: 'http://x/', expect: 599 }).success,
    ).toBe(true);
    expect(
      ReadyProbeSchema.safeParse({ kind: 'http', url: 'http://x/', expect: 600 }).success,
    ).toBe(false);
    expect(
      ReadyProbeSchema.safeParse({ kind: 'http', url: 'http://x/', expect: 99 }).success,
    ).toBe(false);
  });

  it('validates a tcp probe at its port ceiling and fails one step above', () => {
    expect(ReadyProbeSchema.safeParse({ kind: 'tcp', port: 65535 }).success).toBe(true);
    expect(ReadyProbeSchema.safeParse({ kind: 'tcp', port: 65536 }).success).toBe(false);
    expect(ReadyProbeSchema.safeParse({ kind: 'tcp', port: 0 }).success).toBe(false);
  });
});

describe('start command: ready / ready_timeout both-or-neither', () => {
  it('fails when ready is present without ready_timeout', () => {
    const result = AdlYmlSchema.shape.commands.shape.start.safeParse({
      argv: ['npm', 'run', 'dev'],
      ready: { kind: 'tcp', port: 5432 },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ready_timeout/);
  });

  it('fails when ready_timeout is present without ready', () => {
    const result = AdlYmlSchema.shape.commands.shape.start.safeParse({
      argv: ['npm', 'run', 'dev'],
      ready_timeout: '30s',
    });
    expect(result.success).toBe(false);
  });

  it('validates when both are present, and when neither is', () => {
    expect(
      AdlYmlSchema.shape.commands.shape.start.safeParse({
        argv: ['npm', 'run', 'dev'],
        ready: { kind: 'tcp', port: 5432 },
        ready_timeout: '30s',
      }).success,
    ).toBe(true);
    expect(
      AdlYmlSchema.shape.commands.shape.start.safeParse({ argv: ['npm', 'run', 'dev'] }).success,
    ).toBe(true);
  });
});

describe('ContextConfigSchema', () => {
  it('rejects a context file entry that is absolute or contains a parent-directory segment', () => {
    expect(ContextConfigSchema.safeParse({ files: ['/etc/passwd'] }).success).toBe(false);
    expect(ContextConfigSchema.safeParse({ files: ['../secrets.env'] }).success).toBe(false);
    expect(ContextConfigSchema.safeParse({ files: ['docs/README.md'] }).success).toBe(true);
  });

  it('validates max_bytes at its ceiling and fails one step above', () => {
    expect(ContextConfigSchema.safeParse({ max_bytes: 2_000_000 }).success).toBe(true);
    expect(ContextConfigSchema.safeParse({ max_bytes: 2_000_001 }).success).toBe(false);
  });

  it('defaults max_bytes and on_overflow when the block is present but empty', () => {
    const result = ContextConfigSchema.parse({});
    expect(result.max_bytes).toBe(200_000);
    expect(result.on_overflow).toBe('truncate');
  });

  it('accepts on_overflow: error as an explicit alternative to silent truncation', () => {
    expect(ContextConfigSchema.safeParse({ on_overflow: 'error' }).success).toBe(true);
    expect(ContextConfigSchema.safeParse({ on_overflow: 'ignore' }).success).toBe(false);
  });
});

describe('PipelineEntrySchema', () => {
  it('validates a bare string as a built-in stage', () => {
    expect(PipelineEntrySchema.safeParse('develop').success).toBe(true);
  });

  it('validates an object naming a harness, with an optional with block', () => {
    expect(PipelineEntrySchema.safeParse({ harness: 'security' }).success).toBe(true);
    expect(
      PipelineEntrySchema.safeParse({ harness: 'security', with: { level: 'strict' } }).success,
    ).toBe(true);
    expect(
      PipelineEntrySchema.safeParse({ harness: 'security', on_send_back: 'stop' }).success,
    ).toBe(true);
  });

  it('parses the group syntax and rejects it, naming it as a future capability', () => {
    const result = PipelineEntrySchema.safeParse({ group: [{ harness: 'security' }] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/future/i);
  });
});

describe('LimitsSchema', () => {
  it('validates max_rounds, budget_usd, and repeat_finding_threshold at their ceilings and fails one step above', () => {
    const ceiling = LimitsSchema.parse({});
    expect(LimitsSchema.safeParse({ max_rounds: 1 }).success).toBe(true);

    const cases: Array<[string, number, number]> = [
      ['max_rounds', 50, 51],
      ['budget_usd', 10_000, 10_000.01],
      ['repeat_finding_threshold', 20, 21],
    ];
    for (const [field, atCeiling, aboveCeiling] of cases) {
      expect(LimitsSchema.safeParse({ [field]: atCeiling }).success, `${field} at ceiling`).toBe(
        true,
      );
      expect(
        LimitsSchema.safeParse({ [field]: aboveCeiling }).success,
        `${field} above ceiling`,
      ).toBe(false);
    }
    expect(ceiling.max_rounds).toBeGreaterThan(0);
  });

  it('rejects zero and negative values', () => {
    expect(LimitsSchema.safeParse({ max_rounds: 0 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ budget_usd: -1 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ repeat_finding_threshold: 0 }).success).toBe(false);
  });
});

describe('parseAdlYml: strictness and structure', () => {
  it('rejects an unrecognised top-level key', () => {
    const source = fixture('valid-http-ready.yml') + '\nnot_a_real_key: true\n';
    const error = parseInvalid('invalid-unknown-key.yml'); // already covers top-level; this also sanity-checks a synthetic case
    expect(error).toBeInstanceOf(LoadError);
    expect(parseAdlYml(source)).toBeInstanceOf(LoadError);
  });
});

describe('AdlYmlSchema: self-documentation', () => {
  it('carries a non-empty description on every top-level field', () => {
    const missing: string[] = [];
    for (const [key, fieldSchema] of Object.entries(AdlYmlSchema.shape)) {
      const description = (fieldSchema as { description?: string }).description;
      if (!description || description.trim().length === 0) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('records the four promises in the module header', () => {
    for (const phrase of [
      'version: 1',
      'closed set of ADL-provided variables',
      'daemon-only',
      'never auto-detected',
    ]) {
      expect(MODULE_SOURCE, phrase).toContain(phrase);
    }
  });

  it('parses the worked example in its own module header', () => {
    const example = extractYamlExample(MODULE_SOURCE);
    const result = parseAdlYml(example);
    if (result instanceof LoadError) {
      throw new Error(`worked example in adl-yml.ts header failed to parse: ${result.message}`);
    }
    expect(result.version).toBe(1);
    expect(result.commands.start.ready?.kind).toBe('http');
  });
});
