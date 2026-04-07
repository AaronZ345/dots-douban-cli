import { BASE, FETCH_TIMEOUT_MS, UA, cleanText, fetchHtml } from './common.js';
import { debug } from '../utils/debug.js';
import { formEncode } from '../utils/parsing.js';

type InterestStatus = 'collect' | 'wish' | 'do';

interface DoubanJsonResponse {
  r?: number;
  msg?: string;
  status?: string;
  ok?: boolean;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface ProfileMatch {
  id: string;
  name?: string;
}

export interface CurrentUserProfile {
  id: string;
  name: string;
  url: string;
}

export interface FeedItem {
  user: string;
  action: string;
  target: string;
  content: string;
  time: string;
  url: string;
}

export interface CollectionRecord {
  id: string;
  title: string;
  url: string;
  status: InterestStatus;
  date?: string;
  rating?: number;
  comment?: string;
}

export interface ReviewCreateResult {
  id: string;
  url: string;
}

interface ResolveCkOptions {
  forceRefresh?: boolean;
}

interface CkCacheEntry {
  value: string;
  expiresAt: number;
}

const CK_CACHE_TTL_MS = 30 * 60 * 1000;
const ckCache = new Map<string, CkCacheEntry>();
const CK_ERROR_PATTERNS: RegExp[] = [
  /\bck\b/i,
  /invalid\s*token/i,
  /token\s*invalid/i,
  /token\s*expired/i,
  /ck\s*expired/i,
  /ck[^\n]{0,20}(?:无效|过期)/i,
  /(?:无效|过期)[^\n]{0,20}ck/i,
  /请先登录/i,
  /更新[^\n]{0,20}登录状态/i
];

function parseJsonResponse(text: string): DoubanJsonResponse | null {
  try {
    return JSON.parse(text) as DoubanJsonResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('authenticated', `JSON 解析失败: ${message}`);
    return null;
  }
}

function parseApiError(res: Response, text: string): string {
  const parsed = parseJsonResponse(text);
  if (parsed && typeof parsed.msg === 'string' && parsed.msg.trim()) {
    return parsed.msg.trim();
  }
  return `HTTP ${res.status}: ${text.slice(0, 120)}`;
}

function parseJsonApiResult(text: string): DoubanJsonResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('豆瓣接口返回空响应');
  }

  const parsed = parseJsonResponse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`豆瓣接口返回非 JSON 对象: ${trimmed.slice(0, 120)}`);
  }

  if (typeof parsed.r === 'number') {
    if (parsed.r !== 0) {
      throw new Error(parsed.msg || `豆瓣接口错误 code=${String(parsed.code || 'unknown')}`);
    }
    return parsed;
  }

  const hasNegativeSignals =
    parsed.ok === false
    || parsed.success === false
    || (typeof parsed.status === 'string' && ['fail', 'failed', 'error'].includes(parsed.status.trim().toLowerCase()));

  if (typeof parsed.status === 'string') {
    const normalized = parsed.status.trim().toLowerCase();
    if (normalized === 'ok' || normalized === 'success') {
      return parsed;
    }
    if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') {
      throw new Error(parsed.msg || parsed.error || `豆瓣接口错误 status=${parsed.status}`);
    }
  }

  if (typeof parsed.ok === 'boolean' && parsed.ok) {
    return parsed;
  }

  if (typeof parsed.success === 'boolean' && parsed.success) {
    return parsed;
  }

  if (hasNegativeSignals) {
    throw new Error(parsed.msg || parsed.error || '豆瓣接口返回失败状态');
  }

  if (typeof parsed.msg === 'string' && parsed.msg.trim()) {
    throw new Error(parsed.msg.trim());
  }

  if (typeof parsed.error === 'string' && parsed.error.trim()) {
    throw new Error(parsed.error.trim());
  }

  // 某些豆瓣接口成功时仅返回对象片段，不包含显式成功字段，且无失败信号。
  return parsed;
}

async function postForm(url: string, data: Record<string, string>, cookies: string, referer: string): Promise<DoubanJsonResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookies,
      Referer: referer,
      Origin: 'https://www.douban.com',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: formEncode(data),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseApiError(res, text));
  }
  return parseJsonApiResult(text);
}

