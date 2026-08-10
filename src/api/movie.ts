import { BASE, cleanText, extractField, fetchHtml, fetchJson, isChallengePage, isRecord, normalizeTitle, ResponseSchemaError } from './common.js';
import {
  getSubjectComments,
  getSubjectRatingStats,
  getSubjectReviews,
  type SubjectCommentItem,
  type SubjectPaginatedResult,
  type SubjectRatingStats,
  type SubjectReviewItem
} from './subject.js';
import { debug } from '../utils/debug.js';

interface Subject {
  id: string;
  title: string;
  rate: string;
  url: string;
  cover: string;
}

interface RankItem {
  id: string;
  title: string;
  score: string;
  vote_count: number;
  types: string[];
  regions: string[];
  release_date: string;
  actors: string[];
  url: string;
  cover_url: string;
}

export interface MovieDetail {
  id: string;
  title: string;
  year: string;
  original_title: string;
  rating: string;
  directors: string[];
  actors: string[];
  genres: string[];
  countries: string[];
  durations: string[];
  languages: string[];
  aka: string[];
  pubdate: string[];
  comment_count: number;
  review_count: number;
  summary: string;
  url: string;
  episodes_count?: number;
  episodes_info?: string;
}

interface MovieAbstractResponse {
  r?: number;
  subject?: {
    title?: string;
    year?: string;
    original_title?: string;
    rate?: string;
    directors?: string[];
    actors?: string[];
    genres?: string[];
    countries?: string[];
    durations?: string[];
    languages?: string[];
    aka?: string[];
    pubdate?: string[];
    comment_count?: number;
    review_count?: number;
    url?: string;
  };
}

interface MobileMovieResponse {
  type?: string;
  title?: string;
  year?: string | number;
  original_title?: string;
  intro?: string;
  rating?: { value?: number };
  directors?: Array<{ name?: string }>;
  actors?: Array<{ name?: string }>;
  genres?: string[];
  countries?: string[];
  durations?: string[];
  languages?: string[];
  aka?: string[];
  pubdate?: string[];
  comment_count?: number;
  review_count?: number;
  episodes_count?: number;
  episodes_info?: string;
  url?: string;
}

export interface ComingItem {
  id: string;
  title: string;
  release_date: string;
  types: string[];
  regions: string[];
  wish_count: number;
  url: string;
}

export interface WeeklyItem {
  rank: number;
  id: string;
  title: string;
  trend: string;
  url: string;
}

export type ReviewItem = SubjectReviewItem;
export type CommentItem = SubjectCommentItem;
export type PaginatedResult<T> = SubjectPaginatedResult<T>;

function sanitizeList(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const text = cleanText(String(value || ''));
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });

  return result;
}

function splitSlashList(raw: string): string[] {
  return sanitizeList(raw.split('/').map((item) => item.trim()).filter(Boolean));
}

function parseCountFromText(raw: string): number {
  const text = cleanText(raw).replace(/[，,]/g, '');
  if (!text) return 0;

  const wanMatch = text.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wanMatch) {
    return Math.round(Number(wanMatch[1]) * 10000);
  }

  const numMatch = text.match(/(\d+)/);
  return numMatch ? Number(numMatch[1]) : 0;
}

function extractCountByPath(html: string, path: 'comments' | 'reviews'): number {
  const regex = new RegExp(`<a[^>]*href="[^"]*\\/${path}[^"]*"[^>]*>([\\s\\S]*?)<\\/a>`, 'g');
  let max = 0;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const count = parseCountFromText(match[1]);
    if (count > max) max = count;
  }

  return max;
}

function normalizeArrayField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return sanitizeList(value);
  }
  if (typeof value === 'string') {
    return splitSlashList(value);
  }
  return [];
}

function assignArrayIfNotEmpty(target: MovieDetail, key: keyof Pick<MovieDetail, 'genres' | 'countries' | 'durations' | 'languages' | 'aka' | 'pubdate'>, value: unknown): void {
  const list = normalizeArrayField(value);
  if (list.length > 0) {
    target[key] = list;
  }
}

function assignArrayIfEmpty(target: MovieDetail, key: keyof Pick<MovieDetail, 'genres' | 'countries' | 'durations' | 'languages' | 'aka' | 'pubdate'>, value: unknown): void {
  if (target[key].length === 0) assignArrayIfNotEmpty(target, key, value);
}

