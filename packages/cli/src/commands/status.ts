import pc from 'picocolors';
import type { DaemonClient } from '../http-client.js';

/**
 * `adl status` — the shape `GET /features` returns, restated on the CLI side
 * so the table renderer has field names to reach for. Kept minimal for this
 * tracer: the full column set (D-23) and the resolved stage-name rendering
 * (D-22, `gating 2/4 (test)`) land with the full status view in a later plan.
 */
export interface FeatureRow {
  readonly id: string;
  readonly repoId: string;
  readonly state: string;
  readonly round: number;
  readonly stageIndex: number;
  readonly pipelineLength: number;
  readonly ageMs: number;
  readonly worker: { readonly pid: number } | null;
}

export interface StatusCommandOptions {
  readonly json: boolean;
}

/** A minimal write sink — real `process.stdout`, or a captured stream in tests. */
export interface WriteSink {
  write(chunk: string): void;
}

export interface StatusCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * `statusCommand` prints `GET /features`: `--json` emits the array verbatim,
 * the default prints a minimal table (D-24). Kept at the `picocolors` level
 * of formatting — no TUI, per the stack's rejection of Ink for a status
 * table.
 */
export async function statusCommand(
  options: StatusCommandOptions,
  deps: StatusCommandDeps,
): Promise<void> {
  const features = (await deps.client.getFeatures()) as readonly FeatureRow[];
  const out = deps.stdout ?? process.stdout;

  if (options.json) {
    out.write(`${JSON.stringify(features)}\n`);
    return;
  }

  if (features.length === 0) {
    out.write('No features in flight.\n');
    return;
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
  const rows = features.map((feature) => [
    feature.id,
    feature.repoId,
    feature.state,
    `${feature.stageIndex}/${feature.pipelineLength}`,
    String(feature.round),
    formatAge(feature.ageMs),
    feature.worker ? String(feature.worker.pid) : pc.dim('-'),
  ]);

  out.write(`${header.join('  ')}\n`);
  for (const row of rows) {
    out.write(`${row.join('  ')}\n`);
  }
}
