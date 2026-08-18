import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecSpec, LogChunk, Workspace } from '@adl/core/stage';
import { destroyScratchHome } from '../../src/exec/scratch-home.js';
import { worktreeWorkspace } from '../../src/worktree/backend.js';
import { withTempRepo } from '../helpers/temp-repo.js';

/**
 * The credential boundary, measured from inside a real child process.
 *
 * `env.test.ts` checks the record `buildChildEnv` builds. This file checks the
 * environment a child actually receives, which is a different thing: Node
 * rewrites the environment on the way across the boundary, and the threat model
 * (T-2-16) is about what the agent can read, not about what ADL intended to
 * pass.
 */

/**
 * Located the same way `packages/db/test/helpers/temp-db.ts` locates its
 * fixtures — resolved from this module's own URL, so it does not depend on the
 * process cwd, which the workspace deliberately changes for the child.
 */
const ENV_DUMP_CHILD = fileURLToPath(
  new URL('../helpers/env-dump-child.cjs', import.meta.url),
);

/**
 * The credential-shaped variable names this suite looks for.
 *
 * **This list is the limitation, and it is deliberate.** A credential whose
 * name is not on it is not detected — so when Phase 16 adds a provider, its key
 * name is added here or this assertion silently stops covering it. That is the
 * flagged assumption A-E10 in `02-03-PLAN.md`: the test proves "these shapes do
 * not cross", not "nothing crosses". The structural guarantee is
 * `buildChildEnv`'s zero-inherit default; this is the observation that confirms
 * it, not a substitute for it.
 *
 * Exported so a later phase can assert the list is a superset of whatever
 * credential names its own configuration knows about.
 */
export const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /GITHUB_TOKEN/i,
  /GH_TOKEN/i,
  /GITLAB_TOKEN/i,
  /GITEA_TOKEN/i,
  /ANTHROPIC_API_KEY/i,
  /CLAUDE_CODE_OAUTH_TOKEN/i,
  /OPENAI_API_KEY/i,
  /GOOGLE_API_KEY/i,
  /GEMINI_API_KEY/i,
]);

/**
 * Unmistakable sentinels. Unique enough that a grep over a CI log answers "did
 * this leak?" without ambiguity, and obviously not real credentials so nobody
 * revokes anything on finding one.
 */
const FORGE_TOKEN_VAR = 'GITHUB_TOKEN';
const FORGE_TOKEN_VALUE = 'ghp_adl0205forgetokensentinelmustnotleak';
const MODEL_KEY_VAR = 'ANTHROPIC_API_KEY';
const MODEL_KEY_VALUE = 'sk-ant-adl0205modelkeysentinelmustnotleak';
/** A DIFFERENT value, named explicitly on one ExecSpec, for the scoping proof. */
const SCOPED_KEY_VALUE = 'sk-ant-adl0205scopedtoexactlyonecall';

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Run the env-dump child and return everything it printed, both streams. */
async function dumpChildEnv(
  workspace: Workspace,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const chunks: LogChunk[] = [];
  const spec: ExecSpec = {
    argv: [process.execPath, ENV_DUMP_CHILD],
    cwd: workspace.root,
    path: process.env.PATH ?? '',
    networkPolicy: 'full',
    resources: {},
    ...(env === undefined ? {} : { env }),
  };

  const result = await workspace.exec(spec, (chunk) => chunks.push(chunk));
  expect(result.exitCode).toBe(0);

  return chunks.map((chunk) => chunk.text).join('\n');
}

/** Run a command in the workspace, returning its exit code and its output. */
async function runIn(
  workspace: Workspace,
  argv: readonly string[],
): Promise<{ exitCode: number | null; output: string }> {
  const chunks: LogChunk[] = [];
  const result = await workspace.exec(
    {
      argv,
      cwd: workspace.root,
      path: process.env.PATH ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    (chunk) => chunks.push(chunk),
  );
  return {
    exitCode: result.exitCode,
    output: chunks.map((chunk) => chunk.text).join('\n'),
  };
}

const savedEnv = new Map<string, string | undefined>();

function setInParent(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, previous] of savedEnv) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  savedEnv.clear();
});

