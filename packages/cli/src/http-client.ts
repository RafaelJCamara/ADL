/**
 * `@adl/cli`'s HTTP client — the ONLY way this package reaches the manager
 * (D-18, D-21). Wraps `fetch` with the base URL and the `Authorization:
 * Bearer` header; never reaches past HTTP into `@adl/db` or `@adl/manager`
 * internals, which pnpm's strict `node_modules` makes a resolve-time failure
 * rather than a review finding — this package lists neither in its
 * `package.json`.
 */

/** D-25's exact daemon-down message, with the real host and port interpolated. */
export function daemonDownMessage(host: string, port: number): string {
  return `Cannot reach the ADL daemon at ${host}:${port}. Is it running? Try: adl daemon start`;
}

/** Thrown when the daemon cannot be reached at all — connection refused, DNS failure, etc. */
export class DaemonUnreachableError extends Error {
  readonly host: string;
  readonly port: number;

  constructor(host: string, port: number) {
    super(daemonDownMessage(host, port));
    this.name = 'DaemonUnreachableError';
    this.host = host;
    this.port = port;
  }
}

export interface DaemonClientConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface DaemonClient {
  /** `GET /features` — the raw JSON array the manager returns. */
  getFeatures(): Promise<readonly unknown[]>;
}

/**
 * `daemonClient(config)` — a thin `fetch` wrapper. Never auto-starts the
 * daemon on a connection failure: a read-only status command with a
 * process-spawning side effect is surprising and hard to undo (D-25).
 */
export function daemonClient(config: DaemonClientConfig): DaemonClient {
  const baseUrl = `http://${config.host}:${config.port}`;

  async function request(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
    } catch {
      throw new DaemonUnreachableError(config.host, config.port);
    }
    return response;
  }

  return {
    async getFeatures() {
      const response = await request('/features');
      if (!response.ok) {
        throw new Error(`GET /features failed with status ${response.status}`);
      }
      return (await response.json()) as readonly unknown[];
    },
  };
}
