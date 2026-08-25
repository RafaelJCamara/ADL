/**
 * `readRoleRounds` — one role's round history, in the shape FORGE-06's
 * renderer takes (M05 step 5.11).
 *
 * **Derived, never remembered.** There is no `sticky_comments` table and no
 * new column: a role's comment is recomputed in full from `rounds`,
 * `stage_attempts`, `verdicts` and `findings` every time it is published, and
 * the forge's copy is simply overwritten. That is the same "evaluate state,
 * don't remember events" discipline `@adl/core/detect`'s undeveloped predicate
 * (5.2), DETECT-05's restart reconciliation (5.6), and 5.10's draft-CR
 * idempotency check already run on — and here it also buys the property a
 * remembered rendering could not: a comment edited by a human, or lost with a
 * deleted change request, is repaired by the next round rather than corrupted
 * by it.
 *
 * **Why a role is addressed by `stage_id` rather than by name.** A round's rows
 * are keyed by the pipeline entry that produced them (`stage_attempts.stage_id`
 * — `dispatchOnce` takes it from the snapshotted pipeline, never from a
 * literal), so "the developer's rounds" is "the rounds in which the pipeline's
 * first entry ran". Matching on a hardcoded `'develop'` here would be a second,
 * quietly disagreeing source of truth for a name `adl.yml` gets to choose.
 *
 * Verdict and finding rows are read even though **nothing writes them yet** —
 * the loop runner (5.13) and the command gate (5.14) are what will. Rendering
 * them is a dozen lines and is exercised by this module's own tests against
 * directly-inserted rows, so those steps inherit a pull-request surface instead
 * of having to add one; the alternative is that the first gate to produce a
 * verdict shows up on the change request as "1 attempt — completed".
 */
import type { Kysely } from 'kysely';
import type { Database } from '@adl/db';
import type { StickyRound } from '@adl/core/forge';
import { SeveritySchema } from '@adl/core/verdict';

/**
 * `blocker → major → minor → nit`, read off the schema's own declaration order
 * rather than restated here.
 *
 * `@adl/core`'s `sortFindings` orders findings exactly this way, and for a
 * reason that applies verbatim to a comment republished every round: without a
 * total order, equal-severity findings come out in whatever order the gate
 * emitted them, so a comment re-rendered from an unchanged set of findings
 * churns anyway. `sortFindings` itself takes a parsed `Finding`, which these
 * database rows are not, so the order is rebuilt from the same source of truth
 * instead of the rows being inflated into `Finding`s just to sort them.
 */
const SEVERITY_RANK = new Map<string, number>(
  SeveritySchema.options.map((severity, index) => [severity, index]),
);

/**
 * Detail the publishing event itself carries that no table records.
 *
 * Today there is exactly one: the commit sha a `developer_outcome: committed`
 * reports. Scoped to a single `roundId` rather than applied to "the latest
 * round" because the supervisor knows exactly which round its worker was
 * assigned, and "latest" is a guess that is wrong the moment two rounds are
 * ever in flight.
 *
 * **A note lives only as long as its round is the newest one**, and M05 step
 * 5.13 narrowed that rather than removing it. A finished round now renders its
 * real result from `rounds.outcome_json` — {@link describeRoundOutcome} — so a
 * fold no longer degrades to a bare `send_back`. The **sha** specifically is
 * still not read back, because the debt item that owned this
 * (`docs/plan/DEBT.md` D-5-11-1) rested on a premise that turned out to be
 * false: `RoundOutcome` has no field for a commit, so writing the real outcome
 * could never have carried one. Its durable home is a `rounds.head_sha`
 * column — a migration, and one with a second consumer waiting (a gate needs
 * the diff between the base and exactly that commit), which is why it belongs
 * to the step that adds the gate rather than being smuggled in here.
 */
export interface RoundNote {
  readonly roundId: string;
  /** Prepended to that round's rendered body. */
  readonly line: string;
  /** Used instead of the derived headline for that round. */
  readonly headline: string;
}

