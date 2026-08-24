import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostGitWorkspace } from '@adl/workspace';
import {
  ADL_YML_PATH,
  AdlYmlUnavailableError,
  resolveProductionAdlYml,
} from '../../src/config/resolve-adl-yml.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';

/**
 * M05 step 5.4 — `resolveProductionAdlYml`'s own unit coverage: read, parse,
 * and refuse, driven with an injected `readFile` so none of it needs a real
 * repository on disk. The one case that DOES need a real repository (proving
 * the wiring against a real `Workspace.read()`) is its own `describe` block
 * below, over `withTempRepo`'s real `mainRepo`.
 */

const VALID_ADL_YML = `
version: 1
commands:
  build: { argv: [npm, ci] }
  start: { argv: [npm, start] }
  test: { argv: [npm, test] }
  teardown: { argv: [docker, compose, down] }
pipeline: [develop]
limits:
  budget_usd: 42
`;

describe('resolveProductionAdlYml — injected readFile', () => {
  it('reads the default path (adl.yml) and returns a parsed, validated config', async () => {
    const seen: string[] = [];
    const outcome = await resolveProductionAdlYml({
      readFile: (path) => {
        seen.push(path);
        return Promise.resolve(VALID_ADL_YML);
      },
    });

    expect(seen).toEqual([ADL_YML_PATH]);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.config.pipeline).toEqual(['develop']);
      expect(outcome.config.limits.budget_usd).toBe(42);
    }
  });

  it('honours a custom path override', async () => {
    const seen: string[] = [];
    const outcome = await resolveProductionAdlYml({
      path: 'config/adl.yml',
      readFile: (path) => {
        seen.push(path);
        return Promise.resolve(VALID_ADL_YML);
      },
    });

    expect(seen).toEqual(['config/adl.yml']);
    expect(outcome.kind).toBe('resolved');
  });

  it('refuses with reason "unreadable" when the read itself fails, never throwing', async () => {
    const outcome = await resolveProductionAdlYml({
      readFile: () => Promise.reject(new Error('ENOENT: no such file')),
    });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('unreadable');
      expect(outcome.refusal.path).toBe(ADL_YML_PATH);
      expect(outcome.refusal.message).toContain('ENOENT');
    }
  });

  it('refuses with reason "invalid" for malformed YAML, never throwing', async () => {
    const outcome = await resolveProductionAdlYml({
      readFile: () => Promise.resolve('version: [this is not: valid'),
    });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('invalid');
    }
  });

  it('refuses with reason "invalid" for YAML that fails AdlYmlSchema validation, never throwing', async () => {
    const outcome = await resolveProductionAdlYml({
      readFile: () =>
        Promise.resolve('version: 1\ncommands: {}\npipeline: [develop]\n'),
    });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.reason).toBe('invalid');
      // `commands` is missing all four required lifecycle commands.
      expect(outcome.refusal.message).toContain('commands');
    }
  });
});

describe('AdlYmlUnavailableError', () => {
  it('carries the refusal and uses it as the thrown error message', () => {
    const error = new AdlYmlUnavailableError({
      reason: 'unreadable',
      path: 'adl.yml',
      message: 'could not read adl.yml',
    });
    expect(error.name).toBe('AdlYmlUnavailableError');
    expect(error.message).toBe('could not read adl.yml');
    expect(error.refusal.reason).toBe('unreadable');
  });
});

describe('resolveProductionAdlYml — a real Workspace.read() over a real repository', () => {
  it('reads exactly what is on disk at mainRepo/adl.yml, with no git ref involved', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      await writeFile(join(mainRepo, ADL_YML_PATH), VALID_ADL_YML, 'utf8');

      const workspace = await hostGitWorkspace({
        featureId: 'test-adl-yml-read',
        mainRepo,
        scratchRoot,
        baseRef: 'HEAD',
      });

      const outcome = await resolveProductionAdlYml({
        readFile: (path) => workspace.read(path),
      });

      expect(outcome.kind).toBe('resolved');
      if (outcome.kind === 'resolved') {
        expect(outcome.config.limits.budget_usd).toBe(42);
      }
    });
  });

  it('refuses when mainRepo has no adl.yml at all — an uncommitted, unwritten file', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot }) => {
      const workspace = await hostGitWorkspace({
        featureId: 'test-adl-yml-missing',
        mainRepo,
        scratchRoot,
        baseRef: 'HEAD',
      });

      const outcome = await resolveProductionAdlYml({
        readFile: (path) => workspace.read(path),
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'refused') {
        expect(outcome.refusal.reason).toBe('unreadable');
      }
    });
  });

  it('reads the WORKING TREE, not the committed tree — an uncommitted edit is seen', async () => {
    // The whole point of using Workspace.read() rather than a git-ref
    // lookup (`resolveProductionAdlYml`'s own docblock): mainRepo is ADL's
    // own checkout, never an agent's, so its working tree is exactly what
    // the operator's own `git pull` last left there — including a file
    // that has not been committed yet.
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      await writeFile(join(mainRepo, ADL_YML_PATH), VALID_ADL_YML, 'utf8');
      // Deliberately NOT committed — `git.add`/`git status` would show it
      // as untracked, and a git-ref read of HEAD would not see it at all.
      expect((await git.status()).not_added).toContain(ADL_YML_PATH);

      const workspace = await hostGitWorkspace({
        featureId: 'test-adl-yml-uncommitted',
        mainRepo,
        scratchRoot,
        baseRef: 'HEAD',
      });
      const outcome = await resolveProductionAdlYml({
        readFile: (path) => workspace.read(path),
      });

      expect(outcome.kind).toBe('resolved');
    });
  });
});
