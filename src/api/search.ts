import { cleanText, extractWindowJsonObject, fetchHtml, fetchJson, normalizeTitle } from './common.js';
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
  id?: string;
  year?: string;
}

async function fetchSuggestYears(keyword: string): Promise<Map<string, string>> {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(keyword)}`;
  const items = await fetchJson<SubjectSuggestItem[]>(url, {
    Referer: 'https://movie.douban.com/'
  });

  const map = new Map<string, string>();
  for (const item of items) {
    const id = item.id ? String(item.id).trim() : '';
    const year = item.year ? String(item.year).trim() : '';
    if (!id || !year) continue;
    map.set(id, year);
  }
  return map;
}

function parseSearchFromHtml(html: string, limit: number): SearchItem[] {
  const rawData = extractWindowJsonObject(html, '__DATA__');
  if (!rawData) throw new Error('搜索页未找到完整的 __DATA__ JSON 数据');

  const data = JSON.parse(rawData) as {
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

  return (data.items || [])
    .filter((item) => item.tpl_name === 'search_subject' && !!item.url)
    .map((item) => {
      const ratingValue = typeof item.rating?.value === 'number' ? item.rating.value.toFixed(1) : '-';
      const yearMatch = (item.abstract || '').match(/(19|20)\d{2}/);
      return {
        id: String(item.id || ''),
        title: normalizeTitle(item.title || ''),
        rating: ratingValue,
        year: yearMatch?.[0],
        url: item.url || '',
        cover: item.cover_url,
        abstract: cleanText(item.abstract || '')
      };
    })
    .filter((item) => item.id && item.title)
    .slice(0, limit);
}

/**
 * Search movies by keyword.
 * Try Douban JSON API first, then fallback to HTML parsing.
 */
export async function searchMovies(keyword: string, start = 0, limit = 20): Promise<SearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [];

  let suggestYears = new Map<string, string>();
  try {
    suggestYears = await fetchSuggestYears(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('search', `suggest 年份接口失败: ${message}`);
  }

  try {
    const apiUrl = `https://www.douban.com/j/search?q=${encodeURIComponent(query)}&start=${start}&cat=1002`;
    const data = await fetchJson<{ items?: Array<Record<string, unknown>> }>(apiUrl, {
      Referer: 'https://www.douban.com/search'
    });

    if (!Array.isArray(data.items)) throw new Error('搜索接口返回格式异常');

    const items = data.items
      .map((item) => {
        const rawId = String(item.id || '');
        const ratingValue = typeof item.rating === 'number'
          ? item.rating.toFixed(1)
          : typeof item.rating === 'string'
            ? item.rating
            : '-';
        return {
          id: rawId,
          title: normalizeTitle(String(item.title || '')),
          rating: ratingValue,
          year: item.year ? String(item.year) : undefined,
          url: String(item.url || `https://movie.douban.com/subject/${rawId}/`),
          cover: item.img ? String(item.img) : undefined,
          abstract: item.abstract ? cleanText(String(item.abstract)) : undefined
        };
      })
      .filter((item) => item.id && item.title)
      .slice(0, limit);

    if (items.length > 0) {
      return items.map((item) => ({
        ...item,
        year: suggestYears.get(item.id) || item.year
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('search', `JSON 搜索接口失败，回退 HTML 解析: ${message}`);
  }

  const pageUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(query)}&cat=1002&start=${start}`;
  const html = await fetchHtml(pageUrl, { Referer: 'https://www.douban.com/' });
  return parseSearchFromHtml(html, limit).map((item) => ({
    ...item,
    year: suggestYears.get(item.id) || item.year
  }));
}