function emptyMovieDetail(id: string, url: string): MovieDetail {
  return {
    id,
    title: '',
    year: '',
    original_title: '',
    rating: '-',
    directors: [],
    actors: [],
    genres: [],
    countries: [],
    durations: [],
    languages: [],
    aka: [],
    pubdate: [],
    comment_count: 0,
    review_count: 0,
    summary: '',
    url
  };
}

function applyAbstractDetail(detail: MovieDetail, response: MovieAbstractResponse): void {
  const subject = response.subject;
  if (!subject) return;
  if (!detail.title && subject.title) detail.title = normalizeTitle(subject.title);
  if (!detail.year && subject.year) detail.year = cleanText(subject.year);
  if (!detail.original_title && subject.original_title) detail.original_title = normalizeTitle(subject.original_title);
  if (detail.rating === '-' && subject.rate) detail.rating = subject.rate;
  if (detail.directors.length === 0 && Array.isArray(subject.directors)) {
    detail.directors = sanitizeList(subject.directors);
  }
  if (detail.actors.length === 0 && Array.isArray(subject.actors)) {
    detail.actors = sanitizeList(subject.actors);
  }
  assignArrayIfEmpty(detail, 'genres', subject.genres);
  assignArrayIfEmpty(detail, 'countries', subject.countries);
  assignArrayIfEmpty(detail, 'durations', subject.durations);
  assignArrayIfEmpty(detail, 'languages', subject.languages);
  assignArrayIfEmpty(detail, 'aka', subject.aka);
  assignArrayIfEmpty(detail, 'pubdate', subject.pubdate);
  if (detail.comment_count === 0 && typeof subject.comment_count === 'number' && Number.isFinite(subject.comment_count)) {
    detail.comment_count = Math.max(0, Math.trunc(subject.comment_count));
  }
  if (detail.review_count === 0 && typeof subject.review_count === 'number' && Number.isFinite(subject.review_count)) {
    detail.review_count = Math.max(0, Math.trunc(subject.review_count));
  }
}

function applyMobileDetail(detail: MovieDetail, response: MobileMovieResponse): void {
  if (response.title) detail.title = normalizeTitle(response.title);
  if (response.year) detail.year = cleanText(String(response.year));
  if (response.original_title) detail.original_title = normalizeTitle(response.original_title);
  if (typeof response.rating?.value === 'number' && Number.isFinite(response.rating.value)) {
    detail.rating = response.rating.value.toFixed(1);
  }
  if (detail.directors.length === 0 && Array.isArray(response.directors)) {
    detail.directors = response.directors.map((person) => cleanText(person.name || '')).filter(Boolean);
  }
  if (detail.actors.length === 0 && Array.isArray(response.actors)) {
    detail.actors = response.actors.map((person) => cleanText(person.name || '')).filter(Boolean);
  }
  assignArrayIfEmpty(detail, 'genres', response.genres);
  assignArrayIfEmpty(detail, 'countries', response.countries);
  assignArrayIfEmpty(detail, 'durations', response.durations);
  assignArrayIfEmpty(detail, 'languages', response.languages);
  assignArrayIfEmpty(detail, 'aka', response.aka);
  assignArrayIfEmpty(detail, 'pubdate', response.pubdate);
  if (detail.comment_count === 0 && typeof response.comment_count === 'number' && Number.isFinite(response.comment_count)) {
    detail.comment_count = Math.max(0, Math.trunc(response.comment_count));
  }
  if (detail.review_count === 0 && typeof response.review_count === 'number' && Number.isFinite(response.review_count)) {
    detail.review_count = Math.max(0, Math.trunc(response.review_count));
  }
  if (!detail.summary && response.intro) detail.summary = cleanText(response.intro);
  if (typeof response.episodes_count === 'number' && Number.isFinite(response.episodes_count) && response.episodes_count > 0) {
    detail.episodes_count = Math.trunc(response.episodes_count);
  }
  if (!detail.episodes_info && response.episodes_info) detail.episodes_info = cleanText(response.episodes_info);
}

