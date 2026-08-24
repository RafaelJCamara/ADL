/**
 * `@adl/core/detect` — the pure half of feature detection (DETECT-01).
 *
 * Everything here is pure. Reading repository state is the caller's job;
 * see `packages/manager/src/detect/scanner.ts` for the I/O half.
 */
export { scanFeatureFolders } from './scan.js';
export {
  undevelopedFeatureFolders,
  type UndevelopedInput,
} from './undeveloped.js';
export {
  UNTRUSTED_REASONS,
  evaluateSpecTrust,
  type TrustDecision,
  type TrustedDecision,
  type TrustInput,
  type UntrustedDecision,
  type UntrustedReason,
} from './trust.js';
