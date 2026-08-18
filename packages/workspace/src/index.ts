/**
 * `@adl/workspace` — the exec boundary.
 *
 * Every process ADL starts goes through this package (WORK-02). That is enforced
 * by the `adl/no-direct-spawn` lint rule in `eslint.config.js`, whose single
 * exemption is `packages/workspace/**`, rather than by review: a direct spawn
 * reaching the OS process table bypasses the zero-inherit environment, the
 * scratch `HOME`, the privilege drop, and the git-config neutralisation all at
 * once.
 *
 * `@adl/core` declares the {@link Workspace} interface and nothing else; the
 * implementations live here, because core is pure and I/O-free.
 */

// Errors — the workspace layer's own failure type.
export { WorkspaceError } from './errors.js';
