/**
 * The contract suite, run over every registered backend, plus the structural
 * guard that keeps the registry the only place a backend is named.
 *
 * This file deliberately contains **no expectations of its own** beyond the two
 * suite invocations and the one structural assertion. Every behavioural
 * expectation lives in `../helpers/contract.ts` and therefore runs twice, once
 * per backend, with only the id differing. That is what makes "the loop runs
 * against the second backend unchanged" a property of the code rather than a
 * sentence in a document — if it were false, half of these would be red.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceTeardownReport } from '@adl/core/stage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceRegistry } from '../../src/registry.js';
import {
  describeWorkspaceContract,
  type ContractSubject,
} from '../helpers/contract.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

/**
 * One temp git repository, shared by both suites.
 *
 * The worktree backend needs it for real; the stub backend needs only a
 * `mainRepo` string to scope its inventory by, and giving it the same one is
 * both realistic and a small extra guarantee — the two inventories are keyed the
 * same way and still do not see each other's entries.
 *
 * `tracked.txt` is committed by this fixture, which is exactly the suite's
 * `CONTRACT_SEEDED_FILE` precondition: overwriting it in the worktree produces a
 * modification rather than an untracked file, so `snapshot()` has something it
 * can capture.
 */
let repo: OpenedTempRepo;

beforeAll(async () => {
  repo = await openTempRepo();
});

afterAll(async () => {
  await repo.cleanup();
});

/** Build a subject over the backend the registry hands back for `id`. */
function subjectFor(id: string): ContractSubject {
  // Resolved through the registry, never constructed directly — the same route
  // the manager takes, so the suite exercises the resolution path too.
  const backend = workspaceRegistry().resolve(id);

  return {
    create: (
      featureId: string,
      onTeardown: (report: WorkspaceTeardownReport) => void,
    ) =>
      backend.create({
        featureId,
        mainRepo: repo.mainRepo,
        scratchRoot: repo.scratchRoot,
        baseRef: 'HEAD',
        onTeardown,
      }),
    list: () => backend.list(repo.mainRepo),
  };
}

describeWorkspaceContract('worktree', () => subjectFor('worktree'));
describeWorkspaceContract('stub', () => subjectFor('stub'));

/**
 * The invariant test behind this plan's assumption-delta `promote` decision.
 *
 * `Workspace` is the primary representation and the git worktree is a *detail
 * of one variant*. The moment a future phase imports a backend factory directly
 * — or reaches for a backend module to branch on which one it got — the
 * singular assumption is back and "zero call-site edits" is false, while every
 * type still looks generic and every other test stays green. This is the thing
 * that goes red instead.
 *
 * Implemented by reading files rather than by shelling out to a search tool, so
 * it runs identically wherever CI happens to run and names the offending file.
 */
const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** The one module allowed to reach a backend. Repository-relative for messages. */
const SOLE_CONSTRUCTION_SITE = 'registry.ts';

/** Modules that define a backend factory; importing one is the violation. */
const BACKEND_MODULES = ['worktree/backend.js', 'stub/backend.js'];

/** The factory names themselves, for a namespace or aliased import. */
const BACKEND_FACTORIES = ['worktreeWorkspace', 'stubWorkspace'];

/**
 * Every `import ... from '...'` statement in `source`.
 *
 * `export ... from '...'` is deliberately NOT matched. The barrel re-exports
 * both factories on purpose — the registry needs them and an embedder may want
 * them — and this guard measures *imports*, which is the thing that creates a
 * second construction site.
 */
function importStatements(source: string): readonly string[] {
  // Strip comments first: this file's own prose names both factories, and a
  // guard that reported on a docblock would be untrustworthy in both directions.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  return [
    ...code.matchAll(/^[ \t]*import\s[\s\S]*?from\s*['"][^'"]+['"]/gm),
  ].map((match) => match[0]);
}

async function typescriptSources(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await typescriptSources(full)));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }

  return found;
}

describe('the registry is the only place a backend is named', () => {
  it('finds no module outside registry.ts importing a backend factory', async () => {
    const files = await typescriptSources(SRC_ROOT);
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];

    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (name === SOLE_CONSTRUCTION_SITE) continue;

      for (const statement of importStatements(await readFile(file, 'utf8'))) {
        const reachesModule = BACKEND_MODULES.some((module) =>
          statement.includes(module),
        );
        const namesFactory = BACKEND_FACTORIES.some((factory) =>
          statement.includes(factory),
        );

        if (reachesModule || namesFactory) {
          offenders.push(
            `${name}: ${statement.replace(/\s+/g, ' ')} — only src/${SOLE_CONSTRUCTION_SITE} may name a workspace backend; every other consumer resolves an id through the registry and receives a Workspace`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('confirms registry.ts really does name both, so the guard is not vacuous', async () => {
    // Without this, deleting both backends would make the assertion above pass.
    const statements = importStatements(
      await readFile(join(SRC_ROOT, SOLE_CONSTRUCTION_SITE), 'utf8'),
    ).join('\n');

    for (const factory of BACKEND_FACTORIES) {
      expect(statements).toContain(factory);
    }
  });
});
