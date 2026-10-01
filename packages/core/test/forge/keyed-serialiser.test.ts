import { describe, expect, it } from 'vitest';
import { createKeyedSerialiser } from '../../src/forge/keyed-serialiser.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createKeyedSerialiser', () => {
  it('runs tasks sharing a key one at a time, in call order', async () => {
    const serialise = createKeyedSerialiser();
    const events: string[] = [];
    const gate = deferred();

    const first = serialise('k', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = serialise('k', async () => {
      events.push('second:start');
    });

    // Let anything that is going to run, run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('does not make different keys wait for each other', async () => {
    const serialise = createKeyedSerialiser();
    const gate = deferred();
    const blocked = serialise('a', () => gate.promise);

    await expect(serialise('b', async () => 'ran')).resolves.toBe('ran');

    gate.resolve();
    await blocked;
  });

  it('returns each task its own result', async () => {
    const serialise = createKeyedSerialiser();
    const results = await Promise.all([
      serialise('k', async () => 1),
      serialise('k', async () => 2),
    ]);
    expect(results).toEqual([1, 2]);
  });

  it('hands a rejection to its own caller only; the next task for the key still runs', async () => {
    const serialise = createKeyedSerialiser();
    const failing = serialise('k', async () => {
      throw new Error('boom');
    });
    const next = serialise('k', async () => 'still ran');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('still ran');
  });

  it('keeps working for a key after its chain has fully drained', async () => {
    const serialise = createKeyedSerialiser();
    await serialise('k', async () => 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(serialise('k', async () => 2)).resolves.toBe(2);
  });
});
