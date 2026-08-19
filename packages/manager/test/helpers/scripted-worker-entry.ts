// The forked process's own entry point for tests (D-30).
//
// This is a SEPARATE module from `../../src/worker-entry/index.ts` — it is
// the file `forkWorker` actually launches under test. It imports `runWorker`
// — a plain, non-side-effecting named export — from the real worker entry
// and passes it a scripted `StageRunner`. That is D-30 exactly: the actual
// process, the actual IPC handshake, the actual heartbeat loop and lease
// plumbing, with only the thing that would call an agent swapped for a
// scripted no-op. There is no `--fake` flag and no environment variable
// selecting a runner INSIDE the production module; this file is simply a
// second, real caller of `runWorker`.
//
// Configuration crosses the fork() boundary the only way data can: through
// the child's environment (`ADL_TEST_STAGE_DELAY_MS`), never a closure.
import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';

const delayMs = Number(process.env.ADL_TEST_STAGE_DELAY_MS ?? '150');

const stageRunner: StageRunner = async () => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    verdictJson: JSON.stringify({
      outcome: 'skip',
      summary: 'scripted worker — no agent in this phase',
      findings: [],
    }),
  };
};

runWorker({ stageRunner });
