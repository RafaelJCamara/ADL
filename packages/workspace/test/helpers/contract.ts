/**
 * One conformance suite, written against the `Workspace` interface and nothing
 * else, run once per registered backend.
 *
 * This is how Phase 2's success criterion 3 stops being a claim. "A second
 * backend is registered and the loop runs against it unchanged" is unfalsifiable
 * as long as only one implementation exists; it becomes checkable the moment the
 * same expectations run twice with only the registry id differing.
 *
 * **No case here may name a backend, inspect a concrete type, or branch on
 * which implementation it received.** If a case needs to know, the interface is
 * missing something and the fix belongs on the interface — that rule is the
 * whole value of the file, and a single `if` would quietly retire it. Anything
 * genuinely backend-specific (the worktree backend's refusal to snapshot over
 * untracked files, which is a statement about git rather than about the port)
 * lives in `test/registry.test.ts` instead.
 *
 * `.planning/REQUIREMENTS.md` BACK-03 — "a single conformance suite is passed by
 * every adapter in both families, in CI" — is the same shape at a larger scale
 * in Phase 11. Building it here is a rehearsal, not speculation.
 */
import { stat } from 'node:fs/promises';
import type {
  LogChunk,
  ManagedWorkspace,
  Workspace,
  WorkspaceTeardownReport,
} from '@adl/core/stage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainmentError, WorkspaceError } from '../../src/errors.js';

/**
 * The file every case that needs pre-existing content uses.
 *
 * **The factory's workspaces must already contain it**, in whatever form the
 * backend considers established — for the worktree backend that means committed
 * on the base ref, so that overwriting it produces a modification rather than an
 * untracked file. Stating it as a precondition on the fixture rather than
 * handling it per backend is what keeps the cases below free of conditionals.
 */
export const CONTRACT_SEEDED_FILE = 'tracked.txt';

/** What the suite is handed: a way to make workspaces, and the inventory. */
export interface ContractSubject {
  /**
   * Stand up a fresh workspace under `featureId`, wired to `onTeardown`.
   *
   * The sink is supplied by the suite rather than the fixture so the teardown
   * case can read what `destroy()` reported without either backend needing a
   * bespoke hook.
   */
  create(
    featureId: string,
    onTeardown: (report: WorkspaceTeardownReport) => void,
  ): Promise<Workspace>;
  /** The backend's own inventory, scoped to the repository these live in. */
  list(): Promise<readonly ManagedWorkspace[]>;
}

/** A child that prints one line to each stream, then exits with `code`. */
function twoStreamChild(code: number): readonly string[] {
  return [
    process.execPath,
    '-e',
    "process.stdout.write('OUT-MARK\\n'); process.stderr.write('ERR-MARK\\n'); process.exit(Number(process.argv[1] ?? 0));",
    String(code),
  ];
}

let nextFeature = 0;

/**
 * Declare the contract for one backend.
 *
 * `factory` is a thunk rather than a value because the fixtures it closes over
 * (a temp git repository, for one) are built in the calling file's `beforeAll`,
 * which runs after this function has already declared its cases.
 */
