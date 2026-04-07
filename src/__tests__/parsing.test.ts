import { describe, expect, it } from 'vitest';
import { formEncode, isNumericId, parseNonNegativeInt, parsePositiveInt } from '../utils/parsing.ts';

describe('utils/parsing', () => {
  it('parseNonNegativeInt returns fallback for undefined input', () => {
    expect(parseNonNegativeInt(undefined, '--start', 5)).toBe(5);
  });

  it('parsePositiveInt parses valid positive integer', () => {
    expect(parsePositiveInt('12', '--limit', 20)).toBe(12);
  });

  it('parsePositiveInt rejects non-positive numbers', () => {
    expect(() => parsePositiveInt('0', '--limit', 20)).toThrow('--limit 必须是正整数');
  });

  it('isNumericId validates trimmed numeric id', () => {
    expect(isNumericId(' 1292052 ')).toBe(true);
    expect(isNumericId('12a')).toBe(false);
  });

  it('formEncode skips nullish fields', () => {
    expect(formEncode({ a: '1', b: undefined, c: null, d: 'ok' })).toBe('a=1&d=ok');
  });
});
