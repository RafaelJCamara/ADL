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
import { dirname } from 'node:path';
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
  /**
   * Re-open the workspace under `featureId`, or `undefined` if there is none
   * (M05 step 5.14).
   *
   * Takes the same two arguments as {@link ContractSubject.create} for the same
   * reason: the cases below have to be able to *pair* the two calls on one id
   * and read what each one reported, without either backend needing a hook the
   * other does not have.
   */
  attach(
    featureId: string,
    onTeardown: (report: WorkspaceTeardownReport) => void,
  ): Promise<Workspace | undefined>;
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
    /** The id `workspace` was created under, so a case can attach to the same one. */
    let workspaceId: string;
    let reports: WorkspaceTeardownReport[];

    /** Unique per case, so no case can be affected by another's leftovers. */
    function freshId(): string {
      nextFeature += 1;
      return `contract-${nextFeature}`;
    }

    beforeEach(async () => {
      subject = factory();
      reports = [];
      workspaceId = freshId();
      workspace = await subject.create(workspaceId, (entry) =>
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

    it.each([
      ['the workspace root’s own parent', (root: string) => dirname(root)],
      [
        'a sibling whose name extends the root’s',
        (root: string) => `${root}-evil`,
      ],
      ['a relative path that climbs out', () => '..'],
    ])('refuses an exec whose cwd is %s', async (_label, outside) => {
      // WR-01. `ExecSpec.cwd` DECLARED this contract in @adl/core — "the backend
      // resolves it inside the workspace root" — and no backend enforced it: the
      // value went to execa verbatim, so `exec`, the most powerful of the three
      // interface methods, was the one with no guard while `read` and `write`
      // had one. A harness holding a `Workspace` through @adl/plugin-sdk could
      // start any binary anywhere on the host.
      //
      // Here rather than in a backend's own file precisely because it must hold
      // for EVERY backend — including the container backend that does not exist
      // yet, which will inherit this case the day it registers an id.
      //
      // `ContainmentError` specifically, not merely "an error": the same
      // discrimination the write/read cases above rely on. A child that failed
      // to spawn with ENOENT would satisfy a looser assertion and prove nothing
      // about the guard.
      //
      // The sibling case is the one a bare `startsWith` accepts (T-2-25), and it
      // is checked through the port rather than only against the predicate
      // because the point is that the BACKEND reaches the separator-aware guard,
      // not that the guard exists somewhere.
      await expect(
        workspace.exec(
          {
            argv: twoStreamChild(0),
            cwd: outside(workspace.root),
            path: process.env.PATH ?? '',
            networkPolicy: 'full',
            resources: {},
          },
          () => {},
        ),
      ).rejects.toThrow(ContainmentError);

      // The positive half is the three exec cases above, every one of which
      // passes `cwd: workspace.root`: a guard that refused everything would turn
      // them red rather than leaving this case looking satisfied.
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

      /** What the first teardown said about each resource it named. */
      const first = new Map(
        reports.map((entry) => [entry.resource, entry.outcome]),
      );

      reports.length = 0;

      // Idempotent AND observably so. Plan 02-05's point: teardown that is
      // idempotent but reports nothing gives an operator no way to tell a
      // reclaimed resource from a leaked one.
      await expect(workspace.destroy()).resolves.toBeUndefined();
      expect(reports.map((entry) => entry.outcome)).toContain('already-absent');

      // ── And PER RESOURCE, which this case could not see until WR-04 ───────
      //
      // `toContain('already-absent')` above is satisfied by any single entry.
      // On the worktree backend that entry was the scratch home, while the
      // worktree entry sat right beside it saying `reclaimed` for a second
      // time — a resource that had not existed since the first call, reported
      // as freshly reclaimed to an operator whose whole reason for reading this
      // log is to tell a reclaimed resource from a leaked one. The aggregate
      // assertion agreed with itself the entire time.
      //
      // Stated as "nothing is reclaimed twice" rather than "everything is
      // already-absent" on purpose: a scratch home that lost the Windows handle
      // race on the first teardown legitimately reports `not-reclaimed` then
      // and `reclaimed` now, and a rule that forbade that would be forbidding
      // the truth.
      const second = new Map(
        reports.map((entry) => [entry.resource, entry.outcome]),
      );

      expect(
        [...second.keys()].sort(),
        'the second teardown must account for the same resources as the first — a resource that stops being reported is a resource nobody is watching',
      ).toEqual([...first.keys()].sort());

      const reclaimedTwice = [...second]
        .filter(
          ([resource, outcome]) =>
            outcome === 'reclaimed' && first.get(resource) === 'reclaimed',
        )
        .map(([resource]) => resource);

      expect(
        reclaimedTwice,
        'a second destroy() reported `reclaimed` for a resource the first destroy() had already reclaimed (WR-04)',
      ).toEqual([]);
    });

    it('leaves no root directory behind after destroy', async () => {
      await workspace.destroy();
      await expect(stat(workspace.root)).rejects.toThrow();
    });

    /* ──────────────────────────────────────────────────────────────────────
     * attach ↔ detach (M05 step 5.14)
     *
     * The pair that makes a gate able to judge the developer's work. Before it
     * existed, `createProductionStageRunner` called `destroy()` at the end of
     * every stage and the next stage's `create()` branched from `baseRef` —
     * `docs/plan/DEBT.md` D-5-13-1. These cases run over both backends for the
     * same reason every case above does: the property belongs to the port, and
     * the container backend inherits them the day it registers an id.
     * ────────────────────────────────────────────────────────────────────── */

    it('attaches to a detached workspace and sees what the last run wrote', async () => {
      // The whole point, in one case. A second stage — a different process in
      // production — must reach the *same* workspace, with the previous
      // stage's work in it. `CONTRACT_SEEDED_FILE` was written by `beforeEach`
      // through the port, so the assertion is about continuity and not about
      // any backend's idea of where files live.
      await workspace.write('developer-wrote-this.txt', 'round-1 work');
      await workspace.detach();

      const second = await subject.attach(workspaceId, (entry) =>
        reports.push(entry),
      );
      expect(
        second,
        'a detached workspace must still be attachable',
      ).toBeDefined();

      await expect(second!.read('developer-wrote-this.txt')).resolves.toBe(
        'round-1 work',
      );
      await expect(second!.read(CONTRACT_SEEDED_FILE)).resolves.toBe('seed');
      expect(second!.id).toBe(workspace.id);
      expect(second!.root).toBe(workspace.root);

      await second!.detach();
    });

    it('gives the attached workspace its own scratch HOME', async () => {
      // D-07 is per *run*, not per workspace: the scratch `HOME` is what
      // `detach()` reclaims, so an attach that reused the detached one would
      // hand the next stage a directory that had just been deleted — and would
      // also let one stage's leftover `.gitconfig` or session file reach the
      // next, which is the one thing D-07 promises cannot happen.
      const first = workspace.scratchHome;
      await workspace.detach();

      const second = await subject.attach(workspaceId, () => {});
      expect(second).toBeDefined();
      expect(second!.scratchHome).not.toBe(first);

      const info = await stat(second!.scratchHome);
      expect(info.isDirectory()).toBe(true);

      await second!.detach();
    });

    it('reports nothing to attach to for a workspace that was never created', async () => {
      // `undefined`, not a throw: "there is nothing here" is the ordinary
      // round-1-index-0 case, and it is what lets a caller write
      // `attach(spec) ?? create(spec)` with no filesystem probe of its own.
      await expect(
        subject.attach(freshId(), () => {}),
      ).resolves.toBeUndefined();
    });

    it('reports nothing to attach to once the workspace is destroyed', async () => {
      await workspace.destroy();

      await expect(
        subject.attach(workspaceId, () => {}),
        'destroy() reclaims the workspace, so there must be nothing left to attach to',
      ).resolves.toBeUndefined();
    });

    it('keeps the workspace in the inventory across a detach', async () => {
      // The counterpart to the `destroy()` half of the inventory case above.
      // A detach that dropped the entry would make the GC sweep — which reads
      // this inventory and asks feature state (D-16, D-20) — blind to a
      // workspace that is very much still on disk.
      await workspace.detach();

      expect((await subject.list()).map((entry) => entry.featureId)).toContain(
        workspaceId,
      );
    });

    it('reports what detach reclaimed, and stays a safe no-op the second time', async () => {
      await workspace.detach();

      // It reports *something* — a teardown that reclaims silently gives an
      // operator no way to tell a reclaimed resource from a leaked one (plan
      // 02-05's point, restated for this half of the lifecycle).
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.every((entry) => entry.workspaceId === workspace.id)).toBe(
        true,
      );

      // And it names none of what it deliberately kept. `detach()` did not
      // touch the workspace, so reporting it would tell an operator the
      // opposite of what happened.
      const detached = new Set(reports.map((entry) => entry.resource));
      reports.length = 0;

      // Idempotent, and — the property that actually matters — non-throwing:
      // this runs in the `finally` of every stage including the failing ones,
      // where a raising cleanup would replace the error being reported.
      await expect(workspace.detach()).resolves.toBeUndefined();
      expect(reports.map((entry) => entry.resource)).toEqual([...detached]);
      expect(reports.map((entry) => entry.outcome)).not.toContain('reclaimed');
    });

    it('still destroys a workspace that was detached and never re-attached', async () => {
      // The crash shape: a worker detaches, the feature is later abandoned, and
      // the GC sweep reclaims it without anything having attached in between.
      await workspace.detach();

      await expect(workspace.destroy()).resolves.toBeUndefined();
      await expect(stat(workspace.root)).rejects.toThrow();
    });
  });
}
