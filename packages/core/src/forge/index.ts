/**
 * `@adl/core/forge` — the forge port (FORGE-01). Pure declarations only; an
 * adapter package supplies the implementation. Not re-exported through
 * `@adl/plugin-sdk` — see `forge.ts`'s own docblock for why.
 */
export {
  CHANGE_REQUEST_STATES,
  COLLABORATOR_PERMISSIONS,
  FORGE_ADAPTER_MEMBERS,
  type ChangeRequest,
  type ChangeRequestState,
  type CollaboratorPermission,
  type ForgeAdapter,
  type ForgeAdapterMember,
  type ForgeRepoRef,
  type OpenChangeRequestInput,
  type PromoteToReadyInput,
  type ReadDiffInput,
  type ReadFileInput,
  type UpsertCommentInput,
} from './forge.js';
export {
  DEFAULT_COMMENT_BODY_MAX_LENGTH,
  escapeCollapsibleTags,
  renderStickyComment,
  type StickyCommentInput,
  type StickyRound,
} from './sticky-comment.js';