describe('credentials: the boundary a real child sees', () => {
  it('hands a child neither a forge token nor a model key it did not name', async () => {
    // Both live in THIS process while the child runs — the daemon's own
    // situation, where the worker holds every credential it might ever need to
    // hand out and hands out none of them by default (D-10).
    setInParent(FORGE_TOKEN_VAR, FORGE_TOKEN_VALUE);
    setInParent(MODEL_KEY_VAR, MODEL_KEY_VALUE);

    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'cred-1',
        baseRef: 'HEAD',
      });

      try {
        const dumped = await dumpChildEnv(workspace);

        // ── The assertion, phrased as D-11 phrases it ────────────────────
        //
        // Absence of the credential PATTERNS — deliberately NOT emptiness of
        // the environment.
        //
        // Do not "tighten" this into an emptiness check. On Windows the child's
        // environment is never empty even when the parent passes nothing:
        // spawning with `env: {}` was reproduced injecting eleven variables
        // (HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT,
        // TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR) while both the forge
        // token and the model key set in the parent were correctly absent
        // (02-RESEARCH.md § Pitfall 6, verified on this repository's own
        // development machine, Node v22.23.2 / execa 10.0.1). An emptiness
        // assertion is therefore red on the maintainer's laptop and green on
        // Linux CI — and the natural "fix" for that is to relax it into
        // something that no longer proves anything, which is the actual danger
        // here. What matters is that no credential crossed, and that is what
        // this checks.
        for (const pattern of CREDENTIAL_NAME_PATTERNS) {
          expect(dumped).not.toMatch(pattern);
        }
        expect(dumped).not.toContain(FORGE_TOKEN_VALUE);
        expect(dumped).not.toContain(MODEL_KEY_VALUE);

        // The child really did dump something — otherwise every assertion above
        // is satisfied by an empty string, and the test proves nothing.
        expect(dumped).toContain('PATH');
      } finally {
        await workspace.destroy();
      }
    });
  }, 60_000);

  it('scopes a model key to exactly the one exec that named it', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'cred-2',
        baseRef: 'HEAD',
      });

      try {
        // Two children of the SAME workspace. D-09 puts the allowlist on the
        // ExecSpec rather than on the Workspace precisely so that the agent-CLI
        // invocation can hold a key while the build, the test run, and every
        // other command in the same round cannot.
        const withKey = await dumpChildEnv(workspace, {
          [MODEL_KEY_VAR]: SCOPED_KEY_VALUE,
        });
        const withoutKey = await dumpChildEnv(workspace);

        expect(withKey).toContain(SCOPED_KEY_VALUE);
        // Asserted from both sides. "It was absent" alone would also pass if
        // the key never reached anything at all, which would mean the exec
        // boundary was broken in the other direction and the agent CLI could
        // never authenticate.
        expect(withoutKey).not.toContain(SCOPED_KEY_VALUE);
        expect(withoutKey).not.toMatch(/ANTHROPIC_API_KEY/i);
      } finally {
        await workspace.destroy();
      }
    });
  }, 60_000);

  it('lands agent-written git and npm configuration inside the disposable HOME', async (ctx) => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await worktreeWorkspace({
        mainRepo,
        scratchRoot,
        featureId: 'cred-3',
        baseRef: 'HEAD',
      });

      const scratchHome = workspace.scratchHome;
      const gitconfig = join(scratchHome, '.gitconfig');
      const npmrc = join(scratchHome, '.npmrc');

      try {
        // Probed through the exec boundary itself rather than by scanning PATH,
        // so "can a child run this?" is answered by the same mechanism the
        // assertions use. Skipped with a stated reason rather than failed: a
        // missing npm is an environment fact, not a defect in this code.
        const gitProbe = await runIn(workspace, ['git', '--version']);
        const npmProbe = await runIn(workspace, ['npm', '--version']);
        if (gitProbe.exitCode !== 0 || npmProbe.exitCode !== 0) {
          ctx.skip(
            `git or npm is not resolvable on PATH for a child of this workspace ` +
              `(git exit ${String(gitProbe.exitCode)}, npm exit ${String(npmProbe.exitCode)}); ` +
              `the neutraliser assertions need both.`,
          );
        }

        // ── A child writes configuration the way an agent would ──────────
        const email = 'agent@adl-scratch.invalid';
        const registry = 'http://registry.adl-scratch.invalid/';

        const wroteGit = await runIn(workspace, [
          'git',
          'config',
          '--global',
          'user.email',
          email,
        ]);
        expect(wroteGit.exitCode).toBe(0);

        const wroteNpm = await runIn(workspace, [
          'npm',
          'config',
          'set',
          'registry',
          registry,
        ]);
        expect(wroteNpm.exitCode).toBe(0);

        // It landed in the scratch directory, not in the host user's home.
        // This is the whole of T-2-17: an `.npmrc` naming a hostile registry
        // must not be able to poison installs on the host afterwards.
        expect(await exists(gitconfig)).toBe(true);
        expect(await exists(npmrc)).toBe(true);

        // ── A second child reads it back ─────────────────────────────────
        // Proving the neutralisers point somewhere real. Pointing them at a
        // sink would satisfy "did not reach the host" while breaking any agent
        // that needs a committer identity, and the break would look like a bug
        // in the agent.
        const readGit = await runIn(workspace, [
          'git',
          'config',
          '--global',
          '--get',
          'user.email',
        ]);
        expect(readGit.exitCode).toBe(0);
        expect(readGit.output).toContain(email);

        const readNpm = await runIn(workspace, [
          'npm',
          'config',
          'get',
          'registry',
        ]);
        expect(readNpm.exitCode).toBe(0);
        expect(readNpm.output).toContain(registry);

        // ── Teardown, and the gate on it ─────────────────────────────────
        await workspace.destroy();

        // `Workspace.destroy()` returns void — its signature belongs to the
        // backend, not to this plan — so the teardown REPORT is obtained by
        // running the same best-effort removal a second time. That is safe
        // precisely because Task 2 made it idempotent, and `already-absent` is
        // the positive statement that `destroy()` removed the directory.
        const report = await destroyScratchHome(scratchHome);

        if (report.outcome === 'already-absent') {
          expect(await exists(gitconfig)).toBe(false);
          expect(await exists(npmrc)).toBe(false);
          expect(await exists(scratchHome)).toBe(false);
        } else {
          // NOT a failure, and do not "tighten" it into one. Removal is
          // best-effort by Task 2's contract, and Pitfall 6 reproduced the
          // not-removed path on this repository's own Windows development
          // machine: a just-exited child can still hold a handle on the
          // directory. Asserting file absence unconditionally would make the
          // suite red for a reason the plan already anticipated and accepted.
          // The security property is delivered by the unpredictable mkdtemp
          // name and the fresh directory per run, not by this delete landing
          // first time. What is asserted is that the outcome is REPORTED and
          // names the directory, so a leak is visible rather than silent.
          expect(report.path).toBe(scratchHome);
          if (report.outcome === 'not-removed') {
            expect(report.reason).not.toBe('');
          }
          console.warn(
            `[02-05] scratch HOME teardown did not report removal: ${report.outcome} at ${report.path}`,
          );
        }
      } finally {
        // destroy() is reached on the happy path above; this covers an early
        // failure. Both the worktree teardown and the scratch-home teardown
        // tolerate being reached twice.
        await destroyScratchHome(scratchHome);
      }
    });
  }, 180_000);
});
