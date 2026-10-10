import {
  BOOK_BASE,
  cleanText,
  fetchHtml,
  fetchJson,
  isChallengePage,
  isRecord,
  normalizeTitle,
  ResponseSchemaError
} from './common.js';
import {
  parseBookDetailHtml,
  parseBookMediaList,
  parseBookSearchPage,
  parseBookTop250Page,
  type ParsedBookDetail
} from './book-parsers.js';
import {
  getSubjectComments,
  getSubjectRatingStats,
  getSubjectReviews,
  type SubjectPaginatedResult,
  type SubjectCommentItem,
  type SubjectRatingStats,
  type SubjectReviewItem
} from './subject.js';
import { debug } from '../utils/debug.js';

export interface BookItem {
  id: string;
  title: string;
  rating: string;
  votes: string;
  meta: string;
  url: string;
  cover?: string;
  abstract?: string;
  rank?: number;
  trend?: string;
  tags?: string[];
}

export interface BookSearchItem extends BookItem {
  year?: string;
}

export interface BookSeries {
  title: string;
  url: string;
  total?: number;
}

export interface BookDetail {
  id: string;
  title: string;
  original_title: string;
  rating: string;
  rating_count: number;
  rating_distribution: number[];
  author: string;
  translator: string[];
  publisher: string;
  producer: string[];
  pubdate: string;
  subtitle: string;
  pages: string;
  price: string;
  binding: string;
  isbn: string;
  comment_count: number;
  review_count: number;
  annotation_count: number;
  tags: string[];
  summary: string;
  author_intro: string;
  catalog: string;
  cover: string;
  series: BookSeries | null;
  has_ebook: boolean;
  url: string;
}

export interface BookNoteItem {
  id: string;
  user: string;
  chapter: string;
  content: string;
  time: string;
  url: string;
}

export type BookReviewItem = SubjectReviewItem;
export type BookCommentItem = SubjectCommentItem;
export type BookRatingStats = SubjectRatingStats;

export const BOOK_CHART_CATEGORIES = {
  '全部': '',
  '文学': 'literary',
  '小说': 'novel',
  '历史文化': 'history',
  '社会纪实': 'social',
  '科学新知': 'tech',
  '艺术设计': 'art',
  '商业经管': 'business',
  '绘本漫画': 'comics'
} as const;

type BookCategory = keyof typeof BOOK_CHART_CATEGORIES;

export const BOOK_LATEST_CATEGORIES = Object.freeze(Object.keys(BOOK_CHART_CATEGORIES) as BookCategory[]);

export const BOOK_CHART_PAGE_LIMIT = 20;

function isBookCategory(value: string): value is BookCategory {
  return Object.hasOwn(BOOK_CHART_CATEGORIES, value);
}

function normalizeList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of values) {
    let raw = '';
    if (typeof item === 'string' || typeof item === 'number') {
      raw = String(item);
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      raw = String(record.name || record.title || record.tag || '');
    }

    const text = cleanText(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }

  return result;
}

function normalizeScalar(value: unknown): string {
  return normalizeList(value).join(' / ');
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
}

/**
 * Get Douban Book Top250.
 */
export async function getBookTop250(start = 0, limit = 20): Promise<BookItem[]> {
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const results: BookItem[] = [];
  const seen = new Set<string>();
  let pageStart = start;

  while (results.length < limit) {
    const html = await fetchHtml(`${BOOK_BASE}/top250?start=${pageStart}`, { Referer: BOOK_BASE });
    if (isChallengePage(html)) throw new Error('图书 Top250 页面触发了反爬挑战，暂时无法解析');

    const pageItems = parseBookTop250Page(html);
    if (pageItems.length === 0 && pageStart < 250) {
      throw new ResponseSchemaError('图书 Top250 页面未解析出预期条目', `${BOOK_BASE}/top250?start=${pageStart}`);
    }
    let added = 0;
    for (const item of pageItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      added += 1;
      if (results.length >= limit) break;
    }

    if (added === 0 || pageItems.length < 25 || pageStart + 25 >= 250) break;
    pageStart += 25;
  }

  return results;
}

/**
 * Keep the original public API behavior for callers that used `getBookHot` as
 * a Top250 data source before v0.4.0.
 */
export function getBookHot(start = 0, limit = 20): Promise<BookItem[]> {
  return getBookTop250(start, limit);
}

/**
 * Get the current monthly popular book chart.
 */
