import { describe, expect, it } from 'vitest';

import { DaemonConfigSchema } from '../../src/config/effective-config.js';

/**
 * Phase 3 Plan 06, Task 2: the daemon-only fields added to `DaemonConfigSchema`
 * in place — `lease_ttl_ms`, `heartbeat_interval_ms`, `worker_stop_grace_ms`,
 * `concurrency`, `api`, `gc`, `repos` — and the D-02 lease-timing rule.
 */

describe('DaemonConfigSchema — Phase 3 fields, defaults', () => {
  it('parses an empty object and resolves every documented default', () => {
    const result = DaemonConfigSchema.parse({});

    expect(result.concurrency.global).toBe(1);
    expect(result.concurrency.per_repo).toBeUndefined();
    expect(result.lease_ttl_ms).toBe(30_000);
    expect(result.heartbeat_interval_ms).toBe(10_000);
    expect(result.worker_stop_grace_ms).toBe(10_000);
    expect(result.api.host).toBe('127.0.0.1');
    expect(result.api.port).toBe(4173);
    expect(result.api.token).toBeUndefined();
    expect(result.gc.interval_ms).toBe(30 * 60 * 1000);
    expect(result.poll.interval_ms).toBe(60_000);
    expect(result.repos).toEqual([]);
  });

  it('concurrency.per_repo is absent by default and, when present, must be at least 1', () => {
    const withoutPerRepo = DaemonConfigSchema.parse({});
    expect(withoutPerRepo.concurrency.per_repo).toBeUndefined();

    const withPerRepo = DaemonConfigSchema.parse({
      concurrency: { per_repo: 2 },
    });
    expect(withPerRepo.concurrency.per_repo).toBe(2);

    const result = DaemonConfigSchema.safeParse({
      concurrency: { per_repo: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('concurrency.global of 0 fails validation', () => {
    const result = DaemonConfigSchema.safeParse({ concurrency: { global: 0 } });
    expect(result.success).toBe(false);
  });

  it('an unknown top-level key is rejected — the schema is a strictObject', () => {
    const result = DaemonConfigSchema.safeParse({
      totally_unknown_field: true,
    });
    expect(result.success).toBe(false);
  });

  it('api.host accepts a non-loopback value — the daemon warns, this schema does not reject', () => {
    const result = DaemonConfigSchema.parse({ api: { host: '0.0.0.0' } });
    expect(result.api.host).toBe('0.0.0.0');
  });
});

describe('DaemonConfigSchema — D-02 lease-timing rule (lease_ttl_ms >= 3x heartbeat_interval_ms)', () => {
  it('rejects lease_ttl_ms 100 with heartbeat_interval_ms 50, naming both fields', () => {
    const result = DaemonConfigSchema.safeParse({
      lease_ttl_ms: 100,
      heartbeat_interval_ms: 50,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join('; ');
      expect(message).toContain('lease_ttl_ms');
      expect(message).toContain('heartbeat_interval_ms');
    }
  });

  it('accepts lease_ttl_ms 150 with heartbeat_interval_ms 50 — the rule is at-least-3x, inclusive', () => {
    const result = DaemonConfigSchema.safeParse({
      lease_ttl_ms: 150,
      heartbeat_interval_ms: 50,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the documented defaults (30000 / 10000), which are exactly 3x', () => {
    const result = DaemonConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('DaemonConfigSchema — repos (D-35)', () => {
  it('parses a watched repo entry with features_dir defaulted', () => {
    const result = DaemonConfigSchema.parse({
      repos: [
        {
          id: 'my-repo',
          remote_url: 'git@github.com:example/my-repo.git',
          default_branch: 'main',
          forge: 'github',
        },
      ],
    });

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]?.features_dir).toBe('features');
  });

  it('rejects a repo entry missing a required field', () => {
    const result = DaemonConfigSchema.safeParse({
      repos: [{ id: 'my-repo' }],
    });
    expect(result.success).toBe(false);
  });
});
