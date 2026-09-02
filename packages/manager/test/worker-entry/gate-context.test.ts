import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { AgentEvent, AgentRunner, Workspace } from '@adl/core/stage';
import { isWithinRoot, workspaceRegistry } from '@adl/workspace';
import {
  withTempRepo,
  type TempRepo,
} from '../../../workspace/test/helpers/temp-repo.js';
import type { AssignMessage } from '../../src/ipc/protocol.js';
import { logsRootFor } from '../../src/store/transcript-path.js';
import { buildGateContext } from '../../src/worker-entry/gate-context.js';

/**
 * Fresh-context gate isolation, assembly half (ROLE-03, M05 step 5.17).
 *
 * `packages/core/test/stage/gate-context.test.ts` asserts that `GateContext`
 * *declares* nothing a gate may not see. This file asserts the other two thirds
 * of the same property:
 *
 * 1. **The narrowing really happens.** `buildGateContext` turns an
 *    `AssignMessage` — which carries `logsRoot`, `stageAttemptId` and
 *    `sendBackBriefJson` — into a context that carries none of them, and
 *    populates all three of AC3's permitted sources from the repository.
 * 2. **The one member that could have been a back door is not one.**
 *    `GateContext.workspace` is a live filesystem handle, so "a gate cannot
 *    read the developer's transcript" rests on the transcript living *outside*
 *    the workspace root. That is a fact about two path derivations in two
 *    different modules, and it is asserted here rather than argued in a
 *    docblock, because it is the single link in the fresh-context argument that
 *    lives outside the type.
 * 3. **A failure to assemble is a `StageError`, never a verdict.** A gate whose
 *    context could not be built judged nothing, and reporting a verdict anyway
 *    would make an infrastructure failure cost the developer a round (CORE-06).
 */

const SPEC_MARKDOWN = `# Title

Widget export

## Acceptance Criteria

- The export button appears on the widget page.
`;

interface Prepared {
  readonly workspace: Workspace;
  readonly assign: AssignMessage;
  readonly baseSha: string;
  readonly headSha: string;
}

/**
 * A real worktree carrying a real commit on top of a real base — the shape a
 * gate actually attaches to (M05 step 5.14).
 *
 * Built through the registry and the git binary rather than by hand: the diff
 * under test is `git`'s own answer, and a fixture that wrote its own file list
 * would be asserting that the test can make a list.
 */
async function prepare(
  repo: TempRepo,
  options: { readonly writeSpec?: boolean; readonly baseRef?: string } = {},
): Promise<Prepared> {
  const featureId = `feat-${ulid()}`;
  const handle = `features/${featureId}`;

  if (options.writeSpec !== false) {
    await mkdir(join(repo.mainRepo, handle), { recursive: true });
    await writeFile(
      join(repo.mainRepo, handle, 'spec.md'),
      SPEC_MARKDOWN,
      'utf8',
    );
    await repo.git.add(`${handle}/spec.md`);
    await repo.git.raw(['commit', '-m', `add ${handle}`]);
  }

  const baseSha = (await repo.git.revparse(['HEAD'])).trim();
  const backend = workspaceRegistry().resolve('worktree');
  const workspace = await backend.create({
    featureId,
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef: baseSha,
  });

  // The developer's commit, made inside the worktree the gate will judge.
  await workspace.write('src/exporter.ts', 'export const exporter = 1;\n');
  await workspace.exec(
    {
      argv: ['git', 'add', '-A'],
      cwd: workspace.root,
      path: process.env['PATH'] ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    () => {},
  );
  await workspace.exec(
    {
      argv: ['git', 'commit', '-m', 'implement the exporter'],
      cwd: workspace.root,
      path: process.env['PATH'] ?? '',
      env: {
        GIT_AUTHOR_NAME: 'ADL',
        GIT_AUTHOR_EMAIL: 'adl@noreply.local',
        GIT_COMMITTER_NAME: 'ADL',
        GIT_COMMITTER_EMAIL: 'adl@noreply.local',
      },
      networkPolicy: 'full',
      resources: {},
    },
    () => {},
  );

  let headSha = '';
  await workspace.exec(
    {
      argv: ['git', 'rev-parse', 'HEAD'],
      cwd: workspace.root,
      path: process.env['PATH'] ?? '',
      networkPolicy: 'full',
      resources: {},
    },
    (chunk) => {
      if (chunk.stream === 'stdout') headSha += chunk.text;
    },
  );

  const assign: AssignMessage = {
    t: 'assign',
    featureId,
    leaseToken: ulid(),
    workspaceHandle: handle,
    effectiveConfigJson: '{}',
    heartbeatIntervalMs: 1000,
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef: options.baseRef ?? baseSha,
    workspaceBackendId: 'worktree',
    roundId: ulid(),
    stageAttemptId: ulid(),
    stageId: 'test',
    stageIndex: 1,
    logsRoot: join(dirname(repo.scratchRoot), 'logs'),
    // The two fields that must not survive the narrowing. Present here exactly
    // so their absence downstream means something.
    pushUrl: 'https://x-access-token:secret@example.invalid/o/r.git',
    sendBackBriefJson: JSON.stringify({ findings: [] }),
  };

  return { workspace, assign, baseSha, headSha: headSha.trim() };
}

/**
 * The two members M07 step 7.1 added, as the smallest thing that satisfies the
 * type. Neither is exercised by the assertions in this file — it tests the
 * narrowing, and these are the caller's to supply — but a fixture that omitted
 * them would stop compiling rather than stop asserting, which is why they are
 * here rather than casts at each call site.
 */
const NO_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});
const UNUSED_AGENTS: AgentRunner = {
  run: () => {
    throw new Error('the assembly tests never call a model');
  },
  probe: () => {
    throw new Error('the assembly tests never probe a backend');
  },
};

