import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRecordPatch, editPersonalRecord, parseRecordForm } from '../api/record.ts';
import { browserLaunchOptions } from '../browser.ts';
import { parseBrowserCookieJson, resolveBrowserCookieTarget, browserFromSystemIdentifier } from '../auth.ts';
import { recordPatchFromOptions } from '../commands/records.ts';

function form(comment = '原短评', kind = 'movie', status = 'wish') {
  return { interest_status: status, html: `<form action="/j/subject/123/interest">
    <input name="ck" value="fixture-csrf"><input name="rating" value="4">
    <input name="tags" value="科幻 经典"><textarea name="comment">${comment}</textarea>
    <input name="privacy" type="checkbox" value="1" checked>
    <input name="share-shuo" type="checkbox" checked value="1">
    <input name="share-sina" type="checkbox" checked value="1">
    </form>`, kind };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('record updates', () => {
  it('reads original fields and excludes broadcast switches', () => {
    const parsed = parseRecordForm(form('A &amp; B'), 'movie', '123');
    expect(parsed.record).toMatchObject({ status: 'wish', rating: 4, comment: 'A & B', tags: ['科幻', '经典'], private: true });
    expect(parsed.record).not.toHaveProperty('ck');
    expect(parsed.fields).not.toHaveProperty('share-shuo');
    expect(parsed.fields).not.toHaveProperty('share-sina');
  });
  it('fails before writing when privacy or labels cannot be preserved', () => {
    const payload = form();
    payload.html = payload.html.replace(/<input name="privacy"[^>]+>/, '');
    expect(() => parseRecordForm(payload, 'book', '123')).toThrow('隐私');
  });
  it('reads current live forms with cookie CSRF, private checkbox, and JSON tags', () => {
    const payload = form();
    payload.html = payload.html.replace('<input name="ck" value="fixture-csrf">', '').replace('name="privacy"', 'name="private"').replace('name="tags" value="科幻 经典"', 'name="tags"');
    const parsed = parseRecordForm({ ...payload, tags: ['原标签'] }, 'movie', '123', 'fixture-csrf');
    expect(parsed.record).toMatchObject({ tags: ['原标签'], private: true });
    expect(parsed.privateField).toBe('private');
    expect(parsed.fields.ck).toBe('fixture-csrf');
  });
  it('reads book state from its selected radio when the JSON state field is absent', () => {
    const payload = form();
    const html = payload.html.replace('<input name="rating"', '<input type="radio" name="interest" value="collect" checked><input name="rating"');
    expect(parseRecordForm({ html, tags: [] }, 'book', '123').record.status).toBe('collect');
  });
  it('rejects foreign form actions and unknown status', () => {
    expect(() => parseRecordForm({ ...form(), html: form().html.replace('/j/subject/123/interest', 'https://evil.example/') }, 'movie', '123')).toThrow('地址');
    expect(() => parseRecordForm(form('x', 'movie', 'unexpected'), 'movie', '123')).toThrow('状态');
  });
  it('preserves fields when changing only a comment', () => {
    const before = parseRecordForm(form(), 'movie', '123').record;
    const after = applyRecordPatch(before, { comment: '新短评' });
    expect(after).toEqual({ ...before, comment: '新短评' });
    expect(before.comment).toBe('原短评');
  });
  it('allows clearing comment, rating, and tags independently', () => {
    const before = parseRecordForm(form(), 'book', '123').record;
    expect(applyRecordPatch(before, { comment: '', rating: null, tags: [] })).toMatchObject({ comment: '', rating: null, tags: [], status: 'wish', private: true });
  });
  it('requires an explicit status when creating a new record', () => {
    const before = parseRecordForm(form('', 'book', 'none'), 'book', '123').record;
    expect(() => applyRecordPatch(before, { comment: '书评' })).toThrow('显式指定');
    expect(applyRecordPatch(before, { status: 'collect', comment: '书评' }).status).toBe('collect');
  });
  it('dry run and unchanged updates never POST', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(form()));
    vi.stubGlobal('fetch', fetchMock);
    const result = await editPersonalRecord('movie', '123', { comment: '预览' }, 'fixture-session', true);
    expect(result).toMatchObject({ dryRun: true, verified: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    await editPersonalRecord('movie', '123', { comment: '原短评' }, 'fixture-session');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(['movie', 'book'] as const)('updates %s once and verifies all retained fields', async (kind) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(form()))
      .mockResolvedValueOnce(Response.json(form()))
      .mockResolvedValueOnce(Response.json({ r: 0 }))
      .mockResolvedValueOnce(Response.json(form('新短评')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await editPersonalRecord(kind, '123', { comment: '新短评' }, 'fixture-session');
    expect(result).toMatchObject({ changed: true, verified: true, after: { status: 'wish', rating: 4, private: true, tags: ['科幻', '经典'] } });
    const [url, init] = fetchMock.mock.calls[2];
    expect(String(url)).toContain(`${kind}.douban.com/j/subject/123/interest`);
    const fields = new URLSearchParams(init.body);
    expect(fields.get('interest')).toBe('wish');
    expect(fields.get('rating')).toBe('4');
    expect(fields.get('privacy')).toBe('1');
    expect(fields.has('share-shuo')).toBe(false);
    expect(init.redirect).toBe('manual');
    expect(fetchMock.mock.calls.filter(([, value]) => value.method === 'POST')).toHaveLength(1);
  });
  it('stops when another edit changes the original record', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(form())).mockResolvedValueOnce(Response.json(form('另一处修改')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(editPersonalRecord('movie', '123', { comment: '新短评' }, 'fixture-session')).rejects.toThrow('发生变化');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not retry uncertain writes and rejects incorrect readback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(form())).mockResolvedValueOnce(Response.json(form())).mockRejectedValueOnce(new Error('network lost'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(editPersonalRecord('movie', '123', { comment: '新短评' }, 'fixture-session')).rejects.toThrow('network lost');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockReset().mockResolvedValueOnce(Response.json(form())).mockResolvedValueOnce(Response.json(form())).mockResolvedValueOnce(Response.json({ r: 0 })).mockResolvedValueOnce(Response.json(form('错误结果')));
    await expect(editPersonalRecord('book', '123', { comment: '新短评' }, 'fixture-session')).rejects.toThrow('不一致');
  });
  it('rejects mutually exclusive or invalid edit options before login', () => {
    expect(() => recordPatchFromOptions({ comment: 'x', clearComment: true })).toThrow('只能');
    expect(() => recordPatchFromOptions({ rating: '2.5' })).toThrow('1-5');
    expect(() => recordPatchFromOptions({ tags: '含 空格' })).toThrow('空白');
    expect(() => recordPatchFromOptions({ private: true, public: true })).toThrow('不能同时');
    expect(() => recordPatchFromOptions({})).toThrow('至少');
  });
});

describe('browser support and cookie imports', () => {
  it.each(['chromium', 'brave', 'arc'] as const)('selects only %s storage on macOS', (browser) => {
    expect(resolveBrowserCookieTarget(browser, 'darwin')).toEqual({ backend: 'chrome', chromiumBrowser: browser });
  });
  it('recognizes Chromium and Brave system identifiers', () => {
    expect(browserFromSystemIdentifier('org.chromium.Chromium')).toBe('chromium');
    expect(browserFromSystemIdentifier('com.brave.Browser')).toBe('brave');
  });
  it('distinguishes native Safari from Playwright WebKit', () => {
    expect(() => browserLaunchOptions('safari')).toThrow('Safari');
    expect(browserLaunchOptions('webkit')).toEqual({});
  });
  it('accepts storage state and ignores unrelated cookies', () => {
    const cookies = [{ name: 'dbcl2', value: 'fixture-account', domain: '.douban.com' }, { name: 'ck', value: 'fixture-csrf', domain: '.douban.com' }, { name: 'dbcl2', value: 'unrelated', domain: 'evil.example' }];
    expect(parseBrowserCookieJson(JSON.stringify({ cookies, origins: [] }))).toEqual({ dbcl2: 'fixture-account', ck: 'fixture-csrf' });
  });
  it('rejects expired, foreign-domain, and ambiguous account cookies', () => {
    expect(parseBrowserCookieJson(JSON.stringify([{ name: 'dbcl2', value: 'expired', domain: '.douban.com', expires: 1 }]))).toBeNull();
    expect(parseBrowserCookieJson(JSON.stringify([{ name: 'dbcl2', value: 'foreign', domain: '.douban.com.evil.example' }]))).toBeNull();
    expect(parseBrowserCookieJson(JSON.stringify([{ name: 'dbcl2', value: 'one', domain: '.douban.com' }, { name: 'dbcl2', value: 'two', domain: '.douban.com' }]))).toBeNull();
  });
});
