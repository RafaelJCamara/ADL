import { runWorker } from '../../src/worker-entry/index.js';
import { createProductionStageRunner } from '../../src/worker-entry/stage-runner.js';

/**
 * The dev-run tracer's own worker entry (04-06) — the REAL production stage
 * runner (`createProductionStageRunner`), pointed at a scripted "claude" CLI
 * double instead of the real, billed one.
 *
 * Mirrors `scripted-worker-entry.ts`'s precedent exactly, and for the same
 * reason `worker-entry/index.ts`'s own docblock states it has NO `--fake`
 * flag and no environment variable selecting a runner: a flag on the
 * SHIPPED binary is a foot-gun on a real installation. So the shipped entry
 * point carries no test-only injection surface at all, and this SEPARATE
 * file does — `StartDaemonOptions.workerEntryPath` is the existing seam
 * that points a test daemon at it instead of the real one, matching how
 * `03-06`'s tracer already points at `scripted-worker-entry.ts` for its own
 * scripted double.
 *
 * The claude binary override travels via `ADL_TRACER_CLAUDE_BINARY_JSON` on
 * THIS process's own environment — set by the test through
 * `StartDaemonOptions.workerEnv` (04-06's own addition to
 * `SupervisorDeps`/`forkWorker`), never read by the real, shipped
 * `worker-entry/index.ts`.
 */

function readClaudeBinaryOverride(): readonly string[] | undefined {
  const raw = process.env['ADL_TRACER_CLAUDE_BINARY_JSON'];
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(
      'ADL_TRACER_CLAUDE_BINARY_JSON must be a JSON array of strings',
    );
  }
  return parsed;
}

const claudeBinary = readClaudeBinaryOverride();

runWorker({
  stageRunner: createProductionStageRunner({
    ...(claudeBinary !== undefined ? { claudeBinary } : {}),
    claudeCliPath: process.env['PATH'] ?? '',
  }),
});
