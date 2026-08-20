#!/usr/bin/env node
// A replay double exiting non-zero with a generic (non-auth) failure and no
// terminal stream-json result event.
process.stderr.write('a generic internal error occurred\n');
process.exit(7);
