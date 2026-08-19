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
 * Every extension a module under `src/` may carry.
 *
 * This walker filtered on `entry.name.endsWith('.ts')` and therefore could not
 * see a `.mts`, `.cts` or `.tsx` module — the same blind spot 02-VERIFICATION.md
 * demonstrated in `eslint.config.js`'s `files: ['**\/*.ts']`, arriving in the
 * belt-and-braces guard that exists BECAUSE the lint rule can be edited. All
 * three source-tree assertions below run off this function: the registry's
 * sole-construction-site rule, the `simple-git` scan added for CR-01, and the
 * `assertCwdWithinRoot` call-site pin added for WR-01. A single `.mts` under
 * `src/` would have been invisible to the lint rule and to its backstop
 * simultaneously, which is the one combination that leaves no evidence at all.
 *
 * ── Why `.js`, `.mjs` and `.cjs` are here too ─────────────────────────────
 *
 * That sentence is the whole argument, and it does not stop at TypeScript. Once
 * `eslint.config.js`'s `MODULE_SOURCE_EXTENSIONS` reached the JavaScript
 * spellings, a walker that did not would have recreated the identical hole one
 * layer down: the lint rule catches a `.mjs` under `src/` naming `simpleGit`,
 * but the guard whose entire purpose is to survive an EDIT to that lint rule
 * would not. "Somebody widens a glob wrongly" plus "a `.mjs` exists" is exactly
 * the combination this backstop is for, and a TypeScript-only walker is blind to
 * precisely that pair.
 *
 * The cost is bounded and worth naming: `src/` contains only `.ts` today, so the
 * widening changes nothing about what is scanned right now. It changes what
 * happens the first time it would matter, which is the only moment a backstop
 * is ever worth anything.
 *
 * `.d.ts` matches too, via the `ts` alternative. That is correct rather than
 * incidental: a declaration file naming a backend factory is still a second
 * construction site as far as an importing module is concerned.
 */
const MODULE_SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Directory names the walker must not descend into, for the one caller that
 * starts at the PACKAGE root rather than at `src/`.
 *
 * `src/` and `test/` contain nothing but hand-written source, so the three
 * assertions that walk them pass no skip set at all and are unaffected by this.
 * The T-2-40 scan at the bottom of this file has to start one directory higher,
 * and `packages/workspace/node_modules/execa/` is right there — a scan that
 * descended into it would report the exec library's own source as an offender
 * on every machine that has run `pnpm install`, which is a guard that gets
 * switched off within a day.
 *
 * Deliberately a name set rather than a path prefix: a `node_modules` nested
 * under a future sub-package inside this one is skipped for the same reason the
 * top-level one is, and neither has to be enumerated.
 */
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
]);

/** The empty default, so the three existing callers keep walking everything. */
const DESCEND_EVERYWHERE: ReadonlySet<string> = new Set<string>();

async function moduleSources(
  dir: string,
  skipDirectories: ReadonlySet<string> = DESCEND_EVERYWHERE,
): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      found.push(...(await moduleSources(full, skipDirectories)));
    } else if (MODULE_SOURCE.test(entry.name)) {
      found.push(full);
    }
  }

  return found;
}

