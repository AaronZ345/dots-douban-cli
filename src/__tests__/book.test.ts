import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBookInfo, getBookNotes, searchBooks } from '../api/book.ts';
import { parseBookDetailHtml, parseBookMediaList, parseBookSearchPage } from '../api/book-parsers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function searchHtml(start: number, total: number, ids: number[]): string {
  return `<script>window.__DATA__ = ${JSON.stringify({
    start,
    count: ids.length,
    total,
    items: ids.map((id) => ({
      tpl_name: 'search_subject',
      id,
      title: `书 ${id}`,
      url: `https://book.douban.com/subject/${id}/`,
      abstract: `作者 / 出版社 / 2026-${id % 12 + 1}`,
      rating: { value: 8.5 }
    }))
  })};</script>`;
}

describe('book parsers', () => {
  it('parses paginated search metadata and subjects', () => {
    const page = parseBookSearchPage(searchHtml(15, 40, [16, 17, 18]));

    expect(page.start).toBe(15);
    expect(page.count).toBe(3);
    expect(page.total).toBe(40);
    expect(page.items[0]).toMatchObject({ id: '16', title: '书 16', rating: '8.5', year: '2026' });
  });

  it('rejects malformed search payloads instead of treating them as empty results', () => {
    const missingItems = '<script>window.__DATA__ = {"start":0,"count":1,"total":1};</script>';
    const invalidCount = '<script>window.__DATA__ = {"start":0,"count":"1","total":1,"items":[]};</script>';

    expect(() => parseBookSearchPage(missingItems)).toThrow('items 不是数组');
    expect(() => parseBookSearchPage(invalidCount)).toThrow('count 不是非负整数');
  });

  it('parses current chart media blocks', () => {
    const html = `
      <li class="media clearfix">
        <strong class="green-num-box">1</strong>
        <span class="trend up"></span><span class="rank-value">2</span>
        <a href="https://book.douban.com/subject/1234567/"><img class="subject-cover" src="cover.jpg"></a>
        <div class="media__body">
          <h2><a class="fleft" href="https://book.douban.com/subject/1234567/">测试图书</a></h2>
          <p class="subject-abstract color-gray">作者 / 2026 / 出版社</p>
          <p class="subject-rating"><span class="font-small fleft">9.1</span><span class="fleft ml8 color-gray">(123人评价)</span></p>
          <div class="subject-tags"><span class="tag">小说</span></div>
        </div>
      </li>`;

    expect(parseBookMediaList(html)[0]).toMatchObject({
      id: '1234567',
      title: '测试图书',
      rating: '9.1',
      votes: '123人评价',
      rank: 1,
      trend: 'up 2',
      tags: ['小说']
    });
  });

  it('parses detail fields and rating distribution from HTML', () => {
    const html = `
      <meta property="og:image" content="cover.jpg">
      <span property="v:itemreviewed">测试书</span>
      <strong property="v:average">9.2</strong>
      <span property="v:votes">12,345</span>
      <div id="info">
        <span class="pl">作者</span>: <a>作者甲</a><br>
        <span class="pl">出版社</span>: 测试出版社<br>
        <span class="pl">副标题</span>: 一个副标题<br>
        <span class="pl">ISBN</span>: 9781234567890<br>
      </div>
      <div class="rating_per">50.0%</div>
      <span class="rating_per">30.0%</span><span class="rating_per">15.0%</span>
      <span class="rating_per">4.0%</span><span class="rating_per">1.0%</span>
      <div class="indent" id="link-report"><div class="intro">这是简介</div></div>`;

    expect(parseBookDetailHtml(html)).toMatchObject({
      title: '测试书',
      rating: '9.2',
      rating_count: 12345,
      author: '作者甲',
      publisher: '测试出版社',
      subtitle: '一个副标题',
      isbn: '9781234567890',
      summary: '这是简介'
    });
  });
});

describe('book API orchestration', () => {
  it('rejects malformed annotation responses instead of returning an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));

    await expect(getBookNotes('2567698')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('rejects malformed annotation entries without leaking TypeErrors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ annotations: [null] })));

    await expect(getBookNotes('2567698')).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('aggregates multiple 15-item search pages to satisfy limit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const start = Number(new URL(url).searchParams.get('start') || 0);
      const ids = Array.from({ length: 15 }, (_, index) => start + index + 1);
      return new Response(searchHtml(start, 40, ids), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const items = await searchBooks('测试', 0, 20);

    expect(items).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('start=15');
  });

  it('maps the current mobile array schema and dedicated tags endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/tags')) {
        return Response.json({ tags: ['科幻', '中国科幻'] });
      }
      if (url.includes('m.douban.com/rexxar/api/v2/book/2567698')) {
        return Response.json({
          title: '三体',
          rating: { value: 8.9, count: 517251 },
          author: ['刘慈欣'],
          press: ['重庆出版社'],
          pubdate: ['2008-1'],
          subtitle: ['“地球往事”三部曲之一'],
          pages: ['302'],
          price: ['23.00'],
          comment_count: 124664,
          review_count: 4778,
          intro: '测试简介',
          cover_url: 'cover.jpg'
        });
      }
      return new Response('blocked', { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const detail = await getBookInfo('2567698');

    expect(detail).toMatchObject({
      title: '三体',
      publisher: '重庆出版社',
      pubdate: '2008-1',
      subtitle: '“地球往事”三部曲之一',
      pages: '302',
      price: '23.00',
      tags: ['科幻', '中国科幻']
    });
  });

  it('falls back to HTML when the mobile detail endpoint fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/subject/1234567/')) {
        return new Response(`
          <span property="v:itemreviewed">HTML 书籍</span>
          <strong property="v:average">8.8</strong>
          <div id="info">
            <span class="pl">作者</span>: 网页作者<br>
            <span class="pl">出版社</span>: 网页出版社<br>
            <span class="pl">ISBN</span>: 9781234567890<br>
          </div>`, { status: 200 });
      }
      return new Response('failed', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const detail = await getBookInfo('1234567');

    expect(detail).toMatchObject({
      title: 'HTML 书籍',
      rating: '8.8',
      author: '网页作者',
      publisher: '网页出版社',
      isbn: '9781234567890'
    });
  });
});
