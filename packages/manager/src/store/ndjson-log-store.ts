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
 * "tell me when there is more". `04-08`'s follow loop
 * (`api/routes/logs.ts`) is built entirely on top of `readTranscriptFrom`,
 * polling it at a named interval; keeping the two apart is what let the
 * offset semantics here be tested exhaustively with no timer in this
 * module's own suite, and isolates the platform-dependent watch behaviour
 * `04-RESEARCH.md`'s Assumption A2 flags into the route, not this file.
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

  // Node documents concurrent, unawaited writes to one FileHandle as
  // unsafe — they are dispatched to the libuv threadpool independently, with
  // no guaranteed completion order. A caller whose event source can emit
  // several records before the first `append()` promise settles (the real
  // CLI-adapter case: one stdout chunk can translate to multiple AgentEvents
  // in one synchronous loop) would otherwise risk two records landing on
  // disk out of `seq` order, or interleaving mid-write into an invalid JSON
  // line. Chaining every append onto a private queue makes ordering
  // structural — true for every caller — rather than something each caller
  // must remember to `await` one at a time.
  //
  // The queue tail itself must never become a rejected promise: `.then()`
  // with no rejection handler propagates a rejection straight through
  // without running its callback, so one malformed record (a validation
  // failure, not an I/O failure) would silently stop every append after it
  // for the lifetime of this writer. Each turn therefore swallows its own
  // failure into the queue (`.catch(() => undefined)`) while still
  // rejecting the *caller's* promise for that specific append via a
  // separately-tracked result.
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    append(record: TranscriptRecord): Promise<number> {
      const result = writeQueue.then(async () => {
        // Validated here, not merely trusted from the caller: a malformed
        // record reaching JSON.stringify would still produce *a* line, just
        // not one `TranscriptRecordSchema.parse` could read back — catching
        // that at the write site is cheaper than discovering it at read time.
        const parsed = TranscriptRecordSchema.parse(record);
        const line = `${JSON.stringify(parsed)}\n`;
        await handle.appendFile(line, 'utf8');

        // Re-stat rather than accumulate `Buffer.byteLength(line)`: this is
        // what makes "the returned offset equals the file's size on disk"
        // true by construction rather than by an argument that the two
        // never drift apart.
        currentOffset = (await handle.stat()).size;
        return currentOffset;
      });
      writeQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    offset(): number {
      return currentOffset;
    },
    async close(): Promise<void> {
      // Drain any queued appends before closing — closing the handle out
      // from under a still-pending `appendFile` would fail that write.
      await writeQueue;
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

/**
 * The last whole records of the transcript at `path`, reading at most
 * `maxBytes` from the end of the file (M06 step 6.8).
 *
 * `readTranscriptFrom` cannot serve this. It is built for a *follower* — a
 * reader that holds an offset the writer handed it, so every byte from that
 * offset onward begins on a record boundary. A tail reader has no such
 * offset: `size - maxBytes` lands wherever it lands, which is mid-record for
 * every file bigger than the window. So the first partial line is discarded
 * here, and only here; the follow path's byte accounting is untouched.
 *
 * **Lenient where `readTranscriptFrom` is strict, deliberately.** That
 * function parses with `TranscriptRecordSchema.parse` and lets a malformed
 * line throw, which is right for a live view whose consumer can retry. This
 * one renders a **pull-request comment**: a single unreadable line must not
 * be the thing that stops a human being told their feature escalated, for
 * exactly the reason `publish/role-rounds.ts`'s `describeRoundOutcome` gives
 * about degrading rather than throwing while rendering a change request. A
 * line that does not parse is skipped and the rest are still returned.
 *
 * `undefined` — never an empty array — when the file does not exist, so a
 * caller can say "this attempt wrote no transcript" rather than "the agent
 * emitted nothing", which are different facts about a failed run.
 */
export async function readTranscriptTail(
  path: string,
  maxBytes: number,
): Promise<readonly TranscriptRecord[] | undefined> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return [];

  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return [];

    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    // Splitting the decoded string on '\n' is safe for the same reason
    // `readTranscriptFrom` states: 0x0A never appears as a UTF-8
    // continuation byte, so every split point is a newline the writer
    // emitted. A window starting mid-file may still begin mid-*character*,
    // which `toString('utf8')` renders as U+FFFD — harmless, because that
    // first line is dropped below as a partial record regardless.
    const lines = buffer.toString('utf8').split('\n');
    // Whatever followed the last newline: empty when the file ends on one
    // (the common case), the partial bytes of an in-flight write otherwise.
    lines.pop();

    // **The partial first line needs no special case, and must not get one.**
    // A window opened at `size - maxBytes` usually begins inside a record, and
    // the obvious fix — drop the first line whenever `start > 0` — is wrong:
    // the window sometimes lands exactly *on* a newline, and then that first
    // line is a whole record the drop would silently throw away. The lenient
    // parse below already handles both, and handles them correctly: a proper
    // suffix of a serialised record can never itself parse, because the outer
    // object's closing brace is present without its opening one, while a
    // record that starts on a boundary parses like any other. One mechanism,
    // right in both cases, instead of two that disagree at the boundary.
    const records: TranscriptRecord[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = TranscriptRecordSchema.safeParse(parsed);
      if (record.success) records.push(record.data);
    }
    return records;
  } finally {
    await handle.close();
  }
}
