/**
 * The structural half of plan `02-08`: the properties that make the
 * poisoned-configuration proof next door hold for operations nobody has written
 * yet.
 *
 * `poisoned-config.test.ts` proves that the eight overrides beat a poisoned
 * repository *today*, for the four operations this client currently ships. That
 * proof expires the moment Phase 5 adds a push. What does not expire is the
 * shape: there is one argv builder, it is unreachable from outside the module,
 * and every exported member goes through it. This file asserts the shape.
 *
 * It also carries the three assertions that have nowhere else to live: that
 * ADL's own git home is genuinely out of reach of a feature's scratch home,
 * that the registry's third entry is deliberately outside the contract suite
 * rather than accidentally missing from it, and that there is no configuration
 * surface anywhere through which a forge token could reach a worker-launched
 * child.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  Workspace,
} from '@adl/core/stage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as managerGitModule from '../../src/git/manager-git.js';
import {
  managerGitClient,
  NEUTRALISE_ARGS,
  NEUTRALISED_CONFIG,
} from '../../src/git/manager-git.js';
import { isWithinRoot } from '../../src/paths.js';
import {
  workspaceRegistry,
  WORKSPACE_BACKEND_IDS,
} from '../../src/registry.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

let repo: OpenedTempRepo;

beforeAll(async () => {
  repo = await openTempRepo();
});

afterAll(async () => {
  await repo.cleanup();
});

/* ────────────────────────────────────────────────────────────────────────────
 * 1. There is no reachable path to a git invocation without the overrides
 * ──────────────────────────────────────────────────────────────────────────── */

/** A `Workspace` that records the argv it is asked to run and launches nothing. */
function recordingWorkspace(into: string[][]): Workspace {
  return {
    id: 'recorder',
    root: repo.mainRepo,
    scratchHome: join(repo.mainRepo, '..', 'recorder-home'),
    exec(spec: ExecSpec, log: (chunk: LogChunk) => void): Promise<ExecResult> {
      into.push([...spec.argv]);
      // One empty stdout chunk, so the parsers downstream see a well-formed
      // (if uninteresting) success rather than a shape they never handle.
      log({ stream: 'stdout', text: '' });
      return Promise.resolve({ exitCode: 0, durationMs: 0 });
    },
    read: () => Promise.resolve(''),
    write: () => Promise.resolve(),
    snapshot: () => Promise.reject(new Error('not used by this test')),
    destroy: () => Promise.resolve(),
  };
}