/** Collapse whitespace: a summary, title or error kind is inlined into a single markdown line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface AttemptRow {
  readonly roundId: string;
  readonly roundNumber: number;
  readonly roundOutcome: string | null;
  readonly roundOutcomeJson: string | null;
  readonly attempt: number;
  readonly status: string;
  readonly errorKind: string | null;
  readonly verdictId: string | null;
  readonly verdictOutcome: string | null;
  readonly verdictSummary: string | null;
  readonly verdictReason: string | null;
}

interface FindingRow {
  readonly verdictId: string;
  readonly fingerprint: string;
  readonly severity: string;
  readonly title: string;
  readonly path: string | null;
  readonly line: number | null;
}

function attemptLabel(row: AttemptRow): string {
  if (row.verdictOutcome !== null) {
    const detail = row.verdictSummary ?? row.verdictReason;
    return detail === null
      ? `**${row.verdictOutcome}**`
      : `**${row.verdictOutcome}** — ${oneLine(detail)}`;
  }
  if (row.status === 'error') {
    return row.errorKind === null
      ? 'errored'
      : `errored (\`${oneLine(row.errorKind)}\`)`;
  }
  if (row.status === 'running') return 'still running';
  return 'completed';
}

function describeAttempt(row: AttemptRow): string {
  return `- Attempt ${String(row.attempt)} — ${attemptLabel(row)}`;
}

function describeFinding(finding: FindingRow): string {
  // `path` is workspace-relative by contract (T-1-36) — a host path here would
  // leak the daemon's filesystem layout into a public change request. The
  // guard is upstream, at the writer; this renders what was stored.
  const where =
    finding.path === null
      ? ''
      : ` (\`${oneLine(finding.path)}${finding.line === null ? '' : `:${String(finding.line)}`}\`)`;
  return `  - \`${oneLine(finding.severity)}\` ${oneLine(finding.title)}${where}`;
}

/**
 * A closed round's outcome, in the words a human folding it open wants —
 * read from `rounds.outcome_json`, which M05 step 5.13's round loop writes.
 *
 * `rounds.outcome` alone is the bare kind, so a prior round used to fold away
 * as `Round 1 — send_back` with no hint of *what* it sent back. The payload is
 * the difference between that and `send_back — 2 findings`, and it is the only
 * durable record of a finished round: the sticky comment is re-derived from the
 * database every time (see this module's own docblock), so anything not in a
 * column is simply gone by the next round.
 *
 * Falls back to the bare kind for a round closed before this column carried a
 * payload, or for JSON this build cannot read — a fold that says less is much
 * better than one that throws while rendering a pull request.
 */
function describeRoundOutcome(
  outcome: string,
  outcomeJson: string | null,
): string {
  if (outcomeJson === null) return oneLine(outcome);
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcomeJson) as unknown;
  } catch {
    return oneLine(outcome);
  }
  if (typeof parsed !== 'object' || parsed === null) return oneLine(outcome);

  const payload = parsed as {
    kind?: unknown;
    reason?: unknown;
    brief?: { findings?: unknown };
    inconclusive?: unknown;
  };
  const findings = payload.brief?.findings;
  if (payload.kind === 'send_back' && Array.isArray(findings)) {
    return `send_back — ${String(findings.length)} finding${findings.length === 1 ? '' : 's'}`;
  }
  if (payload.kind === 'escalate' && typeof payload.reason === 'string') {
    return `escalate — ${oneLine(payload.reason)}`;
  }
  if (payload.kind === 'unverified' && Array.isArray(payload.inconclusive)) {
    const count = payload.inconclusive.length;
    return `unverified — ${String(count)} gate${count === 1 ? '' : 's'} could not tell`;
  }
  return oneLine(outcome);
}

function deriveHeadline(
  rows: readonly AttemptRow[],
  roundOutcome: string | null,
  roundOutcomeJson: string | null,
): string {
  const outcomes = rows
    .map((row) => row.verdictOutcome)
    .filter((outcome): outcome is string => outcome !== null);
  if (outcomes.length > 0) return outcomes[outcomes.length - 1] ?? '';
  if (roundOutcome !== null) {
    return describeRoundOutcome(roundOutcome, roundOutcomeJson);
  }

  const last = rows[rows.length - 1];
  if (last === undefined) return '';
  if (last.status === 'running') return 'in progress';
  if (last.status === 'error') {
    return last.errorKind === null
      ? 'errored'
      : `errored (${oneLine(last.errorKind)})`;
  }
  return rows.length === 1 ? '1 attempt' : `${String(rows.length)} attempts`;
}

