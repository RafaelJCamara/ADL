import { describe, expect, it } from 'vitest';
import {
  daemonStartCommand,
  type DaemonStartDeps,
} from '../../src/commands/daemon.js';
import { buildProgram, type CliConfig } from '../../src/index.js';

/**
 * `adl daemon start` (5.7) — `@adl/cli`'s own honest-gap default, and the
 * `startDaemon` injection seam `@adl/manager`'s real binary uses instead of
 * it. `@adl/cli` still structurally cannot resolve `@adl/manager` (D-21),
 * so nothing here ever boots a real daemon — that proof lives in
 * `packages/manager/test/boot/cli-entry.test.ts`.
 */

class CapturingSink {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function withExitCodeReset<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = original;
  }
}

function fixedConfig(): CliConfig {
  return { host: '127.0.0.1', port: 4173, token: 'test-token' };
}

describe('daemonStartCommand — the default', () => {
  it('reports the honest gap and exits non-zero, without throwing', async () => {
    const stderr = new CapturingSink();
    await withExitCodeReset(async () => {
      await daemonStartCommand({ stderr });
      expect(process.exitCode).toBe(1);
    });
    expect(stderr.text()).toContain('cannot boot the manager');
    expect(stderr.text()).toContain('@adl/manager');
  });
});

describe('adl daemon start — the injection seam', () => {
  it('falls back to daemonStartCommand when no startDaemon override is supplied', async () => {
    const stderr = new CapturingSink();
    const program = buildProgram({ loadConfig: fixedConfig, stderr });

    await withExitCodeReset(async () => {
      await program.parseAsync(['node', 'adl', 'daemon', 'start'], {
        from: 'node',
      });
      expect(process.exitCode).toBe(1);
    });
    expect(stderr.text()).toContain('cannot boot the manager');
  });

  it('calls the injected startDaemon with the raw --config value and stderr, never touching loadConfig', async () => {
    const stderr = new CapturingSink();
    const calls: DaemonStartDeps[] = [];
    const program = buildProgram({
      loadConfig: () => {
        throw new Error(
          'daemon start must never call loadConfig — @adl/cli has no daemon-config schema',
        );
      },
      stderr,
      startDaemon: async (deps) => {
        calls.push(deps);
      },
    });

    await program.parseAsync(
      ['node', 'adl', '--config', 'custom.json', 'daemon', 'start'],
      { from: 'node' },
    );

    expect(calls).toEqual([{ configPath: 'custom.json', stderr }]);
  });

  it('passes configPath: undefined when --config is not given', async () => {
    const calls: DaemonStartDeps[] = [];
    const program = buildProgram({
      loadConfig: fixedConfig,
      startDaemon: async (deps) => {
        calls.push(deps);
      },
    });

    await program.parseAsync(['node', 'adl', 'daemon', 'start'], {
      from: 'node',
    });

    expect(calls).toEqual([{ configPath: undefined, stderr: undefined }]);
  });
});
