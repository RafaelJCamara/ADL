import { createHash } from 'node:crypto';

/**
 * sha256 of `input`, lowercase hex, 64 characters.
 *
 * `node:crypto` is a builtin computation rather than I/O, so it sits inside
 * `@adl/core`'s purity boundary deliberately (Architectural Responsibility
 * Map). Nothing here touches the filesystem, the network, or the environment.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
