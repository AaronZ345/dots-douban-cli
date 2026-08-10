import { cleanText, extractWindowJsonObject, fetchHtml, fetchJson, normalizeTitle, ResponseSchemaError } from './common.js';
import { debug } from '../utils/debug.js';

export interface SearchItem {
  id: string;
  title: string;
  rating: string;
  year?: string;
  url: string;
  cover?: string;
  abstract?: string;
}

interface SubjectSuggestItem {
  id?: string | number;
  title?: string;
  sub_title?: string;
  year?: string | number;
  url?: string;
  img?: string;
  type?: string;
}

interface MovieSearchPage {
  items: SearchItem[];
  start: number;
  count: number;
  total: number;
}

interface SuggestResult {
  years: Map<string, string>;
  items: SearchItem[];
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

async function fetchSuggestions(keyword: string): Promise<SuggestResult> {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(keyword)}`;
  const response = await fetchJson<SubjectSuggestItem[]>(url, {
    Referer: 'https://movie.douban.com/'
  });
  if (!Array.isArray(response)) {
    throw new ResponseSchemaError('电影建议接口返回格式异常', url);
  }

  const years = new Map<string, string>();
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  for (const item of response) {
    if (item.type && item.type !== 'movie' && item.type !== 'tv') continue;
    const id = String(item.id || '').trim();
    const title = normalizeTitle(item.title || '');
    const year = item.year ? String(item.year).trim() : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    if (year) years.set(id, year);
    items.push({
      id,
      title,
      rating: '-',
      year: year || undefined,
      url: item.url || `https://movie.douban.com/subject/${id}/`,
      cover: item.img,
      abstract: cleanText(item.sub_title || '') || undefined
    });
  }
  return { years, items };
}

export function parseMovieSearchPage(html: string, url = 'https://search.douban.com/movie/subject_search'): MovieSearchPage {
  const rawData = extractWindowJsonObject(html, '__DATA__');
  if (!rawData) throw new ResponseSchemaError('搜索页未找到完整的 __DATA__ JSON 数据', url);

  let data: {
    start?: number;
    count?: number;
    total?: number;
    items?: Array<{
      tpl_name?: string;
      id?: string | number;
      title?: string;
      url?: string;
      cover_url?: string;
      abstract?: string;
      rating?: { value?: number };
    }>;
  };
  try {
    data = JSON.parse(rawData) as typeof data;
  } catch (error) {
    throw new ResponseSchemaError(
      `搜索页 __DATA__ 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      url,
      rawData.slice(0, 240)
    );
  }

  if (!Array.isArray(data.items)) {
    throw new ResponseSchemaError('搜索页 __DATA__.items 不是数组', url, rawData.slice(0, 240));
  }

  const items = data.items
    .filter((item) => item.tpl_name === 'search_subject' && !!item.url)
    .map((item) => {
      const ratingValue = typeof item.rating?.value === 'number' && Number.isFinite(item.rating.value)
        ? item.rating.value.toFixed(1)
        : '-';
      const yearMatch = (item.abstract || '').match(/(19|20)\d{2}/);
      return {
        id: String(item.id || '').trim(),
        title: normalizeTitle(item.title || ''),
        rating: ratingValue,
        year: yearMatch?.[0],
        url: item.url || '',
        cover: item.cover_url,
        abstract: cleanText(item.abstract || '')
      };
    })
    .filter((item) => item.id && item.title);

  const start = nonNegativeInteger(data.start, 0);
  const count = nonNegativeInteger(data.count, items.length);
  const total = nonNegativeInteger(data.total, start + count);
  if (count > 0 && items.length === 0 && start < total) {
    throw new ResponseSchemaError('搜索页声明有结果但未解析出任何电影', url, rawData.slice(0, 240));
  }

  return { items, start, count, total };
}

/**
 * Search movies through the HTML search endpoint and aggregate its 15-item pages.
 */
export async function searchMovies(keyword: string, start = 0, limit = 20): Promise<SearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const suggestionPromise = fetchSuggestions(query).catch((error): SuggestResult => {
    const message = error instanceof Error ? error.message : String(error);
    debug('search', `suggest 接口失败: ${message}`);
    return { years: new Map<string, string>(), items: [] };
  });

  const results: SearchItem[] = [];
  const seen = new Set<string>();
  let pageStart = start;
  let firstPageError: unknown;
  const maxPages = Math.min(50, Math.max(1, Math.ceil(limit / 15) + 3));

  for (let pageNumber = 0; pageNumber < maxPages && results.length < limit; pageNumber += 1) {
    const pageUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(query)}&cat=1002&start=${pageStart}`;
    let page: MovieSearchPage;
    try {
      const html = await fetchHtml(pageUrl, { Referer: 'https://www.douban.com/' });
      page = parseMovieSearchPage(html, pageUrl);
    } catch (error) {
      if (results.length === 0) firstPageError = error;
      const message = error instanceof Error ? error.message : String(error);
      debug('search', `${results.length > 0 ? '后续搜索页失败，保留已有结果' : '首个搜索页失败'}: ${message}`);
      break;
    }

    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      if (results.length >= limit) break;
    }

    if (page.count <= 0 || pageStart + page.count >= page.total) break;
    const nextStart = pageStart + page.count;
    if (nextStart <= pageStart) {
      throw new ResponseSchemaError('电影搜索分页游标没有前进', pageUrl);
    }
    pageStart = nextStart;
  }

  const suggestions = await suggestionPromise;
  if (results.length === 0 && firstPageError && start === 0 && suggestions.items.length > 0) {
    return suggestions.items.slice(0, limit);
  }
  if (results.length === 0 && firstPageError) throw firstPageError;

  return results.slice(0, limit).map((item) => ({
    ...item,
    year: suggestions.years.get(item.id) || item.year
  }));
}
