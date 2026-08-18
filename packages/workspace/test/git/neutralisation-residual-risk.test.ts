/**
 * What {@link NEUTRALISED_CONFIG} does NOT close, demonstrated (02-REVIEW.md
 * WR-12).
 *
 * The list was introduced as "Every executable configuration key". It is not,
 * and the gap is not a missing entry — it is a family of keys whose names the
 * ATTACKER chooses. `filter.<driver>.clean` / `.smudge` and
 * `diff.<driver>.textconv` / `.command` name programs git runs whenever a
 * `.gitattributes` entry selects that driver, and `<driver>` is arbitrary, so
 * `-c filter.x.clean=` closes one driver rather than the mechanism. There is no
 * `-c` override that disables the family: `core.attributesFile` only points the
 * GLOBAL attributes file somewhere inert and has no effect on a `.gitattributes`
 * committed in the repository or on `.git/info/attributes`.
 *
 * `manager-git.ts` now records this in prose, as
 * {@link NEUTRALISATION_RESIDUAL_RISK}. Prose is where an accepted risk goes to
 * be forgotten, so this file is the other half: the risk is **observed**, on the
 * production `snapshot()` path, with ADL's full neutralisation in force.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **THIS SUITE ASSERTS THAT A HOLE IS OPEN. READ THIS BEFORE "FIXING" IT RED.**
 *
 * If the case below starts failing, exactly one of two things has happened and
 * they want opposite responses:
 *
 * 1. **Someone closed the hole** — a new control in `adlGit`, a git release that
 *    stopped honouring a committed `.gitattributes` for filter drivers, or a
 *    per-driver override that actually generalises. That is good news. DELETE
 *    this case and delete the matching sentence from
 *    `NEUTRALISATION_RESIDUAL_RISK`, so the recorded risk and the code stop
 *    disagreeing.
 * 2. **The fixture stopped reaching the mechanism** — `node` is not on the
 *    child's `PATH`, the `.gitattributes` did not get committed, the tree was
 *    not dirty so `stash create` never had a blob to clean. Then the case is
 *    measuring nothing and should be repaired, not deleted. The assertion
 *    message names both, and the `filtered` control below tells them apart: it
 *    proves git really did apply the driver before anything is concluded from
 *    the probe.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why this is recorded rather than mitigated: the reachable surface here is
 * repository CONTENT, not configuration, and the control that actually answers
 * it is the one WORK-05 already provides — a worker that cannot write the
 * repository cannot commit a `.gitattributes` into ADL's base ref either. D-05
 * makes that Linux-only, which is exactly why the residual risk is stated as
 * residual rather than as covered.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NEUTRALISATION_RESIDUAL_RISK,
  NEUTRALISED_CONFIG,
} from '../../src/git/manager-git.js';
import { workspaceRegistry } from '../../src/registry.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

let repo: OpenedTempRepo;
/** Where the filter driver's program records that it ran. */
let probeSentinel: string;

/** Git parses configuration values with `\` as an escape; give it slashes. */
const asConfigPath = (path: string): string => path.replaceAll('\\', '/');

/**
 * The driver name, chosen by whoever wrote the `.gitattributes`.
 *
 * Deliberately not a name anything in ADL could have anticipated. That IS the
 * finding: a fixed `-c filter.<name>.clean=` list can only ever close names
 * somebody thought of first.
 */
const DRIVER = 'adlprobe';

