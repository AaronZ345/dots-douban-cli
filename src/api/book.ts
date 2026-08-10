import {
  BOOK_BASE,
  cleanText,
  fetchHtml,
  fetchJson,
  isChallengePage,
  normalizeTitle
} from './common.js';
import {
  parseBookDetailHtml,
  parseBookMediaList,
  parseBookSearchPage,
  parseBookSubjectList,
  parseBookTop250Page,
  type ParsedBookDetail,
  type ParsedBookListItem
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

export const BOOK_CHART_CATEGORIES: Record<string, string> = {
  '全部': '',
  '文学': 'literary',
  '小说': 'novel',
  '历史文化': 'history',
  '社会纪实': 'social',
  '科学新知': 'tech',
  '艺术设计': 'art',
  '商业经管': 'business',
  '绘本漫画': 'comics'
};

export const BOOK_LATEST_CATEGORIES = [
  '全部',
  '文学',
  '小说',
  '历史文化',
  '社会纪实',
  '科学新知',
  '艺术设计',
  '商业经管',
  '绘本漫画'
] as const;

export type BookTagSort = 'T' | 'R' | 'S';

function toBookItem(item: ParsedBookListItem): BookItem {
  return { ...item };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const results: BookItem[] = [];
  const seen = new Set<string>();
  let pageStart = Math.max(0, Math.trunc(start));

  while (results.length < limit) {
    const html = await fetchHtml(`${BOOK_BASE}/top250?start=${pageStart}`, { Referer: BOOK_BASE });
    if (isChallengePage(html)) throw new Error('图书 Top250 页面触发了反爬挑战，暂时无法解析');

    const pageItems = parseBookTop250Page(html);
    let added = 0;
    for (const item of pageItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(toBookItem(item));
      added += 1;
      if (results.length >= limit) break;
    }

    if (added === 0 || pageItems.length < 25) break;
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
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const subcat = BOOK_CHART_CATEGORIES[category];
  if (typeof subcat === 'undefined') {
    throw new Error(`不支持的榜单分类：${category}`);
  }

  const query = subcat ? `?subcat=${encodeURIComponent(subcat)}` : '';
  const html = await fetchHtml(`${BOOK_BASE}/chart${query}`, { Referer: BOOK_BASE });
  if (isChallengePage(html)) throw new Error('热门图书榜触发了反爬挑战，暂时无法解析');
  return parseBookMediaList(html).slice(0, limit).map(toBookItem);
}

/**
 * Get recently published books, optionally filtered by category.
 */
export async function getLatestBooks(category = '全部', limit = 20): Promise<BookItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  if (!BOOK_LATEST_CATEGORIES.includes(category as typeof BOOK_LATEST_CATEGORIES[number])) {
    throw new Error(`不支持的新书分类：${category}`);
  }

  const query = category === '全部' ? '' : `?subcat=${encodeURIComponent(category)}`;
  const html = await fetchHtml(`${BOOK_BASE}/latest${query}`, { Referer: BOOK_BASE });
  if (isChallengePage(html)) throw new Error('新书速递页面触发了反爬挑战，暂时无法解析');
  return parseBookMediaList(html).slice(0, limit).map(toBookItem);
}

/**
 * Browse books by tag. Sort: T=relevance, R=publication date, S=rating.
 */
export async function getBooksByTag(
  tag: string,
  start = 0,
  limit = 20,
  sort: BookTagSort = 'T'
): Promise<BookItem[]> {
  const normalizedTag = tag.trim();
  if (!normalizedTag) return [];
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const results: BookItem[] = [];
  let pageStart = Math.trunc(start);

  while (results.length < limit) {
    const url = `${BOOK_BASE}/tag/${encodeURIComponent(normalizedTag)}?start=${pageStart}&type=${sort}`;
    const html = await fetchHtml(url, { Referer: BOOK_BASE });
    if (isChallengePage(html)) throw new Error('图书标签页面触发了反爬挑战，暂时无法解析');

    const pageItems = parseBookSubjectList(html);
    if (pageItems.length === 0) break;
    results.push(...pageItems.map(toBookItem));
    pageStart += pageItems.length;
    if (pageItems.length < 20) break;
  }

  return uniqueById(results).slice(0, limit);
}

async function searchBookSuggestions(keyword: string, limit: number): Promise<BookSearchItem[]> {
  const items = await fetchJson<Array<{
    id?: string | number;
    title?: string;
    url?: string;
    pic?: string;
    author_name?: string;
    year?: string | number;
    type?: string;
  }>>(`${BOOK_BASE}/j/subject_suggest?q=${encodeURIComponent(keyword)}`, {
    Referer: `${BOOK_BASE}/`
  });

  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => !item.type || item.type === 'b')
    .map((item) => {
      const id = String(item.id || '').trim();
      const year = item.year ? String(item.year) : undefined;
      const author = cleanText(item.author_name || '');
      return {
        id,
        title: normalizeTitle(item.title || ''),
        rating: '-',
        votes: '-',
        meta: [author, year].filter(Boolean).join(' / ') || '-',
        year,
        url: item.url || `${BOOK_BASE}/subject/${id}/`,
        cover: item.pic,
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
export async function searchBooks(keyword: string, start = 0, limit = 20): Promise<BookSearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const results: BookSearchItem[] = [];
  let pageStart = Math.trunc(start);

  try {
    while (results.length < limit) {
      const url = `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(query)}&cat=1001&start=${pageStart}`;
      const html = await fetchHtml(url, { Referer: 'https://www.douban.com/' });
      if (isChallengePage(html)) throw new Error('图书搜索页面触发了反爬挑战');

      const page = parseBookSearchPage(html);
      results.push(...page.items.map((item) => ({ ...item })));
      if (page.count <= 0 || pageStart + page.count >= page.total) break;
      pageStart += page.count;
    }

    const unique = uniqueById(results);
    if (unique.length > 0) return unique.slice(0, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('book', `完整搜索失败，回退建议接口: ${message}`);
  }

  if (start > 0) return [];
  return searchBookSuggestions(query, limit);
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

  const data = await fetchJson<{ tags?: unknown }>(
    `https://m.douban.com/rexxar/api/v2/book/${bookId}/tags`,
    { Referer: `https://m.douban.com/book/subject/${bookId}/` }
  );
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
  orderBy: 'hot' | 'latest' = 'hot',
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
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(limit) || limit <= 0) return { items: [], total: 0 };

  const data = await fetchJson<{
    total?: number;
    annotations?: Array<{
      id?: string;
      chapter?: string;
      title?: string;
      abstract?: string;
      create_time?: string;
      author?: { name?: string };
      user?: { name?: string };
      url?: string;
    }>;
  }>(`https://m.douban.com/rexxar/api/v2/book/${id}/annotations?count=${limit}&start=${start}`, {
    Referer: `https://m.douban.com/book/subject/${id}/`
  });

  const items = Array.isArray(data.annotations)
    ? data.annotations.map((item) => ({
      id: item.id || '',
      user: cleanText(item.author?.name || item.user?.name || '') || '匿名',
      chapter: cleanText(item.chapter || item.title || '') || '-',
      content: cleanText(item.abstract || ''),
      time: cleanText(item.create_time || ''),
      url: item.url || `${BOOK_BASE}/annotation/${item.id || ''}/`
    }))
    : [];

  return {
    items,
    total: typeof data.total === 'number' && data.total >= 0 ? data.total : items.length
  };
}