/**
 * Every round in which `stageId` ran for `featureId`, oldest first.
 *
 * A round in which this role did not run at all is absent rather than empty —
 * the inner join is what decides that, and it is the right answer: a reviewer
 * that never ran in round 2 has nothing to say about round 2, and a fold
 * saying so is noise on a change request a human is reading.
 */
export async function readRoleRounds(
  db: Kysely<Database>,
  params: {
    readonly featureId: string;
    readonly stageId: string;
    readonly note?: RoundNote;
  },
): Promise<readonly StickyRound[]> {
  const rows: AttemptRow[] = await db
    .selectFrom('rounds')
    .innerJoin('stage_attempts', 'stage_attempts.round_id', 'rounds.id')
    .leftJoin('verdicts', 'verdicts.stage_attempt_id', 'stage_attempts.id')
    .select([
      'rounds.id as roundId',
      'rounds.number as roundNumber',
      'rounds.outcome as roundOutcome',
      'rounds.outcome_json as roundOutcomeJson',
      'stage_attempts.attempt as attempt',
      'stage_attempts.status as status',
      'stage_attempts.error_kind as errorKind',
      'verdicts.id as verdictId',
      'verdicts.outcome as verdictOutcome',
      'verdicts.summary as verdictSummary',
      'verdicts.reason as verdictReason',
    ])
    .where('rounds.feature_id', '=', params.featureId)
    .where('stage_attempts.stage_id', '=', params.stageId)
    .orderBy('rounds.number')
    .orderBy('stage_attempts.attempt')
    .execute();

  const verdictIds = rows
    .map((row) => row.verdictId)
    .filter((id): id is string => id !== null);
  // Guarded rather than always issued: Kysely renders an empty `in` list as
  // `in ()`, which SQLite rejects outright.
  const findings: FindingRow[] =
    verdictIds.length === 0
      ? []
      : await db
          .selectFrom('findings')
          .select([
            'verdict_id as verdictId',
            'fingerprint',
            'severity',
            'title',
            'path',
            'line',
          ])
          .where('verdict_id', 'in', verdictIds)
          .execute();

  const findingsByVerdict = new Map<string, FindingRow[]>();
  for (const finding of findings) {
    const bucket = findingsByVerdict.get(finding.verdictId) ?? [];
    bucket.push(finding);
    findingsByVerdict.set(finding.verdictId, bucket);
  }
  // Ordered here rather than in SQL: `order by severity` is text order, which
  // agrees with severity order for today's four values by coincidence alone —
  // a fifth value would silently sort into the wrong place.
  for (const bucket of findingsByVerdict.values()) {
    bucket.sort((a, b) => {
      const rank =
        (SEVERITY_RANK.get(a.severity) ?? SEVERITY_RANK.size) -
        (SEVERITY_RANK.get(b.severity) ?? SEVERITY_RANK.size);
      if (rank !== 0) return rank;
      return a.fingerprint < b.fingerprint
        ? -1
        : a.fingerprint > b.fingerprint
          ? 1
          : 0;
    });
  }

  const byRound = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    const bucket = byRound.get(row.roundId) ?? [];
    bucket.push(row);
    byRound.set(row.roundId, bucket);
  }

  const rounds: StickyRound[] = [];
  for (const [roundId, attempts] of byRound) {
    const first = attempts[0];
    if (first === undefined) continue;

    const noted =
      params.note !== undefined && params.note.roundId === roundId
        ? params.note
        : undefined;

    const lines: string[] = [];
    if (noted !== undefined) lines.push(noted.line, '');
    for (const attempt of attempts) {
      lines.push(describeAttempt(attempt));
      const attemptFindings =
        attempt.verdictId === null
          ? []
          : (findingsByVerdict.get(attempt.verdictId) ?? []);
      for (const finding of attemptFindings)
        lines.push(describeFinding(finding));
    }

    rounds.push({
      number: first.roundNumber,
      headline:
        noted?.headline ??
        deriveHeadline(attempts, first.roundOutcome, first.roundOutcomeJson),
      body: lines.join('\n'),
    });
  }

  return rounds;
}
