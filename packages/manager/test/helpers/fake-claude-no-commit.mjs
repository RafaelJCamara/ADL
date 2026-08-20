#!/usr/bin/env node
// A replay double that runs "successfully" but makes no commit — exercises
// the honest "blocked" reporting Task 2's must_haves require.
const lines = [
  {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-5',
    session_id: 'sess_fake',
  },
  {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'Looking at the spec…' }],
    },
  },
  { type: 'result', subtype: 'success', duration_ms: 2 },
];
for (const line of lines) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
process.exit(0);
