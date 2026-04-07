import { describe, expect, it } from 'vitest';
import { cleanText, extractField, extractWindowJsonObject } from '../api/common.ts';

describe('api/common helpers', () => {
  it('cleanText strips tags and decodes html entities', () => {
    const raw = '<div>Tom &amp; Jerry&nbsp;<span>"Hi"&#39;s</span></div>';
    expect(cleanText(raw)).toBe('Tom & Jerry "Hi"\'s');
  });

  it('extractField parses info block field by label', () => {
    const info = '<span class="pl">导演</span>: <a href="#">克里斯托弗·诺兰</a><br/>';
    expect(extractField(info, '导演')).toBe('克里斯托弗·诺兰');
  });

  it('extractWindowJsonObject returns full nested object payload', () => {
    const html = '<script>window.__DATA__ = {"a":1,"nested":{"text":"brace } inside","n":2}};</script>';
    expect(extractWindowJsonObject(html, '__DATA__')).toBe('{"a":1,"nested":{"text":"brace } inside","n":2}}');
  });
});
