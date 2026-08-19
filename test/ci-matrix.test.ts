import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Asserts the D-33 Windows CI leg actually exists, rather than trusting a
 * comment that says it does.
 *
 * `.github/workflows/ci.yml` is not otherwise exercised by any local
 * command — nothing in `pnpm test` reads it. Without this test, the Windows
 * leg (or the Linux-only gating around it) could be silently deleted in a
 * later edit and every local signal would stay green while a green CI tick
 * stopped meaning what it claims to mean (03-01-PLAN.md's Repudiation
 * threat T-3-10).
 *
 * Assertions are made on the parsed structure, following
 * `test/toolchain.test.ts`'s approach of checking configuration rather than
 * trusting it — not on raw substring matches, which a cosmetic reformat
 * could break without changing meaning, or silently stop catching a real
 * regression if the substring happens to survive by accident.
 */

const CI_WORKFLOW_PATH = fileURLToPath(
  new URL('../.github/workflows/ci.yml', import.meta.url),
);

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
}

interface WorkflowJob {
  readonly 'runs-on'?: unknown;
  readonly strategy?: {
    readonly matrix?: {
      readonly os?: readonly string[];
      readonly 'node-version'?: readonly number[];
    };
  };
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs?: Record<string, WorkflowJob>;
}

async function loadWorkflow(): Promise<Workflow> {
  const text = await readFile(CI_WORKFLOW_PATH, 'utf8');
  return parse(text) as Workflow;
}

describe('.github/workflows/ci.yml — the D-33 cross-platform matrix', () => {
  it('parses as YAML', async () => {
    await expect(loadWorkflow()).resolves.toBeDefined();
  });

  it('names both ubuntu-latest and windows-latest in jobs.verify.strategy.matrix.os', async () => {
    const workflow = await loadWorkflow();
    const os = workflow.jobs?.verify?.strategy?.matrix?.os;

    expect(os, 'jobs.verify.strategy.matrix.os must exist').toBeDefined();
    expect(os).toContain('ubuntu-latest');
    expect(os).toContain('windows-latest');
  });

  it('sets runs-on to the matrix os value rather than a hardcoded literal', async () => {
    const workflow = await loadWorkflow();
    const runsOn = workflow.jobs?.verify?.['runs-on'];

    expect(runsOn).toBe('${{ matrix.os }}');
  });

  it('gates the unprivileged-worker-user provisioning step to Linux', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs?.verify?.steps ?? [];
    const provisioning = steps.find((step) =>
      step.name?.includes('Provision the unprivileged worker user'),
    );

    expect(
      provisioning,
      'the provisioning step must still exist',
    ).toBeDefined();
    expect(provisioning?.if).toContain('runner.os');
    expect(provisioning?.if).toContain('Linux');
  });

  it('has a test step reachable on a non-Linux runner', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs?.verify?.steps ?? [];
    const nonLinuxTestStep = steps.find(
      (step) =>
        step.run?.includes('pnpm') &&
        step.run?.includes('test') &&
        step.if?.includes('runner.os') &&
        step.if?.includes('!='),
    );

    expect(
      nonLinuxTestStep,
      'a test step whose `if:` makes it run on a non-Linux runner must exist, or the Windows leg never runs the suite',
    ).toBeDefined();
  });

  it('runs the Linux-only sg-wrapped test step only on Linux', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs?.verify?.steps ?? [];
    const linuxTestStep = steps.find((step) => step.run?.includes('sg '));

    expect(
      linuxTestStep,
      'the sg-wrapped test step (dependent on the Linux-only worker identity) must still exist',
    ).toBeDefined();
    expect(linuxTestStep?.if).toContain('runner.os');
    expect(linuxTestStep?.if).toContain('Linux');
  });

  it('runs the workspace root suite unconditionally on every leg', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs?.verify?.steps ?? [];
    const rootSuiteStep = steps.find((step) =>
      step.run?.includes('--project root'),
    );

    expect(
      rootSuiteStep,
      'the root-suite test step must still exist',
    ).toBeDefined();
    expect(
      rootSuiteStep?.if,
      'the root-suite step must not be platform-gated — it runs on every leg',
    ).toBeUndefined();
  });
});
