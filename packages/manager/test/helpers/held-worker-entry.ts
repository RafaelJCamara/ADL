// The "held" worker double (03-09, D-32's scenario) — never completes its
// stage on its own.
//
// `scripted-worker-entry.ts` completes after `ADL_TEST_STAGE_DELAY_MS` and
// self-exits; `zombie-worker-entry.ts` suppresses self-termination to prove
// the fence against a *late* stale write. Neither answers what the D-32
// scenario needs: three workers captured *definitively* mid-round, with no
// timing window to race. `forkWorker` (`@adl/workspace`) builds a forked
// child's environment from a fixed allowlist plus whatever the caller passes
// on `ForkWorkerOptions.env` (WORK-06) — `createSupervisor.spawn` passes
// none, so `ADL_TEST_STAGE_DELAY_MS` never reaches a child forked through the
// supervisor at all, making that env var an unreliable way to hold a worker
// open for a scenario whose SIGKILL timing must be exact rather than merely
// probable.
//
// This double's `stageRunner` returns a promise that never resolves. Every
// other part of `runWorker` (D-01's heartbeat loop, D-28's `soft_stop`
// handling) is wired unconditionally in the real worker entry, so this
// process still heartbeats and would still exit cleanly on `soft_stop` — the
// only two ways it can ever stop are an external signal (`SIGKILL`, this
// scenario's own or the production boot-orphan kill's) or `soft_stop`,
// exactly the two the scenario exercises.
import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';

const stageRunner: StageRunner = () =>
  new Promise(() => {
    // Deliberately never resolves or rejects — see module docblock.
  });

runWorker({ stageRunner });
