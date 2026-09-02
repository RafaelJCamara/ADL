import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptRecordSchema, type TranscriptRecord } from '@adl/core/stage';
import { nowIso } from '@adl/db';
import {
  openTranscriptWriter,
  readTranscriptFrom,
  readTranscriptTail,
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

  it('concurrent, unawaited appends land on disk in call order rather than racing on the shared file handle', async () => {
    // Mirrors the real caller shape that motivated queueing appends: a
    // synchronous loop (e.g. one stdout chunk translating to several
    // AgentEvents) that fires off several appends before awaiting any of
    // them. Node documents concurrent unawaited writes to one FileHandle as
    // order-unsafe — without an internal write queue this test is flaky by
    // construction; with one, it is deterministic.
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        const promises = [
          writer.append(record(1)),
          writer.append(record(2)),
          writer.append(record(3)),
          writer.append(record(4)),
          writer.append(record(5)),
        ];
        await Promise.all(promises);

        const read = await readTranscriptFrom(path, 0);
        expect(read.outcome).toBe('read');
        if (read.outcome === 'read') {
          expect(read.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
        }
      } finally {
        await writer.close();
      }
    });
  });

  it('a validation failure on one queued append rejects only that call — later appends still land', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        const good1 = writer.append(record(1));
        // seq must be a non-negative integer per TranscriptRecordSchema —
        // this call's promise must reject without poisoning the internal
        // write queue for the calls after it.
        const bad = writer.append(record(-1));
        const good2 = writer.append(record(2));

        await expect(good1).resolves.toBeTypeOf('number');
        await expect(bad).rejects.toThrow();
        await expect(good2).resolves.toBeTypeOf('number');

        const read = await readTranscriptFrom(path, 0);
        expect(read.outcome).toBe('read');
        if (read.outcome === 'read') {
          expect(read.records.map((r) => r.seq)).toEqual([1, 2]);
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

/**
 * `readTranscriptTail` (M06 step 6.8) — the third reader of this file, asking
 * a question the other two cannot: what is at the *end*.
 *
 * The properties that matter are the two `readTranscriptFrom` deliberately
 * does not have. A window starting at `size - maxBytes` lands mid-record for
 * every file bigger than the window, so the first partial line must be
 * discarded — and unlike the follow path, a line that does not parse is
 * skipped rather than thrown, because the caller is rendering a pull-request
 * comment and one bad line must not be what stops a human being told their
 * feature escalated.
 */
describe('readTranscriptTail (M06 step 6.8)', () => {
  it('returns every record when the whole file fits inside the window', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        for (const seq of [1, 2, 3]) await writer.append(record(seq));
      } finally {
        await writer.close();
      }

      const tail = await readTranscriptTail(path, 64 * 1024);
      expect(tail?.map((r) => r.seq)).toEqual([1, 2, 3]);
    });
  });

  it('drops the partial first record when the window starts mid-file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        for (const seq of [1, 2, 3, 4]) await writer.append(record(seq));
      } finally {
        await writer.close();
      }

      const size = (await stat(path)).size;
      // Deliberately sized to bisect the third record rather than to land on a
      // boundary — the two cases are asserted separately, because a single
      // "drop the first line when start > 0" rule passes this one and fails
      // the next.
      const oneRecord = size / 4;
      const tail = await readTranscriptTail(path, Math.floor(oneRecord * 2.5));

      // The bisected record is gone and no partial survived it. The point of
      // the assertion is the ABSENCE of a malformed entry, which is what a
      // naive slice would have produced.
      expect(tail?.map((r) => r.seq)).toEqual([3, 4]);
    });
  });

  it('keeps the first record when the window starts exactly on a record boundary', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      const offsets: number[] = [];
      try {
        for (const seq of [1, 2, 3, 4])
          offsets.push(await writer.append(record(seq)));
      } finally {
        await writer.close();
      }

      const size = (await stat(path)).size;
      // The exact byte after record 2's newline — so the window's first line
      // is record 3, whole. This is the case that makes an unconditional
      // "shift the first line when start > 0" a data-loss bug rather than a
      // harmless belt-and-braces: it would report [4] and drop a good record.
      const boundary = offsets[1] ?? 0;
      const tail = await readTranscriptTail(path, size - boundary);

      expect(tail?.map((r) => r.seq)).toEqual([3, 4]);
    });
  });

  it('skips a line it cannot parse and still returns the ones around it', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        await writer.append(record(1));
      } finally {
        await writer.close();
      }
      // Two distinct failures, because they fail at different layers: one is
      // not JSON at all, the other is JSON that is not a TranscriptRecord.
      await appendFile(path, 'not json at all\n', 'utf8');
      await appendFile(path, `${JSON.stringify({ seq: 2 })}\n`, 'utf8');
      const writer2 = await openTranscriptWriter(path);
      try {
        await writer2.append(record(3));
      } finally {
        await writer2.close();
      }

      const tail = await readTranscriptTail(path, 64 * 1024);
      expect(tail?.map((r) => r.seq)).toEqual([1, 3]);
      // The contrast that makes the leniency load-bearing rather than
      // incidental: the follow path throws on exactly this file.
      await expect(readTranscriptFrom(path, 0)).rejects.toThrow();
    });
  });

  it('reports undefined for a file that does not exist, and an empty array for one that is empty', async () => {
    await withTempDir(async (dir) => {
      // Two different facts about a failed run — "the agent wrote no
      // transcript" and "it wrote one and it is empty" — which the escalation
      // comment renders as two different sentences.
      expect(await readTranscriptTail(join(dir, 'missing.ndjson'), 1024)).toBe(
        undefined,
      );

      const path = join(dir, 'empty.ndjson');
      const writer = await openTranscriptWriter(path);
      await writer.close();
      expect(await readTranscriptTail(path, 1024)).toEqual([]);
    });
  });

  it('reports an empty array rather than throwing for a non-positive window', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'transcript.ndjson');
      const writer = await openTranscriptWriter(path);
      try {
        await writer.append(record(1));
      } finally {
        await writer.close();
      }
      // Unlike `readTranscriptFrom`'s offset, a zero window is not a caller
      // bug worth a named error — it is "show me nothing", and this renders a
      // comment rather than serving a stream.
      expect(await readTranscriptTail(path, 0)).toEqual([]);
      expect(await readTranscriptTail(path, -1)).toEqual([]);
    });
  });
});
