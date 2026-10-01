import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

/**
 * The prompt artifact appears at its final path only once it is complete.
 *
 * `writeFile` creates and truncates before it writes, so a reader that gates
 * on the file existing can read a prompt of zero bytes. That is not
 * hypothetical: it failed `determinism.test.ts` on the Windows CI leg
 * (`a.length=0, b.length=1858`) and reproduced 2 times in 3000 on an idle
 * machine. The race is a few microseconds wide, so this test does not try to
 * win it — it asserts the property that closes it: nothing ever opens the
 * FINAL path for writing.
 */

const written: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => {
      written.push(String(args[0]));
      return actual.writeFile(...args);
    }),
  };
});

const {
  PromptArtifactConflictError,
  writePromptArtifact,
  promptArtifactPathFor,
} = await import('../../src/prompt/artifact.js');

const dirs: string[] = [];

afterEach(async () => {
  written.length = 0;
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-prompt-atomic-'));
  dirs.push(dir);
  return dir;
}

function address() {
  return {
    featureId: `feat-${ulid()}`,
    roundId: `round-${ulid()}`,
    stageId: 'develop',
    stageIndex: 0,
    attempt: 1,
  } as const;
}

describe('writePromptArtifact is atomic', () => {
  it('never opens the final path for writing, and leaves no temp file behind', async () => {
    const r = await root();
    const a = address();
    const final = promptArtifactPathFor(r, a);

    const path = await writePromptArtifact(r, a, {
      systemPrompt: 'system',
      instructions: 'do the thing',
    });

    expect(path).toBe(final);
    expect(written).not.toContain(final);
    expect(written).toHaveLength(1);
    expect(JSON.parse(await readFile(final, 'utf8'))).toEqual({
      systemPrompt: 'system',
      instructions: 'do the thing',
    });
    expect(await readdir(dirname(final))).toEqual([
      final.slice(dirname(final).length + 1),
    ]);
  });

  it('an identical retry writes nothing at all', async () => {
    const r = await root();
    const a = address();
    const content = { systemPrompt: 's', instructions: 'i' };

    await writePromptArtifact(r, a, content);
    written.length = 0;
    await writePromptArtifact(r, a, content);

    expect(written).toEqual([]);
  });

  it('still refuses different content for the same attempt, and leaves the record alone', async () => {
    const r = await root();
    const a = address();
    const final = promptArtifactPathFor(r, a);

    await writePromptArtifact(r, a, {
      systemPrompt: 's',
      instructions: 'first',
    });
    const before = await readFile(final, 'utf8');

    await expect(
      writePromptArtifact(r, a, { systemPrompt: 's', instructions: 'second' }),
    ).rejects.toBeInstanceOf(PromptArtifactConflictError);

    expect(await readFile(final, 'utf8')).toBe(before);
    expect(await readdir(dirname(final))).toHaveLength(1);
  });
});
