import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

/**
 * A real `pino` logger writing to an in-memory sink, for tests that need to
 * assert on a specific warn line's fields (D-09: "a captured warn record
 * contains the feature id, the presented token, and the current token") —
 * a level lower than `pino`'s own log-object shape would otherwise require
 * hand-rolling a fake that duck-types the whole `Logger` interface.
 */
export interface CapturedLog {
  readonly level: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

export interface CapturingLogger {
  readonly logger: Logger;
  readonly logs: readonly CapturedLog[];
}

export function createCapturingLogger(): CapturingLogger {
  const logs: CapturedLog[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        logs.push(JSON.parse(chunk.toString()) as CapturedLog);
      } catch {
        // A non-JSON line (should not happen with pino's default
        // transport-less output) is dropped rather than failing the test.
      }
      callback();
    },
  });
  const logger = pino({ level: 'debug' }, stream);
  return { logger, logs };
}
