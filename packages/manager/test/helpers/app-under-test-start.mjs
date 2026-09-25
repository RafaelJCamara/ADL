/**
 * The `commands.start` of a real app under test (M08 step 8.2's tracer).
 *
 * It is deliberately **two** processes: a `node:cluster` primary — the direct child
 * ADL starts — and one worker, which is a real descendant. That shape is the whole
 * point of the reaping assertion. `exec/run.ts` passes `killDescendants: true` so a
 * killed child's subtree goes with it, and a single-process fixture would pass
 * whether or not that flag were there.
 *
 * ## Why `node:cluster` and not a plain spawn
 *
 * `adl/no-direct-spawn` bans `node:child_process` everywhere outside
 * `packages/workspace`, and it covers `.mjs` — it rejected the first version of
 * this file. Taking an exemption for a test double would be the wrong trade in a
 * rule whose exemption count is *measured* rather than argued
 * (`test/lint/no-restricted-imports.test.ts`); `blind-gate-probe.mjs` says the same
 * thing about itself.
 *
 * `cluster` is not a way round that. It is the realistic shape: a node app with a
 * primary and workers is precisely the multi-process app whose tree ADL has to
 * reap, and nothing in ADL's own code gains a spawn here. What it does reveal is a
 * real hole in the ban's specifier list — `node:cluster` and
 * `node:worker_threads` both reach the process table and neither is on it. That is
 * recorded in `DEBT.md` § 4 rather than exploited quietly.
 *
 * ## The primary serves, the worker just lives
 *
 * Inverted from the obvious arrangement, and for a measurable reason: when a
 * cluster worker calls `listen()`, the **primary** creates the listening socket and
 * distributes connections. So a worker-hosted server would make `portAccepting`
 * report on the primary, and the two observables would collapse into one. With the
 * primary serving, `app-teardown-witness.mjs` gets two independent facts — the
 * port (the direct child) and the worker's pid (the descendant).
 *
 * `PORT` comes from the environment, which is how `${ADL_PORT}` reaches the app:
 * `commands.start.env` is one of the two documented interpolation sites
 * (`adl-yml.ts` promise 2), and asserting that the number ADL allocated is the
 * number the server bound is what proves the whole chain.
 *
 * argv[2] — where to write the pid file, outside every workspace so teardown cannot
 *           take the evidence with it.
 */
import cluster from 'node:cluster';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT);

if (cluster.isPrimary) {
  const pidFile = process.argv[2];
  const worker = cluster.fork();

  createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, port }));
      return;
    }
    response.writeHead(404);
    response.end();
  }).listen(port, '127.0.0.1', () => {
    writeFileSync(
      pidFile,
      JSON.stringify({
        primary: process.pid,
        worker: worker.process.pid,
        port,
      }),
      'utf8',
    );
    // The `log` readiness probe's subject, if a fixture ever declares one. Written
    // after the pid file so a reader of the transcript knows the file exists by the
    // time this line appears.
    console.log(
      `ADL_APP_LISTENING ${port} primary=${process.pid} worker=${worker.process.pid}`,
    );
  });

  // Kept alive deliberately: `commands.start` describes a process that outlives its
  // own invocation. An app that exited here would be reported as
  // `app-exited-before-ready`, which is the right answer for an app that exits and
  // the wrong one for this fixture.
  setInterval(() => {}, 1_000);
} else {
  // The descendant. It does nothing but exist, which is all the reaping assertion
  // needs of it — and it deliberately does not listen, so the port stays an
  // observable of the primary alone.
  console.log(`ADL_APP_WORKER ${process.pid}`);
  setInterval(() => {}, 1_000);
}
