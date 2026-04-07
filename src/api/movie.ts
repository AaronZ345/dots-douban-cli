import { BASE, cleanText, extractField, fetchHtml, fetchJson, isChallengePage, normalizeTitle } from './common.js';
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

export interface ReviewItem {
  id: string;
  user: string;
  rating: string;
  votes: number;
  time: string;
  content: string;
  url: string;
}

export interface CommentItem {
  id: string;
  user: string;
  avatar: string;
  rating: number;
  votes: number;
  time: string;
  content: string;
  url: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

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
    url: `${BASE}/subject/${id}/`
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

  try {
    const html = await fetchHtml(subjectUrl, { Referer: BASE });
    const parsed = parseMovieDetailFromHtml(movieId, html);
    if (parsed) return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('movie', `主页面解析失败，进入回退逻辑: ${message}`);
  }

  const detail: MovieDetail = {
    id: movieId,
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
    url: subjectUrl
  };

  try {
    const abstract = await fetchJson<{
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
    }>(`${BASE}/j/subject_abstract?subject_id=${movieId}`, { Referer: BASE });

    const subject = abstract.subject;
    if (subject) {
      if (subject.title) detail.title = normalizeTitle(subject.title);
      if (subject.year) detail.year = cleanText(subject.year);
      if (subject.original_title) detail.original_title = normalizeTitle(subject.original_title);
      if (subject.rate) detail.rating = subject.rate;
      if (Array.isArray(subject.directors)) detail.directors = subject.directors.map((name) => cleanText(name));
      if (Array.isArray(subject.actors)) detail.actors = subject.actors.map((name) => cleanText(name));
      assignArrayIfNotEmpty(detail, 'genres', subject.genres);
      assignArrayIfNotEmpty(detail, 'countries', subject.countries);
      assignArrayIfNotEmpty(detail, 'durations', subject.durations);
      assignArrayIfNotEmpty(detail, 'languages', subject.languages);
      assignArrayIfNotEmpty(detail, 'aka', subject.aka);
      assignArrayIfNotEmpty(detail, 'pubdate', subject.pubdate);
      if (typeof subject.comment_count === 'number' && Number.isFinite(subject.comment_count)) {
        detail.comment_count = Math.max(0, Math.trunc(subject.comment_count));
      }
      if (typeof subject.review_count === 'number' && Number.isFinite(subject.review_count)) {
        detail.review_count = Math.max(0, Math.trunc(subject.review_count));
      }
      if (subject.url) detail.url = subject.url;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('movie', `subject_abstract 回退失败: ${message}`);
  }

  try {
    const mobile = await fetchJson<{
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
      url?: string;
    }>(`https://m.douban.com/rexxar/api/v2/movie/${movieId}`, {
      Referer: `https://m.douban.com/movie/subject/${movieId}/`
    });

    if (mobile.title) detail.title = normalizeTitle(mobile.title);
    if (mobile.year) detail.year = cleanText(String(mobile.year));
    if (mobile.original_title) detail.original_title = normalizeTitle(mobile.original_title);
    if (typeof mobile.rating?.value === 'number') detail.rating = mobile.rating.value.toFixed(1);
    if (Array.isArray(mobile.directors) && mobile.directors.length > 0) {
      detail.directors = mobile.directors
        .map((person) => cleanText(person.name || ''))
        .filter(Boolean);
    }
    if (Array.isArray(mobile.actors) && mobile.actors.length > 0) {
      detail.actors = mobile.actors
        .map((person) => cleanText(person.name || ''))
        .filter(Boolean);
    }
    assignArrayIfNotEmpty(detail, 'genres', mobile.genres);
    assignArrayIfNotEmpty(detail, 'countries', mobile.countries);
    assignArrayIfNotEmpty(detail, 'durations', mobile.durations);
    assignArrayIfNotEmpty(detail, 'languages', mobile.languages);
    assignArrayIfNotEmpty(detail, 'aka', mobile.aka);
    assignArrayIfNotEmpty(detail, 'pubdate', mobile.pubdate);
    if (typeof mobile.comment_count === 'number' && Number.isFinite(mobile.comment_count)) {
      detail.comment_count = Math.max(0, Math.trunc(mobile.comment_count));
    }
    if (typeof mobile.review_count === 'number' && Number.isFinite(mobile.review_count)) {
      detail.review_count = Math.max(0, Math.trunc(mobile.review_count));
    }
    if (mobile.intro) detail.summary = cleanText(mobile.intro);
    if (mobile.url) detail.url = mobile.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('movie', `mobile API 回退失败: ${message}`);
  }

  // Try TV API for episodes count (works for TV shows)
  try {
    const tv = await fetchJson<{
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
    }>(`https://m.douban.com/rexxar/api/v2/tv/${movieId}`, {
      Referer: `https://m.douban.com/movie/subject/${movieId}/`
    });

    // Only use TV data if we got valid response
    if (tv.title) {
      if (!detail.title) detail.title = normalizeTitle(tv.title);
      if (!detail.year && tv.year) detail.year = cleanText(String(tv.year));
      if (!detail.original_title && tv.original_title) detail.original_title = normalizeTitle(tv.original_title);
      if (detail.rating === '-' && typeof tv.rating?.value === 'number') detail.rating = tv.rating.value.toFixed(1);
      if (detail.directors.length === 0 && Array.isArray(tv.directors) && tv.directors.length > 0) {
        detail.directors = tv.directors.map((person) => cleanText(person.name || '')).filter(Boolean);
      }
      if (detail.actors.length === 0 && Array.isArray(tv.actors) && tv.actors.length > 0) {
        detail.actors = tv.actors.map((person) => cleanText(person.name || '')).filter(Boolean);
      }
      if (detail.genres.length === 0) assignArrayIfNotEmpty(detail, 'genres', tv.genres);
      if (detail.countries.length === 0) assignArrayIfNotEmpty(detail, 'countries', tv.countries);
      if (detail.durations.length === 0) assignArrayIfNotEmpty(detail, 'durations', tv.durations);
      if (detail.languages.length === 0) assignArrayIfNotEmpty(detail, 'languages', tv.languages);
      if (detail.aka.length === 0) assignArrayIfNotEmpty(detail, 'aka', tv.aka);
      if (detail.pubdate.length === 0) assignArrayIfNotEmpty(detail, 'pubdate', tv.pubdate);
      if (detail.comment_count === 0 && typeof tv.comment_count === 'number' && Number.isFinite(tv.comment_count)) {
        detail.comment_count = Math.max(0, Math.trunc(tv.comment_count));
      }
      if (detail.review_count === 0 && typeof tv.review_count === 'number' && Number.isFinite(tv.review_count)) {
        detail.review_count = Math.max(0, Math.trunc(tv.review_count));
      }
      if (!detail.summary && tv.intro) detail.summary = cleanText(tv.intro);
      if (tv.url) detail.url = tv.url;
    }
    // Always try to get episodes_count and episodes_info from TV API
    if (typeof tv.episodes_count === 'number' && Number.isFinite(tv.episodes_count) && tv.episodes_count > 0) {
      detail.episodes_count = tv.episodes_count;
    }
    if (tv.episodes_info) {
      detail.episodes_info = cleanText(tv.episodes_info);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('movie', `TV API 回退失败: ${message}`);
  }

  if (!detail.title) throw new Error(`获取电影详情失败，ID=${movieId}`);
  return detail;
}

/**
 * Get hot/trending by tag
 * @param type - 'movie' or 'tv'
 * @param tag - '热门', '美剧', '日剧', '韩剧', '国产剧', '综艺', '最新' etc.
 * @param limit - number of results
 */
export async function getHot(type: 'movie' | 'tv', tag: string, limit = 20): Promise<Subject[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const url = `${BASE}/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&page_limit=${limit}&page_start=0`;
  const data = await fetchJson<{ subjects: Subject[] }>(url);
  return Array.isArray(data.subjects) ? data.subjects : [];
}

/**
 * Get ranked list by genre type
 * @param typeId - genre type ID (17=科幻, 5=动作, 13=爱情, 25=动画, 10=悬疑, etc.)
 * @param limit - number of results
 */
export async function getRank(typeId: number, limit = 20): Promise<RankItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const url = `${BASE}/j/chart/top_list?type=${typeId}&interval_id=100:90&start=0&limit=${limit}`;
  const data = await fetchJson<RankItem[] | { data?: RankItem[] }>(url);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  return [];
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
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const results: Top250Item[] = [];
  const seen = new Set<string>();
  let pageStart = Math.max(0, start);

  while (results.length < limit) {
    const html = await fetchHtml(`${BASE}/top250?start=${pageStart}`);

    // Split by item blocks
    const items = html.split('<div class="item">').slice(1);
    if (items.length === 0) break;

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
    }

    pageStart += 25;
  }

