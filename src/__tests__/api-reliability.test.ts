import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBookChart, getLatestBooks, searchBooks } from '../api/book.ts';
import { getUserCollectionPage } from '../api/collection.ts';
import { getHot, getMovieDetail, getRank, getTop250 } from '../api/movie.ts';
import { parseMovieSearchPage, searchMovies } from '../api/search.ts';
import { getSubjectComments, getSubjectRatingStats, getSubjectReviews } from '../api/subject.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function searchHtml(start: number, total: number, kind: 'movie' | 'book', count = 15): string {
  return `<script>window.__DATA__ = ${JSON.stringify({
    start,
    count,
    total,
    items: Array.from({ length: Math.min(count, Math.max(0, total - start)) }, (_, index) => {
      const id = start + index + 1;
      return {
        tpl_name: 'search_subject',
        id,
        title: `${kind} ${id}`,
        url: `https://${kind}.douban.com/subject/${id}/`,
        abstract: `2026 / item ${id}`,
        rating: { value: 8.5 }
      };
    })
  })};</script>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html' } });
}

describe('search reliability', () => {
  it('rejects malformed movie search pagination metadata', () => {
    const html = '<script>window.__DATA__ = {"start":0,"count":null,"total":1,"items":[]};</script>';
    expect(() => parseMovieSearchPage(html)).toThrow('count 不是非负整数');
  });

  it('uses HTML movie search as the primary path and aggregates pages', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/j/subject_suggest')) {
        return Response.json([{ id: '1', title: 'movie 1', year: '2026', type: 'movie' }]);
      }
      const start = Number(new URL(url).searchParams.get('start') || 0);
      return htmlResponse(searchHtml(start, 40, 'movie'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const items = await searchMovies('测试', 0, 40);

    expect(items).toHaveLength(40);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('www.douban.com/j/search'))).toBe(false);
  });

  it('keeps successful movie pages when a later page fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/j/subject_suggest')) return Response.json([]);
      const start = Number(new URL(url).searchParams.get('start') || 0);
      return start === 0 ? htmlResponse(searchHtml(0, 40, 'movie')) : htmlResponse('failed', 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchMovies('测试', 0, 30)).resolves.toHaveLength(15);
  });

  it('keeps successful book pages when a later page fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const start = Number(new URL(url).searchParams.get('start') || 0);
      return start === 0 ? htmlResponse(searchHtml(0, 40, 'book')) : htmlResponse('failed', 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchBooks('测试', 0, 30)).resolves.toHaveLength(15);
  });

  it('makes single-page book chart limits explicit', async () => {
    await expect(getBookChart('全部', 21)).rejects.toThrow('最多返回 20 条');
    await expect(getLatestBooks('全部', 50)).rejects.toThrow('最多返回 20 条');
  });
});

describe('movie source orchestration', () => {
  it('returns structured schema errors for malformed list endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes('/search_subjects')
        ? Response.json(null)
        : Response.json({ data: [null] });
    }));

    await expect(getHot('movie', '热门')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    await expect(getRank(17)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('stops Top250 pagination when the upstream page makes no progress', async () => {
    const items = Array.from({ length: 25 }, (_, index) => `
      <div class="item">
        <em>${index + 1}</em>
        <a href="https://movie.douban.com/subject/${index + 1}/"><span class="title">电影 ${index + 1}</span></a>
        <span class="rating_num">8.0</span>
      </div>`).join('');
    const fetchMock = vi.fn(async () => htmlResponse(items));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTop250(0, 30)).resolves.toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('merges concurrent sources without requesting TV data for a movie', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/j/subject_abstract')) {
        return Response.json({ subject: { title: '测试电影', year: '2026', directors: ['导演甲'] } });
      }
      if (url.includes('/rexxar/api/v2/movie/123')) {
        return Response.json({ type: 'movie', title: '测试电影', intro: '简介', rating: { value: 8.8 } });
      }
      return htmlResponse('forbidden', 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    const detail = await getMovieDetail('123');

    expect(detail).toMatchObject({ title: '测试电影', year: '2026', rating: '8.8', summary: '简介' });
    expect(requested.some((url) => url.includes('/rexxar/api/v2/tv/'))).toBe(false);
  });

});

