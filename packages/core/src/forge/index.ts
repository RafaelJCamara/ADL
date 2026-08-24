/**
 * `@adl/core/forge` — the forge port (FORGE-01). Pure declarations only; an
 * adapter package supplies the implementation. Not re-exported through
 * `@adl/plugin-sdk` — see `forge.ts`'s own docblock for why.
 */
export {
  CHANGE_REQUEST_STATES,
  type ChangeRequest,
  type ChangeRequestState,
  type ForgeAdapter,
  type ForgeRepoRef,
  type OpenChangeRequestInput,
  type PromoteToReadyInput,
  type ReadDiffInput,
  type ReadFileInput,
  type UpsertCommentInput,
} from './forge.js';
