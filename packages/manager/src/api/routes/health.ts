import type { Hono } from 'hono';

/**
 * `GET /health` — the ONE unauthenticated route (Task 1's checkpoint,
 * option-b). It returns ONLY a liveness status word and the schema version —
 * nothing feature-related, spend-related, repo-related, or token-related —
 * so an external supervisor (a systemd readiness probe, a container
 * healthcheck, a plain `curl` smoke test) can probe the daemon without
 * holding a credential that can also pause or kill every feature on the
 * host.
 */

export interface HealthRouteDeps {
  readonly schemaVersion: number;
}

export function registerHealthRoute(app: Hono, deps: HealthRouteDeps): void {
  app.get('/health', (c) =>
    c.json({ status: 'ok', schemaVersion: deps.schemaVersion }),
  );
}