function extractCookieValue(cookieHeader: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const match = cookieHeader.match(pattern);
  if (!match?.[1]) return undefined;
  return match[1].replace(/^"|"$/g, '').trim() || undefined;
}

function ckCacheKey(cookies: string): string {
  const dbcl2 = extractCookieValue(cookies, 'dbcl2');
  if (dbcl2) return `dbcl2:${dbcl2}`;
  return `cookie:${cookies}`;
}

function getCachedCk(cookies: string): string | null {
  const entry = ckCache.get(ckCacheKey(cookies));
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    ckCache.delete(ckCacheKey(cookies));
    return null;
  }

  return entry.value;
}

function cacheCk(cookies: string, ck: string): void {
  const value = ck.trim();
  if (!value) return;

  ckCache.set(ckCacheKey(cookies), {
    value,
    expiresAt: Date.now() + CK_CACHE_TTL_MS
  });
}

function clearCachedCk(cookies: string): void {
  ckCache.delete(ckCacheKey(cookies));
}

function isCkRelatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim();
  return CK_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function withCkRetry<T>(
  cookies: string,
  existingCk: string | undefined,
  subjectId: string | undefined,
  action: (ck: string) => Promise<T>
): Promise<T> {
  const ck = await resolveCk(cookies, existingCk, subjectId);

  try {
    return await action(ck);
  } catch (error) {
    if (!isCkRelatedError(error)) throw error;

    clearCachedCk(cookies);
    const refreshedCk = await resolveCk(cookies, undefined, subjectId, { forceRefresh: true });
    return action(refreshedCk);
  }
}

