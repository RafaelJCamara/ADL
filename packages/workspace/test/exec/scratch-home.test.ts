import {
  access,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createScratchHome,
  destroyScratchHome,
  listScratchHomes,
  scratchHomeRoot,
} from '../../src/exec/scratch-home.js';
import { posixOnly } from '../helpers/platform.js';

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe('scratch home: create and destroy', () => {
  it('creates a directory whose name is not derivable from a feature id or the clock', async () => {
    const a = await createScratchHome();
    const b = await createScratchHome();

    try {
      expect(await exists(a.path)).toBe(true);
      expect(await exists(b.path)).toBe(true);

      // T-2-20: a predictable name lets a co-resident process pre-create the
      // directory or win a race to it. Two creations back to back — the case
      // `Date.now()`-based naming gets wrong — must differ.
      expect(a.path).not.toBe(b.path);
      expect(basename(a.path)).toMatch(/^adl-home-/);
      expect(basename(b.path)).toMatch(/^adl-home-/);
    } finally {
      await destroyScratchHome(a.path);
      await destroyScratchHome(b.path);
    }
  });

  it('takes the agent-written config with it', async () => {
    const home = await createScratchHome();
    const gitconfig = join(home.path, '.gitconfig');
    const npmrc = join(home.path, '.npmrc');

    await writeFile(gitconfig, '[core]\n\thooksPath = /tmp/evil\n');
    await writeFile(npmrc, 'registry=https://evil.example.invalid/\n');

    const teardown = await destroyScratchHome(home.path);

    // Gated on the reported outcome rather than asserted unconditionally:
    // removal is best-effort by this module's contract, and on Windows a
    // handle still open on the directory is a documented outcome, not a bug
    // (02-RESEARCH.md § Pitfall 6, § Pattern 6).
    expect(teardown.outcome).toBe('removed');
    if (teardown.outcome === 'removed') {
      expect(await exists(gitconfig)).toBe(false);
      expect(await exists(npmrc)).toBe(false);
      expect(await exists(home.path)).toBe(false);
    }
  });

  it('is safe to call twice, reporting the second as already absent', async () => {
    const home = await createScratchHome();

    const first = await destroyScratchHome(home.path);
    // No throw, and a distinguishable outcome. `Workspace.destroy()` and any
    // later GC backstop can both reach this; a teardown that must run exactly
    // once is one nobody can safely add a backstop to.
    const second = await destroyScratchHome(home.path);

    expect(first.outcome).toBe('removed');
    expect(second.outcome).toBe('already-absent');
    expect(second.path).toBe(home.path);
  });

  it('never shares a directory between concurrent runs', async () => {
    // Created concurrently rather than sequentially: mkdtemp's race-freedom is
    // the property under test, and sequential creation cannot exercise it.
    const [one, two] = await Promise.all([
      createScratchHome(),
      createScratchHome(),
    ]);

    try {
      expect(one.path).not.toBe(two.path);

      const survivor = join(two.path, '.npmrc');
      await writeFile(survivor, 'registry=https://registry.npmjs.org/\n');
      await writeFile(join(one.path, '.npmrc'), 'registry=https://other/\n');

      const teardown = await destroyScratchHome(one.path);
      expect(teardown.outcome).toBe('removed');

      // Tearing one workspace down must not touch another's HOME — the failure
      // mode a shared or parent-directory-scoped teardown would produce.
      expect(await exists(two.path)).toBe(true);
      expect(await readFile(survivor, 'utf8')).toContain('registry.npmjs.org');
    } finally {
      await destroyScratchHome(two.path);
    }
  });

  it('reports rather than throws when something still holds the directory', async () => {
    const home = await createScratchHome();
    const held = join(home.path, 'held-open.txt');
    await writeFile(held, 'a child was writing here when the round ended\n');

    const handle = await open(held, 'r');

    try {
      // Deliberately asserted as "resolves and reports", not as a fixed
      // outcome. On Windows an open handle makes removal fail with EBUSY/EPERM
      // — the reproduced case this retry loop exists for — while on POSIX an
      // open handle does not prevent unlink at all and removal simply succeeds.
      // Pinning either one would make the suite red on the other platform,
      // which is the same trap Pitfall 6 sets for the emptiness assertion.
      const teardown = await destroyScratchHome(home.path);

      expect(['removed', 'not-removed']).toContain(teardown.outcome);
      expect(teardown.path).toBe(home.path);

      if (teardown.outcome === 'not-removed') {
        // The operator has to be able to find the leaked directory, so the
        // result names it and says why. A swallowed failure would leave a temp
        // directory nobody knows about.
        expect(teardown.reason).not.toBe('');
        expect(teardown.attempts).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await handle.close();
      await destroyScratchHome(home.path);
    }
  });

  it("creates every home inside ADL's own root, not loose in the temp directory", async () => {
    const home = await createScratchHome();

    try {
      // CR-03: loose under a world-readable `/tmp`, every live home's name is
      // one `ls` away, and the shared worker group makes the name the only
      // thing standing between one feature's agent and another's HOME. Inside
      // a root the group can traverse but not list, `mkdtemp`'s
      // unpredictability is a control again rather than a decoration.
      expect(dirname(home.path)).toBe(scratchHomeRoot());
      expect(basename(scratchHomeRoot())).toBe('adl-homes');
      expect(await exists(scratchHomeRoot())).toBe(true);
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('keeps the ownership record BESIDE the home, never inside it', async () => {
    const home = await createScratchHome();

    try {
      // Inside would be a file the agent — and, while one worker identity is
      // shared by every concurrent feature, any *other* feature's agent — can
      // rewrite. A marker naming a dead pid is a request to the sweep to delete
      // the directory, so a writable one is a way to ask ADL to destroy a
      // running feature's HOME. The home therefore starts EMPTY.
      expect(await readdir(home.path)).toEqual([]);

      // Mirrors `ownerFileFor` in src/exec/scratch-home.ts.
      const marker = `${home.path}.owner`;
      expect(await exists(marker)).toBe(true);
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
        pid: process.pid,
      });

      // And the inventory the GC backstop reads finds both halves.
      const found = (await listScratchHomes()).find(
        (entry) => entry.path === home.path,
      );
      expect(found?.owner).toEqual({ pid: process.pid });
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('takes the ownership record with the home at teardown', async () => {
    const home = await createScratchHome();
    const marker = `${home.path}.owner`;

    const teardown = await destroyScratchHome(home.path);

    expect(teardown.outcome).toBe('removed');
    // A marker left behind would accumulate in the root forever, and — worse —
    // would still be there if the OS ever handed the same name out again.
    expect(await exists(marker)).toBe(false);
    expect((await listScratchHomes()).map((entry) => entry.path)).not.toContain(
      home.path,
    );
  });

  it('gives the root no group or world permission of its own', async (ctx) => {
    const gate = posixOnly(
      "the scratch-home root's containment is POSIX mode bits, and fs.Stats.mode on Windows reports the read-only attribute rather than permissions",
      'CR-03',
    );
    if (gate.kind === 'skip') {
      ctx.skip(gate.reason);
      return;
    }

    const home = await createScratchHome();

    try {
      const info = await stat(scratchHomeRoot());
      const mode = info.mode & 0o777;

      // 0700 as created. `applyWorkerAccess` adds group `--x` — traverse only —
      // when and only when the privilege drop is actually in force, so the
      // resting state carries no group or world bit at all.
      expect(mode & 0o007, `world bits on ${scratchHomeRoot()}`).toBe(0);
      expect(mode & 0o060, `group read/write on ${scratchHomeRoot()}`).toBe(0);
      expect(mode & 0o700).toBe(0o700);
    } finally {
      await destroyScratchHome(home.path);
    }
  });

  it('reports an unremovable path instead of throwing', async () => {
    // The case above cannot force the failure branch on every platform: a plain
    // Node read handle does not block removal on this repository's own Windows
    // machine either (Node opens with FILE_SHARE_DELETE, verified locally), and
    // the reproduced EBUSY comes from a just-exited CHILD PROCESS holding the
    // directory — which a unit test cannot stage reliably. This one drives the
    // same branch deterministically and identically on every platform, so the
    // "returns a reason, never throws" contract has a guard that cannot go
    // quiet on a platform where the race stops reproducing.
    const teardown = await destroyScratchHome('\0not-a-real-path');

    expect(teardown.outcome).toBe('not-removed');
    if (teardown.outcome === 'not-removed') {
      expect(teardown.reason).toContain('ERR_INVALID_ARG_VALUE');
      // A non-transient error breaks out immediately rather than burning the
      // retry budget on something that cannot improve.
      expect(teardown.attempts).toBe(1);
    }
  });
});
