#!/usr/bin/env node
// A replay double emitting a terminal result line whose subtype this
// translator does not recognise — exercises "an unclassifiable terminal
// event" from Task 2's behaviour list.
const line = {
  type: 'result',
  subtype: 'something_never_documented',
  duration_ms: 3,
};
process.stdout.write(`${JSON.stringify(line)}\n`);
process.exit(0);
