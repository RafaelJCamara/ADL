import { readFileSync } from 'node:fs';
import { featuresRepository, type Database } from '@adl/db';
import { processIsAlive } from '@adl/workspace';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

/**
 * D-13/D-14: the boot-time orphan kill. `lease_owner` records the worker's
 * PID *and* process start time, and the kill signals a PID only when both
 * still match what was recorded — PIDs are reused, so a stale PID may
 * belong to an unrelated process by the time the daemon restarts. A control
 * plane that `SIGKILL`s an unrelated process on restart is not shippable —
 * ADL is installed on other teams' infrastructure.
 */

// ---------------------------------------------------------------------------
// Encoding — `lease_owner` stays a plain TEXT column, JSON inside it
// ---------------------------------------------------------------------------

/**
 * The worker identity a lease is held by. `startTime` is `null` when it
 * could not be read at record time (Windows — there is no `/proc`; D-33's
 * documented degradation) — a `null` is treated as **not attributable** by
 * {@link killBootOrphans}, never coerced into a match.
 */
export interface LeaseOwnerRecord {
  readonly pid: number;
  /** Boot-relative clock ticks (`/proc/<pid>/stat` field 22), as a string — meaningful only within one daemon uptime session (Pitfall 2). */
  readonly startTime: string | null;
}

export function encodeLeaseOwner(record: LeaseOwnerRecord): string {
  return JSON.stringify(record);
}

/**
 * Decode `lease_owner`. Returns `undefined` for `null`, unparseable JSON, or
 * a shape that is not a {@link LeaseOwnerRecord} — including the plain
 * descriptive string (`'manager'`) a lease briefly holds between being
 * acquired and the worker's `ready` message landing (see `daemon.ts`).
 * `undefined` is deliberately **not attributable**: `killBootOrphans` never
 * signals a PID it cannot decode a record for.
 */
export function decodeLeaseOwner(
  raw: string | null,
): LeaseOwnerRecord | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof (parsed as { pid: unknown }).pid === 'number' &&
      'startTime' in parsed &&
      (typeof (parsed as { startTime: unknown }).startTime === 'string' ||
        (parsed as { startTime: unknown }).startTime === null)
    ) {
      return parsed as LeaseOwnerRecord;
    }
  } catch {
    // Not JSON at all — undecodable, not attributable.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Process start time (D-14, Pattern 4)
// ---------------------------------------------------------------------------

export type ProcessStartTimeResult =
  | { readonly kind: 'available'; readonly startTime: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Read a process's start time in clock ticks since boot, from
 * `/proc/<pid>/stat` field 22 (0-indexed 21) on Linux.
 *
 * The value is boot-relative, not wall-clock — meaningful only within the
 * *same* boot session a value was previously recorded in, which is exactly
 * D-14's use case (a daemon comparing against a value it or its predecessor
 * recorded during the current uptime). Do not persist or compare these
 * values as though they were portable identifiers across a host reboot.
 *
 * On Windows (and any platform without `/proc`) this returns `unavailable`
 * with a stated reason — the documented degradation D-33/Phase 2's D-05/D-18
 * precedent establishes: `killBootOrphans` treats an unavailable start time
 * as not attributable, never as a license to signal on PID alone.
 */
export function readProcessStartTime(pid: number): ProcessStartTimeResult {
  if (process.platform !== 'linux') {
    return {
      kind: 'unavailable',
      reason: `process start time is only read from /proc on Linux (platform: ${process.platform})`,
    };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) is parenthesised and may itself contain spaces or
    // parens, so every field before it is unreliable to split on naively.
    // Splitting after the *last* ')' anchors on the one token that is
    // guaranteed not to appear inside `comm` at that position.
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return {
        kind: 'unavailable',
        reason: `could not parse /proc/${pid}/stat`,
      };
    }
    const rest = stat.slice(closeParen + 2).split(' ');
    // `rest[0]` is field 3 (state); field 22 is therefore index 22-3=19.
    const startTime = rest[19];
    if (startTime === undefined || startTime.length === 0) {
      return {
        kind: 'unavailable',
        reason: `could not parse /proc/${pid}/stat`,
      };
    }
    return { kind: 'available', startTime };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// The kill
// ---------------------------------------------------------------------------

export interface OrphanKillOutcome {
  readonly featureId: string;
  readonly pid: number;
  readonly outcome:
    'killed' | 'skipped-dead' | 'skipped-mismatch' | 'skipped-unattributable';
}

export interface KillBootOrphansDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  /** Defaults to `processIsAlive` from `@adl/workspace` — never a second liveness probe. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Defaults to {@link readProcessStartTime}. Injectable so a test can drive the "unavailable" case on every platform. */
  readonly readStartTime?: (pid: number) => ProcessStartTimeResult;
  /** Defaults to `process.kill(pid, 'SIGKILL')`. Injectable so a test can assert on the exact PID signalled without actually sending a signal. */
  readonly signal?: (pid: number) => void;
}

