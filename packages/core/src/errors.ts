/**
 * A source position inside the raw text a loader was handed.
 *
 * Line and column are 1-based, matching every editor and every parser this
 * project embeds. `offset` is a 0-based index into the raw string.
 */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset?: number;
}

/**
 * Raised by every loader in `@adl/core` when the input is structurally
 * unusable — a missing required heading, an empty criteria section, a spec
 * larger than the cap.
 *
 * A `LoadError` is a statement about the *author's file*, not about ADL. Its
 * message is shown to the person who wrote the spec, so it names what is wrong
 * and where, never an internal symbol.
 */
export class LoadError extends Error {
  override readonly name = 'LoadError';

  /** Where in the source the problem is, when the loader can say. */
  readonly position: SourcePosition | undefined;

  constructor(message: string, position?: SourcePosition) {
    super(message);
    this.position = position;
    // Keeps `instanceof LoadError` working when the output is transpiled to a
    // target where Error subclassing is not native.
    Object.setPrototypeOf(this, LoadError.prototype);
  }
}