function extractCkFromHtml(html: string): string {
  const input = html.match(/name=["']ck["']\s+value=["']([^"']+)["']/i);
  if (input?.[1]) return input[1];

  const dataAttr = html.match(/data-ck=["']([^"']+)["']/i);
  if (dataAttr?.[1]) return dataAttr[1];

  const inScript = html.match(/[?&]ck=([A-Za-z0-9]+)/);
  if (inScript?.[1]) return inScript[1];

  throw new Error('无法解析 ck token，请重新登录后重试');
}

export async function resolveCk(
  cookies: string,
  existingCk?: string,
  subjectId?: string,
  options: ResolveCkOptions = {}
): Promise<string> {
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh) {
    const cached = getCachedCk(cookies);
    if (cached) return cached;

    const provided = existingCk?.trim();
    if (provided) {
      cacheCk(cookies, provided);
      return provided;
    }

    const ckInCookieHeader = extractCookieValue(cookies, 'ck');
    if (ckInCookieHeader) {
      cacheCk(cookies, ckInCookieHeader);
      return ckInCookieHeader;
    }
  }

  if (subjectId) {
    const subjectHtml = await fetchHtml(`${BASE}/subject/${subjectId}/`, {
      Referer: BASE,
      Cookie: cookies
    });
    const ck = extractCkFromHtml(subjectHtml);
    cacheCk(cookies, ck);
    return ck;
  }

  const homeHtml = await fetchHtml('https://www.douban.com/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });
  const ck = extractCkFromHtml(homeHtml);
  cacheCk(cookies, ck);
  return ck;
}

function parseMineAnchor(html: string): ProfileMatch | null {
  const byClassThenHref = html.match(/<a[^>]*class=["'][^"']*\blnk-mine\b[^"']*["'][^>]*href=["']https:\/\/www\.douban\.com\/people\/([^/"']+)\/["'][^>]*>([\s\S]*?)<\/a>/i);
  if (byClassThenHref?.[1]) {
    return { id: byClassThenHref[1], name: cleanText(byClassThenHref[2] || '') };
  }

  const byHrefThenClass = html.match(/<a[^>]*href=["']https:\/\/www\.douban\.com\/people\/([^/"']+)\/["'][^>]*class=["'][^"']*\blnk-mine\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (byHrefThenClass?.[1]) {
    return { id: byHrefThenClass[1], name: cleanText(byHrefThenClass[2] || '') };
  }

  return null;
}

function parseProfileFromHtml(html: string): CurrentUserProfile {
  const mine = parseMineAnchor(html);
  if (!mine?.id) {
    throw new Error('当前页面未找到 lnk-mine，无法识别当前登录用户，请重新登录后重试');
  }

  return {
    id: mine.id,
    name: mine.name || mine.id,
    url: `https://www.douban.com/people/${mine.id}/`
  };
}

export async function getCurrentUserProfile(cookies: string): Promise<CurrentUserProfile> {
  // 先尝试 /mine/ 页面，更可靠
  const mineHtml = await fetchHtml('https://www.douban.com/mine/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  // 从 /mine/ 页面提取用户 ID
  const titleMatch = mineHtml.match(/<title>\s*([^<\n]+?)\s*<\/title>/);
  const peopleMatch = mineHtml.match(/href=["']https:\/\/www\.douban\.com\/people\/([^/"']+)\//);

  if (peopleMatch?.[1]) {
    const id = peopleMatch[1];
    const name = titleMatch?.[1]?.trim() || id;
    return {
      id,
      name,
      url: `https://www.douban.com/people/${id}/`
    };
  }

  // 回退到首页 lnk-mine
  const html = await fetchHtml('https://www.douban.com/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  return parseProfileFromHtml(html);
}

export async function createReview(
  movieId: string,
  title: string,
  content: string,
  cookies: string,
  existingCk?: string
): Promise<ReviewCreateResult> {
  const id = movieId.trim();
  if (!/^\d+$/.test(id)) throw new Error('电影 ID 必须是纯数字');
  if (!title.trim()) throw new Error('长评标题不能为空');
  if (!content.trim()) throw new Error('长评内容不能为空');

  return withCkRetry(cookies, existingCk, id, async (ck) => {
    const result = await postForm(
      `${BASE}/j/review/create`,
      {
        ck,
        subject_id: id,
        title: title.trim(),
        review: content.trim()
      },
      cookies,
      `${BASE}/subject/${id}/`
    );

    const reviewId = String(result.id || '').trim();
    return {
      id: reviewId,
      url: reviewId ? `${BASE}/review/${reviewId}/` : `${BASE}/subject/${id}/`
    };
  });
}

export async function unmarkSubject(movieId: string, cookies: string, existingCk?: string): Promise<void> {
  const id = movieId.trim();
  if (!/^\d+$/.test(id)) throw new Error('电影 ID 必须是纯数字');

  await withCkRetry(cookies, existingCk, id, async (ck) => {
    try {
      await postForm(
        `${BASE}/j/subject/${id}/removeinterest`,
        { ck },
        cookies,
        `${BASE}/subject/${id}/`
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('authenticated', `removeinterest 失败，回退 interest=none: ${message}`);
      await postForm(
        `${BASE}/j/subject/${id}/interest`,
        { ck, interest: 'none' },
        cookies,
        `${BASE}/subject/${id}/`
      );
    }
  });
}

export async function followUser(userId: string, cookies: string, existingCk?: string): Promise<void> {
  const id = userId.trim();
  if (!id) throw new Error('用户 ID 不能为空');

  await withCkRetry(cookies, existingCk, undefined, async (ck) => {
    try {
      await postForm(
        `https://www.douban.com/j/contact/follow/${encodeURIComponent(id)}`,
        { ck },
        cookies,
        'https://www.douban.com/'
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('authenticated', `follow 接口失败，回退 add: ${message}`);
      await postForm(
        'https://www.douban.com/j/contact/add',
        { ck, people_id: id },
        cookies,
        'https://www.douban.com/'
      );
    }
  });
}

export async function unfollowUser(userId: string, cookies: string, existingCk?: string): Promise<void> {
  const id = userId.trim();
  if (!id) throw new Error('用户 ID 不能为空');

  await withCkRetry(cookies, existingCk, undefined, async (ck) => {
    try {
      await postForm(
        `https://www.douban.com/j/contact/unfollow/${encodeURIComponent(id)}`,
        { ck },
        cookies,
        'https://www.douban.com/'
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('authenticated', `unfollow 接口失败，回退 remove: ${message}`);
      await postForm(
        'https://www.douban.com/j/contact/remove',
        { ck, people_id: id },
        cookies,
        'https://www.douban.com/'
      );
    }
  });
}

export async function getFeed(cookies: string, limit = 20): Promise<FeedItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const html = await fetchHtml('https://www.douban.com/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  const results: FeedItem[] = [];
  const blockRegex = /<div class="status-item[\s\S]*?<\/div>\s*<\/div>/g;

  let match;
  while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
    const block = match[0];

    const userMatch = block.match(/class="name"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const actionMatch = block.match(/class="action"[^>]*>([\s\S]*?)<\/span>/i);
    const targetMatch = block.match(/class="title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const contentMatch = block.match(/class="status-saying"[^>]*>([\s\S]*?)<\/blockquote>/i)
      || block.match(/class="status-content"[^>]*>([\s\S]*?)<\/div>/i);
    const timeMatch = block.match(/class="created_at"[^>]*>([\s\S]*?)<\/span>/i);
    const urlMatch = block.match(/href="(https:\/\/www\.douban\.com\/people\/[^"#]+\/status\/\d+)"/i);

    results.push({
      user: cleanText(userMatch?.[1] || '未知用户'),
      action: cleanText(actionMatch?.[1] || '更新了动态'),
      target: cleanText(targetMatch?.[1] || '-'),
      content: cleanText(contentMatch?.[1] || ''),
      time: cleanText(timeMatch?.[1] || ''),
      url: urlMatch?.[1] || ''
    });
  }

  return results;
}

function normalizeRatingClass(block: string): number | undefined {
  const match = block.match(/rating(\d)-t/);
  if (!match) return undefined;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : undefined;
}

function parseCollectionBlocks(html: string, status: InterestStatus): CollectionRecord[] {
  const items: CollectionRecord[] = [];
  const itemRegex = /<li[^>]*class="item"[^>]*>[\s\S]*?<\/li>/g;

  let match;
  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[0];
    const subjectMatch = block.match(/href="https:\/\/movie\.douban\.com\/subject\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/i);
    if (!subjectMatch?.[1]) continue;

    const dateMatch = block.match(/<div class="date">([\s\S]*?)<\/div>/i);
    const commentMatch = block.match(/<span class="comment">([\s\S]*?)<\/span>/i);

    // 从 date div 中提取日期（格式：2026-03-18）
    const dateText = dateMatch?.[1] || '';
    const dateOnly = dateText.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';

    items.push({
      id: subjectMatch[1],
      title: cleanText(subjectMatch[2]),
      url: `https://movie.douban.com/subject/${subjectMatch[1]}/`,
      status,
      date: dateOnly,
      rating: normalizeRatingClass(block),
      comment: cleanText(commentMatch?.[1] || '') || undefined
    });
  }

  return items;
}

function parseCollectionNextStart(html: string): number | null {
  const nextMatch = html.match(/<span[^>]*class=["'][^"']*next[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i);
  if (!nextMatch?.[1]) return null;

  const href = nextMatch[1].replace(/&amp;/g, '&').trim();
  let url: URL;

  try {
    url = new URL(href, BASE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('authenticated', `解析下一页 start 失败: ${message}`);
    return null;
  }

  const nextStart = Number(url.searchParams.get('start'));
  if (!Number.isInteger(nextStart) || nextStart < 0) return null;
  return nextStart;
}

export async function getCollectionRecords(
  userId: string,
  status: InterestStatus,
  limit = 200,
  cookies?: string
): Promise<CollectionRecord[]> {
  const id = userId.trim();
  if (!id) throw new Error('用户 ID 不能为空');
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const results: CollectionRecord[] = [];
  const seenIds = new Set<string>();
  const visitedStarts = new Set<number>();
  const encodedId = encodeURIComponent(id);
  let start = 0;

  while (results.length < limit) {
    if (visitedStarts.has(start)) break;
    visitedStarts.add(start);

    const html = await fetchHtml(`${BASE}/people/${encodedId}/${status}/?start=${start}&sort=time&rating=all&filter=all&mode=list`, {
      Referer: `${BASE}/people/${encodedId}/${status}/`,
      ...(cookies ? { Cookie: cookies } : {})
    });

    const pageItems = parseCollectionBlocks(html, status);
    if (pageItems.length === 0) break;

    for (const item of pageItems) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      results.push(item);
      if (results.length >= limit) break;
    }

    const nextStart = parseCollectionNextStart(html);
    if (nextStart === null || nextStart <= start) break;
    start = nextStart;
  }

  return results;
}