  return results;
}

/**
 * Get now playing movies
 */
export interface NowPlayingItem {
  id: string;
  title: string;
  score: string;
  director: string;
  actors: string[];
  duration: string;
  region: string;
  release_date: string;
  vote_count: number;
  wish_count: number;
}

export async function getNowPlaying(city = 'beijing'): Promise<NowPlayingItem[]> {
  const html = await fetchHtml(`${BASE}/cinema/nowplaying/${city}/`);
  const results: NowPlayingItem[] = [];

  // Match the whole <li> tag to extract all data-* attributes
  const itemRegex = /<li[^>]*class="list-item"[^>]*data-[^>]+>/g;
  const readAttr = (tag: string, key: string): string => {
    const m = tag.match(new RegExp(`data-${key}="([^"]*)"`));
    return m ? cleanText(m[1]) : '';
  };

  let match;
  while ((match = itemRegex.exec(html)) !== null) {
    const tag = match[0];
    const id = readAttr(tag, 'subject');
    const title = normalizeTitle(readAttr(tag, 'title'));
    if (!id || !title) continue;

    const actors = readAttr(tag, 'actors')
      .split(/[，,]/)
      .map((s) => cleanText(s))
      .filter(Boolean);
    const voteStr = readAttr(tag, 'votecount').replace(/\D/g, '');
    const wishStr = readAttr(tag, 'wish').replace(/\D/g, '');

    results.push({
      id,
      title,
      score: readAttr(tag, 'score') || '-',
      director: readAttr(tag, 'director') || '-',
      actors,
      duration: readAttr(tag, 'duration') || '-',
      region: readAttr(tag, 'region') || '-',
      release_date: readAttr(tag, 'release') || '-',
      vote_count: voteStr ? Number(voteStr) : 0,
      wish_count: wishStr ? Number(wishStr) : 0
    });
  }
  return results;
}

