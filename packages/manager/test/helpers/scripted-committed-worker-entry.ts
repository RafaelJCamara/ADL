// A scripted worker double reporting a real `StageRunnerVerdict` envelope
// (M05 step 5.10) — `scripted-worker-entry.ts`'s own `verdictJson` predates
// that envelope (`{outcome:'skip', ...}`, a `Verdict`-shaped placeholder) and
// so can never exercise `onDeveloperCommitted`. This double sends exactly
// the shape a real `createProductionStageRunner` returns for a real commit,
// with a fixed, test-recognisable sha — used to prove the supervisor's
// `stage_result` branch fires the new callback for a real commit and not for
// anything else.
//
// `runWorker(...)` at the bottom is a real top-level side effect (it
// registers this PROCESS's own `process.on('message')`/`'disconnect'`
// handlers) — matching every other file in this directory (`held-worker-entry.ts`,
// `scripted-worker-entry.ts`, ...), all of which exist ONLY to be launched by
// `child_process.fork()`, never imported by a test file directly. The fixed
// sha constant this module's own tests assert against therefore lives in
// `worker-harness.ts` instead (`SCRIPTED_COMMITTED_SHA`) — importing it from
// here would import this module's side effect into the test process itself.
import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';
import type { StageRunnerVerdict } from '../../src/worker-entry/stage-runner.js';
import { SCRIPTED_COMMITTED_SHA } from './worker-harness.js';

const delayMs = Number(process.env.ADL_TEST_STAGE_DELAY_MS ?? '50');

const stageRunner: StageRunner = async () => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const verdict: StageRunnerVerdict = {
    kind: 'developer_outcome',
    outcome: { kind: 'committed', sha: SCRIPTED_COMMITTED_SHA },
  };
  return { verdictJson: JSON.stringify(verdict) };
};

runWorker({ stageRunner });