function parseMovieDetailFromHtml(id: string, html: string): MovieDetail | null {
  if (isChallengePage(html)) return null;

  const titleMatch = html.match(/<span\s+property="v:itemreviewed"[^>]*>([\s\S]*?)<\/span>/);
  const yearMatch = html.match(/<span[^>]*class="year"[^>]*>([\s\S]*?)<\/span>/);
  const ratingMatch = html.match(/<strong[^>]*property="v:average"[^>]*>([\s\S]*?)<\/strong>/);
  const infoMatch = html.match(/<div id="info"[^>]*>([\s\S]*?)<\/div>/);
  const infoHtml = infoMatch ? infoMatch[1] : '';

  const directors: string[] = [];
  const directorRegex = /<a[^>]*rel="v:directedBy"[^>]*>([\s\S]*?)<\/a>/g;
  let directorMatch;
  while ((directorMatch = directorRegex.exec(html)) !== null) {
    directors.push(cleanText(directorMatch[1]));
  }

  const actors: string[] = [];
  const actorRegex = /<a[^>]*rel="v:starring"[^>]*>([\s\S]*?)<\/a>/g;
  let actorMatch;
  while ((actorMatch = actorRegex.exec(html)) !== null) {
    actors.push(cleanText(actorMatch[1]));
  }

  const genres: string[] = [];
  const genreRegex = /<span[^>]*property="v:genre"[^>]*>([\s\S]*?)<\/span>/g;
  let genreMatch;
  while ((genreMatch = genreRegex.exec(html)) !== null) {
    genres.push(cleanText(genreMatch[1]));
  }

  const durations: string[] = [];
  const runtimeRegex = /<span[^>]*property="v:runtime"[^>]*>([\s\S]*?)<\/span>/g;
  let runtimeMatch;
  while ((runtimeMatch = runtimeRegex.exec(html)) !== null) {
    durations.push(cleanText(runtimeMatch[1]));
  }

  const pubdate: string[] = [];
  const pubdateRegex = /<span[^>]*property="v:initialReleaseDate"[^>]*>([\s\S]*?)<\/span>/g;
  let pubdateMatch;
  while ((pubdateMatch = pubdateRegex.exec(html)) !== null) {
    pubdate.push(cleanText(pubdateMatch[1]));
  }

  let summary = '';
  const summaryMatch = html.match(/<span[^>]*property="v:summary"[^>]*>([\s\S]*?)<\/span>/);
  if (summaryMatch) {
    summary = cleanText(summaryMatch[1]);
  }

  const title = titleMatch ? normalizeTitle(titleMatch[1]) : '';
  if (!title) return null;

  const yearText = yearMatch ? cleanText(yearMatch[1]).match(/(19|20)\d{2}/)?.[0] || '' : '';
  const originalTitle = extractField(infoHtml, '原名');
  const countries = splitSlashList(extractField(infoHtml, '制片国家/地区'));
  const languages = splitSlashList(extractField(infoHtml, '语言'));
  const aka = splitSlashList(extractField(infoHtml, '又名'));
  const durationsFromInfo = splitSlashList(extractField(infoHtml, '片长'));
  const pubdateFromInfo = splitSlashList(extractField(infoHtml, '上映日期'));
  const episodesInfo = extractField(infoHtml, '集数');
  const episodesCountMatch = episodesInfo.match(/\d+/);
  const episodesCount = episodesCountMatch ? Number(episodesCountMatch[0]) : 0;

  return {
    id,
    title,
    year: yearText,
    original_title: originalTitle || '',
    rating: ratingMatch ? cleanText(ratingMatch[1]) : '-',
    directors,
    actors,
    genres: sanitizeList(genres),
    countries,
    durations: sanitizeList(durations.length > 0 ? durations : durationsFromInfo),
    languages,
    aka,
    pubdate: sanitizeList(pubdate.length > 0 ? pubdate : pubdateFromInfo),
    comment_count: extractCountByPath(html, 'comments'),
    review_count: extractCountByPath(html, 'reviews'),
    summary,
    url: `${BASE}/subject/${id}/`,
    episodes_count: episodesCount > 0 ? episodesCount : undefined,
    episodes_info: episodesInfo || undefined
  };
}

/**
 * Get movie detail by subject id.
 * Parse subject page first; if blocked, fallback to public JSON endpoints.
 */
