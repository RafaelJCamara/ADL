import { describe, expect, it } from 'vitest';
import { undevelopedFeatureFolders } from '../../src/detect/undeveloped.js';

describe('undevelopedFeatureFolders', () => {
  it('returns a scanned folder with no known row and no open change request', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['dark-mode'],
      knownFolders: [],
      openChangeRequestFolders: [],
    });

    expect(result).toEqual(['dark-mode']);
  });

  it('excludes a scanned folder that already has a features row', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['dark-mode', 'export-widgets'],
      knownFolders: ['dark-mode'],
      openChangeRequestFolders: [],
    });

    expect(result).toEqual(['export-widgets']);
  });

  it('excludes a scanned folder with an open change request even without a known row — the DB-loss reconciliation case', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['dark-mode', 'export-widgets'],
      knownFolders: [],
      openChangeRequestFolders: ['dark-mode'],
    });

    expect(result).toEqual(['export-widgets']);
  });

  it('excludes a folder covered by either check, keeps the rest, in scan order', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['alpha', 'beta', 'gamma', 'delta'],
      knownFolders: ['beta'],
      openChangeRequestFolders: ['delta'],
    });

    expect(result).toEqual(['alpha', 'gamma']);
  });

  it('returns empty when every scanned folder is already known or open', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['dark-mode', 'export-widgets'],
      knownFolders: ['dark-mode'],
      openChangeRequestFolders: ['export-widgets'],
    });

    expect(result).toEqual([]);
  });

  it('returns empty for an empty scan, regardless of known or open folders', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: [],
      knownFolders: ['dark-mode'],
      openChangeRequestFolders: ['export-widgets'],
    });

    expect(result).toEqual([]);
  });

  it('ignores a known or open folder that is not currently scanned — cross-references never add folders, only remove them', () => {
    const result = undevelopedFeatureFolders({
      scannedFolders: ['dark-mode'],
      knownFolders: ['removed-feature'],
      openChangeRequestFolders: ['another-removed-feature'],
    });

    expect(result).toEqual(['dark-mode']);
  });
});