describe('the neutralisation cannot be reached around', () => {
  /**
   * How to drive each operation.
   *
   * The keys are compared against the client's own keys below, so an operation
   * added in Phase 5 or Phase 9 fails this suite until it is listed here — which
   * is the point. A new push method that quietly built its own argv would
   * otherwise be covered by nothing.
   */
  const invocations: Record<
    keyof managerGitModule.ManagerGitClient,
    (client: managerGitModule.ManagerGitClient) => Promise<unknown>
  > = {
    status: (client) => client.status(),
    revParse: (client) => client.revParse('HEAD'),
    branches: (client) => client.branches(),
    effectiveConfig: (client) => client.effectiveConfig('user.name'),
  };

  it('drives every member the client exposes, with none left uncovered', async () => {
    const client = managerGitClient(recordingWorkspace([]));
    expect(Object.keys(invocations).sort()).toEqual(Object.keys(client).sort());
  });

  it('puts every override before the subcommand, on every operation', async () => {
    for (const [name, invoke] of Object.entries(invocations)) {
      const captured: string[][] = [];
      await invoke(managerGitClient(recordingWorkspace(captured)));

      expect(captured, `${name} ran exactly one git invocation`).toHaveLength(
        1,
      );
      const argv = captured[0] ?? [];

      expect(argv[0], `${name} invokes the git binary first`).toBe('git');
      expect(
        argv.slice(1, 1 + NEUTRALISE_ARGS.length),
        `${name} carries the full neutralisation prefix`,
      ).toEqual([...NEUTRALISE_ARGS]);

      // Position, not mere presence. `-c` is a TOP-LEVEL git option: an
      // override that landed after the subcommand would be passed to the
      // subcommand instead and silently do nothing, while a presence-only
      // assertion stayed green.
      const subcommandAt = 1 + NEUTRALISE_ARGS.length;
      const subcommand = argv[subcommandAt];
      expect(
        subcommand,
        `${name} has a subcommand after the prefix`,
      ).toBeDefined();
      expect(subcommand?.startsWith('-')).toBe(false);

      for (const assignment of NEUTRALISED_CONFIG) {
        const at = argv.indexOf(assignment);
        expect(at, `${name} passes ${assignment}`).toBeGreaterThan(0);
        expect(
          at,
          `${name} passes ${assignment} before the subcommand`,
        ).toBeLessThan(subcommandAt);
        expect(argv[at - 1], `${assignment} is introduced by -c`).toBe('-c');
      }
    }
  });

  it('exports no second entry point that could build an argv of its own', () => {
    // The module's only exported *function* is the factory. A `raw(argv)`
    // helper, or an exported argv builder, would put an unneutralised git
    // invocation one import away from every future call site — which is the
    // bypass this whole plan exists to make unrepresentable.
    const exportedFunctions = Object.entries(managerGitModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    expect(exportedFunctions).toEqual(['managerGitClient']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. ADL's own git home is out of reach of every feature's scratch home (D-08)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("ADL's own git home", () => {
  it('does not read a .gitconfig an agent left in its scratch HOME', async () => {
    const adlHome = join(repo.scratchRoot, '..', 'adl-home-isolation');
    const registry = workspaceRegistry({ hostGit: { configHome: adlHome } });

    const feature = await registry.resolve('worktree').create({
      featureId: 'feat-home',
      mainRepo: repo.mainRepo,
      scratchRoot: repo.scratchRoot,
      baseRef: 'HEAD',
    });
    const host = await registry.resolve('host-git').create({
      featureId: 'adl-own-home',
      mainRepo: repo.mainRepo,
      scratchRoot: repo.scratchRoot,
      baseRef: 'HEAD',
    });

    try {
      // The agent writes a global git configuration into the HOME ADL gave it.
      // This is not an attack — it is what `git config --global user.name`
      // does, and D-07 is what makes it survivable.
      await writeFile(
        join(feature.scratchHome, '.gitconfig'),
        '[adlprobe]\n\tmarker = agent-written\n',
        'utf8',
      );

      // ADL writes its own, into its own home. Both files exist at once, which
      // is what makes the assertion discriminating: without it, a client that
      // ignored global configuration entirely would pass.
      await mkdir(adlHome, { recursive: true });
      await writeFile(
        join(adlHome, '.gitconfig'),
        '[adlprobe]\n\tmarker = adl-own-home\n',
        'utf8',
      );

      const marker =
        await managerGitClient(host).effectiveConfig('adlprobe.marker');

      expect(marker).toBe('adl-own-home');
      expect(marker).not.toBe('agent-written');

      // And structurally, not only by observation: the two homes are different
      // directories and ADL's is not inside the tree features are created in.
      expect(host.scratchHome).not.toBe(feature.scratchHome);
      expect(isWithinRoot(repo.scratchRoot, host.scratchHome)).toBe(false);
    } finally {
      await feature.destroy();
      await host.destroy();
    }
  });

  it('refuses a git home inside the feature scratch root rather than warning', async () => {
    await expect(
      workspaceRegistry({
        hostGit: { configHome: join(repo.scratchRoot, 'inside') },
      })
        .resolve('host-git')
        .create({
          featureId: 'adl-own-bad',
          mainRepo: repo.mainRepo,
          scratchRoot: repo.scratchRoot,
          baseRef: 'HEAD',
        }),
    ).rejects.toThrow(/inside the feature scratch root/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Three backends, two of them peers — stated rather than implied
 * ──────────────────────────────────────────────────────────────────────────── */

const CONTRACT_SUITE = fileURLToPath(
  new URL('../contract/workspace-contract.test.ts', import.meta.url),
);

describe('the registry after the host-rooted entry', () => {
  it('knows three ids', () => {
    expect(workspaceRegistry().ids()).toEqual(['worktree', 'stub', 'host-git']);
    expect([...WORKSPACE_BACKEND_IDS]).toEqual([
      'worktree',
      'stub',
      'host-git',
    ]);
  });

  it('runs the contract suite over exactly the two FEATURE backends', async () => {
    const source = await readFile(CONTRACT_SUITE, 'utf8');
    const covered = [
      ...source.matchAll(/describeWorkspaceContract\(\s*'([^']+)'/g),
    ].map((match) => match[1]);

    // Not three. The host-rooted backend's `destroy()` deletes nothing and its
    // `snapshot()` refuses, so putting it through a suite that asserts
    // create-and-reclaim semantics would mean either weakening those cases for
    // the two backends they exist to hold to a standard, or asserting something
    // untrue about this one. The divergence is a decision, and this assertion is
    // where it is recorded — an omission would look identical without it.
    expect(covered).toEqual(['worktree', 'stub']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. There is no surface through which a forge token reaches an agent's child
 * ──────────────────────────────────────────────────────────────────────────── */

const EXEC_SPEC_SOURCE = fileURLToPath(
  new URL('../../../core/src/stage/workspace.ts', import.meta.url),
);

/** Anything whose NAME suggests it carries a secret. */
const CREDENTIAL_SHAPED = /token|credential|secret|password|apikey|auth/i;

/** Strip comments, so a docblock discussing tokens is not read as a field. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the credential boundary (D-09, D-12, WORK-06)', () => {
  it('offers no member on a worker-launched workspace that could carry one', async () => {
    // Constructed with the FULL daemon configuration, which is the only way the
    // assertion means anything: a workspace built from a minimal spec would
    // trivially have no credential member.
    const workspace = await workspaceRegistry({
      hostGit: { configHome: join(repo.scratchRoot, '..', 'adl-home-surface') },
      backends: [],
    })
      .resolve('worktree')
      .create({
        featureId: 'feat-surface',
        mainRepo: repo.mainRepo,
        scratchRoot: repo.scratchRoot,
        baseRef: 'HEAD',
      });

    try {
      // The exact `Workspace` port, and nothing else. An extra member would be
      // a place a credential could be parked for the lifetime of a feature
      // rather than the lifetime of one call.
      expect(Object.keys(workspace).sort()).toEqual(
        [
          'destroy',
          'exec',
          'id',
          'read',
          'root',
          'scratchHome',
          'snapshot',
          'write',
        ].sort(),
      );

      for (const member of Object.keys(workspace)) {
        expect(member).not.toMatch(CREDENTIAL_SHAPED);
      }
    } finally {
      await workspace.destroy();
    }
  });

  it('declares no field on ExecSpec through which one could be supplied but `env`', async () => {
    const source = withoutComments(await readFile(EXEC_SPEC_SOURCE, 'utf8'));
    const body = /export interface ExecSpec \{([\s\S]*?)\n\}/.exec(source)?.[1];

    expect(
      body,
      'ExecSpec is declared where this test expects it',
    ).toBeDefined();

    const fields = [...(body ?? '').matchAll(/^\s*readonly (\w+)\??:/gm)].map(
      (match) => match[1],
    );

    expect(fields).toContain('env');
    for (const field of fields) {
      expect(field).not.toMatch(CREDENTIAL_SHAPED);
    }
  });

  it('offers no credential field on the daemon-facing registry configuration', async () => {
    const source = withoutComments(
      await readFile(
        fileURLToPath(new URL('../../src/registry.ts', import.meta.url)),
        'utf8',
      ),
    );
    const body =
      /export interface WorkspaceRegistryConfig \{([\s\S]*?)\n\}/.exec(
        source,
      )?.[1];

    expect(body).toBeDefined();

    for (const match of (body ?? '').matchAll(/^\s*readonly (\w+)\??:/gm)) {
      expect(match[1]).not.toMatch(CREDENTIAL_SHAPED);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. The accepted risk stays discoverable (T-2-42)
 * ──────────────────────────────────────────────────────────────────────────── */

const README = fileURLToPath(new URL('../../README.md', import.meta.url));

describe('the operator-facing record of what is overridden', () => {
  it('documents every neutralised key, and no key that is not neutralised', async () => {
    // T-2-42 is ACCEPTED rather than mitigated: ADL overrides configuration an
    // operator might legitimately rely on. An accepted risk is only acceptable
    // while it is discoverable, and the README table is where it is discovered.
    // Without this assertion the table drifts silently, and the acceptance
    // quietly loses the thing that justified it.
    const readme = await readFile(README, 'utf8');
    const section = readme.slice(
      readme.indexOf("## What ADL's own git overrides"),
    );

    const documented = [...section.matchAll(/^\| `([a-z.]+)`\s*\|/gim)].map(
      (match) => match[1],
    );
    const neutralised = NEUTRALISED_CONFIG.map((assignment) =>
      assignment.slice(0, assignment.indexOf('=')),
    );

    expect(documented.sort()).toEqual([...neutralised].sort());
  });
});
