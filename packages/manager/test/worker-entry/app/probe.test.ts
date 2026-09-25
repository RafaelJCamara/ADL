/**
 * All four readiness probe kinds (ROLE-07, M08 step 8.2).
 *
 * `ReadyProbeSchema` has declared four kinds since M01 with no implementation of
 * any of them, so "three probe kinds" was a real error in the step sketch and
 * this file is what keeps the correction honest — including the count itself,
 * asserted below against the union rather than against a number typed here.
 *
 * `http` and `tcp` run against **real listeners** rather than mocks: those two
 * cases are entirely about what a socket does, and a stubbed `fetch` would prove
 * that the switch statement dispatches and nothing about whether the probe can
 * tell a live server from a dead port. `log` and `exec` take injected readers,
 * which is the whole reason `ReadinessDeps` has them.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ReadyProbeSchema, type ReadyProbe } from '@adl/core/config';
import { awaitReady } from '../../../src/worker-entry/app/probe.js';

/** Deps for a case that needs neither the log reader nor the exec runner. */
function baseDeps(): {
  output: () => string;
  exited: () => boolean;
  execProbe: () => Promise<number | null>;
} {
  return {
    output: () => '',
    exited: () => false,
    execProbe: () =>
      Promise.reject(new Error('execProbe must not be called for this kind')),
  };
}

