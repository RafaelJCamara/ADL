/**
 * Port allocation (ROLE-07, M08 step 8.2).
 *
 * `ADL_PORT`'s own description — *"the port ADL allocated for the app under
 * test"* — has been in `ADL_VARIABLES` since M01 with nothing allocating
 * anything. Three properties matter, and the third is the one a reviewer would
 * not think to check.
 */
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { allocatePort } from '../../../src/worker-entry/app/port.js';

/** Will anything accept a TCP connection on this port? */
async function accepting(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (answer: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

describe('allocatePort', () => {
  it('answers with a port in the valid range', async () => {
    const allocation = await allocatePort();
    expect(allocation.ok).toBe(true);
    if (allocation.ok) {
      expect(allocation.port).toBeGreaterThan(0);
      expect(allocation.port).toBeLessThanOrEqual(65_535);
    }
  });

  it('has RELEASED the port by the time it answers', async () => {
    // The property the implementation resolves from inside `close()`'s callback
    // for, and the one that would be invisible in review: handing the app a port
    // ADL was still listening on makes every app fail to bind the very port ADL
    // told it to use — which looks exactly like an app whose start command is
    // wrong, and would be diagnosed as one.
    const allocation = await allocatePort();
    expect(allocation.ok).toBe(true);
    if (allocation.ok) {
      expect(await accepting(allocation.port)).toBe(false);
    }
  }, 20_000);

  it('does not hand out the same port twice in a row', async () => {
    // Not a guarantee the kernel makes, and not asserted as one: it is asserted
    // because a stubbed implementation returning a constant would pass every
    // other case in this file.
    const first = await allocatePort();
    const second = await allocatePort();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.port).not.toBe(second.port);
    }
  });
});
