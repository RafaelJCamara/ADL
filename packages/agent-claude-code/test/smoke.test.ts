import { describe, expect, it } from 'vitest';

import { PINNED_CLAUDE_CODE_VERSION } from '../src/index.js';

/**
 * Proves the package barrel resolves and exports something real, rather than
 * merely existing on disk. `04-01-PLAN.md`'s must-have truths require the
 * package to be "testable rather than merely present" — this is what makes
 * that literally true.
 */
describe('@adl/agent-claude-code barrel', () => {
  it('exports PINNED_CLAUDE_CODE_VERSION as a three-part dotted version string', () => {
    expect(PINNED_CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
