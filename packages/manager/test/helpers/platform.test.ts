import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requirePlatform,
  SKIP_PREFIX,
  windowsOnly,
  type PlatformGate,
} from './platform.js';

describe('requirePlatform', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips loudly when the current platform does not match, writing a greppable, requirement-id-bearing stderr line', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const result: PlatformGate = requirePlatform(
      'win32',
      'start-time verification reads /proc, which has no Windows subject (D-33)',
      'OBS-03',
      'linux',
    );

    expect(result.kind).toBe('skip');
    expect(write).toHaveBeenCalledTimes(1);

    const line = write.mock.calls[0]?.[0] as string;
    expect(line.startsWith(SKIP_PREFIX)).toBe(true);
    expect(line).toContain('[OBS-03]');
    expect(line).toContain('platform: linux');
  });

  it('returns run and writes nothing when the current platform matches', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const result = requirePlatform('win32', 'reason', 'OBS-03', 'win32');

    expect(result).toEqual({ kind: 'run' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('windowsOnly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a requirePlatform('win32', ...) convenience wrapper: skips off-Windows", () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = windowsOnly('needs a Windows subject', 'OBS-04', 'darwin');

    expect(result.kind).toBe('skip');
  });

  it('runs on win32', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = windowsOnly('needs a Windows subject', 'OBS-04', 'win32');

    expect(result).toEqual({ kind: 'run' });
  });
});
