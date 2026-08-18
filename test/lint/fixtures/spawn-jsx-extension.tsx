// DELIBERATE VIOLATION FIXTURE — owned by the 02 verification-gap fix.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, dynamic-`import()` form)
// from a `.tsx` file.
//
// `.tsx` is the third extension `files: ['**/*.ts']` did not reach, and it is
// the one with a scheduled arrival date: the ROADMAP puts a React dashboard in
// the last phase of v1, so the day this repository grows `.tsx` files is a day
// somebody has already planned. Widening the glob without a fixture for this
// extension would leave the dashboard's whole source tree outside the ban with
// nothing red to say so.
//
// Deliberately contains no JSX. The parser enables JSX for `.tsx` regardless,
// and the subject here is the file's EXTENSION reaching the rule — adding an
// element would only add a way for this fixture to fail for an unrelated reason
// and break the negative control.
// Never compiled, never executed, never imported.
export async function launch(command: string): Promise<unknown> {
  const { execa } = await import('execa');
  return execa(command);
}
