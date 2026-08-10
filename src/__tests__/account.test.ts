import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCollectionRecords, getCurrentUserProfile } from '../api/account.ts';
import { getUserCollectionPage } from '../api/collection.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function collectionHtml(): string {
  return `
    <span class="subject-num">1-1 / 1</span>
    <li class="item">
      <a href="https://movie.douban.com/subject/42/">Example</a>
      <div class="date"><span class="rating4-t"></span>2026-08-10</div>
      <div class="comment">Great</div>
    </li>`;
}

function htmlResponseAt(html: string, url: string): Response {
  const response = new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' }
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('authenticated account reads', () => {
  it('loads the current profile from the authenticated mine page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      '<a class="lnk-mine" href="https://www.douban.com/people/alice/">Alice</a>',
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUserProfile('dbcl2=secret')).resolves.toEqual({
      id: 'alice',
      name: 'Alice',
      url: 'https://www.douban.com/people/alice/'
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://www.douban.com/mine/');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie')).toBe('dbcl2=secret');
  });

  it('identifies the current profile after the mine page redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponseAt(
      '<h1><span>Alice</span>（<a href="/edit">编辑</a>）</h1>',
      'https://www.douban.com/people/alice/?_i=example'
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUserProfile('dbcl2=secret')).resolves.toEqual({
      id: 'alice',
      name: 'Alice',
      url: 'https://www.douban.com/people/alice/'
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the profile title when a redirected page has no heading', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponseAt(
      '<title>Alice 的豆瓣</title>',
      'https://www.douban.com/people/alice/'
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUserProfile('dbcl2=secret')).resolves.toMatchObject({
      id: 'alice',
      name: 'Alice'
    });
  });

  it('does not infer the current account from arbitrary profile links', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        '<a href="https://www.douban.com/people/not-the-user/">Not the user</a>',
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(
        '<a class="lnk-mine" href="https://www.douban.com/people/alice/">Alice</a>',
        { status: 200 }
      ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUserProfile('dbcl2=secret')).resolves.toMatchObject({ id: 'alice' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps authenticated collection cookies out of the public loader contract', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(collectionHtml(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getUserCollectionPage({
      kind: 'movie',
      userId: 'alice',
      status: 'collect',
      count: 1
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie')).toBeNull();

    fetchMock.mockClear();
    await expect(getCollectionRecords('alice', 'collect', 1, 'dbcl2=secret')).resolves.toEqual({
      records: [{
        id: '42',
        title: 'Example',
        url: 'https://movie.douban.com/subject/42/',
        status: 'collect',
        date: '2026-08-10',
        rating: 4,
        comment: 'Great'
      }],
      partial: false,
      warnings: []
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie')).toBe('dbcl2=secret');
  });

  it('reports partial collection warnings to the caller', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      collectionHtml().replace('1-1 / 1', '1-2 / 2'),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getCollectionRecords('alice', 'collect', 2, 'dbcl2=secret');

    expect(result.records).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining('页面预计 2 条，实际解析 1 条')
    ]);
  });
});
