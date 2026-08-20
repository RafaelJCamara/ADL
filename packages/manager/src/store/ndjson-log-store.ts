/**
 * The append-and-read primitive for one transcript file (`ARCHITECTURE.md`
 * §4, §9) — the only thing both the worker (appending as `AgentEvent`s
 * arrive) and the manager's HTTP route (serving `?offset=N&follow=1`, 04-08)
 * go through, so they share one understanding of where a byte offset points.
 *
 * **Byte offsets, not character offsets.** `04-RESEARCH.md`'s Architecture
 * Patterns §3 is explicit that offsets are counted with a byte-length
 * measurement — a multi-byte character in agent output would otherwise
 * desynchronise a reader resuming from a character count against a writer
 * that measured bytes. Every offset this module returns or accepts is a byte
 * count, verified against `Buffer.byteLength`/the filesystem's own reported
 * size, never `string.length`.
 *
 * **Whole records only.** A reader may land mid-line while the writer is
 * between a record's bytes and its terminating newline. `readTranscriptFrom`
 * never emits a record it cannot find a full line for, and never counts a
 * partial line's bytes toward the offset it returns — the partial bytes are
 * re-offered on the next read and emitted exactly once when the line
 * completes. This is what makes "reconnect without losing or duplicating
 * output" true (T-4-20); without it a reconnect either drops a record or
 * repeats one.
 *
 * **Discriminated outcomes, never a throw for an ordinary case.** Following
 * `ScratchHomeTeardown`'s three-outcome discipline
 * (`packages/workspace/src/exec/scratch-home.ts`): a reader attaching before
 * the transcript exists, or after the offset it holds, is ordinary — `adl
 * logs -f` has to tell "no new data yet" apart from "nothing will ever come",
 * which an empty array can never say honestly.
 *
 * **Append as records arrive.** `04-RESEARCH.md`'s anti-patterns name
 * buffering the whole transcript until the process exits as the thing that
 * makes a live view impossible and loses everything on a mid-run crash — the
 * exact failure this phase's success criterion 2 forbids.
 *
 * **What this module does NOT do.** No following, no watching, no timers —
 * this module answers "what is in the file from offset N" and nothing about
 * "tell me when there is more". `04-08` builds the follow loop on top of it;
 * keeping the two apart is what lets the offset semantics here be tested
 * exhaustively with no timer in the suite, and isolates the
 * platform-dependent watch behaviour `04-RESEARCH.md`'s Assumption A2 flags
 * into one place that is not this one.
 */
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TranscriptRecordSchema, type TranscriptRecord } from '@adl/core/stage';

/** The handle {@link openTranscriptWriter} returns. */
export interface TranscriptWriter {
  /**
   * Serialise `record` as one line and append it. Resolves to the file's new
   * byte length — precisely the offset a reader should ask for next.
   */
  append(record: TranscriptRecord): Promise<number>;
  /** The byte offset the next `append` will begin at (i.e. the current file length). */
  offset(): number;
  close(): Promise<void>;
}

/**
 * What {@link readTranscriptFrom} resolves to. Three named outcomes rather
 * than an empty array — see the module docblock.
 */
export type TranscriptRead =
  | {
      readonly outcome: 'read';
      /** Whole records only, in file order. Never includes a record whose trailing newline had not yet been written. */
      readonly records: readonly TranscriptRecord[];
      /** The offset the next read should resume from. */
      readonly nextOffset: number;
    }
  | {
      /** The file does not exist yet — an ordinary state for a reader attaching before the first event. */
      readonly outcome: 'absent';
    }
  | {
      /** `offset` is at or beyond the file's current length. `length` is what it actually is right now. */
      readonly outcome: 'past-end';
      readonly length: number;
    };

/** Thrown by {@link readTranscriptFrom} for an offset that can never be a valid byte position. */
export class TranscriptOffsetError extends Error {
  readonly offset: number;

  constructor(offset: number) {
    super(
      `transcript read offset must be a non-negative integer, got ${JSON.stringify(offset)}`,
    );
    this.name = 'TranscriptOffsetError';
    this.offset = offset;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Open (creating, if necessary) a transcript file for append, and the
 * directory chain above it — `transcriptPathFor` (Task 1) computes a path
 * before anything on disk backs it, so creating the chain is this function's
 * job, not the path builder's.
 */
export async function openTranscriptWriter(
  path: string,
): Promise<TranscriptWriter> {
  await mkdir(dirname(path), { recursive: true });

  // 'a': O_APPEND — every write lands at the current end of the file
  // regardless of this handle's own file position, which is what lets a
  // concurrent reader open the same path with its own handle and never
  // observe a write landing mid-file. Creates the file if it does not exist.
  const handle = await open(path, 'a');

  let currentOffset = (await handle.stat()).size;

  return {
    async append(record: TranscriptRecord): Promise<number> {
      // Validated here, not merely trusted from the caller: a malformed
      // record reaching JSON.stringify would still produce *a* line, just
      // not one `TranscriptRecordSchema.parse` could read back — catching
      // that at the write site is cheaper than discovering it at read time.
      const parsed = TranscriptRecordSchema.parse(record);
      const line = `${JSON.stringify(parsed)}\n`;
      await handle.appendFile(line, 'utf8');

      // Re-stat rather than accumulate `Buffer.byteLength(line)`: this is
      // what makes "the returned offset equals the file's size on disk"
      // true by construction rather than by an argument that the two never
      // drift apart.
      currentOffset = (await handle.stat()).size;
      return currentOffset;
    },
    offset(): number {
      return currentOffset;
    },
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

function assertValidOffset(offset: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new TranscriptOffsetError(offset);
  }
}

/**
 * Read whole records from `path` starting at byte `offset`. See the module
 * docblock for the three outcomes and the partial-line rule.
 */
export async function readTranscriptFrom(
  path: string,
  offset: number,
): Promise<TranscriptRead> {
  assertValidOffset(offset);

  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { outcome: 'absent' };
    throw error;
  }

  try {
    const { size } = await handle.stat();

    if (offset >= size) {
      return { outcome: 'past-end', length: size };
    }

    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);

    // Splitting the decoded string on '\n' is safe for byte-accounting
    // purposes: 0x0A never appears as a continuation byte inside a
    // multi-byte UTF-8 sequence, so every split point here is a genuine
    // newline the writer emitted, not a false match inside a character.
    const lines = buffer.toString('utf8').split('\n');
    // The last element is whatever followed the final newline in this read
    // — empty when the read ended exactly on a newline (the common case: all
    // available records are whole), and the partial bytes of an in-flight
    // write otherwise. Either way it is never counted toward `nextOffset`
    // and never parsed as a record.
    lines.pop();

    const records: TranscriptRecord[] = [];
    let consumedBytes = 0;
    for (const line of lines) {
      // +1 for the newline this line was split on — counted regardless of
      // whether the line parses, so `nextOffset` always advances past every
      // complete line this read saw.
      consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (line.length === 0) continue;
      records.push(TranscriptRecordSchema.parse(JSON.parse(line)));
    }

    return { outcome: 'read', records, nextOffset: offset + consumedBytes };
  } finally {
    await handle.close();
  }
}

/** The current byte length of the transcript at `path`, or `undefined` when it does not exist yet. */
export async function transcriptLength(
  path: string,
): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
}
