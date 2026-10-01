import type { ExecSpec, LogChunk, Workspace } from '@adl/core/stage';

/**
 * Run a command through a workspace -- so, under the privilege drop, as the
 * worker -- returning its exit code and everything it printed.
 *
 * Shared by the privilege suites: the point of each is to observe what the
 * worker identity can and cannot do, and a test that reached the filesystem as
 * the daemon would be observing the wrong user.
 */
export async function runIn(
  workspace: Workspace,
  argv: readonly string[],
): Promise<{ exitCode: number | null; output: string }> {
  const chunks: LogChunk[] = [];
  const spec: ExecSpec = {
    argv,
    cwd: workspace.root,
    path: process.env.PATH ?? '',
    networkPolicy: 'full',
    resources: {},
  };
  const result = await workspace.exec(spec, (chunk) => chunks.push(chunk));
  return {
    exitCode: result.exitCode,
    output: chunks.map((chunk) => chunk.text).join('\n'),
  };
}

/** `runIn` of a shell one-liner. */
export function shIn(
  workspace: Workspace,
  script: string,
): ReturnType<typeof runIn> {
  return runIn(workspace, ['/bin/sh', '-c', script]);
}
