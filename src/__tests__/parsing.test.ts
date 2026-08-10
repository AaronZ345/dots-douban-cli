import { describe, expect, it } from 'vitest';
import {
  formEncode,
  getPageRange,
  isNumericId,
  pageToOffset,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveIntAtMost
} from '../utils/parsing.ts';

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

  it('parsePositiveIntAtMost rejects values above the documented limit', () => {
    expect(parsePositiveIntAtMost('20', '--limit', 10, 20)).toBe(20);
    expect(() => parsePositiveIntAtMost('21', '--limit', 10, 20)).toThrow('--limit 不能超过 20');
  });

  it('isNumericId validates trimmed numeric id', () => {
    expect(isNumericId(' 1292052 ')).toBe(true);
    expect(isNumericId('12a')).toBe(false);
  });

  it('converts page numbers to safe offsets and ranges', () => {
    expect(pageToOffset(3, 20)).toBe(40);
    expect(getPageRange(3, 20, 5)).toEqual({ from: 41, to: 45 });
    expect(getPageRange(3, 20, 0)).toEqual({ from: 0, to: 0 });
  });

  it('rejects unsafe page offset inputs', () => {
    expect(() => pageToOffset(0, 20)).toThrow('--page 必须是安全范围内的正整数');
    expect(() => pageToOffset(1, 0)).toThrow('每页数量必须是安全范围内的正整数');
    expect(() => pageToOffset(Number.MAX_SAFE_INTEGER, 2)).toThrow('超出安全整数范围');
  });

  it('formEncode skips nullish fields', () => {
    expect(formEncode({ a: '1', b: undefined, c: null, d: 'ok' })).toBe('a=1&d=ok');
  });
});
