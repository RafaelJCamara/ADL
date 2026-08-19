import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { forkWorker, WORKER_ENV_ALLOWLIST } from '../../src/exec/fork.js';

/**
 * `forkWorker` behaviour: the live IPC channel, the piped stdio, the
 * constructed (not inherited) environment, and the pid — the six behaviours
 * `03-03-PLAN.md`'s `<behavior>` list names for Task 1.
 *
 * The environment case is the load-bearing one (WORK-06): a variable set in
 * THIS process and never named on `options.env` must not reach the child.
 * `echo-worker.js` reports its own `process.env` back over the same IPC
 * channel the round-trip test proves is live, so absence is measured on the
 * receiving end — the same "trust what the OS handed the child, not what the
 * builder returned" discipline `env.ts`'s own test suite follows.
 */

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'echo-worker.js');
const MISSING_ENTRY = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'does-not-exist-9f21.js',
);

/** Set in this very process and never named on a fork's `options.env`. */
const PARENT_ONLY_VAR = 'ADL_FORK_UNIT_PARENT_ONLY_9C31';
const PARENT_ONLY_VALUE = 'must-not-cross-into-the-worker-4e02';

interface EchoReply {
  readonly echo: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function firstChunk(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    stream.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    stream.once('error', reject);
  });
}

afterEach(() => {
  delete process.env[PARENT_ONLY_VAR];
});

describe('forkWorker', () => {
  it('opens a live IPC channel: a sent message reaches the child and its reply reaches a parent listener', async () => {
    const worker = forkWorker(FIXTURE, { cwd: process.cwd() });
    try {
      expect(typeof worker.child.send).toBe('function');

      const reply = await new Promise<EchoReply>((resolve) => {
        worker.child.once('message', (message) => {
          resolve(message as EchoReply);
        });
        worker.child.send?.({ hello: 'worker' });
      });

      expect(reply.echo).toMatchObject({ hello: 'worker' });
    } finally {
      worker.child.kill();
    }
  });

  it("pipes stdout and stderr to the caller rather than inheriting the daemon's own streams", async () => {
    const worker = forkWorker(FIXTURE, { cwd: process.cwd() });
    try {
      const [stdoutLine, stderrLine] = await Promise.all([
        firstChunk(worker.stdout),
        firstChunk(worker.stderr),
      ]);

      expect(stdoutLine).toContain('echo-worker: started');
      expect(stderrLine).toContain('echo-worker: started (stderr)');
    } finally {
      worker.child.kill();
    }
  });

  it("exposes the child's pid", () => {
    const worker = forkWorker(FIXTURE, { cwd: process.cwd() });
    try {
      expect(typeof worker.pid).toBe('number');
      expect(worker.pid).toBe(worker.child.pid);
    } finally {
      worker.child.kill();
    }
  });

  it('constructs the child environment from the allowlist plus options.env — a parent-only variable never crosses', async () => {
    process.env[PARENT_ONLY_VAR] = PARENT_ONLY_VALUE;

    const worker = forkWorker(FIXTURE, { cwd: process.cwd() });
    try {
      const reply = await new Promise<EchoReply>((resolve) => {
        worker.child.once('message', (message) => {
          resolve(message as EchoReply);
        });
        worker.child.send?.({ ping: true });
      });

      // D-10-shaped assertion, restated for the fork boundary: a variable
      // live in THIS process while the fork runs, and never named on
      // options.env, must be absent from the child's reported environment.
      expect(reply.env[PARENT_ONLY_VAR]).toBeUndefined();
      expect(Object.values(reply.env)).not.toContain(PARENT_ONLY_VALUE);

      // POSITIVE half of the same proof: the allowlist itself DID cross, so
      // the absence above is deliberate exclusion, not a broken IPC channel
      // reporting nothing at all.
      for (const name of WORKER_ENV_ALLOWLIST) {
        const parentValue = process.env[name];
        if (parentValue !== undefined) {
          expect(reply.env[name]).toBe(parentValue);
        }
      }
    } finally {
      worker.child.kill();
    }
  });

  it('carries an explicit options.env entry through to the child', async () => {
    const worker = forkWorker(FIXTURE, {
      cwd: process.cwd(),
      env: { ADL_FORK_UNIT_EXPLICIT: 'explicit-sentinel-7a1e' },
    });
    try {
      const reply = await new Promise<EchoReply>((resolve) => {
        worker.child.once('message', (message) => {
          resolve(message as EchoReply);
        });
        worker.child.send?.({ ping: true });
      });

      expect(reply.env.ADL_FORK_UNIT_EXPLICIT).toBe('explicit-sentinel-7a1e');
    } finally {
      worker.child.kill();
    }
  });

  it('rejects or emits an error carrying the path when the entry module does not exist', async () => {
    const worker = forkWorker(MISSING_ENTRY, { cwd: process.cwd() });
    try {
      const error = await new Promise<Error>((resolve) => {
        worker.child.once('error', resolve);
      });

      expect(error.message).toContain(MISSING_ENTRY);
    } finally {
      worker.child.kill();
    }
  });
});
