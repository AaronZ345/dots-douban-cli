import { describe, expect, it, vi } from 'vitest';
import { cleanText, extractField, extractWindowJsonObject, HttpClient, HttpRequestError } from '../api/common.ts';

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

  it('retries retryable GET responses and respects Retry-After', async () => {
    const delays: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '2' }
      }))
      .mockResolvedValueOnce(new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }));
    const client = new HttpClient({
      fetchImpl: fetchMock,
      maxAttempts: 2,
      maxRetryDelayMs: 5000,
      sleep: async (delayMs) => { delays.push(delayMs); },
      random: () => 0
    });

    await expect(client.getHtml('https://movie.douban.com/test')).resolves.toContain('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
  });

  it('rejects challenge pages with a structured error', async () => {
    const client = new HttpClient({
      fetchImpl: async () => new Response('<form name="sec" id="sec">安全验证</form>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }),
      maxAttempts: 1
    });

    await expect(client.getHtml('https://movie.douban.com/test')).rejects.toMatchObject({
      code: 'CHALLENGE',
      url: 'https://movie.douban.com/test'
    } satisfies Partial<HttpRequestError>);
  });

  it('validates JSON content type before decoding', async () => {
    const client = new HttpClient({
      fetchImpl: async () => new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }),
      maxAttempts: 1
    });

    await expect(client.getJson('https://movie.douban.com/api')).rejects.toMatchObject({
      code: 'CONTENT_TYPE'
    } satisfies Partial<HttpRequestError>);
  });
});