beforeAll(async () => {
  repo = await openTempRepo();
  probeSentinel = join(repo.scratchRoot, '..', 'wr12-filter-fired');

  // A clean filter is a program git pipes the worktree file THROUGH on its way
  // into a blob. This one records that it ran and then behaves itself, so the
  // capture under test still produces the content it should — a probe that
  // corrupted the blob would fail the case for the wrong reason.
  const probe = join(repo.scratchRoot, '..', 'wr12-probe.cjs');
  await writeFile(
    probe,
    `const fs = require('node:fs');\n` +
      `fs.writeFileSync(${JSON.stringify(probeSentinel)}, 'FIRED\\n');\n` +
      `process.stdin.pipe(process.stdout);\n`,
    'utf8',
  );

  // Committed repository CONTENT selects the driver. This is the half no `-c`
  // override reaches.
  await writeFile(
    join(repo.mainRepo, '.gitattributes'),
    `tracked.txt filter=${DRIVER}\n`,
    'utf8',
  );
  await repo.git.add('.gitattributes');
  await repo.git.raw(['commit', '-m', 'attributes']);

  // And configuration names the program. Written straight into the file for the
  // reason `adl-git.test.ts` gives: that an agent can put it there is proven in
  // `poisoned-config.test.ts` and is not re-proven here — and `simple-git`
  // refuses this key by name anyway (`allowUnsafeFilter`).
  await appendFile(
    join(repo.mainRepo, '.git', 'config'),
    `[filter "${DRIVER}"]\n\tclean = node '${asConfigPath(probe)}'\n`,
    'utf8',
  );
});

afterAll(async () => {
  await repo.cleanup();
});

describe('the residual risk NEUTRALISED_CONFIG records but does not close', () => {
  it('names the wildcard driver families rather than implying they are covered', () => {
    // The prose half. Cheap, and it is what stops the word "every" coming back:
    // the residual-risk string has to keep naming the two families, and no
    // entry may quietly appear in the list claiming to have closed them.
    expect(NEUTRALISATION_RESIDUAL_RISK).toContain('filter.<driver>');
    expect(NEUTRALISATION_RESIDUAL_RISK).toContain('diff.<driver>');
    expect(NEUTRALISATION_RESIDUAL_RISK).toContain('.gitattributes');

    // A wildcard key cannot be neutralised by name, so none may be listed as if
    // it had been. If this fails, someone has added `filter.x.clean=` to the
    // list and closed exactly one driver while the table now reads as complete.
    const wildcardish = NEUTRALISED_CONFIG.filter((assignment) =>
      /^(filter|diff)\.[^.]+\.(clean|smudge|textconv|command)=/.test(
        assignment,
      ),
    );
    expect(
      wildcardish,
      'a per-driver override in NEUTRALISED_CONFIG closes one attacker-chosen name, not the mechanism — record it in NEUTRALISATION_RESIDUAL_RISK instead',
    ).toEqual([]);
  });

  it('executes a committed .gitattributes filter during snapshot(), overrides and all', async () => {
    const workspace = await workspaceRegistry().resolve('worktree').create({
      featureId: 'wr12-filter',
      mainRepo: repo.mainRepo,
      scratchRoot: repo.scratchRoot,
      baseRef: 'HEAD',
    });

    try {
      // Dirty the filtered file, so `git stash create` has a blob to write and
      // therefore a reason to run the clean filter. `git status` alone does NOT
      // reach it — git answers "modified" from cached stat data without ever
      // reading the content — which is why this case drives the real capture.
      await workspace.write('tracked.txt', 'mutated-for-the-filter\n');

      const handle = await workspace.snapshot();

      // The CONTROL, and it runs before anything is concluded: git must
      // actually have applied the driver. Without this, a `.gitattributes` that
      // never matched would leave no sentinel and the case would read as "the
      // hole is closed" while proving nothing at all.
      const filtered = await repo.git.raw([
        'check-attr',
        'filter',
        '--',
        'tracked.txt',
      ]);
      expect(
        filtered,
        'git does not consider tracked.txt to be driven by the filter, so this case is not reaching the mechanism it is about',
      ).toContain(DRIVER);

      let fired = false;
      try {
        fired = (await readFile(probeSentinel, 'utf8')).includes('FIRED');
      } catch {
        fired = false;
      }

      expect(
        fired,
        'The .gitattributes-driven filter did NOT run under ADL’s neutralisation. Read this file’s docblock before changing anything: either the hole was closed (delete this case AND the matching sentence in NEUTRALISATION_RESIDUAL_RISK) or the fixture stopped reaching the mechanism (repair it). The `filtered` control above passed, so git did select the driver.',
      ).toBe(true);

      await handle.release();
    } finally {
      await workspace.destroy();
    }
  });
});