export async function getBookChart(category = '全部', limit = 20): Promise<BookItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  if (limit > BOOK_CHART_PAGE_LIMIT) {
    throw new RangeError(`热门图书榜单最多返回 ${BOOK_CHART_PAGE_LIMIT} 条，当前请求 ${limit} 条`);
  }
  if (!isBookCategory(category)) {
    throw new Error(`不支持的榜单分类：${category}`);
  }
  const subcat = BOOK_CHART_CATEGORIES[category];

  const query = subcat ? `?subcat=${encodeURIComponent(subcat)}` : '';
  const html = await fetchHtml(`${BOOK_BASE}/chart${query}`, { Referer: BOOK_BASE });
  if (isChallengePage(html)) throw new Error('热门图书榜触发了反爬挑战，暂时无法解析');
  const items = parseBookMediaList(html);
  if (items.length === 0) {
    throw new ResponseSchemaError('热门图书榜页面未解析出预期条目', `${BOOK_BASE}/chart${query}`);
  }
  return items.slice(0, limit);
}

/**
 * Get recently published books, optionally filtered by category.
 */
export async function getLatestBooks(category = '全部', limit = 20): Promise<BookItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  if (limit > BOOK_CHART_PAGE_LIMIT) {
    throw new RangeError(`新书速递最多返回 ${BOOK_CHART_PAGE_LIMIT} 条，当前请求 ${limit} 条`);
  }
  if (!isBookCategory(category)) {
    throw new Error(`不支持的新书分类：${category}`);
  }

  const query = category === '全部' ? '' : `?subcat=${encodeURIComponent(category)}`;
  const html = await fetchHtml(`${BOOK_BASE}/latest${query}`, { Referer: BOOK_BASE });
  if (isChallengePage(html)) throw new Error('新书速递页面触发了反爬挑战，暂时无法解析');
  const items = parseBookMediaList(html);
  if (items.length === 0) {
    throw new ResponseSchemaError('新书速递页面未解析出预期条目', `${BOOK_BASE}/latest${query}`);
  }
  return items.slice(0, limit);
}

async function searchBookSuggestions(keyword: string, limit: number): Promise<BookSearchItem[]> {
  const url = `${BOOK_BASE}/j/subject_suggest?q=${encodeURIComponent(keyword)}`;
  const response = await fetchJson<unknown>(url, {
    Referer: `${BOOK_BASE}/`
  });

  if (!Array.isArray(response)) {
    throw new ResponseSchemaError('图书建议接口返回格式异常', `${BOOK_BASE}/j/subject_suggest`);
  }
  const items = response.filter(isRecord);
  if (response.length > 0 && items.length === 0) {
    throw new ResponseSchemaError('图书建议接口未返回有效条目', url);
  }
  return items
    .filter((item) => typeof item.type !== 'string' || item.type === 'b')
    .map((item) => {
      const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '';
      const year = typeof item.year === 'string' || typeof item.year === 'number' ? String(item.year) : undefined;
      const author = cleanText(typeof item.author_name === 'string' ? item.author_name : '');
      return {
        id,
        title: normalizeTitle(typeof item.title === 'string' ? item.title : ''),
        rating: '-',
        votes: '-',
        meta: [author, year].filter(Boolean).join(' / ') || '-',
        year,
        url: typeof item.url === 'string' ? item.url : `${BOOK_BASE}/subject/${id}/`,
        cover: typeof item.pic === 'string' ? item.pic : undefined,
        abstract: author
      };
    })
    .filter((item) => item.id && item.title)
    .slice(0, limit);
}

/**
 * Search books by keyword. Douban returns 15 subjects per page, so aggregate
 * pages until the requested limit is satisfied.
 */
export async function searchBooks(keyword: string, start = 0, limit = 20, metadata?: import('./search.js').SearchMetadata): Promise<BookSearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const results: BookSearchItem[] = [];
  const seen = new Set<string>();
  let pageStart = start;
  let firstPageError: unknown;
  const report = metadata ?? { partial: false, warnings: [] };
  report.source = '完整搜索';
  const maxPages = Math.min(50, Math.max(1, Math.ceil(limit / 15) + 3));

  for (let pageNumber = 0; pageNumber < maxPages && results.length < limit; pageNumber += 1) {
    if (pageNumber) await new Promise((resolve) => setTimeout(resolve, 1000));
    const url = `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(query)}&cat=1001&start=${pageStart}`;
    try {
      const html = await fetchHtml(url, { Referer: 'https://www.douban.com/' });
      if (isChallengePage(html)) throw new Error('图书搜索页面触发了反爬挑战');

      const page = parseBookSearchPage(html, url);
      if (page.start !== pageStart) {
        throw new ResponseSchemaError(`图书搜索分页起点异常：请求 ${pageStart}，返回 ${page.start}`, url);
      }
      for (const item of page.items) {
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        results.push({ ...item });
        if (results.length >= limit) break;
      }
      if (page.count <= 0 || pageStart + page.count >= page.total) break;
      const nextStart = pageStart + page.count;
      if (nextStart <= pageStart) throw new ResponseSchemaError('图书搜索分页游标没有前进', url);
      pageStart = nextStart;
    } catch (error) {
      if (results.length === 0) firstPageError = error;
      const message = error instanceof Error ? error.message : String(error);
      report.partial = true;
      report.warnings.push(`start=${pageStart} 搜索页失败：${message}`);
      debug('book', `${results.length > 0 ? '后续搜索页失败，保留已有结果' : '完整搜索失败，准备回退建议接口'}: ${message}`);
      break;
    }
  }

  if (results.length > 0 || !firstPageError) return results.slice(0, limit);
  if (start > 0) {
    if (firstPageError) throw firstPageError;
    return [];
  }
  try {
    const items = await searchBookSuggestions(query, limit);
    report.source = '搜索建议';
    report.warnings.push('完整搜索不可用，返回搜索建议；结果不保证完整');
    return items;
  } catch (suggestionError) {
    if (firstPageError) throw firstPageError;
    throw suggestionError;
  }
}

