/**
 * `@adl/cli` — status, logs, pause, kill.
 *
 * This package is an HTTP client for the manager's API and nothing else
 * (D-18, D-21): it lists neither `@adl/db` nor `@adl/manager` in its
 * `package.json`, so pnpm's strict `node_modules` turns any reach past HTTP
 * into a resolve-time failure rather than a review finding.
 *
 * Nothing is exported yet — this is Wave 0 scaffolding. Later plans in this
 * phase add the commander program, the HTTP client, and the `status` /
 * `logs` / `pause` / `kill` subcommands.
 */
export {};
