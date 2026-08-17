import { describe, expect, it } from 'vitest';

import {
  ADL_VARIABLES,
  interpolate,
  type AdlVariableName,
} from '../../src/config/interpolate.js';
import { LoadError } from '../../src/errors.js';

describe('interpolate — the allowlisted substitution', () => {
  it('substitutes the allocated port into a readiness probe target', () => {
    const url = interpolate('http://127.0.0.1:${ADL_PORT}/health', {
      ADL_PORT: '3000',
    });
    expect(url).toBe('http://127.0.0.1:3000/health');
  });

  it('substitutes the allocated port into a command environment value', () => {
    const envValue = interpolate('${ADL_PORT}', { ADL_PORT: '4000' });
    expect(envValue).toBe('4000');
  });

  it('returns a template with no variables unchanged', () => {
    expect(interpolate('no variables here', {})).toBe('no variables here');
  });

  it('substitutes the same variable referenced twice', () => {
    const result = interpolate('${ADL_PORT} and again ${ADL_PORT}', {
      ADL_PORT: '9',
    });
    expect(result).toBe('9 and again 9');
  });

  it('a variable name outside the allowlist raises a LoadError naming it', () => {
    expect(() => interpolate('${ADL_ROUND}', { ADL_PORT: '3000' })).toThrow(
      LoadError,
    );
    expect(() => interpolate('${ADL_ROUND}', { ADL_PORT: '3000' })).toThrow(
      /ADL_ROUND/,
    );
  });
});

describe('interpolate — never reads the process environment', () => {
  it('a variable naming a system search path fails validation, never resolves to PATH', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/should/never/appear';
    try {
      expect(() => interpolate('${PATH}', { ADL_PORT: '3000' })).toThrow(
        LoadError,
      );
      expect(() => interpolate('${PATH}', { ADL_PORT: '3000' })).toThrow(
        /PATH/,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('a variable naming a model API key fails validation', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-appear';
    try {
      expect(() =>
        interpolate('${ANTHROPIC_API_KEY}', { ADL_PORT: '3000' }),
      ).toThrow(LoadError);
      expect(() =>
        interpolate('${ANTHROPIC_API_KEY}', { ADL_PORT: '3000' }),
      ).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('ADL_VARIABLES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(ADL_VARIABLES)).toBe(true);
  });

  it('names the allocated port, the feature id, the round, and the verdict file', () => {
    const names: readonly AdlVariableName[] = [
      'ADL_PORT',
      'ADL_FEATURE_ID',
      'ADL_ROUND',
      'ADL_VERDICT_FILE',
    ];
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(ADL_VARIABLES, name)).toBe(
        true,
      );
    }
  });

  it('every documented variable substitutes when supplied', () => {
    const values = {
      ADL_PORT: '3000',
      ADL_FEATURE_ID: 'dark-mode',
      ADL_ROUND: '2',
      ADL_VERDICT_FILE: '.adl/verdicts/review.json',
    };
    for (const name of Object.keys(ADL_VARIABLES) as AdlVariableName[]) {
      expect(interpolate(`\${${name}}`, values)).toBe(values[name]);
    }
  });
});
