/**
 * The workspace layer's own failure type.
 *
 * `LoadError` from `@adl/core` is deliberately not reused: it is a statement
 * about the *author's file* and its message is shown to whoever wrote the spec.
 * A `WorkspaceError` is a statement about ADL's own machinery — a worktree that
 * would not tear down, an environment variable a caller named but left unset —
 * and its audience is the operator reading the daemon log.
 *
 * The `workspaceId` context field exists because the daemon runs many
 * workspaces concurrently, so an error without one is an error nobody can trace
 * back to a feature.
 */
export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';

  /** Which workspace failed, when the failing code knows. */
  readonly workspaceId: string | undefined;

  constructor(message: string, workspaceId?: string) {
    super(message);
    this.workspaceId = workspaceId;
    // Keeps `instanceof WorkspaceError` working when the output is transpiled to
    // a target where Error subclassing is not native.
    Object.setPrototypeOf(this, WorkspaceError.prototype);
  }
}
