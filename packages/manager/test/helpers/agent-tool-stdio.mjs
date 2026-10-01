// How a replay double runs one of its tools -- `git add`, `git commit` -- so that
// what the tool prints goes where it goes for the agent CLI the double stands in
// for (2026-10-01, CI run 36857444603).
//
// A real agent CLI runs its tools as subprocesses and hands their output back to
// the model as the tool's result; under `--output-format stream-json` that is
// stdout content. None of it reaches the CLI's OWN stderr. The doubles called
// `execFileSync` with no `stdio`, and for that call Node's default writes the
// child's stderr straight to the parent's -- so anything git printed came out of
// the double as if the CLI itself had written it. `agent-claude-code`'s line
// handler (`src/backend.ts`, `createLineHandler`) does what its contract says
// with CLI stderr: an `error` event, which the stage runner folds into a
// `stage_error`.
//
// That stayed latent until git printed something on a commit that succeeded.
// Git 2.55 (GitHub's ubuntu-latest image) ends every `git commit` by deleting
// the `AUTO_MERGE` pseudoref; the files backend takes `packed-refs.lock` in the
// COMMON git directory for any deletion; and under the privilege drop that
// directory is deliberately not the worker's
// (`packages/workspace/src/worktree/shared-git.ts`). Git prints `error: Unable to
// create '.../packed-refs.lock': Permission denied` and the commit still exits 0
// with the branch moved. Git 2.43 (Ubuntu 24.04's own package) does not attempt
// the deletion and prints nothing. Every in-process developer stage on the Linux
// legs became a retryable `provider_error`.
//
// Captured, not swallowed: a tool that FAILS still throws out of `execFileSync`
// with its stderr in the error's message, the double dies non-zero, and the stage
// reports it -- which is what a real CLI whose commit failed amounts to as well.
export const TOOL_STDIO = 'pipe';
