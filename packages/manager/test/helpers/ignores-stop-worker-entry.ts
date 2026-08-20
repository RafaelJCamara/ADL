// A worker double that acknowledges `assign` but ignores every subsequent
// manager-to-worker message, `soft_stop` included — the D-28/T-3-33 "a
// worker that ignores soft_stop" scenario `test/control/kill.test.ts`
// exercises. Unlike `zombie-worker-entry.ts` (which self-exits after a
// fixed pause), this double never exits on its own; only an external
// SIGKILL stops it, which is exactly the forced path `stopWorker` must
// prove it takes.
//
// It still speaks the real, Zod-validated IPC contract — `parseManagerMessage`
// and the real `WorkerToManagerMessage` shapes — so the manager side under
// test sees exactly the same bytes a real worker would send.
import { parseManagerMessage } from '../../src/ipc/protocol.js';
import type { WorkerToManagerMessage } from '../../src/ipc/protocol.js';

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
    // Every subsequent message — soft_stop included — is deliberately
    // ignored. That is the whole point of this double.
    return;
  }

  send({
    t: 'ready',
    leaseToken: message.leaseToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
});