export function describeWorkspaceContract(
  name: string,
  factory: () => ContractSubject,
): void {
  describe(`workspace contract: ${name}`, () => {
    let subject: ContractSubject;
    let workspace: Workspace;
    let reports: WorkspaceTeardownReport[];

    /** Unique per case, so no case can be affected by another's leftovers. */
    function freshId(): string {
      nextFeature += 1;
      return `contract-${nextFeature}`;
    }

    beforeEach(async () => {
      subject = factory();
      reports = [];
      workspace = await subject.create(freshId(), (entry) =>
        reports.push(entry),
      );
      // Establish the seeded file's contents for this case. A write, not a
      // fixture detail, so both backends reach the same starting state through
      // the same interface call.
      await workspace.write(CONTRACT_SEEDED_FILE, 'seed');
    });

    afterEach(async () => {
      // Unconditional: `destroy()` is required to be idempotent, so a case that
      // already destroyed its workspace is not a special case here — and a case
      // that failed mid-way must not leak a worktree.
      await workspace.destroy();
    });

    it('exposes a root that is a real directory while the workspace is live', async () => {
      // Not incidental. The containment guard realpaths the deepest existing
      // part of a candidate, so a backend whose root has no filesystem presence
      // would pass every rejection case below for no reason at all — the guard
      // would be resolving against some unrelated ancestor. This case is what
      // stops that from being invisible.
      const info = await stat(workspace.root);
      expect(info.isDirectory()).toBe(true);
    });

    it('lists a live workspace and stops listing it once destroyed', async () => {
      const id = freshId();
      const extra = await subject.create(id, () => {});

      expect((await subject.list()).map((entry) => entry.featureId)).toContain(
        id,
      );

      await extra.destroy();

      expect(
        (await subject.list()).map((entry) => entry.featureId),
      ).not.toContain(id);
    });

    it('round-trips contents through write and read', async () => {
      await workspace.write('nested/dir/file.txt', 'round-trip');
      await expect(workspace.read('nested/dir/file.txt')).resolves.toBe(
        'round-trip',
      );
    });

    it('rejects a read of a path that was never written', async () => {
      await expect(workspace.read('never-written.txt')).rejects.toThrow(
        WorkspaceError,
      );
    });

    it.each([
      ['a parent-directory escape', '../escape.txt'],
      ['an absolute path', '/etc/adl-escape'],
      ['the workspace root itself', '.'],
    ])('rejects a write to %s', async (_label, candidate) => {
      // ContainmentError specifically, not merely "an error": both backends must
      // refuse through the SAME guard, and the error type is what proves it
      // rather than a message string that could be coincidentally similar.
      await expect(workspace.write(candidate, 'x')).rejects.toThrow(
        ContainmentError,
      );
      await expect(workspace.read(candidate)).rejects.toThrow(ContainmentError);
    });

    it('streams stdout and stderr as separately tagged chunks', async () => {
      const chunks: LogChunk[] = [];

      const result = await workspace.exec(
        {
          argv: twoStreamChild(0),
          cwd: workspace.root,
          path: process.env.PATH ?? '',
          networkPolicy: 'full',
          resources: {},
        },
        (chunk) => chunks.push(chunk),
      );

      expect(result.exitCode).toBe(0);
      expect(
        chunks
          .filter((chunk) => chunk.stream === 'stdout')
          .map((chunk) => chunk.text)
          .join(''),
      ).toContain('OUT-MARK');
      expect(
        chunks
          .filter((chunk) => chunk.stream === 'stderr')
          .map((chunk) => chunk.text)
          .join(''),
      ).toContain('ERR-MARK');
    });

    it('reports a failing child as an exit code rather than a rejection', async () => {
      // The single most common thing that happens at this boundary is a command
      // gate whose test suite fails. If that arrived as a thrown error,
      // `ExecResult.exitCode` would be unreachable for the common case.
      const result = await workspace.exec(
        {
          argv: twoStreamChild(3),
          cwd: workspace.root,
          path: process.env.PATH ?? '',
          networkPolicy: 'full',
          resources: {},
        },
        () => {},
      );

      expect(result.exitCode).toBe(3);
    });

    it('terminates a child whose signal was already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const chunks: LogChunk[] = [];
      const result = await workspace.exec(
        {
          // Would run for a minute if nothing cancelled it, so the assertion
          // that this call returns at all is the assertion that it was killed.
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000);'],
          cwd: workspace.root,
          path: process.env.PATH ?? '',
          signal: controller.signal,
          networkPolicy: 'full',
          resources: {},
        },
        (chunk) => chunks.push(chunk),
      );

      // Not `toBe(1)`: a cancelled child reports a non-zero code on Windows and
      // a null code with a signal on POSIX. What must never happen is a clean 0,
      // which would mean the process ran to completion.
      expect(result.exitCode).not.toBe(0);
      expect(result.durationMs).toBeLessThan(30_000);
      expect(chunks).toEqual([]);
    });

    it('captures, restores, and then releases a snapshot', async () => {
      await workspace.write(CONTRACT_SEEDED_FILE, 'captured-contents');

      const handle = await workspace.snapshot();
      expect(handle.id).not.toBe('');

      await workspace.write(CONTRACT_SEEDED_FILE, 'mutated-contents');
      await expect(workspace.read(CONTRACT_SEEDED_FILE)).resolves.toBe(
        'mutated-contents',
      );

      await handle.restore();
      await expect(workspace.read(CONTRACT_SEEDED_FILE)).resolves.toBe(
        'captured-contents',
      );

      await expect(handle.release()).resolves.toBeUndefined();

      // Release is not advisory. A handle that still restored afterwards would
      // mean whatever backs the capture was never actually let go.
      await expect(handle.restore()).rejects.toThrow(WorkspaceError);
    });

    it('reports what destroy reclaimed, and reports the second destroy as already absent', async () => {
      await workspace.destroy();

      expect(reports.length).toBeGreaterThan(0);
      expect(reports.every((entry) => entry.workspaceId === workspace.id)).toBe(
        true,
      );
      expect(reports.map((entry) => entry.outcome)).toContain('reclaimed');

      reports.length = 0;

      // Idempotent AND observably so. Plan 02-05's point: teardown that is
      // idempotent but reports nothing gives an operator no way to tell a
      // reclaimed resource from a leaked one.
      await expect(workspace.destroy()).resolves.toBeUndefined();
      expect(reports.map((entry) => entry.outcome)).toContain('already-absent');
    });

    it('leaves no root directory behind after destroy', async () => {
      await workspace.destroy();
      await expect(stat(workspace.root)).rejects.toThrow();
    });
  });
}
