/**
 * `@adl/manager` — the control plane.
 *
 * This package owns everything that must be singular: the lease queue, worker
 * supervision, the HTTP API, config, credentials, and round/budget accounting
 * (per `.planning/PROJECT.md` § Manager/worker shape). It is the only package
 * that writes to `@adl/db`.
 *
 * Nothing is exported yet — this is Wave 0 scaffolding. Later plans in this
 * phase add the daemon startup entry, the Hono `app` factory, the reaper and
 * dispatcher bind functions, and the worker-supervisor IPC contract to this
 * barrel, each with a "why public" comment in the style `@adl/workspace`'s
 * barrel establishes.
 */
export {};
