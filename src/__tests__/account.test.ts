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
    await expect(getCollectionRecords('alice', 'collect', 1, 'dbcl2=secret')).resolves.toEqual([{
      id: '42',
      title: 'Example',
      url: 'https://movie.douban.com/subject/42/',
      status: 'collect',
      date: '2026-08-10',
      rating: 4,
      comment: 'Great'
    }]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie')).toBe('dbcl2=secret');
  });
});
