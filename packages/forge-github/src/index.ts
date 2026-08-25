/**
 * `@adl/forge-github` — the GitHub `ForgeAdapter` implementation
 * (FORGE-02). See `src/backend.ts` for the module docblock.
 */
export {
  githubForgeAdapter,
  type GithubForgeAdapterOptions,
  type GithubForgeAdapter,
  type GithubPushToken,
} from './backend.js';
export { parseGithubRemoteUrl, githubPushUrl } from './repo-ref.js';
export type { GithubPushUrlParams } from './repo-ref.js';