describe('buildGateContext carries the caller’s capabilities through (M07 step 7.1)', () => {
  it('hands the gate the exact `with:` block and agent runner it was given', async () => {
    await withTempRepo(async (repo) => {
      const { workspace, assign } = await prepare(repo);
      try {
        const config = Object.freeze({ severity: 'strict', maxFiles: 40 });
        const built = await buildGateContext({
          workspace,
          assign,
          config,
          agents: UNUSED_AGENTS,
          onEvent: () => {},
        });

        expect(built.ok).toBe(true);
        if (!built.ok) return;

        // Reference identity, not structural equality. A `toEqual` would pass
        // against a defensive copy, and a copy is exactly what would break the
        // `agents` member: a gate must call the runner the caller wrapped for
        // spend reporting (D-5-18-1), not a lookalike.
        expect(built.gate.config).toBe(config);
        expect(built.gate.agents).toBe(UNUSED_AGENTS);
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);
});

describe('buildGateContext assembles spec, diff and repository (AC3)', () => {
  it('populates all three permitted sources from the repository', async () => {
    await withTempRepo(async (repo) => {
      const { workspace, assign, baseSha, headSha } = await prepare(repo);
      try {
        const built = await buildGateContext({
          workspace,
          assign,
          config: NO_CONFIG,
          agents: UNUSED_AGENTS,
          onEvent: () => {},
        });

        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const { gate } = built;

        // Spec — read out of the worktree, keyed on the folder name (D-16),
        // never on the `features` row's ULID.
        expect(gate.spec.title).toBe('Title');
        expect(gate.spec.acceptanceCriteria.length).toBeGreaterThan(0);

        // Diff — git's own answer for `base...head`, and it names the file the
        // commit above actually wrote.
        expect(gate.diff.base).toBe(baseSha);
        expect(gate.diff.head).toBe(headSha);
        expect(gate.diff.changedPaths).toEqual(['src/exporter.ts']);

        // Repository — the attached worktree, carrying that commit.
        expect(gate.workspace.root).toBe(workspace.root);
        expect(gate.stageId).toBe('test');
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);

  it('carries nothing from the assign message beyond those three', async () => {
    await withTempRepo(async (repo) => {
      const { workspace, assign } = await prepare(repo);
      try {
        const built = await buildGateContext({
          workspace,
          assign,
          config: NO_CONFIG,
          agents: UNUSED_AGENTS,
          onEvent: () => {},
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;

        // Asserted over the VALUE, not only the type. The type is proven by
        // `GATE_CONTEXT_MEMBERS`' compile-time exhaustiveness in @adl/core; what
        // this catches is a builder that spread the whole message in and let
        // structural typing hide the excess — which compiles, because a wider
        // object is assignable to a narrower interface everywhere except at a
        // fresh object literal.
        expect(Object.keys(built.gate).sort()).toEqual([
          // `agents` and `config` joined the list in M07 step 7.1 and come
          // from the CALLER, not from the message — which is why they are
          // listed here rather than treated as leaks. The assertion below is
          // what still holds the line: no value from `assign` reaches the gate
          // except the three fields this builder reads by name.
          'agents',
          'config',
          'diff',
          'onEvent',
          'spec',
          'stageId',
          'workspace',
        ]);

        const serialised = JSON.stringify({
          ...built.gate,
          workspace: undefined,
          onEvent: undefined,
          agents: undefined,
        });
        for (const leak of [
          assign.logsRoot,
          assign.stageAttemptId,
          assign.pushUrl,
          assign.sendBackBriefJson,
          assign.leaseToken,
        ]) {
          expect(
            serialised.includes(leak ?? ' never'),
            `the gate context leaked ${JSON.stringify(leak)} out of the assign message`,
          ).toBe(false);
        }
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);

  it('gives the gate a transcript sink and no read side', async () => {
    await withTempRepo(async (repo) => {
      const { workspace, assign } = await prepare(repo);
      try {
        const seen: AgentEvent[] = [];
        const built = await buildGateContext({
          workspace,
          assign,
          config: NO_CONFIG,
          agents: UNUSED_AGENTS,
          onEvent: (event) => seen.push(event),
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;

        built.gate.onEvent({ kind: 'text', messageId: 'stdout', delta: 'hi' });
        expect(seen).toHaveLength(1);
        expect(typeof built.gate.onEvent).toBe('function');
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);
});

describe("the developer's transcript is outside the gate's reach (ROLE-03)", () => {
  it('the transcript root is not inside any workspace root', async () => {
    await withTempRepo(async (repo) => {
      const { workspace } = await prepare(repo);
      try {
        // The single link in the fresh-context argument that lives outside the
        // type. `GateContext.workspace` is a live filesystem handle, and
        // `Workspace.read`/`exec` refuse anything outside `workspace.root`
        // (D-02, WR-01) — so whether a gate can reach a transcript comes down
        // entirely to whether transcripts live under a workspace root.
        //
        // They do not, and the two derivations are independent:
        // `logsRootFor(db)` is `dirname(db)/logs`, while a workspace root is
        // `<scratchRoot>/<id>` and `scratchRoot` is `dirname(db)/scratch`. They
        // are siblings. Asserted rather than reasoned, because a future change
        // to either derivation would silently make the containment guard the
        // only thing standing between a gate and the developer's transcript —
        // and it would then be standing on the wrong side of it.
        const logsRoot = logsRootFor(join(dirname(repo.scratchRoot), 'adl.db'));

        expect(
          isWithinRoot(workspace.root, logsRoot),
          `the transcript root (${logsRoot}) resolved INSIDE the workspace root (${workspace.root}) — a gate holding a Workspace could then read the developer's transcript through the one member GateContext legitimately carries`,
        ).toBe(false);
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);

  it('refuses a read that climbs out of the workspace toward it', async () => {
    await withTempRepo(async (repo) => {
      const { workspace } = await prepare(repo);
      try {
        // The behavioural half of the same property: the containment guard is
        // real, not merely declared. A relative path is what a gate would
        // actually construct, since it knows its own round and stage ids.
        await expect(
          workspace.read(join('..', '..', 'logs', 'anything.ndjson')),
        ).rejects.toThrow();
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);
});

describe('a context that cannot be assembled is a StageError, never a verdict', () => {
  it('classifies an unloadable spec as non-retryable unparseable', async () => {
    await withTempRepo(async (repo) => {
      // No spec folder committed at all, so the worktree has nothing to load.
      const { workspace, assign } = await prepare(repo, { writeSpec: false });
      try {
        const built = await buildGateContext({
          workspace,
          assign,
          config: NO_CONFIG,
          agents: UNUSED_AGENTS,
          onEvent: () => {},
        });

        expect(built.ok).toBe(false);
        if (built.ok) return;
        // `unparseable`, not `provider_error`: a spec that will not load will
        // not load on a retry either, and `stageErrorPolicy` makes this kind
        // non-retryable so the round loop escalates rather than spinning.
        expect(built.kind).toBe('unparseable');
        expect(built.detail).toContain('context could not be assembled');
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);

  it('classifies a diff that cannot be computed as retryable provider_error', async () => {
    await withTempRepo(async (repo) => {
      const { workspace, assign } = await prepare(repo, {
        baseRef: 'refs/heads/this-ref-does-not-exist',
      });
      try {
        const built = await buildGateContext({
          workspace,
          assign,
          config: NO_CONFIG,
          agents: UNUSED_AGENTS,
          onEvent: () => {},
        });

        expect(built.ok).toBe(false);
        if (built.ok) return;
        // Retryable, unlike the spec case — a `git` invocation that failed once
        // is the kind of thing that succeeds on the next dispatch, and CORE-06
        // is emphatic that a gate which could not run must not cost a round.
        expect(built.kind).toBe('provider_error');
        expect(built.detail).toContain('this-ref-does-not-exist');
      } finally {
        await workspace.destroy();
      }
    });
  }, 30_000);
});
