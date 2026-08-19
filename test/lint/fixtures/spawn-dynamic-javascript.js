// DELIBERATE VIOLATION FIXTURE — owned by the 02 Warning B fix.
// Trips: `no-restricted-syntax` (the WORK-02 spawn ban, dynamic-`import()` form)
// from a plain `.js` file.
//
// `.js` is the third JavaScript spelling and the one with an inhabitant already
// at the repository root: `eslint.config.js` is itself a `.js` module, so the
// file defining the architecture rules was — until this fix — outside every one
// of them. Nothing there spawns a process, and the point is not that it might;
// the point is that the set of files the boundary reaches should not be
// determined by which files happen to exist.
//
// The dynamic form is the one that matters most on this extension. Root
// `package.json` sets `"type": "module"`, so a `.js` file here is ESM and
// `await import('execa')` is the idiomatic way to reach an ESM-only package
// from it — no `require` contortion needed, nothing that looks unusual in
// review. 02-RESEARCH.md § Pitfall 2 is the reason the syntax layer exists at
// all: `no-restricted-imports` reports the static form and neither of the other
// two, so a ban widened only on the import layer leaves this file clean.
// Never compiled, never executed, never imported.
export async function launch(command) {
  const { execa } = await import('execa');
  return execa(command);
}