interface MobileBookResponse {
  title?: string;
  original_title?: string;
  rating?: { value?: number; count?: number };
  author?: unknown;
  translator?: unknown;
  press?: unknown;
  publisher?: unknown;
  producers?: unknown;
  pubdate?: unknown;
  subtitle?: unknown;
  book_subtitle?: unknown;
  pages?: unknown;
  price?: unknown;
  comment_count?: number;
  review_count?: number;
  annotation_count?: number;
  tags?: unknown;
  intro?: string;
  summary?: string;
  author_intro?: string;
  catalog?: string;
  cover_url?: string;
  pic?: { large?: string; normal?: string } | string;
  book_series?: { title?: string; url?: string; total_number?: number };
  has_ebook?: boolean;
  url?: string;
}

async function fetchBookHtmlDetail(bookId: string): Promise<ParsedBookDetail> {
  const html = await fetchHtml(`${BOOK_BASE}/subject/${bookId}/`, { Referer: BOOK_BASE });
  if (isChallengePage(html)) throw new Error('图书详情页面触发了反爬挑战');
  return parseBookDetailHtml(html);
}

export async function getBookTags(id: string): Promise<string[]> {
  const bookId = id.trim();
  if (!/^\d+$/.test(bookId)) throw new Error('书籍 ID 必须是纯数字');

  const url = `https://m.douban.com/rexxar/api/v2/book/${bookId}/tags`;
  const data = await fetchJson<unknown>(
    url,
    { Referer: `https://m.douban.com/book/subject/${bookId}/` }
  );
  if (!isRecord(data) || !('tags' in data)) {
    throw new ResponseSchemaError('图书标签接口返回格式异常', url);
  }
  return normalizeList(data.tags);
}

/**
 * Get book detail from independent mobile, HTML, and tags sources. Any one of
 * the detail sources may fail without preventing the other from succeeding.
 */
