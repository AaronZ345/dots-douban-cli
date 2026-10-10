import { afterEach, describe, expect, it, vi } from 'vitest';
import { doulistUrl, getDoulist, parseDoulistPage } from '../api/doulist.ts';
import { searchMovies, type SearchMetadata } from '../api/search.ts';
import { searchBooks } from '../api/book.ts';

function page(id = '1', next: number | null = null) {
  return `<h1>混合书影单</h1><div id="doulist-desc">简介</div>
    <div class="doulist-item" id="item${id}"><div class="title"><a href="https://movie.douban.com/subject/${id}/">电影 ${id}</a></div><span class="rating_nums">8.5</span><div class="abstract">2026</div></div>
    <div class="paginator" data-total-count="2">${next === null ? '' : `<span class="next"><a href="?start=${next}">后页</a></span>`}</div>`;
}
function html(value: string, status = 200) { return new Response(value, { status, headers: { 'content-type': 'text/html' } }); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('doulist pagination', () => {
  it('accepts IDs and rejects foreign URLs', () => {
    expect(doulistUrl('42')).toBe('https://www.douban.com/doulist/42/');
    expect(() => doulistUrl('https://www.douban.com.evil.example/doulist/42/')).toThrow();
    expect(() => doulistUrl('https://user@www.douban.com/doulist/42/')).toThrow();
  });
  it('parses mixed subjects and preserves missing ratings as null', () => {
    const content = page().replace('movie.douban.com', 'book.douban.com').replace('<span class="rating_nums">8.5</span>', '');
    expect(parseDoulistPage(content, doulistUrl('42')).items[0]).toMatchObject({ kind: 'book', rating: null });
  });
  it('reads subsequent pages and retains a resumable cursor when limited', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(html(page('1', 25))).mockResolvedValueOnce(html(page('2')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getDoulist('42', { delayMs: 0 });
    expect(result.items.map((item) => item.id)).toEqual(['1', '2']);
    expect(result).toMatchObject({ partial: false, limited: false, nextStart: null });
    expect(String(fetchMock.mock.calls[1][0])).toContain('start=25');
    fetchMock.mockReset().mockResolvedValue(html(page('1', 25)));
    expect(await getDoulist('42', { limit: 1 })).toMatchObject({ limited: true, nextStart: 25, partial: false });
  });
  it('preserves earlier pages while reporting partial failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(html(page('1', 25))).mockResolvedValueOnce(html('denied', 403)));
    const result = await getDoulist('42', { delayMs: 0 });
    expect(result).toMatchObject({ partial: true, limited: false, nextStart: 25 });
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
  it('fails closed for an unrecognized empty page or foreign next link', () => {
    expect(() => parseDoulistPage('<h1>列表</h1>', doulistUrl('42'))).toThrow('不能判断为空');
    expect(() => parseDoulistPage(page('1', 25).replace('?start=25', 'https://evil.example/?start=25'), doulistUrl('42'))).toThrow();
  });
});
describe('search completeness', () => {
  it.each(['movie', 'book'] as const)('reports a failed later %s page in metadata', async (kind) => {
    const fixture = `<script>window.__DATA__=${JSON.stringify({ start: 0, count: 15, total: 30, items: [{ tpl_name: 'search_subject', id: '1', title: '标题', url: `https://${kind}.douban.com/subject/1/`, rating: { value: 8 } }] })};</script>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(html(fixture)).mockResolvedValueOnce(html('denied', 403)));
    const metadata: SearchMetadata = { partial: false, warnings: [] };
    const items = await (kind === 'movie' ? searchMovies : searchBooks)('标题', 0, 30, metadata);
    expect(items).toHaveLength(1);
    expect(metadata.partial).toBe(true);
    expect(metadata.warnings[0]).toContain('start=15');
  });
  it('does not replace a valid empty book search with suggestions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html('<script>window.__DATA__={"start":0,"count":0,"total":0,"items":[]};</script>'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchBooks('无结果')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