describe('the source walker sees every spelling of a module', () => {
  it('finds .ts, .tsx, .mts, .cts, .js, .mjs and .cjs, and nothing else', async () => {
    // Exercised against a fixture directory rather than against `src/`, because
    // `src/` contains only `.ts` today — which is exactly why the blind spot
    // survived review. A guard over the real tree would be green whether the
    // walker looked at seven extensions or one, and would go on being green
    // right up until the first `.mts` landed and slipped past both this file's
    // assertions at once.
    //
    // The negative half matters as much as the positive: `notes.md`,
    // `stale.tsx.bak` and `stale.mjs.bak` must NOT be read, or the `simple-git`
    // scan below would start reporting on documentation and backup files and a
    // contributor would learn to ignore it. Note `script.js` moved from the
    // negative set to the positive one when the walker widened — deliberately,
    // and it is the single line in this test that records the Warning B change.
    const dir = await mkdtemp(join(tmpdir(), 'adl-walker-'));
    try {
      const planted = [
        'module.ts',
        'component.tsx',
        'esm.mts',
        'cjs.cts',
        'types.d.ts',
        'script.js',
        'esm.mjs',
        'commonjs.cjs',
        'notes.md',
        'stale.tsx.bak',
        'stale.mjs.bak',
      ];
      for (const name of planted) {
        await writeFile(join(dir, name), '', 'utf8');
      }
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'nested', 'deep.mts'), '', 'utf8');
      await writeFile(join(dir, 'nested', 'deep.cjs'), '', 'utf8');

      const found = (await moduleSources(dir))
        .map((file) => relative(dir, file).replaceAll('\\', '/'))
        .sort();

      expect(found).toEqual(
        [
          'cjs.cts',
          'commonjs.cjs',
          'component.tsx',
          'esm.mjs',
          'esm.mts',
          'module.ts',
          'nested/deep.cjs',
          'nested/deep.mts',
          'script.js',
          'types.d.ts',
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('descends into a generated directory unless told not to', async () => {
    // Both halves matter, and the SECOND is the one that keeps the skip set
    // honest. If the walker did not find `node_modules/execa/index.js` without
    // the skip, then passing the skip would be proving nothing — and the
    // T-2-40 scan below, which is the only caller that passes one, would be
    // narrowing a walk that was already narrow. The first half is what makes
    // that scan runnable at all on a machine that has installed dependencies.
    const dir = await mkdtemp(join(tmpdir(), 'adl-walker-skip-'));
    try {
      await writeFile(join(dir, 'real.ts'), '', 'utf8');
      await mkdir(join(dir, 'node_modules', 'execa'), { recursive: true });
      await writeFile(
        join(dir, 'node_modules', 'execa', 'index.js'),
        '',
        'utf8',
      );

      const names = async (skip?: ReadonlySet<string>) =>
        (
          await (skip === undefined
            ? moduleSources(dir)
            : moduleSources(dir, skip))
        )
          .map((file) => relative(dir, file).replaceAll('\\', '/'))
          .sort();

      expect(await names()).toEqual(['node_modules/execa/index.js', 'real.ts']);
      expect(await names(GENERATED_DIRECTORIES)).toEqual(['real.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the registry is the only place a backend is named', () => {
  it('finds no module outside registry.ts importing a backend factory', async () => {
    const files = await moduleSources(SRC_ROOT);
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
    const files = await moduleSources(SRC_ROOT);
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
    const files = await moduleSources(SRC_ROOT);
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
    const files = await moduleSources(SRC_ROOT);
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

/* ────────────────────────────────────────────────────────────────────────────
 * And the fourth: exactly the SANCTIONED modules in this PACKAGE can launch a
 * process — two now, not one, and this block is what keeps a third from
 * arriving silently
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * T-2-40, which until now had a mitigation nobody had written.
 *
 * The threat is "an UNSANCTIONED second exec primitive is introduced,
 * bypassing every control while every lint check passes because the bypass
 * lives inside the exempted directory". The register's mitigation promised an
 * assertion that the repository still has exactly the sanctioned set of files
 * importing a process-launch library — one, at the time T-2-40 was written.
 * `02-08-SUMMARY.md` then recorded T-2-40 as mitigated on the strength of an
 * OBSERVATION — "one file in `packages/workspace/src` imports execa" — which
 * was true, is still true, and enforces nothing on its own. A true sentence
 * about today's tree is not a control over tomorrow's; the whole content of
 * T-2-40 is that an unreviewed primitive arrives LATER and invisibly, which is
 * exactly what already happened once as 02-REVIEW.md CR-01.
 *
 * `src/exec/fork.ts` (Phase 3, `eslint.config.js:21`/`:218`) is the deliberate
 * exception the count now has to accommodate: it is the manager→worker `fork()`
 * seam, reviewed, exported from the barrel, and built with its own environment
 * discipline (`WORKER_ENV_ALLOWLIST`) — not a bypass CR-01's shape. This block
 * is updated to name it as the SECOND sanctioned launcher rather than widened
 * or dropped, because the property T-2-40 protects — "no THIRD, unreviewed
 * primitive arrives invisibly" — still needs a live assertion, and one that
 * still fails the instant a module neither of these two names imports a
 * launcher.
 *
 * ── Why none of the four existing guards catches it ────────────────────────
 *
 * A new `src/git/fast-git.ts` doing `import { execa } from 'execa'` passes all
 * of them, and it is worth being precise about why, because three of the four
 * look like they cover this:
 *
 * - **`adl/no-direct-spawn`** ignores `packages/workspace/**` outright. The ban
 *   never applies inside this package, by design — this package is the
 *   exemption.
 * - **`adl/no-simple-git-in-workspace-src`**, the carve-out inside that
 *   exemption, re-bans `simple-git` and NOTHING ELSE.
 *   `test/lint/no-restricted-imports.test.ts` asserts it must not name `execa`,
 *   and that assertion is correct: `src/exec/run.ts` lives under `src/`, so
 *   banning the specifier there would make the one legitimate process launch a
 *   lint error.
 * - **The `simple-git` source scan above** matches `simple-git|simpleGit`. A
 *   module that reaches the OS process table directly names neither.
 * - **The `exec/run.js` importer pin above** reads like coverage of "who
 *   reaches the exec primitive" and is not. It enumerates who imports the
 *   sanctioned WRAPPER, and a bypass by construction does not import it. That
 *   confusion — a contract assertion satisfied by a neighbouring resource — is
 *   this phase's recurring defect and is the reason this block exists.
 *
 * ── Why this is a source scan and not a fifth lint entry ───────────────────
 *
 * Considered and rejected, on three grounds rather than on effort.
 *
 * `no-restricted-imports` cannot express "everybody in this package except
 * `src/exec/run.ts`" in one config entry. Saying it needs a SECOND entry
 * overlapping `packages/workspace/src/**`, and flat config REPLACES rather than
 * merges — so that entry would silently delete the `simple-git` carve-out from
 * every other source file while `pnpm lint` stayed green. That is not a
 * hypothetical: `eslint.config.js`'s own `adl/no-direct-spawn` docblock records
 * dropping a carve-out and watching the `node:fs` purity ban vanish from the
 * verdict sources with a green build. Buying a lint layer for T-2-40 at the
 * price of reopening CR-01 is a bad trade.
 *
 * Second, a lint entry scoped to `src/` would leave `test/` uncovered, and the
 * exemption is package-WIDE — a second primitive under `test/` is exempt from
 * every rule in the repository.
 *
 * Third, and the reason the trade is not close: `no-restricted-imports` sees
 * three import forms, and this scan is a bare-identifier match over
 * comment-stripped source. A handle built through `createRequire`, a re-export,
 * or a computed specifier evades the rule and not the scan. So the source scan
 * is a strict superset of what the lint entry would have caught, and it costs
 * no config composition. `test/lint/no-restricted-imports.test.ts:695` stays
 * exactly as it is.
 */

/** One directory up from `src/`: the exemption is package-wide, so this is too. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The module that owns the execa-based launch — the one `run()` uses. */
const SOLE_EXEC_PRIMITIVE = 'src/exec/run.ts';

/**
 * The second sanctioned launcher (Phase 3, `eslint.config.js:21`/`:218`): the
 * manager→worker `fork()` seam, a SIBLING of `run.ts` rather than a bypass of
 * it. Named as its own constant rather than folded into
 * {@link SOLE_EXEC_PRIMITIVE} because the two are not interchangeable — each
 * one names a different specifier below, and each is the sole namer of that
 * specifier, not of "process launching" in general.
 */
const FORK_PRIMITIVE = 'src/exec/fork.ts';

/**
 * This file, exempt from the bare-identifier scan only.
 *
 * A textual guard has to name what it forbids, so the constants below put the
 * string in this file's CODE rather than in its prose, where `withoutComments`
 * would have removed it. The exemption is bounded rather than a hole: the
 * import-form assertion at the end of this block covers this file with no
 * exemption at all, so a `workspace-contract.test.ts` that grew an actual
 * import of a launcher is still red.
 */
const THIS_GUARD = 'test/contract/workspace-contract.test.ts';

/**
 * Every way this package could reach the OS process table.
 *
 * `execa` and both spellings of the builtin, which is
 * `FORBIDDEN_SPAWN_SPECIFIERS` minus `simple-git` — that one already has the
 * scan above, with a different exemption. The builtin is on this list and not
 * only `execa` because `import { spawn } from 'node:child_process'` is the more
 * obvious way to write a second exec primitive, and a guard covering the
 * library while leaving the builtin open would reproduce T-2-40 one specifier
 * over.
 *
 * Deliberately NOT imported from `eslint.config.js`, even though the tuple is
 * exported there. This assertion exists because that file can be edited; a
 * version of it that derived its subject matter from the file it is backstopping
 * would go quiet in precisely the edit it is here to survive.
 */
const EXEC_PRIMITIVES = [
  {
    specifier: 'execa',
    // No trailing `\b`, so `execaNode`, `execaSync` and `execaCommand` match
    // too — the boundary that matters is the one at the START of the word.
    mention: /\bexeca/,
    soleNamer: SOLE_EXEC_PRIMITIVE,
  },
  {
    specifier: 'child_process',
    // Matches the `node:`-prefixed spelling as well: banning one and not the
    // other leaves the guard bypassable by deleting five characters, which is
    // the reasoning `FORBIDDEN_CORE_BUILTINS` already carries.
    mention: /\bchild_process\b/,
    // `fork.ts` is the one sanctioned namer (Phase 3). `run()` never imports
    // this builtin — it uses `execa`, which is the row above.
    soleNamer: FORK_PRIMITIVE as string | undefined,
  },
] as const;

describe('exactly the sanctioned modules in this package can launch a process', () => {
  it('scans the whole package — src/, test/ and the root — not only src/', async () => {
    // Anti-vacuity for the two assertions below, and it is the half that would
    // have caught the original defect. A scan rooted at `src/` finds nothing
    // under `test/`, and `test/` is inside the exemption too; a scan that
    // silently walked an empty tree would report zero offenders forever.
    const names = (
      await moduleSources(PACKAGE_ROOT, GENERATED_DIRECTORIES)
    ).map((file) => relative(PACKAGE_ROOT, file).replaceAll('\\', '/'));

    expect(names.length).toBeGreaterThan(25);
    // Root-level, so the walk demonstrably starts at the package and not at src/.
    expect(names).toContain('vitest.config.ts');
    expect(names).toContain(SOLE_EXEC_PRIMITIVE);
    expect(names).toContain(FORK_PRIMITIVE);
    expect(names).toContain(THIS_GUARD);
    // And the skip set did its job, or every install would be an offender.
    expect(names.filter((name) => name.startsWith('node_modules/'))).toEqual(
      [],
    );
  });

  for (const primitive of EXEC_PRIMITIVES) {
    it(`finds no module naming ${primitive.specifier} outside its sanctioned namer`, async () => {
      const files = await moduleSources(PACKAGE_ROOT, GENERATED_DIRECTORIES);
      expect(files.length).toBeGreaterThan(25);

      const offenders: string[] = [];

      for (const file of files) {
        const name = relative(PACKAGE_ROOT, file).replaceAll('\\', '/');
        if (name === primitive.soleNamer) continue;
        if (name === THIS_GUARD) continue;

        if (
          primitive.mention.test(withoutComments(await readFile(file, 'utf8')))
        ) {
          offenders.push(
            `${name} — an UNSANCTIONED process-launch primitive inside packages/workspace (T-2-40). Every lint check in this repository passes for it: adl/no-direct-spawn ignores this package wholesale, and adl/no-simple-git-in-workspace-src re-bans simple-git ONLY. A child started here inherits none of an existing primitive's controls — not the zero-inherit environment, not the scratch HOME, not the privilege drop, not the git-config neutralisation — and none of those bypasses is visible in a diff. Route it through run() in ${SOLE_EXEC_PRIMITIVE} (an agent-facing exec) or forkWorker() in ${FORK_PRIMITIVE} (the manager→worker seam) — the only two reviewed launchers this package has.`,
          );
        }
      }

      expect(offenders).toEqual([]);
    });
  }

  it('confirms the execa launcher really is still the process launch', async () => {
    // Without this, deleting `execa` from `run.ts` — or replacing the launch
    // with a re-export of somebody else's — would leave the assertion above
    // green over a package that no longer has the primitive it is pinning. The
    // same vacuity the `adlGit` and registry pairs above are each half of.
    const source = withoutComments(
      await readFile(join(PACKAGE_ROOT, SOLE_EXEC_PRIMITIVE), 'utf8'),
    );

    expect(source).toContain("from 'execa'");
    expect(source, 'the exemption imports the launcher and calls it').toMatch(
      /\bexeca\s*\(/,
    );
  });

  it('confirms the fork() launcher really is still the process launch', async () => {
    // The same vacuity guard as the execa one above, applied to the second
    // sanctioned launcher: deleting `fork` from `fork.ts` — or replacing the
    // call with a re-export — would leave the scan above green over a package
    // that no longer has the primitive it is pinning.
    const source = withoutComments(
      await readFile(join(PACKAGE_ROOT, FORK_PRIMITIVE), 'utf8'),
    );

    expect(source).toMatch(/from ['"]node:child_process['"]/);
    expect(
      source,
      'the fork seam imports the launcher and calls it',
    ).toMatch(/\bfork\s*\(/);
  });

  it('finds no IMPORT of a launcher outside the exemption, this guard included', async () => {
    // The narrower measurement, run with no exemption for this file. The scan
    // above has to skip `workspace-contract.test.ts` because the constants it
    // matches on are written here; nothing forces this file to contain an
    // import STATEMENT naming a launcher, so nothing here is exempt from that.
    const files = await moduleSources(PACKAGE_ROOT, GENERATED_DIRECTORIES);
    const offenders: string[] = [];

    for (const file of files) {
      const name = relative(PACKAGE_ROOT, file).replaceAll('\\', '/');

      for (const statement of importStatements(await readFile(file, 'utf8'))) {
        for (const primitive of EXEC_PRIMITIVES) {
          if (name === primitive.soleNamer) continue;
          const specifier = new RegExp(
            `['"](?:node:)?${primitive.specifier}['"]`,
          );
          if (specifier.test(statement)) {
            offenders.push(
              `${name}: ${statement.replace(/\s+/g, ' ')} — only ${primitive.soleNamer ?? '(no module)'} may import '${primitive.specifier}' (T-2-40)`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
