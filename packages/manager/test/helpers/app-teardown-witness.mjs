/**
 * `commands.teardown` for M08 step 8.2's tracer — and the **witness** that the
 * app's process tree was already reaped before it ran.
 *
 * ## Why the witness has to be this program
 *
 * The step's own watched-failing pass found the hole this file closes. With
 * `commands.teardown` running *before* the abort, deleting `controller.abort()`
 * from `lifecycle.ts` changed nothing any assertion could see: the worker process
 * exits when a dispatch ends, and execa's `cleanup: true` kills its subprocess
 * then, so the app died either way. The test was measuring execa's parent-exit
 * behaviour and reporting it as ADL's teardown.
 *
 * Reaping before teardown fixes the design *and* makes it observable: this
 * program runs while the worker is still alive, so if ADL had not reaped, the app
 * would still be listening right now. It reports what it finds to a file outside
 * every workspace, the way `blind-gate-probe.mjs` and `app-gate-probe.mjs` do —
 * nothing here asks ADL what it believes it did.
 *
 * ## The one residual, stated
 *
 * A pid can in principle be reused by the operating system between the reap and
 * this check, which would report a dead process as alive. The window is
 * milliseconds and the `portAccepting` field is an independent second observable,
 * so the two would have to be wrong together.
 *
 * argv[2] — the phase marker file, appended to so ORDER is observable.
 * argv[3] — the pid file the app wrote.
 * argv[4] — where to write the witness report.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const [, , markerPath, pidPath, witnessPath] = process.argv;

appendFileSync(markerPath, 'teardown\n', 'utf8');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function accepting(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const witness = {
  readPidFile: false,
  primaryAlive: null,
  workerAlive: null,
  portAccepting: null,
};

try {
  const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
  witness.readPidFile = true;
  witness.primaryAlive = alive(pids.primary);
  witness.workerAlive = alive(pids.worker);
  witness.portAccepting = await accepting(pids.port);
} catch (error) {
  witness.error = error instanceof Error ? error.message : String(error);
}

writeFileSync(witnessPath, JSON.stringify(witness, null, 2), 'utf8');

console.log(
  `ADL_APP_PHASE teardown primaryAlive=${witness.primaryAlive} workerAlive=${witness.workerAlive} portAccepting=${witness.portAccepting}`,
);
