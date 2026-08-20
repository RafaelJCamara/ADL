import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonConfigSchema } from '@adl/core/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DaemonConfigError,
  DaemonConfigSchema as ManagerDaemonConfigSchema,
  DEFAULT_DAEMON_CONFIG_PATH,
  ensureDaemonConfig,
  loadDaemonConfig,
  mintApiToken,
  resolveDaemonConfigPath,
} from '../../src/config/daemon-config.js';
import { posixOnly } from '../helpers/platform.js';

describe('resolveDaemonConfigPath / DEFAULT_DAEMON_CONFIG_PATH', () => {
  it('defaults to .adl/daemon.json', () => {
    expect(DEFAULT_DAEMON_CONFIG_PATH).toBe('.adl/daemon.json');
    expect(resolveDaemonConfigPath()).toBe('.adl/daemon.json');
  });

  it('an explicit path wins over the default', () => {
    expect(resolveDaemonConfigPath('/custom/path.json')).toBe(
      '/custom/path.json',
    );
  });
});

describe('the schema this module parses with', () => {
  it('is reference-identical to DaemonConfigSchema imported from @adl/core/config — no second schema exists here', () => {
    expect(ManagerDaemonConfigSchema).toBe(DaemonConfigSchema);
  });
});

describe('loadDaemonConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adl-daemon-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('against a nonexistent path returns the not-found variant, never throws', async () => {
    const path = join(dir, 'missing.json');
    const result = await loadDaemonConfig(path);
    expect(result.kind).toBe('not-found');
  });

  it('against malformed JSON returns the invalid variant carrying the parser message', async () => {
    const path = join(dir, 'malformed.json');
    await writeFile(path, '{ not valid json', 'utf8');

    const result = await loadDaemonConfig(path);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('against JSON that fails schema validation returns the invalid variant naming the field', async () => {
    const path = join(dir, 'bad-schema.json');
    await writeFile(
      path,
      JSON.stringify({ concurrency: { global: 0 } }),
      'utf8',
    );

    const result = await loadDaemonConfig(path);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.issues?.some((i) => i.path.includes('concurrency'))).toBe(
        true,
      );
    }
  });

  it('against a valid, minimal JSON file returns the loaded variant with schema defaults applied', async () => {
    const path = join(dir, 'valid.json');
    await writeFile(path, JSON.stringify({ api: { token: 'abc123' } }), 'utf8');

    const result = await loadDaemonConfig(path);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.config.api.token).toBe('abc123');
      expect(result.config.concurrency.global).toBe(1);
      expect(result.config.lease_ttl_ms).toBe(30_000);
    }
  });
});

describe('mintApiToken', () => {
  it('produces a 64-char hex string (32 random bytes)', () => {
    const token = mintApiToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two calls never collide', () => {
    expect(mintApiToken()).not.toBe(mintApiToken());
  });
});

describe('ensureDaemonConfig — zero-config first run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adl-daemon-config-ensure-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mints a token and writes the file when it does not exist yet', async () => {
    const path = join(dir, '.adl', 'daemon.json');

    const result = await ensureDaemonConfig(path);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.config.api.token).toMatch(/^[0-9a-f]{64}$/);
    }

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
      api?: { token?: string };
    };
    expect(onDisk.api?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never regenerates a token for an already-existing file', async () => {
    const path = join(dir, 'daemon.json');

    const first = await ensureDaemonConfig(path);
    expect(first.kind).toBe('loaded');
    const firstToken =
      first.kind === 'loaded' ? first.config.api.token : undefined;

    const second = await ensureDaemonConfig(path);
    expect(second.kind).toBe('loaded');
    const secondToken =
      second.kind === 'loaded' ? second.config.api.token : undefined;

    expect(secondToken).toBe(firstToken);
  });

  it('writes the config file owner-only (0o600) — it holds a bearer credential (T-3-04)', async () => {
    const gate = posixOnly(
      'POSIX file-mode bits have no Windows equivalent; the owner-only permission ' +
        'guarantee is verified on POSIX only',
      'T-3-04',
    );
    if (gate.kind === 'skip') return;

    const path = join(dir, '.adl', 'daemon.json');
    await ensureDaemonConfig(path);

    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(join(dir, '.adl'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

describe('DaemonConfigError', () => {
  it('carries the not-found/invalid result and a readable message', () => {
    const error = new DaemonConfigError({ kind: 'not-found', path: '/x' });
    expect(error).toBeInstanceOf(Error);
    expect(error.result.kind).toBe('not-found');
    expect(error.message).toContain('/x');
  });
});
