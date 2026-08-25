import { describe, expect, it } from 'vitest';
import { githubPushUrl, parseGithubRemoteUrl } from '../src/repo-ref.js';

describe('parseGithubRemoteUrl', () => {
  it('parses an https remote, with or without .git', () => {
    expect(parseGithubRemoteUrl('https://github.com/adl-org/adl.git')).toEqual({
      owner: 'adl-org',
      repo: 'adl',
    });
    expect(parseGithubRemoteUrl('https://github.com/adl-org/adl')).toEqual({
      owner: 'adl-org',
      repo: 'adl',
    });
  });

  it('parses an https remote carrying its own credential', () => {
    expect(
      parseGithubRemoteUrl(
        'https://x-access-token:tok@github.com/adl-org/adl.git',
      ),
    ).toEqual({ owner: 'adl-org', repo: 'adl' });
  });

  it('parses the scp-like ssh shorthand', () => {
    expect(parseGithubRemoteUrl('git@github.com:adl-org/adl.git')).toEqual({
      owner: 'adl-org',
      repo: 'adl',
    });
  });

  it('parses the ssh:// form', () => {
    expect(
      parseGithubRemoteUrl('ssh://git@github.com/adl-org/adl.git'),
    ).toEqual({ owner: 'adl-org', repo: 'adl' });
  });

  it('returns undefined for a non-GitHub host rather than guessing', () => {
    expect(
      parseGithubRemoteUrl('https://gitlab.com/adl-org/adl.git'),
    ).toBeUndefined();
  });

  it('returns undefined for a malformed URL rather than guessing', () => {
    expect(parseGithubRemoteUrl('not a url')).toBeUndefined();
    expect(parseGithubRemoteUrl('https://github.com/adl-org')).toBeUndefined();
  });
});

describe('githubPushUrl', () => {
  it('formats an x-access-token credentialed https URL', () => {
    expect(
      githubPushUrl({ token: 'tok-123', owner: 'adl-org', repo: 'adl' }),
    ).toBe('https://x-access-token:tok-123@github.com/adl-org/adl.git');
  });

  it('honors a host override for a test/mock remote', () => {
    expect(
      githubPushUrl({
        token: 'tok-123',
        owner: 'adl-org',
        repo: 'adl',
        host: '127.0.0.1:9999',
      }),
    ).toBe('https://x-access-token:tok-123@127.0.0.1:9999/adl-org/adl.git');
  });
});
