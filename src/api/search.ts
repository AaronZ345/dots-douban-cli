import { cleanText, extractWindowJsonObject, fetchHtml, fetchJson, isRecord, normalizeTitle, ResponseSchemaError } from './common.js';
import { debug } from '../utils/debug.js';
import { sleep } from '../utils/timing.js';

export interface SearchMetadata { partial: boolean; warnings: string[]; source?: string }

export interface SearchItem {
  id: string;
  title: string;
  rating: string;
  year?: string;
  url: string;
  cover?: string;
  abstract?: string;
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

function readPaginationValue(
  data: Record<string, unknown>,
  field: 'start' | 'count' | 'total',
  url: string
): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ResponseSchemaError(`搜索页 __DATA__.${field} 不是非负整数`, url);
  }
  return value;
}

async function fetchSuggestions(keyword: string): Promise<SuggestResult> {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(keyword)}`;
  const response = await fetchJson<unknown>(url, {
    Referer: 'https://movie.douban.com/'
  });
  if (!Array.isArray(response)) {
    throw new ResponseSchemaError('电影建议接口返回格式异常', url);
  }
  const records = response.filter(isRecord);
  if (response.length > 0 && records.length === 0) {
    throw new ResponseSchemaError('电影建议接口未返回有效条目', url);
  }

  const years = new Map<string, string>();
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    if (typeof item.type === 'string' && item.type !== 'movie' && item.type !== 'tv') continue;
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '';
    const title = normalizeTitle(typeof item.title === 'string' ? item.title : '');
    const year = typeof item.year === 'string' || typeof item.year === 'number' ? String(item.year).trim() : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    if (year) years.set(id, year);
    items.push({
      id,
      title,
      rating: '-',
      year: year || undefined,
      url: typeof item.url === 'string' ? item.url : `https://movie.douban.com/subject/${id}/`,
      cover: typeof item.img === 'string' ? item.img : undefined,
      abstract: cleanText(typeof item.sub_title === 'string' ? item.sub_title : '') || undefined
    });
  }
  return { years, items };
}

export function parseMovieSearchPage(html: string, url = 'https://search.douban.com/movie/subject_search'): MovieSearchPage {
  const rawData = extractWindowJsonObject(html, '__DATA__');
  if (!rawData) throw new ResponseSchemaError('搜索页未找到完整的 __DATA__ JSON 数据', url);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    throw new ResponseSchemaError(
      `搜索页 __DATA__ 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      url,
      rawData.slice(0, 240)
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new ResponseSchemaError('搜索页 __DATA__.items 不是数组', url, rawData.slice(0, 240));
  }

  const items = parsed.items
    .filter(isRecord)
    .filter((item) => item.tpl_name === 'search_subject' && typeof item.url === 'string')
    .map((item) => {
      const rating = isRecord(item.rating) ? item.rating.value : undefined;
      const ratingValue = typeof rating === 'number' && Number.isFinite(rating)
        ? rating.toFixed(1)
        : '-';
      const abstract = typeof item.abstract === 'string' ? item.abstract : '';
      const yearMatch = abstract.match(/(19|20)\d{2}/);
      return {
        id: typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '',
        title: normalizeTitle(typeof item.title === 'string' ? item.title : ''),
        rating: ratingValue,
        year: yearMatch?.[0],
        url: item.url as string,
        cover: typeof item.cover_url === 'string' ? item.cover_url : undefined,
        abstract: cleanText(abstract)
      };
    })
    .filter((item) => item.id && item.title);

  const start = readPaginationValue(parsed, 'start', url);
  const count = readPaginationValue(parsed, 'count', url);
  const total = readPaginationValue(parsed, 'total', url);
  if (count > 0 && items.length === 0 && start < total) {
    throw new ResponseSchemaError('搜索页声明有结果但未解析出任何电影', url, rawData.slice(0, 240));
  }

  return { items, start, count, total };
}

/**
 * Search movies through the HTML search endpoint and aggregate its 15-item pages.
 */
export async function searchMovies(keyword: string, start = 0, limit = 20, metadata?: SearchMetadata): Promise<SearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const report = metadata ?? { partial: false, warnings: [] };
  report.source = '完整搜索';

  const results: SearchItem[] = [];
  const seen = new Set<string>();
  let pageStart = start;
  let firstPageError: unknown;
  const maxPages = Math.min(50, Math.max(1, Math.ceil(limit / 15) + 3));

  for (let pageNumber = 0; pageNumber < maxPages && results.length < limit; pageNumber += 1) {
    if (pageNumber) await sleep(1000);
    const pageUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(query)}&cat=1002&start=${pageStart}`;
    let page: MovieSearchPage;
    try {
      const html = await fetchHtml(pageUrl, { Referer: 'https://www.douban.com/' });
      page = parseMovieSearchPage(html, pageUrl);
      if (page.start !== pageStart) {
        throw new ResponseSchemaError(`电影搜索分页起点异常：请求 ${pageStart}，返回 ${page.start}`, pageUrl);
      }
    } catch (error) {
      if (results.length === 0) firstPageError = error;
      const message = error instanceof Error ? error.message : String(error);
      report.partial = true;
      report.warnings.push(`start=${pageStart} 搜索页失败：${message}`);
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

  if (results.length === 0 && firstPageError && start === 0) {
    let suggestions: SuggestResult;
    try { suggestions = await fetchSuggestions(query); } catch { throw firstPageError; }
    if (suggestions.items.length) {
      report.source = '搜索建议';
      report.warnings.push('完整搜索不可用，返回搜索建议；结果不保证完整');
      return suggestions.items.slice(0, limit);
    }
  }
  if (results.length === 0 && firstPageError) throw firstPageError;

  if (results.length < limit && results.length >= maxPages * 15) {
    report.partial = true;
    report.warnings.push('达到搜索页数上限');
  }
  return results.slice(0, limit);
}
