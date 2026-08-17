// DELIBERATE VIOLATION FIXTURE — owned by plan 01-03.
// Trips: `no-restricted-properties` (the ban on reading the process
// environment from inside @adl/core — 01-RESEARCH.md § Pitfall 10, T-1-12).
// Never compiled, never executed, never imported.

export function apiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}
