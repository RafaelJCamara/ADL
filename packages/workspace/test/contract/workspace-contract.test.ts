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
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * Modules that define a backend factory; importing one is the violation.
 *
 * `git/host-backend.js` is on this list even though the host-rooted backend is
 * deliberately outside the contract suite below. The two properties are
 * independent: the suite is about *behavioural* interchangeability, which this
 * backend does not claim, while the guard is about the *registry* being the only
 * place a factory is named — which it claims exactly as much as its two peers
 * do. Leaving it off would mean plan `02-08` added a backend nobody could import
 * by rule and everybody could import in fact.
 */
const BACKEND_MODULES = [
  'worktree/backend.js',
  'stub/backend.js',
  'git/host-backend.js',
];

/** The factory names themselves, for a namespace or aliased import. */
const BACKEND_FACTORIES = [
  'worktreeWorkspace',
  'stubWorkspace',
  'hostGitWorkspace',
];

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

/**
 * Every extension a TypeScript module under `src/` may carry.
 *
 * This walker filtered on `entry.name.endsWith('.ts')` and therefore could not
 * see a `.mts`, `.cts` or `.tsx` module — the same blind spot 02-VERIFICATION.md
 * demonstrated in `eslint.config.js`'s `files: ['**\/*.ts']`, arriving in the
 * belt-and-braces guard that exists BECAUSE the lint rule can be edited. Both
 * source-tree assertions below run off this function: the registry's
 * sole-construction-site rule and the `simple-git` scan added for CR-01. A
 * single `.mts` under `src/` would have been invisible to the lint rule and to
 * its backstop simultaneously, which is the one combination that leaves no
 * evidence at all.
 *
 * `.d.ts` matches too, via the `ts` alternative. That is correct rather than
 * incidental: a declaration file naming a backend factory is still a second
 * construction site as far as an importing module is concerned.
 */
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

async function typescriptSources(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await typescriptSources(full)));
    } else if (TYPESCRIPT_SOURCE.test(entry.name)) {
      found.push(full);
    }
  }

  return found;
}

