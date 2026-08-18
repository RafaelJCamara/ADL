// DELIBERATE VIOLATION FIXTURE — owned by plan 02-02.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, dynamic-import() form,
// over a NON-BUILTIN specifier).
//
// This fixture watches the DERIVATION, not the rule. With the selector list
// hand-written against `child_process` alone — as the first draft of plan 02-02
// had it — this exact file linted clean while the rule table still claimed the
// ban was complete: `no-restricted-imports` is blind to the dynamic form
// (§ Pitfall 2) and the syntax layer named the wrong specifier. `execa@10` is
// ESM-only, so reaching it through `await import()` is the idiomatic form
// rather than an exotic bypass — this is what a contributor writes by accident.
// The other three spawn fixtures cannot detect that failure, because all three
// name the builtin.
//
// `execa` is not installed at the workspace root and does not need to be: both
// rules are purely syntactic, and this file is inside the global
// `test/lint/fixtures/**` ignore and outside every package's tsconfig include,
// so nothing resolves or compiles it.
// Never compiled, never executed, never imported.
export async function launch(command: string): Promise<unknown> {
  const { execa } = await import('execa');
  return execa(command);
}
