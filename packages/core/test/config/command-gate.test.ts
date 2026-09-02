import { describe, expect, it } from 'vitest';

import {
  COMMAND_GATE_OUTPUT_MODES,
  CommandGateWithSchema,
} from '../../src/config/command-gate.js';

/**
 * The plain-command gate's `with:` block (HARN-02, M07 step 7.3).
 *
 * Two properties carry the weight here. `emits` defaults to `exit_code`, so
 * 5.14's built-in `test` gate and every ordinary linter keep working with no
 * `emits` line at all. And the block is `strictObject` where `with:` is
 * generally opaque, because this one is ADL's own — a misspelled key here is a
 * configuration error worth reporting, not a third party's business.
 */
describe('CommandGateWithSchema', () => {
  it('defaults emits to exit_code, so an ordinary program needs no mode line', () => {
    const parsed = CommandGateWithSchema.parse({
      command: { argv: ['npm', 'run', 'lint'] },
    });
    expect(parsed.emits).toBe('exit_code');
  });

  it('accepts a declared verdict mode', () => {
    const parsed = CommandGateWithSchema.parse({
      command: { argv: ['./audit.sh'] },
      emits: 'verdict',
    });
    expect(parsed.emits).toBe('verdict');
  });

  it('rejects a mode it does not know, rather than defaulting past it', () => {
    // Falling back to `exit_code` for an unrecognised value would read a
    // verdict-emitting gate's JSON as ordinary output and judge it on its exit
    // code — a silent misreading of the gate's whole contract.
    expect(
      CommandGateWithSchema.safeParse({
        command: { argv: ['./audit.sh'] },
        emits: 'json',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown key, because this block is ADL’s own', () => {
    expect(
      CommandGateWithSchema.safeParse({
        command: { argv: ['./audit.sh'] },
        emmits: 'verdict',
      }).success,
    ).toBe(false);
  });

  it('requires a command — a gate with no program is not a gate', () => {
    expect(CommandGateWithSchema.safeParse({ emits: 'verdict' }).success).toBe(
      false,
    );
  });

  it('pairs its frozen mode list with the schema it drives', () => {
    // Convention 7's runtime half. Every mode in the list must parse; a list
    // that grew without the schema following would fail here rather than in an
    // adopter's pipeline.
    for (const mode of COMMAND_GATE_OUTPUT_MODES) {
      expect(
        CommandGateWithSchema.safeParse({
          command: { argv: ['true'] },
          emits: mode,
        }).success,
        `COMMAND_GATE_OUTPUT_MODES names "${mode}", which the schema rejects`,
      ).toBe(true);
    }
    expect(Object.isFrozen(COMMAND_GATE_OUTPUT_MODES)).toBe(true);
  });
});
