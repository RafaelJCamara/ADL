import { describe, expect, it } from 'vitest';
import { evaluateSpecTrust, type TrustInput } from '../../src/detect/trust.js';

const BASE_INPUT: TrustInput = {
  ref: 'main',
  defaultBranch: 'main',
  isFork: false,
  allowForkPRs: false,
  authorPermission: 'write',
};

describe('evaluateSpecTrust', () => {
  it('trusts a default-branch folder authored by a write-permission account', () => {
    expect(evaluateSpecTrust(BASE_INPUT)).toEqual({ kind: 'trusted' });
  });

  it('trusts an admin-permission author too', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, authorPermission: 'admin' }),
    ).toEqual({ kind: 'trusted' });
  });

  it('rejects a ref other than the default branch', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, ref: 'feature/some-branch' }),
    ).toEqual({ kind: 'untrusted', reason: 'non-default-branch' });
  });

  it('rejects a fork when fork PRs are not opted in', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, isFork: true, allowForkPRs: false }),
    ).toEqual({ kind: 'untrusted', reason: 'fork' });
  });

  it('accepts a fork when fork PRs are explicitly opted in, subject to the other checks', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, isFork: true, allowForkPRs: true }),
    ).toEqual({ kind: 'trusted' });
  });

  it('rejects an author the forge could not resolve to any account', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, authorPermission: 'unknown' }),
    ).toEqual({ kind: 'untrusted', reason: 'unresolvable-author' });
  });

  it('rejects a resolved author with read-only access', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, authorPermission: 'read' }),
    ).toEqual({ kind: 'untrusted', reason: 'insufficient-permission' });
  });

  it('rejects a resolved author with no access', () => {
    expect(
      evaluateSpecTrust({ ...BASE_INPUT, authorPermission: 'none' }),
    ).toEqual({ kind: 'untrusted', reason: 'insufficient-permission' });
  });

  it('checks the branch before the fork flag, and the fork flag before permission — the first failing check wins', () => {
    expect(
      evaluateSpecTrust({
        ref: 'other',
        defaultBranch: 'main',
        isFork: true,
        allowForkPRs: false,
        authorPermission: 'none',
      }),
    ).toEqual({ kind: 'untrusted', reason: 'non-default-branch' });

    expect(
      evaluateSpecTrust({
        ref: 'main',
        defaultBranch: 'main',
        isFork: true,
        allowForkPRs: false,
        authorPermission: 'none',
      }),
    ).toEqual({ kind: 'untrusted', reason: 'fork' });
  });
});
