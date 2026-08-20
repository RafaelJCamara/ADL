import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ControlResult, DaemonClient } from '../src/http-client.js';
import { buildProgram, type CliConfig } from '../src/index.js';

/**
 * Phase 3 Plan 08, Task 2: the control verbs — scoping, the blast-radius
 * confirmation, and `adl daemon` (D-20, D-26, D-27..29).
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

/** A `DaemonClient` whose calls are recorded, so a test can assert what was — or was not — posted. */
function recordingClient(): DaemonClient & { readonly calls: string[] } {
  const calls: string[] = [];
  const result: ControlResult = { affected: ['feature-1'] };
  return {
    calls,
    getFeatures: async () => [],
    postFeatureControl: async (featureId, verb) => {
      calls.push(`feature:${verb}:${featureId}`);
      return result;
    },
    postControl: async (verb, scope, repoId) => {
      calls.push(`control:${verb}:${scope}:${repoId ?? ''}`);
      return result;
    },
    postGc: async () => {
      calls.push('gc');
      return {
        worktreesRemoved: ['feature-a'],
        scratchHomesRemoved: ['/tmp/scratch-1'],
        worktreeFailures: [],
        scratchHomeFailures: [],
      };
    },
    postShutdown: async () => {
      calls.push('shutdown');
    },
  };
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

describe('adl --help', () => {
  it('lists status, pause, resume, kill, gc, and daemon', () => {
    const program = buildProgram({ loadConfig: fixedConfig });
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining([
        'status',
        'pause',
        'resume',
        'kill',
        'gc',
        'daemon',
      ]),
    );
  });
});

describe('adl kill --all', () => {
  it('non-interactively without --yes refuses, exits non-zero, and posts nothing', async () => {
    const client = recordingClient();
    const program = buildProgram({
      loadConfig: fixedConfig,
      isInteractive: () => false,
      createClient: () => client,
    });

    await withExitCodeReset(async () => {
      await program.parseAsync(['node', 'adl', 'kill', '--all'], {
        from: 'node',
      });
      expect(process.exitCode).not.toBe(0);
    });

    expect(client.calls).toEqual([]);
  });

  it('--all --yes non-interactively posts to the global-scope route', async () => {
    const client = recordingClient();
    const program = buildProgram({
      loadConfig: fixedConfig,
      isInteractive: () => false,
      createClient: () => client,
    });

    await program.parseAsync(['node', 'adl', 'kill', '--all', '--yes'], {
      from: 'node',
    });

    expect(client.calls).toEqual(['control:kill:all:']);
  });

  it('interactively with a declining answer posts nothing and exits 0', async () => {
    const client = recordingClient();
    const input = Readable.from(['n\n']);
    const output = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const program = buildProgram({
      loadConfig: fixedConfig,
      isInteractive: () => true,
      confirmInput: input,
      confirmOutput: output,
      createClient: () => client,
    });

    await withExitCodeReset(async () => {
      await program.parseAsync(['node', 'adl', 'kill', '--all'], {
        from: 'node',
      });
      expect(process.exitCode ?? 0).toBe(0);
    });

    expect(client.calls).toEqual([]);
  });

  it('interactively with an affirmative answer posts and reports the affected feature ids', async () => {
    const client = recordingClient();
    const input = Readable.from(['y\n']);
    const output = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const stdout = new CapturingSink();
    const program = buildProgram({
      loadConfig: fixedConfig,
      stdout,
      isInteractive: () => true,
      confirmInput: input,
      confirmOutput: output,
      createClient: () => client,
    });

    await program.parseAsync(['node', 'adl', 'kill', '--all'], {
      from: 'node',
    });

    expect(client.calls).toEqual(['control:kill:all:']);
    expect(stdout.text()).toContain('feature-1');
  });

  it('a positional feature id combined with --all is a usage error and posts nothing', async () => {
    const client = recordingClient();
    const stderr = new CapturingSink();
    const program = buildProgram({
      loadConfig: fixedConfig,
      stderr,
      createClient: () => client,
    });

    await withExitCodeReset(async () => {
      await program.parseAsync(
        ['node', 'adl', 'kill', 'some-feature-id', '--all'],
        { from: 'node' },
      );
      expect(process.exitCode).not.toBe(0);
    });

    expect(client.calls).toEqual([]);
    expect(stderr.text()).toContain('mutually exclusive');
  });
});

describe('adl pause --repo', () => {
  it('posts the repo scope', async () => {
    const client = recordingClient();
    const program = buildProgram({
      loadConfig: fixedConfig,
      createClient: () => client,
    });

    await program.parseAsync(['node', 'adl', 'pause', '--repo', 'repo-9'], {
      from: 'node',
    });

    expect(client.calls).toEqual(['control:pause:repo:repo-9']);
  });
});

describe('adl gc', () => {
  it('prints the reclaimed counts', async () => {
    const client = recordingClient();
    const stdout = new CapturingSink();
    const program = buildProgram({
      loadConfig: fixedConfig,
      stdout,
      createClient: () => client,
    });

    await program.parseAsync(['node', 'adl', 'gc'], { from: 'node' });

    expect(client.calls).toEqual(['gc']);
    expect(stdout.text()).toContain('1');
  });
});

describe('every verb against a stopped daemon', () => {
  const host = '127.0.0.1';
  const port = 1; // guaranteed connection refusal, nothing bound

  async function run(args: string[]): Promise<{ stderr: string }> {
    const stderr = new CapturingSink();
    const program = buildProgram({
      loadConfig: () => ({ host, port, token: 't' }),
      stderr,
      isInteractive: () => false,
    });

    await withExitCodeReset(async () => {
      await program.parseAsync(['node', 'adl', ...args], { from: 'node' });
      expect(process.exitCode).toBe(1);
    });

    return { stderr: stderr.text() };
  }

  it.each([
    ['status'],
    ['pause', '--repo', 'r1'],
    ['resume', '--repo', 'r1'],
    ['kill', '--repo', 'r1'],
    ['gc'],
    ['daemon', 'stop'],
  ])('adl %s exits 1 with the D-25 message', async (...args) => {
    const { stderr } = await run(args);
    expect(stderr).toContain('Is it running? Try: adl daemon start');
  });
});
