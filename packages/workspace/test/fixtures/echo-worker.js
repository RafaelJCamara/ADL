/**
 * A minimal IPC echo child, forked by `test/exec/fork.test.ts`.
 *
 * Echoes whatever message it receives back to the parent, alongside its own
 * `process.env` — the second half of the reply is what lets the environment
 * test assert on absence: fork without naming a variable, and the reply's
 * `env` object simply does not contain it.
 *
 * Dependency-free and plain JavaScript, so it needs no build step to be
 * forkable directly from a test — `packages/workspace` compiles `src/`, not
 * `test/fixtures/`, and this file is never imported, only forked as its own
 * process.
 */
process.stdout.write('echo-worker: started\n');
process.stderr.write('echo-worker: started (stderr)\n');

process.on('message', (message) => {
  process.send?.({ echo: message, env: process.env });
});
