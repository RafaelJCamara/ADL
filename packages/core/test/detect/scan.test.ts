import { describe, expect, it } from 'vitest';
import { scanFeatureFolders } from '../../src/detect/scan.js';

describe('scanFeatureFolders', () => {
  it('lists the distinct feature folders under featuresDir', () => {
    const paths = [
      'features/dark-mode/spec.md',
      'features/dark-mode/notes.md',
      'features/export-widgets/spec.md',
      'README.md',
      'src/index.ts',
    ];

    expect(scanFeatureFolders(paths, 'features')).toEqual([
      'dark-mode',
      'export-widgets',
    ]);
  });

  it('returns a sorted, deduplicated result', () => {
    const paths = [
      'features/zeta/spec.md',
      'features/alpha/spec.md',
      'features/alpha/other.md',
    ];

    expect(scanFeatureFolders(paths, 'features')).toEqual(['alpha', 'zeta']);
  });

  it('ignores a file sitting directly in featuresDir with no enclosing folder', () => {
    const paths = ['features/README.md', 'features/dark-mode/spec.md'];

    expect(scanFeatureFolders(paths, 'features')).toEqual(['dark-mode']);
  });

  it('ignores a literal featuresDir/ entry with an empty remainder', () => {
    expect(scanFeatureFolders(['features/'], 'features')).toEqual([]);
  });

  it('does not match a directory that merely shares a string prefix', () => {
    const paths = ['features-legacy/dark-mode/spec.md'];

    expect(scanFeatureFolders(paths, 'features')).toEqual([]);
  });

  it('takes only the first path segment past the prefix, however deep the folder goes', () => {
    const paths = ['features/dark-mode/nested/dir/spec.md'];

    expect(scanFeatureFolders(paths, 'features')).toEqual(['dark-mode']);
  });

  it('returns empty for an empty path list', () => {
    expect(scanFeatureFolders([], 'features')).toEqual([]);
  });

  it('accepts a featuresDir already carrying a trailing slash', () => {
    const paths = ['features/dark-mode/spec.md'];

    expect(scanFeatureFolders(paths, 'features/')).toEqual(['dark-mode']);
  });

  it('honours a non-default featuresDir', () => {
    const paths = ['work/dark-mode/spec.md', 'features/wrong-dir/spec.md'];

    expect(scanFeatureFolders(paths, 'work')).toEqual(['dark-mode']);
  });
});
