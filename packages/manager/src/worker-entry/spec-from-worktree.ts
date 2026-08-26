/**
 * Load a feature's normalized spec out of the worktree it is committed in.
 *
 * Two callers need this and they must not derive it twice: the developer stage
 * (`stage-runner.ts`, since M04 — the assign message carries no spec and a
 * worker may not read the database to fetch one) and gate-context assembly
 * (`gate-context.ts`, M05 step 5.17, where the spec is one of the three sources
 * ROLE-03 permits a gate). Two independent readings of "the feature's spec" is
 * how a developer and the gate judging it end up working from different
 * documents while both look correct.
 *
 * ── Why this reads through the workspace rather than around it ─────────────
 *
 * The file content is read with {@link Workspace.read}, which applies
 * `assertWithinRoot` — the containment guard every other path site in this
 * milestone goes through (D-02, WR-01) — rather than with a bare
 * `readFile(join(root, handle, entry))`. That plain-`join` form is
 * `docs/plan/DEBT.md` **WR-02**, filed during M04 as "unreachable with
 * untrusted input today, but inconsistent with the containment discipline used
 * everywhere else". M05 step 5.17 is where it stopped being unreachable: a gate
 * loads the spec **after** the developer's agent has written to that same
 * worktree, so the directory this walks is agent-influenced for the first time.
 *
 * What that does *not* close is `docs/plan/DEBT.md` **D-2-R-3** — the guard
 * realpaths and returns, and the caller then opens, so a symlink planted in the
 * gap still wins. That residual is unchanged, and now live rather than
 * hypothetical; see the entry for its accepted status and proposed fix. The
 * directory listing below is a lexical `resolveWithinRoot` for the reason
 * `store/transcript-path.ts` gives for the same choice: `readdir` needs a path,
 * not a file handle, and there is nothing weaker about the lexical half here
 * because the component being joined is `features/<folder>` from ADL's own
 * detection, not a value an agent chose.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  detectFormat,
  loadAdlTemplateSpec,
  loadGherkinSpec,
  type NormalizedSpec,
} from '@adl/core/spec';
import type { Workspace } from '@adl/core/stage';
import { resolveWithinRoot } from '@adl/workspace';

/**
 * Detect the format and load the normalized spec from `workspace`.
 *
 * `workspaceHandle` (== `feature.path`, e.g. `"features/export-widgets"`) is
 * the repo-relative feature folder — NOT the `features` row's ULID primary key
 * (D-13's identity, unrelated to the `features/<id>/` folder-name identity
 * `NormalizedSpec.id` and the git branch suffix use). Conflating the two means
 * resolving a folder that does not exist for any feature whose folder name is
 * not itself a ULID. `NormalizedSpec`'s own `id` argument is the folder's
 * *basename* — `features/<basename>/` is the convention D-16 documents.
 *
 * Throws (`LoadError` from the spec loaders, `WorkspaceError`/`ContainmentError`
 * from the read, or an `fs` error from the listing). Every caller is one that
 * classifies a failure into a `StageError` rather than propagating it, and the
 * classification differs between them, so this deliberately does not pick one.
 */
export async function loadSpecFromWorktree(
  workspace: Workspace,
  workspaceHandle: string,
): Promise<NormalizedSpec> {
  const featureDir = resolveWithinRoot(workspace.root, workspaceHandle);
  const folderName = basename(workspaceHandle);
  const filenames = await readdir(featureDir);
  const detected = detectFormat(filenames);
  const raw = await workspace.read(join(workspaceHandle, detected.entryFile));
  return detected.sourceFormat === 'adl-template'
    ? loadAdlTemplateSpec(raw, folderName)
    : loadGherkinSpec(raw, folderName, detected.entryFile);
}
