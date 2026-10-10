import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../browser.js', () => ({ launchBrowser: mocks.launch }));
import { configureBrowserReads, closeReadBrowser, readFetch } from '../api/browser-transport.ts';

afterEach(async () => { await closeReadBrowser(); configureBrowserReads(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser read transport', () => {
  it('uses ordinary fetch when browser mode is not selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await readFetch('https://movie.douban.com/')).json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects foreign addresses and writes before launching a browser', async () => {
    mocks.launch.mockClear();
    configureBrowserReads({ browser: 'chrome' });
    await expect(readFetch('https://evil.example/')).rejects.toThrow('豆瓣');
    await expect(readFetch('https://book.douban.com/', { method: 'POST' })).rejects.toThrow('GET');
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('scopes cookies to Douban and returns the final navigation response', async () => {
    const frame = {};
    let handler: ((response: unknown) => void) | undefined;
    const response = { request: () => ({ isNavigationRequest: () => true }), frame: () => frame,
      allHeaders: async () => ({ 'content-type': 'application/json' }), text: async () => '{"ok":true}', status: () => 200 };
    const page = { on: vi.fn((_event, callback) => { handler = callback; }), mainFrame: () => frame,
      goto: vi.fn(async () => handler!(response)), url: () => 'https://movie.douban.com/result', close: vi.fn() };
    const context = { newPage: vi.fn(async () => page), addCookies: vi.fn() };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
    mocks.launch.mockResolvedValue(browser);
    configureBrowserReads({ browser: 'chrome' });
    const result = await readFetch('https://movie.douban.com/test', { method: 'GET', headers: { Cookie: 'dbcl2=fixture; ck=fixture-check; unrelated=ignored' } });
    expect(await result.json()).toEqual({ ok: true });
    expect(result.url).toBe('https://movie.douban.com/result');
    expect(context.addCookies.mock.calls[0][0]).toEqual([
      { name: 'dbcl2', value: 'fixture', domain: '.douban.com', path: '/', secure: true },
      { name: 'ck', value: 'fixture-check', domain: '.douban.com', path: '/', secure: true }
    ]);
    expect(page.close).toHaveBeenCalledOnce();
    await closeReadBrowser();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
