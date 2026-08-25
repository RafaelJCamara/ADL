import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PINNED_CLAUDE_CODE_VERSION } from '@adl/agent-claude-code';
import {
  createProductionDaemonStartRunner,
  type DaemonStartRunnerDeps,
} from '../../src/boot/cli-entry.js';
import {
  BackendUnavailableError,
  claudeVersionCheckRunner,
} from '../../src/boot/backend-preflight.js';
import { SchemaVersionRefusalError } from '../../src/boot/startup.js';
import {
  ADL_YML_PATH,
  AdlYmlUnavailableError,
} from '../../src/config/resolve-adl-yml.js';
import type { DaemonHandle, StartDaemonOptions } from '../../src/daemon.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';

/**
 * `createProductionDaemonStartRunner` (5.7) — the real production
 * `DaemonStartRunner` `@adl/manager`'s `bin.ts` injects into `@adl/cli`'s
 * `buildProgram`. Two kinds of coverage:
 *
 * - The mapping/refusal logic below, against a FAKE `startDaemonFn` — every
 *   `.adl/daemon.json` field lands in the right `StartDaemonOptions` field,
 *   and every one of `startDaemon`'s three named refusals is reported
 *   cleanly rather than thrown.
 * - `real startDaemon()` (5.7's own tracer, at the bottom): a real config
 *   file, a real repository, a scripted `claude --version` double standing
 *   in for the pinned CLI, proving the WHOLE chain — config load through a
 *   real backend preflight PASS through a real, HTTP-reachable daemon.
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

function fakeHandle(overrides: Partial<DaemonHandle> = {}): DaemonHandle {
  return {
    host: '127.0.0.1',
    port: 4173,
    supervisor: {} as DaemonHandle['supervisor'],
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createProductionDaemonStartRunner — mapping and refusals', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adl-cli-entry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('an invalid daemon config is reported to stderr, exits non-zero, and never reaches startDaemonFn', async () => {
    await writeFile(join(dir, 'daemon.json'), '{ not valid json', 'utf8');
    const stderr = new CapturingSink();
    const startDaemonFn = vi.fn();
    const original = process.exitCode;

    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn,
    });

    try {
      await runner({
        configPath: join(dir, 'daemon.json'),
        stderr,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = original;
    }

    expect(startDaemonFn).not.toHaveBeenCalled();
    expect(stderr.text()).toContain('invalid daemon config');
  });

  it('a fresh install mints a daemon config and maps it into StartDaemonOptions with the documented defaults', async () => {
    let captured: StartDaemonOptions | undefined;
    const startDaemonFn = vi.fn(async (options: StartDaemonOptions) => {
      captured = options;
      return fakeHandle();
    });

    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      env: { PATH: '/fake/path' },
      startDaemonFn,
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(startDaemonFn).toHaveBeenCalledTimes(1);
    expect(captured?.dbFilePath).toBe(join(dir, '.adl', 'adl.db'));
    expect(captured?.mainRepo).toBe(dir);
    expect(captured?.scratchRoot).toBe(join(dir, '.adl', 'scratch'));
    expect(captured?.host).toBe('127.0.0.1');
    expect(captured?.port).toBe(4173);
    expect(captured?.leaseTtlMs).toBe(30_000);
    expect(captured?.heartbeatIntervalMs).toBe(10_000);
    expect(typeof captured?.apiToken).toBe('string');
    expect(captured?.apiToken.length).toBeGreaterThan(0);
    expect(captured?.agentBackendVersionCheck).toBeDefined();

    // Zero-config first run (packages/manager/README.md): the file now exists,
    // carries the minted token, and that token is what was passed through.
    const written = JSON.parse(
      await readFile(join(dir, '.adl', 'daemon.json'), 'utf8'),
    ) as { api: { token: string } };
    expect(written.api.token).toBe(captured?.apiToken);
  });

  it('an existing config with an explicit host/port/token is passed through unchanged', async () => {
    await mkdir(join(dir, '.adl'), { recursive: true });
    await writeFile(
      join(dir, '.adl', 'daemon.json'),
      JSON.stringify({
        api: { host: '0.0.0.0', port: 9999, token: 'existing-token' },
        lease_ttl_ms: 60_000,
        heartbeat_interval_ms: 15_000,
      }),
      'utf8',
    );
    let captured: StartDaemonOptions | undefined;
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn: async (options) => {
        captured = options;
        return fakeHandle();
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(captured?.host).toBe('0.0.0.0');
    expect(captured?.port).toBe(9999);
    expect(captured?.apiToken).toBe('existing-token');
    expect(captured?.leaseTtlMs).toBe(60_000);
    expect(captured?.heartbeatIntervalMs).toBe(15_000);
  });

  it('an existing config missing api.token mints one in memory for this boot only, and warns', async () => {
    await mkdir(join(dir, '.adl'), { recursive: true });
    await writeFile(
      join(dir, '.adl', 'daemon.json'),
      JSON.stringify({ gc: { interval_ms: 1_800_000 } }),
      'utf8',
    );
    const { logger, logs } = createCapturingLogger();
    let captured: StartDaemonOptions | undefined;
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      logger,
      startDaemonFn: async (options) => {
        captured = options;
        return fakeHandle();
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(captured?.apiToken).toBeDefined();
    expect(
      logs.some((l) => l.msg?.includes('minted one for this boot only')),
    ).toBe(true);

    // Never persisted back — the file on disk still carries no token.
    const written = JSON.parse(
      await readFile(join(dir, '.adl', 'daemon.json'), 'utf8'),
    ) as { api?: { token?: string } };
    expect(written.api?.token).toBeUndefined();
  });

  it('with no repos[0].github_app configured, forge is absent — matching the "no live GitHub App credentials yet" default (DEBT.md item 1.7)', async () => {
    let captured: StartDaemonOptions | undefined;
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn: async (options) => {
        captured = options;
        return fakeHandle();
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(captured?.forge).toBeUndefined();
  });

  it('a repos[0].github_app block with a real GitHub remote_url builds a real forge option (M05 step 5.10)', async () => {
    await mkdir(join(dir, '.adl'), { recursive: true });
    await writeFile(
      join(dir, '.adl', 'daemon.json'),
      JSON.stringify({
        repos: [
          {
            id: 'main',
            remote_url: 'https://github.com/adl-org/adl-demo.git',
            default_branch: 'main',
            forge: 'github',
            github_app: {
              app_id: 12345,
              private_key: 'not-a-real-key-just-config-plumbing',
              installation_id: 67890,
            },
          },
        ],
      }),
      'utf8',
    );
    let captured: StartDaemonOptions | undefined;
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn: async (options) => {
        captured = options;
        return fakeHandle();
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(captured?.forge).toBeDefined();
    expect(captured?.forge?.adapter.id).toBe('github');
    expect(captured?.forge?.repo).toEqual({
      owner: 'adl-org',
      repo: 'adl-demo',
    });
    expect(typeof captured?.forge?.pushCredential).toBe('function');
  });

  it('a github_app block whose remote_url does not parse as GitHub logs a warning and leaves forge absent, without refusing to start', async () => {
    await mkdir(join(dir, '.adl'), { recursive: true });
    await writeFile(
      join(dir, '.adl', 'daemon.json'),
      JSON.stringify({
        repos: [
          {
            id: 'main',
            remote_url: 'https://gitlab.com/adl-org/adl-demo.git',
            default_branch: 'main',
            forge: 'github',
            github_app: {
              app_id: 12345,
              private_key: 'not-a-real-key-just-config-plumbing',
              installation_id: 67890,
            },
          },
        ],
      }),
      'utf8',
    );
    const { logger, logs } = createCapturingLogger();
    let captured: StartDaemonOptions | undefined;
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      logger,
      startDaemonFn: async (options) => {
        captured = options;
        return fakeHandle();
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    expect(captured?.forge).toBeUndefined();
    expect(
      logs.some((l) =>
        l.msg?.includes('does not parse as a GitHub repository'),
      ),
    ).toBe(true);
  });

  it.each([
    [
      'SchemaVersionRefusalError',
      () =>
        new SchemaVersionRefusalError({
          reason: 'newer-schema',
          storedVersion: 99,
          daemonVersion: 1,
          message: 'schema refused',
        }),
    ],
    [
      'AdlYmlUnavailableError',
      () =>
        new AdlYmlUnavailableError({
          reason: 'unreadable',
          path: ADL_YML_PATH,
          message: 'adl.yml refused',
        }),
    ],
    [
      'BackendUnavailableError',
      () =>
        new BackendUnavailableError({
          reason: 'no-backend-configured',
          backendId: 'claude-code',
          message: 'backend refused',
        }),
    ],
  ] as const)(
    '%s from startDaemonFn is reported to stderr and exits non-zero, never thrown',
    async (_name, buildError) => {
      const stderr = new CapturingSink();
      const original = process.exitCode;
      const runner = createProductionDaemonStartRunner({
        cwd: () => dir,
        startDaemonFn: async () => {
          throw buildError();
        },
        buildAgentBackendVersionCheck: () => async () => ({
          stdout: '',
          exitCode: 0,
        }),
      });

      try {
        await runner({ stderr });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = original;
      }
      expect(stderr.text().length).toBeGreaterThan(0);
    },
  );

  it('an unrecognised error from startDaemonFn propagates rather than being swallowed', async () => {
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn: async () => {
        throw new Error('boom — a genuine bug, not a refusal');
      },
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await expect(runner({ stderr: new CapturingSink() })).rejects.toThrow(
      'boom',
    );
  });

  it('calls onStarted with the real handle, and SIGINT triggers handle.stop()', async () => {
    const handle = fakeHandle();
    const deps: DaemonStartRunnerDeps = {
      cwd: () => dir,
      startDaemonFn: async () => handle,
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    };
    const started: DaemonHandle[] = [];
    const runner = createProductionDaemonStartRunner({
      ...deps,
      onStarted: (h) => started.push(h),
    });

    await runner({ stderr: new CapturingSink() });
    expect(started).toEqual([handle]);
    expect(handle.stop).not.toHaveBeenCalled();

    process.emit('SIGINT');
    // `handle.stop()` is invoked synchronously off the signal handler, not awaited by it.
    await Promise.resolve();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it('SIGINT followed by SIGTERM calls handle.stop() exactly once, and a rejecting second stop never crashes as an unhandled rejection', async () => {
    // A code-review finding on this step: `process.once` only deregisters
    // the listener for the event it fired on, so SIGTERM's own listener is
    // still live after SIGINT already triggered shutdown — and
    // `gracefulShutdown` is not idempotent (a second `server.close()`
    // rejects). Without the `stopping` guard, this test's second
    // `handle.stop()` call would reject unhandled and crash the process.
    let calls = 0;
    const handle = fakeHandle({
      stop: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error('already stopped');
      }),
    });
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      startDaemonFn: async () => handle,
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    process.emit('SIGINT');
    process.emit('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it('a handle.stop() that rejects (e.g. a stop already in flight over HTTP) is caught and logged, never an unhandled rejection', async () => {
    const handle = fakeHandle({
      stop: vi.fn(async () => {
        throw new Error('ERR_SERVER_NOT_RUNNING');
      }),
    });
    const { logger, logs } = createCapturingLogger();
    const runner = createProductionDaemonStartRunner({
      cwd: () => dir,
      logger,
      startDaemonFn: async () => handle,
      buildAgentBackendVersionCheck: () => async () => ({
        stdout: '',
        exitCode: 0,
      }),
    });

    await runner({ stderr: new CapturingSink() });

    process.emit('SIGTERM');
    // Two ticks: one for `handle.stop()`'s own microtask, one for the
    // `.catch()` handler that runs after it rejects.
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(
      logs.some((l) => l.msg?.includes('shutdown reported an error')),
    ).toBe(true);
  });
});

/** A free ephemeral port, released immediately — `ApiTcpPortSchema` rejects `0` (min 1), so a config file cannot ask for OS-assignment the way `StartDaemonOptions.port` can. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('createProductionDaemonStartRunner — real startDaemon (5.7 tracer)', () => {
  const FAKE_CLAUDE_VERSION = fileURLToPath(
    new URL('../helpers/fake-claude-version.mjs', import.meta.url),
  );

  it('a real config file drives a real backend-preflight pass and a real, HTTP-reachable daemon', async () => {
    await withTempRepo(async ({ mainRepo, git }) => {
      await mkdir(join(mainRepo, 'features'), { recursive: true });
      await writeFile(
        join(mainRepo, 'adl.yml'),
        [
          'version: 1',
          'commands:',
          '  build: { argv: ["true"] }',
          '  start: { argv: ["true"] }',
          '  test: { argv: ["true"] }',
          '  teardown: { argv: ["true"] }',
          'pipeline: [develop]',
          '',
        ].join('\n'),
        'utf8',
      );
      await git.add(['adl.yml']);
      await git.raw(['commit', '-m', 'add adl.yml']);

      // A real free port, not the schema-rejected `0` — avoids colliding
      // with a real daemon that might already be running on this machine's
      // default 4173. Written by hand rather than relying on
      // `ensureDaemonConfig`'s own first-run mint — that path is already
      // covered above.
      const port = await freePort();
      await mkdir(join(mainRepo, '.adl'), { recursive: true });
      await writeFile(
        join(mainRepo, '.adl', 'daemon.json'),
        JSON.stringify({ api: { port, token: 'tracer-token' } }),
        'utf8',
      );

      let handle: DaemonHandle | undefined;
      const runner = createProductionDaemonStartRunner({
        cwd: () => mainRepo,
        buildAgentBackendVersionCheck: (deps) =>
          claudeVersionCheckRunner({
            ...deps,
            binary: ['node', FAKE_CLAUDE_VERSION, PINNED_CLAUDE_CODE_VERSION],
          }),
        onStarted: (h) => {
          handle = h;
        },
      });

      const stderr = new CapturingSink();
      try {
        await runner({ stderr });
        expect(stderr.text()).toBe('');
        expect(handle).toBeDefined();

        const response = await fetch(`http://127.0.0.1:${handle?.port}/health`);
        expect(response.status).toBe(200);
      } finally {
        await handle?.stop();
        // On Windows, better-sqlite3's file handle can lag a beat behind
        // `db.destroy()` releasing its OS-level lock — `withTempRepo`'s own
        // cleanup (a bare `rm`, no retry) hits a transient EBUSY on
        // `.adl/adl.db-shm` without this. `maxRetries`/`retryDelay` are
        // `fs.rm`'s own documented answer to exactly this race; harmless,
        // and a no-op, on POSIX.
        await rm(join(mainRepo, '.adl'), {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
      }
    });
  }, 30_000);
});