/**
 * Get coming soon movies from https://movie.douban.com/coming
 */
export async function getComing(limit = 20): Promise<ComingItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
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

  return results;
}

/**
 * Get weekly reputation chart from https://movie.douban.com/chart
 */
export async function getWeekly(limit = 10): Promise<WeeklyItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
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

  return results;
}

/**
 * Get movie reviews (long-form) from mobile API.
 */
export async function getReviews(movieId: string, start = 0, limit = 20): Promise<PaginatedResult<ReviewItem>> {
  const id = movieId.trim();
  if (!/^\d+$/.test(id)) throw new Error('电影 ID 必须是纯数字');
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(limit) || limit <= 0) return { items: [], total: 0 };

  interface ReviewResponse {
    total?: number;
    reviews?: Array<{
      id?: string;
      title?: string;
      abstract?: string;
      rating?: { value?: number };
      useful_count?: number;
      create_time?: string;
      user?: { name?: string };
      url?: string;
    }>;
  }

  const url = `https://m.douban.com/rexxar/api/v2/movie/${id}/reviews?count=${limit}&start=${start}`;
  const data = await fetchJson<ReviewResponse>(url, {
    Referer: `https://m.douban.com/movie/subject/${id}/`
  });

  const items = Array.isArray(data.reviews)
    ? data.reviews.map((item) => ({
      id: item.id || '',
      user: item.user?.name || '匿名',
      rating: item.rating?.value ? String(item.rating.value) : '-',
      votes: item.useful_count || 0,
      time: item.create_time || '',
      content: `【${item.title || '无标题'}】${item.abstract || ''}`,
      url: item.url || `https://movie.douban.com/review/${item.id}/`
    }))
    : [];

  const total = typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
    ? data.total
    : items.length;

  return { items, total };
}

