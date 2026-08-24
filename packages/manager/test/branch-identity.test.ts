import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  composeBranchFeatureId,
  decodeBranchFeatureId,
  folderNameOf,
  ulidOf,
} from '../src/branch-identity.js';

/**
 * DETECT-05 (5.6): a real dispatch's branch has to answer to two different
 * readers — GC's sweep wants the row's ULID back, and DETECT-05's restart
 * reconciliation wants the folder's basename back, precisely when the row
 * (and its ULID) is gone. This is the pure round-trip both depend on.
 */
describe('composeBranchFeatureId / decodeBranchFeatureId', () => {
  it('round-trips an ordinary folder name and ULID', () => {
    const id = ulid();
    const composed = composeBranchFeatureId('dark-mode', id);
    expect(composed).toBe(`dark-mode--${id}`);
    expect(decodeBranchFeatureId(composed)).toEqual({
      folderName: 'dark-mode',
      ulid: id,
    });
  });

  it('splits on the LAST "--", so a folder name containing its own hyphens still round-trips', () => {
    const id = ulid();
    const composed = composeBranchFeatureId('export--widgets-v2', id);
    expect(decodeBranchFeatureId(composed)).toEqual({
      folderName: 'export--widgets-v2',
      ulid: id,
    });
  });

  it('splits correctly even when the folder name ends in a hyphen right before the separator', () => {
    const id = ulid();
    // "foo-" + "--" + id -> "foo---" + id: three consecutive hyphens. The
    // rightmost "--" is still exactly the separator this module inserted,
    // because nothing after it (the ULID) ever contains a hyphen.
    const composed = composeBranchFeatureId('foo-', id);
    expect(composed).toBe(`foo---${id}`);
    expect(decodeBranchFeatureId(composed)).toEqual({
      folderName: 'foo-',
      ulid: id,
    });
  });

  it('returns undefined for a plain id with no separator — every pre-5.6 fixture and any non-ADL string', () => {
    expect(decodeBranchFeatureId(ulid())).toBeUndefined();
    expect(decodeBranchFeatureId('dark-mode')).toBeUndefined();
    expect(decodeBranchFeatureId('')).toBeUndefined();
  });

  it('returns undefined rather than a half-empty pair for a string that starts or ends with the separator', () => {
    expect(decodeBranchFeatureId('--only-a-suffix')).toBeUndefined();
    expect(decodeBranchFeatureId('only-a-prefix--')).toBeUndefined();
  });
});

/**
 * `ulidOf`/`folderNameOf` — the fallback-aware helpers every real call site
 * should use instead of `decodeBranchFeatureId(x)?.half`. A caller that
 * skips the fallback silently DROPS a bare, pre-5.6-shaped branch instead of
 * treating its whole value as the answer — exactly the bug this pair exists
 * to make structurally hard to reintroduce (both `gc-schedule.ts` and
 * `undeveloped.ts` had this asymmetry until it was caught in review).
 */
describe('ulidOf / folderNameOf', () => {
  it('recover their own half of a composed id', () => {
    const id = ulid();
    const composed = composeBranchFeatureId('dark-mode', id);
    expect(ulidOf(composed)).toBe(id);
    expect(folderNameOf(composed)).toBe('dark-mode');
  });

  it('fall back to the whole id for a bare, non-composed value — never undefined, never dropped', () => {
    const id = ulid();
    expect(ulidOf(id)).toBe(id);
    expect(folderNameOf('dark-mode')).toBe('dark-mode');
    // The same bare value answers to BOTH halves when it doesn't decode —
    // there is no way to tell "this is a ULID" from "this is a folder name"
    // once the row that would have disambiguated it is gone, which is
    // exactly the lost-row case this whole encoding exists for.
    expect(ulidOf('dark-mode')).toBe('dark-mode');
    expect(folderNameOf(id)).toBe(id);
  });
});
