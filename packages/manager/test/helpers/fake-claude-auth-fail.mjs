#!/usr/bin/env node
// A replay double simulating a rejected credential — writes an
// authentication-shaped line to stderr and exits non-zero, with no terminal
// stream-json result event at all.
process.stderr.write(
  'Error: authentication failed — invalid ANTHROPIC_API_KEY\n',
);
process.exit(1);
