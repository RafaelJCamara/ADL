// DELIBERATE VIOLATION FIXTURE — owned by plan 02-02.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, dynamic-import() form,
// over the builtin). The second of the two forms `no-restricted-imports` does
// not see (02-RESEARCH.md § Pitfall 2).
// Never compiled, never executed, never imported.
export async function launch(command: string): Promise<unknown> {
  const childProcess = await import('node:child_process');
  return childProcess.spawn(command);
}