/** Start a real HTTP listener answering `status`, and return its port + closer. */
async function withHttp<T>(
  status: number,
  body: (port: number) => Promise<T>,
): Promise<T> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(status);
    response.end('ok');
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      );
    });
  });
  try {
    return await body(port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

/** A port nothing is listening on — allocated and immediately released. */
async function deadPort(): Promise<number> {
  const server = createTcpServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

describe('the probe contract covers every kind the schema declares', () => {
  it('has exactly four kinds, read off the schema rather than typed here', () => {
    // Anti-drift: a fifth kind added to `ReadyProbeSchema` fails this, which is
    // the signal that `attemptFor`'s exhaustive switch needs a case. The count
    // comes from the schema's own union so the assertion cannot go stale.
    const kinds = ReadyProbeSchema.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds.sort()).toEqual(['exec', 'http', 'log', 'tcp']);
  });
});

describe('http', () => {
  it('is satisfied by a real listener answering the expected status', async () => {
    await withHttp(200, async (port) => {
      const outcome = await awaitReady({
        ...baseDeps(),
        probe: {
          kind: 'http',
          url: `http://127.0.0.1:${String(port)}/`,
          expect: 200,
        },
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      expect(outcome.kind).toBe('ready');
    });
  });

  it('is satisfied by ANY response when no status was declared', async () => {
    // `HttpReadyProbeSchema.expect`'s own description: "Default: any response
    // counts as ready". A 503 from a server that is up is still a server that is
    // up, and an app whose health endpoint is not yet green is the gate's problem
    // rather than the lifecycle's.
    await withHttp(503, async (port) => {
      const outcome = await awaitReady({
        ...baseDeps(),
        probe: { kind: 'http', url: `http://127.0.0.1:${String(port)}/` },
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      expect(outcome.kind).toBe('ready');
    });
  });

  it('times out, and reports the LAST attempt rather than a generic message', async () => {
    await withHttp(404, async (port) => {
      const outcome = await awaitReady({
        ...baseDeps(),
        probe: {
          kind: 'http',
          url: `http://127.0.0.1:${String(port)}/`,
          expect: 200,
        },
        timeoutMs: 300,
        intervalMs: 10,
      });
      expect(outcome.kind).toBe('not-ready');
      // The detail a human reads has to be the reason it was still failing, not
      // "the probe was never attempted" — which is what a deadline checked at the
      // top of the loop would have produced.
      if (outcome.kind === 'not-ready') {
        expect(outcome.detail).toContain('answered 404');
        expect(outcome.detail).toContain('expected 200');
      }
    });
  }, 20_000);
});

describe('tcp', () => {
  it('is satisfied by anything accepting a connection', async () => {
    await withHttp(200, async (port) => {
      const outcome = await awaitReady({
        ...baseDeps(),
        probe: { kind: 'tcp', port },
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      expect(outcome.kind).toBe('ready');
    });
  });

  it('times out against a port nothing is listening on', async () => {
    const port = await deadPort();
    const outcome = await awaitReady({
      ...baseDeps(),
      probe: { kind: 'tcp', port },
      timeoutMs: 300,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('not-ready');
  }, 20_000);
});

describe('log', () => {
  it('matches a literal substring in the start command output', async () => {
    let text = 'booting…\n';
    const outcome = await awaitReady({
      ...baseDeps(),
      output: () => text,
      probe: { kind: 'log', pattern: 'listening on' },
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    // Satisfied only after the reader's answer changes — the point of injecting a
    // `() => string` rather than a snapshot.
    expect(outcome.kind).toBe('not-ready');

    text += 'listening on 4000\n';
    const second = await awaitReady({
      ...baseDeps(),
      output: () => text,
      probe: { kind: 'log', pattern: 'listening on' },
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(second.kind).toBe('ready');
  }, 20_000);

  it('treats the pattern as a literal, never as a regular expression', async () => {
    // `LogReadyProbeSchema` says "a literal substring". A pattern out of `adl.yml`
    // is repository-supplied input (D-22), and compiling one as a regex would hand
    // a watched repository a catastrophic-backtracking primitive pointed at the
    // daemon's own worker.
    const outcome = await awaitReady({
      ...baseDeps(),
      output: () => 'listening on 4000',
      probe: { kind: 'log', pattern: 'listening on .*' },
      timeoutMs: 200,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('not-ready');

    const literal = await awaitReady({
      ...baseDeps(),
      output: () => 'ready: a+b (c|d)',
      probe: { kind: 'log', pattern: 'a+b (c|d)' },
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(literal.kind).toBe('ready');
  }, 20_000);
});

describe('exec', () => {
  it('is satisfied by exit 0 and retried on anything else', async () => {
    let attempts = 0;
    const outcome = await awaitReady({
      ...baseDeps(),
      probe: { kind: 'exec', argv: ['pg_isready'] },
      execProbe: () => {
        attempts += 1;
        return Promise.resolve(attempts < 3 ? 1 : 0);
      },
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('ready');
    expect(attempts).toBe(3);
  });

  it('reports a killed probe distinguishably from a failing one', async () => {
    const outcome = await awaitReady({
      ...baseDeps(),
      probe: { kind: 'exec', argv: ['pg_isready'] },
      execProbe: () => Promise.resolve(null),
      timeoutMs: 200,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('not-ready');
    if (outcome.kind === 'not-ready') {
      expect(outcome.detail).toContain('without an exit code');
    }
  }, 20_000);
});

describe('an app that dies is not an app that is slow', () => {
  it('reports app-exited rather than waiting out the timeout', async () => {
    // M08's audit finding 6 in test form: collapsing these two into "not ready"
    // is the single mapping that cannot serve three causes. An app that exited is
    // very likely the developer's code crashing on boot; a probe that has not
    // been satisfied yet is a timeout.
    const started = Date.now();
    const probe: ReadyProbe = { kind: 'log', pattern: 'never' };
    const outcome = await awaitReady({
      ...baseDeps(),
      probe,
      exited: () => true,
      timeoutMs: 30_000,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('app-exited');
    // And it did not sit out the 30s budget first, which is what makes the
    // distinction useful rather than merely present.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('checks for exit BEFORE the first attempt', async () => {
    // `commands.start: { argv: ['true'] }` — every pre-M08 fixture — exits
    // instantly. An exit check only between attempts would probe it for the full
    // timeout before noticing.
    let attempts = 0;
    const outcome = await awaitReady({
      ...baseDeps(),
      probe: { kind: 'exec', argv: ['true'] },
      exited: () => true,
      execProbe: () => {
        attempts += 1;
        return Promise.resolve(1);
      },
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(outcome.kind).toBe('app-exited');
    expect(attempts).toBe(0);
  });
});
