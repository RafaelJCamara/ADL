import pc from 'picocolors';

/**
 * `src/render/status-table.ts` — the table `adl status` renders (D-22..25).
 *
 * Restated here rather than imported, matching `commands/status.ts`'s own
 * existing pattern (and `http-client.ts`'s docblock): `@adl/cli` speaks HTTP
 * only, so the shape `GET /features` returns is a local type, not an import
 * from `@adl/manager`.
 */

/** The stage cell `GET /features` returns — `@adl/manager`'s `StageCell`, restated. */
export interface StageCellView {
  readonly state: string;
  readonly position?: number;
  readonly pipelineLength?: number;
  readonly name?: string;
  readonly label: string;
}

export interface FeatureRow {
  readonly id: string;
  readonly repoId: string;
  readonly path: string;
  readonly state: string;
  readonly stage: StageCellView;
  readonly round: number;
  readonly ageMs: number;
  readonly worker: { readonly pid: number } | null;
  readonly staleRejections: number;
}

/** `12s`, `34m`, `5h` — coarse enough to scan, never fractional. */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/** A ULID is 26 characters — long enough to make every row wrap a narrow terminal. Truncated for the table; `--json` always carries the full id. */
export function truncateId(id: string, length = 10): string {
  return id.length > length ? id.slice(0, length) : id;
}

/**
 * `renderStatusTable(rows)` — `--json`'s table-form sibling. Columns, in
 * order: feature, repo, state, stage, round, age, worker (criterion 1's
 * three required fields plus the context that makes them actionable).
 *
 * The empty case renders one explanatory line, never a bare header — a
 * header with nothing under it reads as a rendering bug, and this command's
 * whole job is to be readable at a glance (D-24).
 */
export function renderStatusTable(rows: readonly FeatureRow[]): string {
  if (rows.length === 0) {
    return 'No features in flight.\n';
  }

  const header = [
    'FEATURE',
    'REPO',
    'STATE',
    'STAGE',
    'ROUND',
    'AGE',
    'WORKER',
  ];
  const lines = rows.map((row) => [
    truncateId(row.id),
    row.repoId,
    row.state,
    row.stage.label,
    String(row.round),
    formatAge(row.ageMs),
    row.worker ? String(row.worker.pid) : pc.dim('-'),
  ]);

  return [header, ...lines].map((cols) => cols.join('  ')).join('\n') + '\n';
}
