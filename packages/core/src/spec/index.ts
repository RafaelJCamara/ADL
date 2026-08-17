/**
 * The spec intake surface.
 *
 * One normalized shape (`NormalizedSpec`), one flat `AC-n` sequence, two
 * authoring formats. Detection decides which loader runs; both loaders route
 * their criteria through `assignCriterionIds`, so the addressing scheme is
 * format-blind and a criterion produced by either can be cited by a finding
 * without translation (D-02).
 */

export type {
  SourceFormat,
  ContextRef,
  SourceSpan,
  SpecStep,
  AcceptanceCriterion,
  NormalizedSpec,
} from './types.js';

export {
  detectFormat,
  SPEC_ENTRY_FILENAME,
  GHERKIN_EXTENSION,
  type DetectedFormat,
} from './detect-format.js';

export { assignCriterionIds, criterionTextHash, type CriterionBody } from './criterion-ids.js';

export { loadAdlTemplateSpec, MAX_SPEC_BYTES } from './markdown.js';

export { LoadError, type SourcePosition } from '../errors.js';
export { sha256Hex } from '../hash.js';