/**
 * Signal every still-running orphan worker from a previous daemon process,
 * before any lease is expired or any feature requeued (D-13 — this must run
 * while `lease_owner` still holds the PID; expiring first would lose it).
 *
 * A PID is signalled **only** when {@link processIsAlive} reports it alive
 * *and* its currently-read start time matches the recorded one exactly. Any
 * other case — dead, unattributable (start time unreadable), or a start-time
 * mismatch (PID reuse) — leaves the process alone, logs why, and reports the
 * outcome. Not signalling is always the safe direction: an orphan left
 * running is recoverable by an operator; killing an unrelated process on
 * someone else's infrastructure is not.
 */
export async function killBootOrphans(
  deps: KillBootOrphansDeps,
): Promise<readonly OrphanKillOutcome[]> {
  const isAlive = deps.isProcessAlive ?? processIsAlive;
  const readStart = deps.readStartTime ?? readProcessStartTime;
  const signal = deps.signal ?? ((pid: number) => process.kill(pid, 'SIGKILL'));

  const leased = await featuresRepository(deps.db).listLeased();
  const outcomes: OrphanKillOutcome[] = [];

  for (const feature of leased) {
    const record = decodeLeaseOwner(feature.lease_owner);
    if (record === undefined) continue; // no PID recorded at all — nothing to attribute
    const { pid } = record;

    if (!isAlive(pid)) {
      outcomes.push({ featureId: feature.id, pid, outcome: 'skipped-dead' });
      continue;
    }

    if (record.startTime === null) {
      deps.logger.warn(
        { featureId: feature.id, pid },
        'boot orphan kill: no start time was recorded for this lease (Windows degradation) — not attributable, leaving the process alone',
      );
      outcomes.push({
        featureId: feature.id,
        pid,
        outcome: 'skipped-unattributable',
      });
      continue;
    }

    const current = readStart(pid);
    if (current.kind === 'unavailable') {
      deps.logger.warn(
        { featureId: feature.id, pid, reason: current.reason },
        'boot orphan kill: process start time unavailable — not attributable, leaving the process alone',
      );
      outcomes.push({
        featureId: feature.id,
        pid,
        outcome: 'skipped-unattributable',
      });
      continue;
    }

    if (current.startTime !== record.startTime) {
      deps.logger.warn(
        {
          featureId: feature.id,
          pid,
          recordedStartTime: record.startTime,
          currentStartTime: current.startTime,
        },
        'boot orphan kill: PID reuse suspected (start time mismatch) — leaving the process alone',
      );
      outcomes.push({
        featureId: feature.id,
        pid,
        outcome: 'skipped-mismatch',
      });
      continue;
    }

    signal(pid);
    deps.logger.info(
      { featureId: feature.id, pid },
      'boot orphan kill: signalled a still-running worker from a previous daemon process',
    );
    outcomes.push({ featureId: feature.id, pid, outcome: 'killed' });
  }

  return outcomes;
}
