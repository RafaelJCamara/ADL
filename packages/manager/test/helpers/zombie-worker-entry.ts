// The D-31 zombie's own entry point — a SEPARATE, purpose-built double, not
// `runWorker` with a swapped-in `StageRunner` (contrast
// `scripted-worker-entry.ts`). The scenario needs two things `runWorker`
// structurally cannot give a test through its one injection point:
//
// 1. **No heartbeats at all, for a fixed pause.** `runWorker` starts its
//    heartbeat `setInterval` unconditionally on `assign`, driven by the
//    assign message's own `heartbeatIntervalMs` — there is no seam to
//    suppress it while still exercising the real heartbeat loop. This
//    double sends none, which is the honest shape of "the process paused":
//    a real paused agent process is not spending cycles heartbeating either.
// 2. **Self-termination structurally suppressed.** It never installs a
//    handler for anything the manager sends after `assign` — `soft_stop`,
//    `lease_lost`, or a channel disconnect all do nothing here, because this
//    scenario is about what the MANAGER does with a stale write, not about
//    whether a real worker would have stopped itself first (D-05 is already
//    covered end to end by `test/scheduler/reaper.test.ts`).
//
// It still speaks the real, Zod-validated IPC contract — `parseManagerMessage`
// and the real `WorkerToManagerMessage` shapes — so the manager side under
// test (the supervisor's message handler and `checkFence`) sees exactly the
// same bytes a real worker would send.
import { parseManagerMessage } from '../../src/ipc/protocol.js';
import type { WorkerToManagerMessage } from '../../src/ipc/protocol.js';

/** How long the zombie stays silent before reporting with its (by then stale) token. */
const PAUSE_MS = 400;

function send(message: WorkerToManagerMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

process.on('message', (raw: unknown) => {
  const parsed = parseManagerMessage(raw);
  if (!parsed.ok) return;
  const message = parsed.message;

  if (message.t !== 'assign') {
    // D-31: every subsequent manager-to-worker message is deliberately
    // ignored — see the module docblock.
    return;
  }

  send({
    t: 'ready',
    leaseToken: message.leaseToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  setTimeout(() => {
    send({
      t: 'stage_result',
      leaseToken: message.leaseToken,
      roundId: 0,
      stageIndex: 0,
      verdictJson: JSON.stringify({
        outcome: 'skip',
        summary: 'D-31 zombie test double — reporting after its pause',
        findings: [],
      }),
    });
    process.exit(0);
  }, PAUSE_MS).unref?.();
});
