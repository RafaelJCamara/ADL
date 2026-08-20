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

/** `@adl/manager`'s `ControlResultSchema`, restated (D-18) — the affected feature ids. */
export interface ControlResult {
  readonly affected: readonly string[];
}

/** The three blast radii D-29 defines. `'feature'` is never sent to `/control/*` — see `postControl`. */
export type ControlScope = 'feature' | 'repo' | 'all';

/** `@adl/manager`'s `GcRunSummary`, restated — what one GC pass reclaimed and could not. */
export interface GcRunSummary {
  readonly worktreesRemoved: readonly string[];
  readonly scratchHomesRemoved: readonly string[];
  readonly worktreeFailures: readonly unknown[];
  readonly scratchHomeFailures: readonly unknown[];
}

/** A non-2xx response from a *reachable* daemon — a 404, a 401, a validation 400. */
export class DaemonRequestError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} failed with status ${status}`);
    this.name = 'DaemonRequestError';
    this.status = status;
  }
}

export interface DaemonClient {
  /** `GET /features` — the raw JSON array the manager returns. */
  getFeatures(): Promise<readonly unknown[]>;
  /** `POST /features/:id/{verb}` — the single-feature scope of pause/resume/kill. */
  postFeatureControl(
    featureId: string,
    verb: 'pause' | 'resume' | 'kill',
  ): Promise<ControlResult>;
  /** `POST /control/{verb}` with `{ scope: 'repo' | 'all', repoId? }` (D-20, D-26, D-27..29). */
  postControl(
    verb: 'pause' | 'resume' | 'kill',
    scope: 'repo' | 'all',
    repoId?: string,
  ): Promise<ControlResult>;
  /** `POST /control/gc` — one GC pass on demand (D-34). */
  postGc(): Promise<GcRunSummary>;
  /** `POST /control/shutdown` — `adl daemon stop`'s graceful-shutdown request. */
  postShutdown(): Promise<void>;
}

/**
 * `daemonClient(config)` — a thin `fetch` wrapper. Never auto-starts the
 * daemon on a connection failure: a read-only status command with a
 * process-spawning side effect is surprising and hard to undo (D-25).
 */
export function daemonClient(config: DaemonClientConfig): DaemonClient {
  const baseUrl = `http://${config.host}:${config.port}`;

  async function rawRequest(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${config.token}` },
      });
    } catch {
      throw new DaemonUnreachableError(config.host, config.port);
    }
  }

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await rawRequest(path, init);
    if (!response.ok) {
      throw new DaemonRequestError(path, response.status);
    }
    return (await response.json()) as T;
  }

  function postJson<T>(path: string, body?: unknown): Promise<T> {
    return requestJson<T>(path, {
      method: 'POST',
      ...(body !== undefined
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
  }

  return {
    getFeatures() {
      return requestJson<readonly unknown[]>('/features');
    },

    postFeatureControl(featureId, verb) {
      return postJson<ControlResult>(`/features/${featureId}/${verb}`);
    },

    postControl(verb, scope, repoId) {
      return postJson<ControlResult>(`/control/${verb}`, { scope, repoId });
    },

    postGc() {
      return postJson<GcRunSummary>('/control/gc');
    },

    async postShutdown() {
      await postJson<unknown>('/control/shutdown');
    },
  };
}
