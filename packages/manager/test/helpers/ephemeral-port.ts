import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

/**
 * Start `app` on port `0` (OS-assigned) and read the assigned port and bound
 * address back from the `http.Server` handle `serve()` returns — a fixed
 * test port is a CI flake waiting for a parallel file.
 */

export interface EphemeralServerContext {
  readonly port: number;
  readonly address: string;
  readonly server: ServerType;
}

export interface EphemeralPortOptions {
  /** Default: `127.0.0.1` — the loopback bind this whole API is built on (D-19). */
  readonly hostname?: string;
}

export async function withEphemeralPort<T>(
  app: Hono,
  fn: (ctx: EphemeralServerContext) => Promise<T>,
  options: EphemeralPortOptions = {},
): Promise<T> {
  const hostname = options.hostname ?? '127.0.0.1';

  const server = await new Promise<ServerType>((resolve) => {
    const instance = serve({ fetch: app.fetch, hostname, port: 0 }, () =>
      resolve(instance),
    );
  });

  const info = server.address();
  const port = typeof info === 'object' && info !== null ? info.port : 0;
  const address =
    typeof info === 'object' && info !== null ? info.address : hostname;

  try {
    return await fn({ port, address, server });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
