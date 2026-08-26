import type { RoundsTable } from '@adl/db';
import {
  RoundOutcomeSchema,
  SendBackBriefSchema,
  type SendBackBrief,
} from '@adl/core/verdict';

/**
 * `sendBackBriefFromClosedRound` / `parseSendBackBriefJson` — the two halves
 * of carrying a send-back verdict into the next developer prompt (LOOP-02,
 * M05 step 5.15).
 *
 * A worker cannot read `rounds.outcome_json` itself (`adl/worker-entry-no-db`),
 * so the brief has to travel on `AssignMessage` the way `pushUrl` and
 * `effectiveConfigJson` already do: the dispatcher reads it out of the
 * database and attaches it (`sendBackBriefFromClosedRound`), the worker reads
 * it back off the wire (`parseSendBackBriefJson`). Two different schemas on
 * two different payloads — `rounds.outcome_json` holds a whole `RoundOutcome`,
 * `AssignMessage.sendBackBriefJson` holds only the `brief` a `send_back`
 * outcome carries — so this module owns both rather than splitting them
 * across `scheduler/` and `worker-entry/`.
 *
 * Both directions degrade to `undefined` rather than throwing on malformed
 * input — the same "a fold that says less is much better than one that
 * throws" discipline `publish/role-rounds.ts`'s `describeRoundOutcome`
 * already established for this exact column. Losing the brief costs round
 * 2's developer a worse prompt (the pre-5.15 behaviour), never a broken
 * dispatch or a broken stage.
 */

/**
 * The brief the developer's NEXT dispatch should carry, derived from the
 * feature's most recently CLOSED round.
 *
 * `undefined` for every case that is not "the prior round sent work back":
 * no round has closed yet (round 1), or the round closed some other way
 * (`green`, `escalate`, `unverified` — none of which dispatch a developer
 * again), or the stored payload cannot be read as a `RoundOutcome` at all.
 *
 * Takes the row rather than reading it itself — `scheduler/dispatcher.ts` is
 * the caller with a `db` handle, and this module stays free of I/O so it can
 * be tested with plain fixtures.
 */
export function sendBackBriefFromClosedRound(
  round: RoundsTable | undefined,
): SendBackBrief | undefined {
  if (round === undefined || round.outcome_json === null) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(round.outcome_json);
  } catch {
    return undefined;
  }

  const parsed = RoundOutcomeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== 'send_back') return undefined;
  return parsed.data.brief;
}

/**
 * Read `AssignMessage.sendBackBriefJson` back into a `SendBackBrief`.
 *
 * `undefined` input (no brief attached — round 1, or any non-developer
 * dispatch) and malformed input (a payload that crossed the `fork()` IPC
 * boundary but does not parse, or does not match the schema) both resolve to
 * `undefined` — `worker-entry/stage-runner.ts` renders the same "no prior
 * feedback" placeholder either way, exactly as it would if this field had
 * never been sent.
 */
export function parseSendBackBriefJson(
  json: string | undefined,
): SendBackBrief | undefined {
  if (json === undefined) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }

  const parsed = SendBackBriefSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