describe('the source walker sees every spelling of a TypeScript module', () => {
  it('finds .ts, .tsx, .mts and .cts, and nothing else', async () => {
    // Exercised against a fixture directory rather than against `src/`, because
    // `src/` contains only `.ts` today — which is exactly why the blind spot
    // survived review. A guard over the real tree would be green whether the
    // walker looked at four extensions or one, and would go on being green
    // right up until the first `.mts` landed and slipped past both this file's
    // assertions at once.
    //
    // The negative half matters as much as the positive: `notes.md` and
    // `stale.tsx.bak` must NOT be read, or the `simple-git` scan below would
    // start reporting on documentation and backup files and a contributor would
    // learn to ignore it.
    const dir = await mkdtemp(join(tmpdir(), 'adl-walker-'));
    try {
      const planted = [
        'module.ts',
        'component.tsx',
        'esm.mts',
        'cjs.cts',
        'types.d.ts',
        'script.js',
        'notes.md',
        'stale.tsx.bak',
      ];
      for (const name of planted) {
        await writeFile(join(dir, name), '', 'utf8');
      }
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'nested', 'deep.mts'), '', 'utf8');

      const found = (await typescriptSources(dir))
        .map((file) => relative(dir, file).replaceAll('\\', '/'))
        .sort();

      expect(found).toEqual(
        [
          'cjs.cts',
          'component.tsx',
          'esm.mts',
          'module.ts',
          'nested/deep.mts',
          'types.d.ts',
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

/* ────────────────────────────────────────────────────────────────────────────
 * The same shape, for the other boundary this package claims to have
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `src/` may not name `simple-git`. At all. Anywhere.
 *
 * 02-REVIEW.md CR-01 and CR-02. The reason this is a source-tree assertion and
 * not only a lint rule is written on the lint rule itself
 * (`adl/no-simple-git-in-workspace-src` in `eslint.config.js`): the boundary has
 * to survive an edit to the lint config, and a guard that reads the tree names
 * the offending file rather than reporting it among five packages' worth of
 * ESLint output.
 *
 * The measurement is deliberately CRUDER than the registry guard above — the
 * bare identifier, not an import statement — because after `adlGit` exists there
 * is no legitimate reason for `src/` to contain the string, and the evasions
 * that matter (a handle built through a dynamic `import()`, a re-export, a
 * `createRequire`) are exactly the ones an import-statement regex cannot see.
 * Comments are stripped first, so the prose in `adl-git.ts` explaining why this
 * rule exists does not trip it; that prose is the one place the words belong.
 */
const SIMPLE_GIT_MENTION = /simple-git|simpleGit/;

/** Everything outside a comment. The prose about this rule must not trip it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The one module allowed to build a git argv for ADL's own account. */
const SOLE_GIT_CHOKEPOINT = 'git/adl-git.ts';

describe('no module under src/ reaches git through simple-git', () => {
  it('finds no source file naming simple-git or simpleGit', async () => {
    const files = await typescriptSources(SRC_ROOT);
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];

    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (
        SIMPLE_GIT_MENTION.test(withoutComments(await readFile(file, 'utf8')))
      ) {
        offenders.push(
          `${name} — simple-git spawns git with no configuration neutralisation (02-RESEARCH.md § Pitfall 5) and, because it passes \`env: undefined\` to spawn unless .env() was called, with the daemon's ENTIRE environment including the forge token (02-REVIEW.md CR-01, CR-02). Route it through adlGit() in src/${SOLE_GIT_CHOKEPOINT}, which carries NEUTRALISE_ARGS, the zero-inherit child environment, a forced C locale, and an exit code.`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('confirms the replacement exists and really carries the overrides', async () => {
    // Without this, deleting `adlGit` outright would make the assertion above
    // pass — a green guard over an empty property, which is the same way the
    // registry case one directory over can go vacuous.
    const chokepoint = await readFile(
      join(SRC_ROOT, SOLE_GIT_CHOKEPOINT),
      'utf8',
    );

    expect(chokepoint).toContain('export function adlGit(');
    expect(withoutComments(chokepoint)).toContain('NEUTRALISE_ARGS');
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * And the third boundary: every child starts inside a root somebody owns
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * The one module that reaches `run()` without a cwd containment guard.
   *
   * `adlGit` is not a `Workspace` and takes no caller-supplied cwd: it is handed
   * the main repository or a worktree path the backend itself created, and it is
   * deliberately the single ADL-side git chokepoint rather than a fourth backend
   * (D-17). WR-01 is about `ExecSpec.cwd` — a value that arrives through the port
   * from a stage, or from a third-party harness holding a `Workspace` via
   * `@adl/plugin-sdk`. Nothing a caller controls reaches this one's parameter.
   */
  const SOLE_UNGUARDED_RUNNER = 'git/adl-git.ts';

  it('names every module that reaches run(), and requires a cwd guard in each', async () => {
    // The contract suite proves the guard for the two backends it runs; this
    // proves that no THIRD module quietly reaches the exec primitive without
    // one. It is the same shape as the `adlGit` call-site pin above and exists
    // for the same reason: the three unguarded `simpleGit` handles CR-01 removed
    // came to exist unnoticed, one call site at a time.
    const files = await typescriptSources(SRC_ROOT);
    const callers: string[] = [];

    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (name === 'exec/run.ts') continue;

      const source = await readFile(file, 'utf8');
      if (
        importStatements(source).some((statement) =>
          statement.includes('exec/run.js'),
        )
      ) {
        callers.push(name);
      }
    }

    // A record of which modules DO, not a ceiling on which may. A new entry is a
    // deliberate line in a diff, and its author is then told by the loop below
    // that it needs a guard or an argument for why it does not.
    expect(callers.sort()).toEqual([
      'git/adl-git.ts',
      'git/host-backend.ts',
      'stub/backend.ts',
      'worktree/backend.ts',
    ]);

    // Without this the exception list could grow to cover everything and the
    // loop below would iterate nothing while still passing.
    expect(
      callers,
      'the documented exception must still be a real module, or the rule below is vacuous',
    ).toContain(SOLE_UNGUARDED_RUNNER);

    const unguarded: string[] = [];
    for (const name of callers) {
      if (name === SOLE_UNGUARDED_RUNNER) continue;
      const source = withoutComments(
        await readFile(join(SRC_ROOT, name), 'utf8'),
      );
      if (!/\bassertCwdWithinRoot\s*\(/.test(source)) {
        unguarded.push(
          `${name} — it reaches run() but never calls assertCwdWithinRoot, so a caller supplying ExecSpec.cwd can start a child outside the root the workspace is confined to (WR-01). @adl/core's ExecSpec.cwd docblock states the guard as a promise; this is what keeps the promise true.`,
        );
      }
    }

    expect(unguarded).toEqual([]);
  });

  it('names every module that runs git for ADL, so a new one is a visible diff', async () => {
    const files = await typescriptSources(SRC_ROOT);
    const reaching: string[] = [];

    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (name === SOLE_GIT_CHOKEPOINT) continue;
      if (/\badlGit\s*\(/.test(withoutComments(await readFile(file, 'utf8')))) {
        reaching.push(name);
      }
    }

    // Not an upper bound on how many modules MAY run git — it is a record of
    // which ones DO. A new entry here is a deliberate line in a diff rather
    // than a fourth quiet git call site, which is precisely how the three
    // simple-git handles this guard replaced came to exist unnoticed.
    expect(reaching.sort()).toEqual([
      'worktree/backend.ts',
      'worktree/lifecycle.ts',
      'worktree/list.ts',
    ]);
  });
});