export async function getMovieDetail(id: string): Promise<MovieDetail> {
  const movieId = id.trim();
  if (!/^\d+$/.test(movieId)) throw new Error('电影 ID 必须是纯数字');

  const subjectUrl = `${BASE}/subject/${movieId}/`;
  const [htmlResult, abstractResult, mobileResult] = await Promise.allSettled([
    fetchHtml(subjectUrl, { Referer: BASE }).then((html) => {
      const parsed = parseMovieDetailFromHtml(movieId, html);
      if (!parsed) throw new ResponseSchemaError('电影详情页未解析出标题', subjectUrl);
      return parsed;
    }),
    fetchJson<MovieAbstractResponse>(`${BASE}/j/subject_abstract?subject_id=${movieId}`, { Referer: BASE }),
    fetchJson<MobileMovieResponse>(`https://m.douban.com/rexxar/api/v2/movie/${movieId}`, {
      Referer: `https://m.douban.com/movie/subject/${movieId}/`
    })
  ]);

  const detail = htmlResult.status === 'fulfilled'
    ? { ...htmlResult.value }
    : emptyMovieDetail(movieId, subjectUrl);

  if (htmlResult.status === 'rejected') {
    debug('movie', `主页面解析失败: ${htmlResult.reason instanceof Error ? htmlResult.reason.message : String(htmlResult.reason)}`);
  }
  if (abstractResult.status === 'fulfilled') {
    applyAbstractDetail(detail, abstractResult.value);
  } else {
    debug('movie', `subject_abstract 回退失败: ${abstractResult.reason instanceof Error ? abstractResult.reason.message : String(abstractResult.reason)}`);
  }

  let mobile: MobileMovieResponse | undefined;
  if (mobileResult.status === 'fulfilled') {
    mobile = mobileResult.value;
    applyMobileDetail(detail, mobile);
  } else {
    debug('movie', `mobile API 回退失败: ${mobileResult.reason instanceof Error ? mobileResult.reason.message : String(mobileResult.reason)}`);
  }

  const shouldFetchTv = mobile?.type === 'tv' && !detail.episodes_count;
  if (shouldFetchTv) {
    try {
      const tv = await fetchJson<MobileMovieResponse>(`https://m.douban.com/rexxar/api/v2/tv/${movieId}`, {
        Referer: `https://m.douban.com/movie/subject/${movieId}/`
      });
      applyMobileDetail(detail, tv);
    } catch (error) {
      debug('movie', `TV API 补充失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!detail.title) throw new Error(`获取电影详情失败，ID=${movieId}`);
  return detail;
}

/**
 * Get hot/trending by tag
 * @param type - 'movie' or 'tv'
 * @param tag - A Douban category such as trending, US TV, Japanese TV, or latest.
 * @param limit - number of results
 */
export async function getHot(type: 'movie' | 'tv', tag: string, limit = 20): Promise<Subject[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const url = `${BASE}/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&page_limit=${limit}&page_start=0`;
  const data = await fetchJson<unknown>(url);
  if (!isRecord(data) || !Array.isArray(data.subjects)) {
    throw new ResponseSchemaError('热门影视接口返回格式异常', url);
  }
  const subjects = data.subjects
    .filter(isRecord)
    .map((item): Subject | null => {
      const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '';
      const title = typeof item.title === 'string' ? normalizeTitle(item.title) : '';
      if (!id || !title) return null;
      return {
        id,
        title,
        rate: typeof item.rate === 'string' || typeof item.rate === 'number' ? String(item.rate) : '-',
        url: typeof item.url === 'string' ? item.url : `${BASE}/subject/${id}/`,
        cover: typeof item.cover === 'string' ? item.cover : ''
      };
    })
    .filter((item): item is Subject => item !== null);
  if (data.subjects.length > 0 && subjects.length === 0) {
    throw new ResponseSchemaError('热门影视接口未解析出有效条目', url);
  }
  return subjects;
}

/**
 * Get ranked list by genre type
 * @param typeId - Douban genre ID (for example: 17=science fiction, 5=action, 13=romance).
 * @param limit - number of results
 */
export async function getRank(typeId: number, limit = 20): Promise<RankItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const url = `${BASE}/j/chart/top_list?type=${typeId}&interval_id=100:90&start=0&limit=${limit}`;
  const data = await fetchJson<unknown>(url);
  const rawItems = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.data)
      ? data.data
      : null;
  if (!rawItems) throw new ResponseSchemaError('分类榜单接口返回格式异常', url);

  const items = rawItems
    .filter(isRecord)
    .map((item): RankItem | null => {
      const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '';
      const title = typeof item.title === 'string' ? normalizeTitle(item.title) : '';
      if (!id || !title) return null;
      return {
        id,
        title,
        score: typeof item.score === 'string' || typeof item.score === 'number' ? String(item.score) : '-',
        vote_count: typeof item.vote_count === 'number' && Number.isFinite(item.vote_count)
          ? Math.max(0, Math.trunc(item.vote_count))
          : 0,
        types: normalizeArrayField(item.types),
        regions: normalizeArrayField(item.regions),
        release_date: typeof item.release_date === 'string' ? cleanText(item.release_date) : '',
        actors: normalizeArrayField(item.actors),
        url: typeof item.url === 'string' ? item.url : `${BASE}/subject/${id}/`,
        cover_url: typeof item.cover_url === 'string' ? item.cover_url : ''
      };
    })
    .filter((item): item is RankItem => item !== null);
  if (rawItems.length > 0 && items.length === 0) {
    throw new ResponseSchemaError('分类榜单接口未解析出有效条目', url);
  }
  return items;
}

/** Genre type mapping */
export const GENRES: Record<string, number> = {
  '剧情': 11, '喜剧': 24, '动作': 5, '爱情': 13, '科幻': 17,
  '动画': 25, '悬疑': 10, '惊悚': 19, '恐怖': 20, '纪录片': 1,
  '短片': 23, '情色': 6, '同性': 26, '音乐': 14, '歌舞': 7,
  '家庭': 28, '儿童': 8, '传记': 2, '历史': 4, '战争': 22,
  '犯罪': 3, '西部': 27, '奇幻': 16, '冒险': 12, '灾难': 21,
  '武侠': 29, '古装': 30, '运动': 18, '黑色电影': 31
};

/**
 * Get Top250
 */
export interface Top250Item {
  rank: number;
  title: string;
  year: string;
  rating: string;
  director: string;
  quote: string;
  url: string;
}

export async function getTop250(start = 0, limit = 25): Promise<Top250Item[]> {
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const results: Top250Item[] = [];
  const seen = new Set<string>();
  let pageStart = start;

  while (results.length < limit) {
    const html = await fetchHtml(`${BASE}/top250?start=${pageStart}`);
    if (isChallengePage(html)) throw new Error('电影 Top250 页面触发了反爬挑战，暂时无法解析');

    // Split by item blocks
    const items = html.split('<div class="item">').slice(1);
    if (items.length === 0) {
      if (pageStart < 250) {
        throw new ResponseSchemaError('电影 Top250 页面未解析出预期条目', `${BASE}/top250?start=${pageStart}`);
      }
      break;
    }

    let added = 0;
    for (const item of items) {
      if (results.length >= limit) break;

      // Extract rank
      const rankMatch = item.match(/<em[^>]*>(\d+)<\/em>/);
      const rank = rankMatch ? Number(rankMatch[1]) : 0;

      // Extract URL and title
      const urlMatch = item.match(/href="(https:\/\/movie\.douban\.com\/subject\/\d+\/)"/);
      const titleMatch = item.match(/<span class="title">([^<]+)<\/span>/);
      if (!urlMatch || !titleMatch) continue;

      const url = urlMatch[1];
      if (seen.has(url)) continue;
      seen.add(url);

      // Extract rating
      const ratingMatch = item.match(/<span class="rating_num"[^>]*>([^<]+)<\/span>/);
      const rating = ratingMatch ? cleanText(ratingMatch[1]) : '-';

      // Extract info line (director, year)
      const infoMatch = item.match(/<div class="bd">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
      const infoLine = infoMatch ? cleanText(infoMatch[1].replace(/<br\s*\/?>/g, ' ')) : '';
      const dirMatch = infoLine.match(/导演:\s*([^主&]+)/);
      const yearMatch = infoLine.match(/(\d{4})/);

      // Extract quote
      const quoteMatch = item.match(/<p class="quote">[\s\S]*?<span[^>]*>([^<]*)<\/span>/);

      results.push({
        rank,
        title: cleanText(titleMatch[1]),
        year: yearMatch ? yearMatch[1] : '-',
        rating,
        director: dirMatch ? cleanText(dirMatch[1]) : '-',
        quote: quoteMatch ? cleanText(quoteMatch[1]) : '',
        url
      });
      added += 1;
    }

    if (added === 0 || pageStart + 25 >= 250) break;
    pageStart += 25;
  }

  return results;
}

/**
 * Get coming soon movies from https://movie.douban.com/coming
 */
export async function getComing(limit = 20): Promise<ComingItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const html = await fetchHtml(`${BASE}/coming`, { Referer: BASE });
  if (isChallengePage(html)) throw new Error('即将上映页面触发了反爬挑战，暂时无法解析');

  const results: ComingItem[] = [];
  const rowRegex = /<tr>\s*<td>\s*([\s\S]*?)<\/td>\s*<td>\s*<a[^>]*href="https:\/\/movie\.douban\.com\/subject\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td>\s*([\s\S]*?)<\/td>\s*<td>\s*([\s\S]*?)<\/td>\s*<td>\s*([\s\S]*?)<\/td>\s*<\/tr>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null && results.length < limit) {
    const wishCount = Number(cleanText(match[6]).replace(/\D/g, '')) || 0;
    results.push({
      id: match[2],
      title: normalizeTitle(match[3]),
      release_date: cleanText(match[1]),
      types: cleanText(match[4]).split('/').map((v) => v.trim()).filter(Boolean),
      regions: cleanText(match[5]).split('/').map((v) => v.trim()).filter(Boolean),
      wish_count: wishCount,
      url: `https://movie.douban.com/subject/${match[2]}/`
    });
  }

  if (results.length === 0) {
    throw new ResponseSchemaError('即将上映页面未解析出预期条目', `${BASE}/coming`);
  }

  return results;
}