export async function getBookInfo(id: string): Promise<BookDetail> {
  const bookId = id.trim();
  if (!/^\d+$/.test(bookId)) throw new Error('书籍 ID 必须是纯数字');

  const url = `${BOOK_BASE}/subject/${bookId}/`;
  const [mobileResult, htmlResult, tagsResult] = await Promise.allSettled([
    fetchJson<MobileBookResponse>(`https://m.douban.com/rexxar/api/v2/book/${bookId}`, {
      Referer: `https://m.douban.com/book/subject/${bookId}/`
    }),
    fetchBookHtmlDetail(bookId),
    getBookTags(bookId)
  ]);

  const mobile = mobileResult.status === 'fulfilled' ? mobileResult.value : undefined;
  const html = htmlResult.status === 'fulfilled' ? htmlResult.value : undefined;
  const remoteTags = tagsResult.status === 'fulfilled' ? tagsResult.value : [];

  if (mobileResult.status === 'rejected') {
    debug('book', `移动端详情失败: ${mobileResult.reason instanceof Error ? mobileResult.reason.message : String(mobileResult.reason)}`);
  }
  if (htmlResult.status === 'rejected') {
    debug('book', `PC 详情失败: ${htmlResult.reason instanceof Error ? htmlResult.reason.message : String(htmlResult.reason)}`);
  }
  if (tagsResult.status === 'rejected') {
    debug('book', `标签接口失败: ${tagsResult.reason instanceof Error ? tagsResult.reason.message : String(tagsResult.reason)}`);
  }

  const title = normalizeTitle(mobile?.title || html?.title || '');
  if (!title) throw new Error(`解析书籍详情失败，ID=${bookId}`);

  const mobileAuthor = normalizeList(mobile?.author);
  const mobileTranslator = normalizeList(mobile?.translator);
  const mobileProducer = normalizeList(mobile?.producers);
  const mobileTags = normalizeList(mobile?.tags);
  const mobilePic = typeof mobile?.pic === 'string'
    ? mobile.pic
    : mobile?.pic?.large || mobile?.pic?.normal || '';
  const mobileSeries = mobile?.book_series?.title
    ? {
      title: cleanText(mobile.book_series.title),
      url: cleanText(mobile.book_series.url || ''),
      total: normalizeCount(mobile.book_series.total_number) || undefined
    }
    : null;

  return {
    id: bookId,
    title,
    original_title: cleanText(mobile?.original_title || '') || html?.original_title || '-',
    rating: typeof mobile?.rating?.value === 'number'
      ? mobile.rating.value.toFixed(1)
      : html?.rating || '-',
    rating_count: normalizeCount(mobile?.rating?.count) || html?.rating_count || 0,
    rating_distribution: html?.rating_distribution || [],
    author: mobileAuthor.length > 0 ? mobileAuthor.join(' / ') : html?.author || '-',
    translator: mobileTranslator.length > 0 ? mobileTranslator : html?.translator || [],
    publisher: normalizeScalar(mobile?.press || mobile?.publisher) || html?.publisher || '-',
    producer: mobileProducer.length > 0 ? mobileProducer : html?.producer || [],
    pubdate: normalizeScalar(mobile?.pubdate) || html?.pubdate || '-',
    subtitle: normalizeScalar(mobile?.book_subtitle || mobile?.subtitle) || html?.subtitle || '-',
    pages: normalizeScalar(mobile?.pages) || html?.pages || '-',
    price: normalizeScalar(mobile?.price) || html?.price || '-',
    binding: html?.binding || '-',
    isbn: html?.isbn || '-',
    comment_count: normalizeCount(mobile?.comment_count),
    review_count: normalizeCount(mobile?.review_count),
    annotation_count: normalizeCount(mobile?.annotation_count),
    tags: remoteTags.length > 0 ? remoteTags : mobileTags.length > 0 ? mobileTags : html?.tags || [],
    summary: cleanText(mobile?.intro || mobile?.summary || '') || html?.summary || '-',
    author_intro: cleanText(mobile?.author_intro || '') || html?.author_intro || '-',
    catalog: cleanText(mobile?.catalog || '') || html?.catalog || '-',
    cover: cleanText(mobile?.cover_url || mobilePic) || html?.cover || '',
    series: mobileSeries || (html?.series ? { ...html.series } : null),
    has_ebook: mobile?.has_ebook === true,
    url: cleanText(mobile?.url || '') || url
  };
}

export function getBookComments(
  bookId: string,
  orderBy: 'hot' = 'hot',
  start = 0,
  count = 20
): Promise<SubjectPaginatedResult<BookCommentItem>> {
  return getSubjectComments('book', bookId, orderBy, start, count);
}

export function getBookReviews(
  bookId: string,
  start = 0,
  limit = 20
): Promise<SubjectPaginatedResult<BookReviewItem>> {
  return getSubjectReviews('book', bookId, start, limit);
}

export function getBookRatingStats(bookId: string): Promise<BookRatingStats> {
  return getSubjectRatingStats('book', bookId);
}

export async function getBookNotes(
  bookId: string,
  start = 0,
  limit = 20
): Promise<SubjectPaginatedResult<BookNoteItem>> {
  const id = bookId.trim();
  if (!/^\d+$/.test(id)) throw new Error('书籍 ID 必须是纯数字');
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return { items: [], total: 0 };

  interface AnnotationResponse {
    total?: number;
    annotations: Array<{
      id?: string;
      chapter?: string;
      title?: string;
      abstract?: string;
      create_time?: string;
      author?: { name?: string };
      user?: { name?: string };
      url?: string;
    }>;
  }

  const url = `https://m.douban.com/rexxar/api/v2/book/${id}/annotations?count=${limit}&start=${start}`;
  const rawData = await fetchJson<unknown>(url, {
    Referer: `https://m.douban.com/book/subject/${id}/`
  });
  if (!isRecord(rawData) || !Array.isArray(rawData.annotations)) {
    throw new ResponseSchemaError('读书笔记接口返回格式异常', url);
  }
  const annotations = rawData.annotations.filter(isRecord) as unknown as AnnotationResponse['annotations'];
  if (rawData.annotations.length > 0 && annotations.length === 0) {
    throw new ResponseSchemaError('读书笔记接口未返回有效条目', url);
  }

  const items = annotations.filter((item) => !!item.id).map((item) => ({
    id: item.id || '',
    user: cleanText(item.author?.name || item.user?.name || '') || '匿名',
    chapter: cleanText(item.chapter || item.title || '') || '-',
    content: cleanText(item.abstract || ''),
    time: cleanText(item.create_time || ''),
    url: item.url || `${BOOK_BASE}/annotation/${item.id || ''}/`
  }));

  return {
    items,
    total: typeof rawData.total === 'number' && Number.isFinite(rawData.total) && rawData.total >= 0
      ? Math.trunc(rawData.total)
      : items.length
  };
}
