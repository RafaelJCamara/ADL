import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptRecordSchema, type TranscriptRecord } from '@adl/core/stage';
import { nowIso } from '@adl/db';
import {
  openTranscriptWriter,
  readTranscriptFrom,
  transcriptLength,
  TranscriptOffsetError,
} from '../../src/index.js';

/**
 * Phase 4 Plan 05, Task 2: append-and-read with byte offsets a reader can
 * resume from — the primitive `ARCHITECTURE.md` §9's `?offset=N&follow=1`
 * addressing contract depends on.
 */

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-transcript-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function record(
  seq: number,
  overrides: Partial<TranscriptRecord> = {},
): TranscriptRecord {
  return {
    seq,
    at: nowIso(),
    event: {
      kind: 'usage',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
    ...overrides,
  };
}

describe('openTranscriptWriter', () => {
  it('creates the parent directory chain and then the file when it does not exist', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'nested', 'deeper', 'develop', '1.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        const stats = await stat(path);
        expect(stats.isFile()).toBe(true);
      } finally {
        await writer.close();
      }
    });
  });

  it('append returns a strictly increasing offset equal to the file size on disk after each call', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        const first = await writer.append(record(1));
        const statsAfterFirst = await stat(path);
        expect(first).toBe(statsAfterFirst.size);

        const second = await writer.append(record(2));
        const statsAfterSecond = await stat(path);
        expect(second).toBe(statsAfterSecond.size);
        expect(second).toBeGreaterThan(first);

        expect(writer.offset()).toBe(second);
      } finally {
        await writer.close();
      }
    });
  });

  it('advances the offset by the byte length of a multi-byte character in agent output, not the character count', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        const rec = record(1, {
          event: { kind: 'text', messageId: 'm1', delta: 'héllo 🚀' },
        });
        const offset = await writer.append(rec);
        const stats = await stat(path);
        expect(offset).toBe(stats.size);

        const serialised = `${JSON.stringify(TranscriptRecordSchema.parse(rec))}\n`;
        expect(offset).toBe(Buffer.byteLength(serialised, 'utf8'));
        // A multi-byte character makes the byte length strictly greater than
        // the UTF-16 string length — proof the offset tracks bytes, not
        // characters.
        expect(offset).toBeGreaterThan(serialised.length);
      } finally {
        await writer.close();
      }
    });
  });

  it('every appended record occupies exactly one line — splitting on newline yields one parseable record per non-empty line', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        await writer.append(record(1));
        await writer.append(record(2));
        await writer.append(record(3));
      } finally {
        await writer.close();
      }

      const content = await readFile(path, 'utf8');
      const lines = content.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(() =>
          TranscriptRecordSchema.parse(JSON.parse(line)),
        ).not.toThrow();
      }
    });
  });

  it('a reader sees appended records before the writer is closed', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        await writer.append(record(1));

        const read = await readTranscriptFrom(path, 0);
        expect(read.outcome).toBe('read');
        if (read.outcome === 'read') {
          expect(read.records).toHaveLength(1);
          expect(read.records[0]?.seq).toBe(1);
        }
      } finally {
        await writer.close();
      }
    });
  });
});

describe('readTranscriptFrom', () => {
  it('from offset 0 after three appends returns all three records and a next offset equal to the file size', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      await writer.append(record(1));
      await writer.append(record(2));
      const finalOffset = await writer.append(record(3));
      await writer.close();

      const read = await readTranscriptFrom(path, 0);
      expect(read.outcome).toBe('read');
      if (read.outcome === 'read') {
        expect(read.records.map((r) => r.seq)).toEqual([1, 2, 3]);
        expect(read.nextOffset).toBe(finalOffset);
        expect(read.nextOffset).toBe(await transcriptLength(path));
      }
    });
  });

  it('from the offset returned after two appends returns only the third record', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      await writer.append(record(1));
      const offsetAfterTwo = await writer.append(record(2));
      await writer.append(record(3));
      await writer.close();

      const read = await readTranscriptFrom(path, offsetAfterTwo);
      expect(read.outcome).toBe('read');
      if (read.outcome === 'read') {
        expect(read.records).toHaveLength(1);
        expect(read.records[0]?.seq).toBe(3);
      }
    });
  });

  it('a read taken while a record is only partially written returns no record and an unchanged offset; completing the line makes it visible exactly once', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      const afterFirst = await writer.append(record(1));

      const full = `${JSON.stringify(TranscriptRecordSchema.parse(record(2)))}\n`;
      const splitPoint = Math.floor(full.length / 2);

      // Simulate a write in progress: raw bytes with no trailing newline
      // yet, bypassing the writer's own atomic append().
      await appendFile(path, full.slice(0, splitPoint), 'utf8');

      const midWrite = await readTranscriptFrom(path, afterFirst);
      expect(midWrite.outcome).toBe('read');
      if (midWrite.outcome === 'read') {
        expect(midWrite.records).toEqual([]);
        expect(midWrite.nextOffset).toBe(afterFirst);
      }

      // Complete the line.
      await appendFile(path, full.slice(splitPoint), 'utf8');
      await writer.close();

      const completed = await readTranscriptFrom(path, afterFirst);
      expect(completed.outcome).toBe('read');
      if (completed.outcome === 'read') {
        expect(completed.records).toHaveLength(1);
        expect(completed.records[0]?.seq).toBe(2);
        expect(completed.nextOffset).toBe(await transcriptLength(path));
      }
    });
  });

  it('at an offset equal to the current file size returns a past-end outcome carrying the current length', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      const finalOffset = await writer.append(record(1));
      await writer.close();

      const read = await readTranscriptFrom(path, finalOffset);
      expect(read).toEqual({ outcome: 'past-end', length: finalOffset });
    });
  });

  it('on a path that does not exist returns an absent outcome rather than a thrown error', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'never-written.ndjson');
      const read = await readTranscriptFrom(path, 0);
      expect(read).toEqual({ outcome: 'absent' });
    });
  });

  it('a negative offset is refused with a named error rather than reaching the filesystem', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      await expect(readTranscriptFrom(path, -1)).rejects.toThrow(
        TranscriptOffsetError,
      );
    });
  });

  it('a non-integer offset is refused with a named error rather than reaching the filesystem', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      await expect(readTranscriptFrom(path, 1.5)).rejects.toThrow(
        TranscriptOffsetError,
      );
    });
  });

  it('a non-finite offset is refused with a named error rather than reaching the filesystem', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      await expect(
        readTranscriptFrom(path, Number.POSITIVE_INFINITY),
      ).rejects.toThrow(TranscriptOffsetError);
      await expect(readTranscriptFrom(path, Number.NaN)).rejects.toThrow(
        TranscriptOffsetError,
      );
    });
  });
});

describe('transcriptLength', () => {
  it('returns the current byte length of an existing transcript', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      const finalOffset = await writer.append(record(1));
      await writer.close();

      await expect(transcriptLength(path)).resolves.toBe(finalOffset);
    });
  });

  it('returns undefined when the file does not exist', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'never-written.ndjson');
      await expect(transcriptLength(path)).resolves.toBeUndefined();
    });
  });
});