describe('partial rating and collection data', () => {
  it('rejects malformed review and comment response objects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));

    await expect(getSubjectReviews('book', '123')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    await expect(getSubjectComments('movie', '123')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('rejects malformed review and comment entries without leaking TypeErrors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return Response.json(url.includes('/reviews') ? { reviews: [null] } : { interests: [null] });
    }));

    await expect(getSubjectReviews('book', '123')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    await expect(getSubjectComments('movie', '123')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('reports a rejected latest-comments request without silently falling back to hot comments', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return htmlResponse('forbidden', 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSubjectComments('movie', '123', 'latest', 0, 1)).rejects.toMatchObject({
      code: 'HTTP_STATUS',
      status: 403,
      message: expect.stringContaining('不会自动改变排序')
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requested[0]).toContain('order_by=latest');
  });

  it('returns subject rating data when the distribution endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rating?')) return htmlResponse('forbidden', 403);
      return Response.json({ rating: { value: 9.1, count: 100 } });
    }));

    const stats = await getSubjectRatingStats('movie', '123');
    expect(stats).toMatchObject({ value: 9.1, count: 100, stars: [0, 0, 0, 0, 0] });
  });

  it('parses movie collection totals and resumes inside an upstream page', async () => {
    const items = Array.from({ length: 30 }, (_, index) => `
      <li class="item">
        <a href="https://movie.douban.com/subject/${index + 1}/">电影 ${index + 1}</a>
        <div class="date"><span class="rating4-t"></span>2026-01-01</div>
        <div class="comment">短评 ${index + 1}</div>
      </li>`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(`
      <span class="subject-num">1-30 / 100</span>
      <ul>${items}</ul>
      <span class="next"><a href="?start=30">后页</a></span>`)));

    const page = await getUserCollectionPage({
      kind: 'movie',
      userId: 'tester',
      status: 'collect',
      start: 0,
      count: 15
    });

    expect(page.items).toHaveLength(15);
    expect(page.total).toBe(100);
    expect(page.nextStart).toBe(15);
    expect(page.partial).toBe(false);
    expect(page.items[0]).toMatchObject({ kind: 'movie', rating: 4, comment: '短评 1' });
  });

  it('supports book collection pages', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      void _input;
      return htmlResponse(`
        <span class="subject-num">1-1 / 1</span>
        <li class="subject-item">
          <div class="pic">
            <a href="https://book.douban.com/subject/42/"><img src="https://img.example.com/book-42.jpg"></a>
          </div>
          <div class="info">
            <h2><a href="https://book.douban.com/subject/42/">图书 42</a></h2>
            <div class="pub">作者 / 出版社 / 2026</div>
            <div class="short-note">
              <span class="date">2026-01-01 读过</span>
              <p class="comment">值得一读</p>
            </div>
          </div>
        </li>`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await getUserCollectionPage({ kind: 'book', userId: 'tester', status: 'collect', count: 10 });
    expect(page.items[0]).toMatchObject({
      kind: 'book',
      id: '42',
      title: '图书 42',
      date: '2026-01-01',
      comment: '值得一读',
      cover: 'https://img.example.com/book-42.jpg'
    });
    expect(page.nextStart).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('mode')).toBe('grid');
  });

  it('separates collection metadata from user comments and finds image-only covers', async () => {
    const html = readFileSync(new URL('./fixtures/movie-collection-page.html', import.meta.url), 'utf8');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input;
      return htmlResponse(html);
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await getUserCollectionPage({
      kind: 'movie',
      userId: 'tester',
      status: 'collect',
      count: 2
    });

    expect(page.items).toEqual([
      {
        kind: 'movie',
        id: '37235567',
        title: '坏蛋联盟2 / The Bad Guys 2',
        url: 'https://movie.douban.com/subject/37235567/',
        rating: 4,
        date: '2026-08-09',
        comment: '',
        cover: 'https://img.example.com/bad-guys-2.webp'
      },
      {
        kind: 'movie',
        id: '42',
        title: '示例电影 / Example Movie',
        url: 'https://movie.douban.com/subject/42/',
        rating: 5,
        date: '2026-08-10',
        comment: '真正的用户短评',
        cover: 'https://img.example.com/example.webp'
      }
    ]);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('mode')).toBe('grid');
  });

  it('waits between upstream collection pages when pacing is requested', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const start = Number(new URL(String(input)).searchParams.get('start') || 0);
      const itemCount = start === 0 ? 15 : 1;
      const items = Array.from({ length: itemCount }, (_, index) => {
        const id = start + index + 1;
        return `<li class="item"><a href="https://movie.douban.com/subject/${id}/">电影 ${id}</a></li>`;
      }).join('');
      const next = start === 0 ? '<span class="next"><a href="?start=15">后页</a></span>' : '';
      return htmlResponse(`<span class="subject-num">${start + 1}-${start + itemCount} / 16</span>${items}${next}`);
    });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', fetchMock);

    const page = await getUserCollectionPage({
      kind: 'movie',
      userId: 'tester',
      status: 'collect',
      count: 16,
      pageDelayMs: 7
    });

    expect(page.items).toHaveLength(16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 7)).toBe(true);
  });
});
