import { access } from 'node:fs/promises';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecSpec, LogChunk } from '@adl/core/stage';
import { worktreeWorkspace } from '../src/worktree/backend.js';
import { withTempRepo } from './helpers/temp-repo.js';

/**
 * The tracer: one feature id, all the way through and back out again.
 *
 * This is deliberately ONE test rather than a suite. Its job is to prove the
 * whole path holds together against a real git repository and a real child
 * process — worktree creation, the exec boundary, the zero-inherit environment,
 * tagged log streaming, and teardown that leaves nothing behind. The
 * per-component edge cases (idempotent teardown, the GC backstop, the full
 * neutraliser set, the containment guard) belong to the plans that build those
 * components, and adding them here would make this test the place everything
 * accumulates.
 */

const STDOUT_MARKER = 'adl-tracer-stdout-4f2a';
const STDERR_MARKER = 'adl-tracer-stderr-9c1b';

/** Set in the PARENT and deliberately never named on the ExecSpec. */
const PARENT_ONLY_VAR = 'ADL_TRACER_PARENT_ONLY';
const PARENT_ONLY_VALUE = 'this-value-must-not-reach-the-child-7e3d';

/**
 * Printed by the child. The third line is the load-bearing one: the child looks
 * the parent-only variable up and reports what it found, so "absent" is a
 * positive observation rather than the absence of evidence.
 */
const CHILD_SCRIPT = `
process.stdout.write(${JSON.stringify(STDOUT_MARKER)} + "\\n");
process.stderr.write(${JSON.stringify(STDERR_MARKER)} + "\\n");
process.stdout.write("PARENT_ONLY:" + (process.env[${JSON.stringify(PARENT_ONLY_VAR)}] ?? "absent") + "\\n");
process.stdout.write("CWD:" + process.cwd() + "\\n");
process.stdout.write("HOME:" + (process.env.HOME ?? "unset") + "\\n");
`;

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe('tracer: a feature worktree runs a real process and leaves nothing behind', () => {
  it('creates, executes, streams tagged output, and tears down completely', async () => {
    process.env[PARENT_ONLY_VAR] = PARENT_ONLY_VALUE;

    try {
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const workspace = await worktreeWorkspace({
          mainRepo,
          scratchRoot,
          featureId: 'tracer-1',
          baseRef: 'HEAD',
        });

        // ── The worktree exists, on the adl/ branch D-13 specifies ──────────
        expect(await exists(workspace.root)).toBe(true);
        expect(await git.raw(['branch', '--list', 'adl/*'])).toContain(
          'adl/tracer-1',
        );
        // D-07: the scratch HOME belongs to the instance and exists while the
        // run is live.
        expect(await exists(workspace.scratchHome)).toBe(true);

        // ── A real child process, through the one exec boundary ─────────────
        const chunks: LogChunk[] = [];
        const spec: ExecSpec = {
          argv: [process.execPath, '-e', CHILD_SCRIPT],
          cwd: workspace.root,
          // Required by the type. Under `extendEnv: false` execa resolves the
          // binary from here, not from the parent's PATH (execa#366).
          path: process.env.PATH ?? '',
          networkPolicy: 'full',
          resources: {},
        };

        const result = await workspace.exec(spec, (chunk) => {
          chunks.push(chunk);
        });

        expect(result.exitCode).toBe(0);

        // ── The stream tag survives, asserted per stream ────────────────────
        // Separately, not as one combined-output check: a single assertion over
        // the concatenation of everything would pass just as happily with the
        // tag discarded, which is the exact defect `{ from: 'all' }` would
        // introduce.
        const stdout = chunks
          .filter((chunk) => chunk.stream === 'stdout')
          .map((chunk) => chunk.text);
        const stderr = chunks
          .filter((chunk) => chunk.stream === 'stderr')
          .map((chunk) => chunk.text);

        expect(stdout.some((text) => text.includes(STDOUT_MARKER))).toBe(true);
        expect(stderr.some((text) => text.includes(STDERR_MARKER))).toBe(true);

        // ── The child ran INSIDE the worktree ───────────────────────────────
        const cwdLine = stdout.find((text) => text.startsWith('CWD:'));
        expect(cwdLine).toBeDefined();
        expect(basename(cwdLine!.slice('CWD:'.length).trim())).toBe('tracer-1');

        // ── D-07: the child's HOME is the instance's scratch home ───────────
        const homeLine = stdout.find((text) => text.startsWith('HOME:'));
        expect(homeLine?.slice('HOME:'.length).trim()).toBe(
          workspace.scratchHome,
        );

        // ── D-10 / WORK-06: nothing was inherited ───────────────────────────
        // The variable is set in this very process and is not named on the
        // spec. The child looked and found nothing.
        expect(stdout).toContain('PARENT_ONLY:absent');
        const everything = [...stdout, ...stderr].join('\n');
        expect(everything).not.toContain(PARENT_ONLY_VALUE);

        // ── Teardown leaves neither a worktree nor a branch ─────────────────
        const worktreePath = workspace.root;
        const scratchHome = workspace.scratchHome;

        await workspace.destroy();

        // `worktree remove` alone would satisfy the first of these and silently
        // fail the second — the branch survives it. Both are asserted for that
        // reason (02-RESEARCH.md § Pattern 1).
        expect(await git.raw(['worktree', 'list'])).not.toContain(worktreePath);
        expect((await git.raw(['branch', '--list', 'adl/*'])).trim()).toBe('');
        expect(await exists(worktreePath)).toBe(false);
        expect(await exists(scratchHome)).toBe(false);
      });
    } finally {
      delete process.env[PARENT_ONLY_VAR];
    }
  });
});
