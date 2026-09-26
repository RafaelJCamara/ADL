import { describe, expect, it } from 'vitest';

import {
  BuiltInCommandGateWithSchema,
  COMMAND_GATE_OUTPUT_MODES,
  CommandGateWithSchema,
  RUNNER_REPORT_FORMATS,
  TestSuiteSchema,
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

/**
 * The report modes (ROLE-08, M08 step 8.5). The load-bearing property is that
 * the formats are DERIVED into the mode list — so a format added for the tester's
 * suite is a mode a command gate can declare, and the other way round — and that a
 * suite cannot declare anything that cannot say "nothing ran".
 */
describe('the runner-report modes', () => {
  it('derives the report formats into the command-gate modes, rather than restating them', () => {
    expect(COMMAND_GATE_OUTPUT_MODES).toEqual(['exit_code', 'verdict', 'tap']);
    for (const format of RUNNER_REPORT_FORMATS) {
      expect(COMMAND_GATE_OUTPUT_MODES).toContain(format);
    }
    expect(Object.isFrozen(RUNNER_REPORT_FORMATS)).toBe(true);
  });

  it('accepts `emits: tap` on a command gate', () => {
    expect(
      CommandGateWithSchema.parse({
        command: { argv: ['node', '--test'] },
        emits: 'tap',
      }).emits,
    ).toBe('tap');
  });
});

describe('BuiltInCommandGateWithSchema — the built-in `test` gate’s own block', () => {
  it('is the command-gate block without its command: `{}` still means exit_code', () => {
    expect(BuiltInCommandGateWithSchema.parse({}).emits).toBe('exit_code');
    expect(BuiltInCommandGateWithSchema.parse({ emits: 'tap' }).emits).toBe(
      'tap',
    );
  });

  it('refuses a command — naming one makes the entry a command gate instead', () => {
    expect(
      BuiltInCommandGateWithSchema.safeParse({ command: { argv: ['x'] } })
        .success,
    ).toBe(false);
  });

  it('is strict, like the block it is derived from', () => {
    expect(
      BuiltInCommandGateWithSchema.safeParse({ emits: 'tap', emmits: 'tap' })
        .success,
    ).toBe(false);
  });
});

describe('TestSuiteSchema — the suite a tester asks ADL to run', () => {
  const COMMAND = { argv: ['node', '--test', '--test-reporter=tap'] };

  it('requires emits — a suite ADL cannot count cannot tell "all passed" from "none ran"', () => {
    expect(TestSuiteSchema.safeParse({ command: COMMAND }).success).toBe(false);
    expect(
      TestSuiteSchema.parse({ command: COMMAND, emits: 'tap' }).emits,
    ).toBe('tap');
  });

  it('makes exit_code and verdict unrepresentable for a suite', () => {
    for (const emits of ['exit_code', 'verdict']) {
      expect(
        TestSuiteSchema.safeParse({ command: COMMAND, emits }).success,
        `a suite was allowed to declare ${emits}`,
      ).toBe(false);
    }
  });

  it('is strict', () => {
    expect(
      TestSuiteSchema.safeParse({ command: COMMAND, emits: 'tap', extra: 1 })
        .success,
    ).toBe(false);
  });
});
