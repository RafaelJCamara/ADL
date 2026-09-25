/**
 * The port ADL allocates for the app under test (ROLE-07, M08 step 8.2).
 *
 * `ADL_VARIABLES`'s own description of `ADL_PORT` — *"the port ADL allocated for
 * the app under test"* — has been in the codebase since M01 with nothing
 * allocating anything. This is the allocator.
 *
 * ## Bind-zero-and-close, and the race it deliberately does not pretend to solve
 *
 * The only portable way to learn a free port is to ask the operating system for
 * one, and the only way to ask is to bind. So this binds `127.0.0.1:0`, reads
 * the port the kernel assigned, and closes the listener — after which the port
 * is free, and **anything on the machine may take it before the app does**.
 * M08 step 8.0's spike measured that this works (P4/P5); it cannot make the gap
 * disappear.
 *
 * Two things follow, and both are decisions rather than omissions:
 *
 * 1. **The window is not closed by holding the socket open.** Handing the app a
 *    port ADL is still listening on would make every app fail to bind, which is
 *    a worse failure than a rare collision.
 * 2. **A lost race is a *retry*, not an escalation.** M08's audit finding 6 is
 *    precisely this case: `inconclusive` completes the feature as
 *    `unrecoverable`, so mapping "the app never came up" to it would wake a human
 *    for a port collision. The lifecycle reports the fact
 *    ({@link AppLifecycleOutcome}) and step 8.3 owns the mapping.
 *
 * `127.0.0.1` rather than `0.0.0.0`, deliberately: an app under test is reachable
 * from the machine running it and from nowhere else, and a port that is free on
 * the loopback interface is the port the app will be told to bind.
 */
import { createServer } from 'node:net';

/** Why a port could not be allocated — reported, never thrown (rule 5). */
export interface PortAllocationFailure {
  readonly ok: false;
  readonly reason: string;
}

/** What {@link allocatePort} answers. */
export type PortAllocation =
  { readonly ok: true; readonly port: number } | PortAllocationFailure;

/**
 * Ask the kernel for a free loopback port and give it straight back.
 *
 * Never throws. A machine that cannot bind a loopback listener at all is a real
 * condition — an exhausted ephemeral range, a security product holding the
 * stack — and the caller has to be able to classify it rather than catch it out
 * of a lifecycle that is otherwise result-shaped.
 */
export async function allocatePort(): Promise<PortAllocation> {
  return await new Promise<PortAllocation>((resolve) => {
    const server = createServer();

    // Registered before `listen`, and it resolves rather than rejecting: the
    // error arrives asynchronously, so a `try`/`catch` around this function
    // would never see it.
    server.once('error', (error: Error) => {
      resolve({
        ok: false,
        reason: `could not bind a loopback listener to allocate a port: ${error.message}`,
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        // A string address is a pipe or a UDS, which `listen(0, host)` cannot
        // produce. Handled rather than asserted because the node typings admit
        // it and a non-null assertion here would be the one place in this file
        // the compiler was overruled.
        server.close(() => {
          resolve({
            ok: false,
            reason:
              'the allocated listener reported no numeric port, so there is no port to hand the app',
          });
        });
        return;
      }

      const { port } = address;
      // Resolved from inside the close callback, not beside it. Resolving early
      // would hand out a port while ADL still held it, and the app would then
      // fail to bind the very port ADL told it to use — which looks exactly like
      // an app whose start command is wrong.
      server.close(() => {
        resolve({ ok: true, port });
      });
    });
  });
}
