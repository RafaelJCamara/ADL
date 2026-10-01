/**
 * A keyed promise chain: tasks sharing a key run one at a time, in call order;
 * tasks with different keys do not wait for each other. Pure -- no timers, no
 * I/O, no dependency -- and no entry outlives the last task queued under its
 * key. Each `createKeyedSerialiser()` call owns an independent set of chains,
 * so the scope of the guarantee is exactly the scope of the instance a caller
 * holds.
 *
 * It exists to make a forge read-then-write atomic (D-7-05-1, D-7-05-2):
 * `githubForgeAdapter.upsertComment` serialises per (change request, key), and
 * the manager's `publishDraftChangeRequest` per (repository, branch). That is a
 * deliberately bounded guarantee, and the bound is the architecture's, not an
 * oversight: forge writes are manager-side (the worker holds no `ForgeAdapter`),
 * and the manager is one process, so one instance per writer is every writer
 * ADL has. It does NOT cover a second manager process against the same
 * repository.
 *
 * A task that rejects does not poison the chain: the rejection is returned to
 * its own caller and the next task for the key still runs.
 */
export type KeyedSerialiser = <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T>;

export function createKeyedSerialiser(): KeyedSerialiser {
  // Each value is a promise that never rejects and settles when the most
  // recently queued task for the key has finished.
  const tails = new Map<string, Promise<void>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      // Only the newest tail may clear the entry; an older one settling must
      // not drop a chain that has since grown.
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