// City code mapping
export const CITIES: Record<string, string> = {
  '北京': 'beijing', '上海': 'shanghai', '广州': 'guangzhou', '深圳': 'shenzhen',
  '苏州': 'suzhou', '杭州': 'hangzhou', '南京': 'nanjing', '成都': 'chengdu',
  '武汉': 'wuhan', '西安': 'xian', '重庆': 'chongqing', '天津': 'tianjin'
};

/**
 * Get movie comments (short reviews) from mobile API.
 * order_by: 'hot' (default) or 'latest'
 */
export async function getComments(movieId: string, orderBy: 'hot' | 'latest' = 'hot', start = 0, count = 20): Promise<PaginatedResult<CommentItem>> {
  const id = movieId.trim();
  if (!/^\d+$/.test(id)) throw new Error('电影 ID 必须是纯数字');
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(count) || count <= 0) return { items: [], total: 0 };

  interface Interest {
    id: string;
    comment?: string;
    rating?: { value?: number };
    vote_count?: number;
    create_time?: string;
    user?: {
      name?: string;
      avatar?: string;
    };
  }

  const url = `https://m.douban.com/rexxar/api/v2/movie/${id}/interests?count=${count}&start=${start}&order_by=${orderBy}`;
  const data = await fetchJson<{ total?: number; interests?: Interest[] }>(url, {
    Referer: `https://m.douban.com/movie/subject/${id}/`
  });

  const items = Array.isArray(data.interests)
    ? data.interests
      .filter((item) => item.comment)
      .map((item) => ({
        id: item.id || '',
        user: item.user?.name || '匿名',
        avatar: item.user?.avatar || '',
        rating: item.rating?.value || 0,
        votes: item.vote_count || 0,
        time: item.create_time || '',
        content: item.comment || '',
        url: `https://www.douban.com/doubanapp/dispatch?uri=/movie/${id}/interest/${item.id}`
      }))
    : [];

  const total = typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
    ? data.total
    : items.length;

  return { items, total };
}

export interface RatingStats {
  value: number;
  count: number;
  stars: number[];
  wish_count: number;
  done_count: number;
  type_ranks: Array<{ type: string; rank: number }>;
}

/**
 * Get movie rating statistics including distribution.
 */
export async function getRatingStats(movieId: string): Promise<RatingStats> {
  const id = movieId.trim();
  if (!/^\d+$/.test(id)) throw new Error('电影 ID 必须是纯数字');

  interface RatingResponse {
    stats?: number[];
    wish_count?: number;
    done_count?: number;
    type_ranks?: Array<{ type: string; rank: number }>;
  }

  interface MovieResponse {
    rating?: { value?: number; count?: number };
  }

  const [ratingData, movieData] = await Promise.all([
    fetchJson<RatingResponse>(`https://m.douban.com/rexxar/api/v2/movie/${id}/rating?for_mobile=1`, {
      Referer: `https://m.douban.com/movie/subject/${id}/`
    }),
    fetchJson<MovieResponse>(`https://m.douban.com/rexxar/api/v2/movie/${id}?for_mobile=1`, {
      Referer: `https://m.douban.com/movie/subject/${id}/`
    })
  ]);

  const rawStats = Array.isArray(ratingData.stats) ? ratingData.stats : [];
  const stats = new Array<number>(5).fill(0).map((_, index) => {
    const value = rawStats[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });

  return {
    value: movieData.rating?.value || 0,
    count: movieData.rating?.count || 0,
    stars: stats.map((s) => Math.round(s * 1000) / 10),
    wish_count: ratingData.wish_count || 0,
    done_count: ratingData.done_count || 0,
    type_ranks: ratingData.type_ranks || []
  };
}
