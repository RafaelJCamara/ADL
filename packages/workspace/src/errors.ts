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

/**
 * A path was refused because it does not resolve inside the workspace root
 * (D-02).
 *
 * A **sibling** of {@link WorkspaceError} rather than a subclass, and that is
 * deliberate. Containment is the one workspace failure a test — and a caller —
 * has to be able to name exactly: "the interface refused to address this" is a
 * different event from "the file was not there", and if this extended
 * `WorkspaceError` then every `instanceof WorkspaceError` assertion in the
 * contract suite would also be satisfied by a containment rejection, so the two
 * cases could not discriminate. `catch (e) { if (e instanceof WorkspaceError) }`
 * treating a traversal attempt as an ordinary I/O failure is exactly the
 * conflation that makes a guard look present while being unobservable.
 *
 * **The message names the candidate and the reason, and never the resolved
 * root** (T-2-28). The root is the host's absolute scratch path; a third-party
 * harness that provoked this rejection has no business learning where on the
 * operator's disk ADL keeps its worktrees. The candidate is the caller's own
 * input, so echoing it back discloses nothing it did not already have.
 */
export class ContainmentError extends Error {
  override readonly name = 'ContainmentError';

  /** The path that was rejected, exactly as the caller wrote it. */
  readonly candidate: string;

  constructor(candidate: string, reason: string) {
    super(`Path ${JSON.stringify(candidate)} was rejected: ${reason}.`);
    this.candidate = candidate;
    Object.setPrototypeOf(this, ContainmentError.prototype);
  }
}