/**
 * Get weekly reputation chart from https://movie.douban.com/chart
 */
export async function getWeekly(limit = 10): Promise<WeeklyItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const html = await fetchHtml(`${BASE}/chart`, { Referer: BASE });
  if (isChallengePage(html)) throw new Error('一周口碑榜页面触发了反爬挑战，暂时无法解析');

  const sectionMatch = html.match(/<h2>一周口碑榜[\s\S]*?<ul class="content" id="listCont2">([\s\S]*?)<\/ul>/);
  if (!sectionMatch) throw new Error('未找到一周口碑榜数据区域');

  const results: WeeklyItem[] = [];
  const itemRegex = /<li class="clearfix">[\s\S]*?<div class="no">(\d+)<\/div>[\s\S]*?<a[^>]*href="https:\/\/movie\.douban\.com\/subject\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="(stay|up|down)">(\d+)<\/div>[\s\S]*?<\/li>/g;

  let match;
  while ((match = itemRegex.exec(sectionMatch[1])) !== null && results.length < limit) {
    const type = match[4];
    const delta = Number(match[5]);
    const trend = type === 'stay' ? 'stay' : `${type} ${delta}`;

    results.push({
      rank: Number(match[1]),
      id: match[2],
      title: normalizeTitle(match[3]),
      trend,
      url: `https://movie.douban.com/subject/${match[2]}/`
    });
  }

  if (results.length === 0) {
    throw new ResponseSchemaError('一周口碑榜区域存在但未解析出条目', `${BASE}/chart`);
  }

  return results;
}

/**
 * Get movie reviews (long-form) from mobile API.
 */
export async function getReviews(movieId: string, start = 0, limit = 20): Promise<PaginatedResult<ReviewItem>> {
  return getSubjectReviews('movie', movieId, start, limit);
}

/**
 * Get movie comments (short reviews) from mobile API.
 * The order parameter remains for compatibility and only accepts hot sorting.
 */
export async function getComments(movieId: string, orderBy: 'hot' = 'hot', start = 0, count = 20): Promise<PaginatedResult<CommentItem>> {
  return getSubjectComments('movie', movieId, orderBy, start, count);
}

export type RatingStats = SubjectRatingStats;

/**
 * Get movie rating statistics including distribution.
 */
export async function getRatingStats(movieId: string): Promise<RatingStats> {
  return getSubjectRatingStats('movie', movieId);
}
