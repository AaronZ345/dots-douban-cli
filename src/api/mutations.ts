import { BASE, BOOK_BASE, FETCH_TIMEOUT_MS, UA, fetchHtml } from './common.js';
import { debug } from '../utils/debug.js';
import { formEncode } from '../utils/parsing.js';

interface DoubanJsonResponse {
  r?: number;
  msg?: string;
  status?: string;
  ok?: boolean;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

type JsonObject = Record<string, unknown>;

interface MutationEndpoint<T> {
  url: string;
  referer: string;
  decode: (payload: JsonObject) => T;
}

class MutationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MutationHttpError';
  }
}

export interface ReviewCreateResult {
  id: string;
  url: string;
}

export type SubjectActionKind = 'movie' | 'book';
export type SubjectInterest = 'collect' | 'wish' | 'do' | 'none';

export interface SubjectActionDescriptor {
  kind: SubjectActionKind;
  baseUrl: string;
}

export interface SubjectInterestPatch {
  interest: SubjectInterest;
  rating?: number;
  comment?: string;
}

export const SUBJECT_ACTIONS: Record<SubjectActionKind, SubjectActionDescriptor> = {
  movie: { kind: 'movie', baseUrl: BASE },
  book: { kind: 'book', baseUrl: BOOK_BASE }
};

interface ResolveCkOptions {
  forceRefresh?: boolean;
  subjectBaseUrl?: string;
}

interface CkCacheEntry {
  value: string;
  expiresAt: number;
}

const CK_CACHE_TTL_MS = 30 * 60 * 1000;
const ALLOWED_MUTATION_HOSTS = new Set([
  'www.douban.com',
  'movie.douban.com',
  'book.douban.com'
]);
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
    debug('mutations', `JSON 解析失败: ${message}`);
    return null;
  }
}

function parseApiError(res: Response, text: string): string {
  const parsed = parseJsonResponse(text);
  if (parsed && typeof parsed.msg === 'string' && parsed.msg.trim()) {
    return parsed.msg.trim();
  }
  if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim();
  }
  return `HTTP ${res.status}: ${text.slice(0, 120)}`;
}

function parseJsonObject(text: string): JsonObject {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('豆瓣接口返回空响应');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`豆瓣接口返回非 JSON 对象: ${trimmed.slice(0, 120)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`豆瓣接口返回非 JSON 对象: ${trimmed.slice(0, 120)}`);
  }
  return parsed as JsonObject;
}

function responseMessage(payload: JsonObject, fallback: string): string {
  if (typeof payload.msg === 'string' && payload.msg.trim()) return payload.msg.trim();
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
  return fallback;
}

function assertNoMutationFailure(payload: JsonObject): void {
  if ('r' in payload && (typeof payload.r !== 'number' || payload.r !== 0)) {
    throw new Error(responseMessage(payload, `豆瓣接口错误 code=${String(payload.code || 'unknown')}`));
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    throw new Error(payload.error.trim());
  }
  if (payload.error) {
    throw new Error(responseMessage(payload, '豆瓣接口返回错误状态'));
  }
  if (payload.ok === false || payload.success === false) {
    throw new Error(responseMessage(payload, '豆瓣接口返回失败状态'));
  }
  if (typeof payload.status === 'string') {
    const status = payload.status.trim().toLowerCase();
    if (status === 'fail' || status === 'failed' || status === 'error') {
      throw new Error(responseMessage(payload, `豆瓣接口错误 status=${payload.status}`));
    }
  }
}

export function decodeExplicitMutation(payload: JsonObject): JsonObject {
  assertNoMutationFailure(payload);

  if (payload.r === 0 || payload.ok === true || payload.success === true) {
    return payload;
  }
  if (typeof payload.status === 'string') {
    const status = payload.status.trim().toLowerCase();
    if (status === 'ok' || status === 'success') return payload;
  }

  throw new Error('豆瓣接口缺少明确的成功状态');
}

function decodeRZeroMutation(payload: JsonObject): JsonObject {
  assertNoMutationFailure(payload);
  if (payload.r !== 0) {
    throw new Error('豆瓣接口缺少明确的 r=0 成功状态');
  }
  return payload;
}

function validateMutationUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_MUTATION_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error(`拒绝向非受信任地址发送登录态: ${url.origin}`);
  }
  return url;
}

async function postForm<T>(
  endpoint: MutationEndpoint<T>,
  data: Record<string, string | undefined>,
  cookies: string
): Promise<T> {
  const url = validateMutationUrl(endpoint.url);
  const referer = validateMutationUrl(endpoint.referer);
  if (url.origin !== referer.origin) {
    throw new Error(`请求来源与目标域不一致: ${referer.origin} -> ${url.origin}`);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookies,
      Referer: referer.toString(),
      Origin: url.origin,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: formEncode(data),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MutationHttpError(parseApiError(res, text), res.status);
  }
  return endpoint.decode(parseJsonObject(text));
}

function isUnsupportedEndpointError(error: unknown): boolean {
  return error instanceof MutationHttpError && [404, 405, 410, 501].includes(error.status);
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
  action: (ck: string) => Promise<T>,
  subjectBaseUrl = BASE
): Promise<T> {
  const ck = await resolveCk(cookies, existingCk, subjectId, { subjectBaseUrl });

  try {
    return await action(ck);
  } catch (error) {
    if (!isCkRelatedError(error)) throw error;

    clearCachedCk(cookies);
    const refreshedCk = await resolveCk(cookies, undefined, subjectId, {
      forceRefresh: true,
      subjectBaseUrl
    });
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
    const subjectBaseUrl = options.subjectBaseUrl || BASE;
    validateMutationUrl(subjectBaseUrl);
    const subjectHtml = await fetchHtml(`${subjectBaseUrl}/subject/${subjectId}/`, {
      Referer: subjectBaseUrl,
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

function validateSubjectId(subjectId: string): string {
  const id = subjectId.trim();
  if (!/^\d+$/.test(id)) throw new Error('条目 ID 必须是纯数字');
  return id;
}

function subjectEndpoint<T>(
  descriptor: SubjectActionDescriptor,
  subjectId: string,
  path: string,
  decode: (payload: JsonObject) => T
): MutationEndpoint<T> {
  const baseUrl = validateMutationUrl(descriptor.baseUrl).origin;
  return {
    url: `${baseUrl}${path}`,
    referer: `${baseUrl}/subject/${subjectId}/`,
    decode
  };
}

export async function updateSubjectInterest(
  descriptor: SubjectActionDescriptor,
  subjectId: string,
  patch: SubjectInterestPatch,
  cookies: string,
  existingCk?: string
): Promise<void> {
  const id = validateSubjectId(subjectId);
  if (patch.rating !== undefined && (!Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > 5)) {
    throw new Error('评分必须是 1-5 的整数');
  }

  await withCkRetry(cookies, existingCk, id, async (ck) => {
    await postForm(
      subjectEndpoint(descriptor, id, `/j/subject/${id}/interest`, decodeRZeroMutation),
      {
        ck,
        interest: patch.interest,
        rating: patch.rating === undefined ? undefined : String(patch.rating),
        comment: patch.comment
      },
      cookies
    );
  }, descriptor.baseUrl);
}

export async function removeSubjectInterest(
  descriptor: SubjectActionDescriptor,
  subjectId: string,
  cookies: string,
  existingCk?: string
): Promise<void> {
  const id = validateSubjectId(subjectId);

  await withCkRetry(cookies, existingCk, id, async (ck) => {
    try {
      await postForm(
        subjectEndpoint(descriptor, id, `/j/subject/${id}/removeinterest`, decodeExplicitMutation),
        { ck },
        cookies
      );
    } catch (error) {
      if (isCkRelatedError(error)) throw error;
      if (!isUnsupportedEndpointError(error)) throw error;
      debug('mutations', 'removeinterest endpoint unsupported; using interest=none fallback');
      await postForm(
        subjectEndpoint(descriptor, id, `/j/subject/${id}/interest`, decodeRZeroMutation),
        { ck, interest: 'none' },
        cookies
      );
    }
  }, descriptor.baseUrl);
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
      {
        url: `${BASE}/j/review/create`,
        referer: `${BASE}/subject/${id}/`,
        decode: decodeExplicitMutation
      },
      {
        ck,
        subject_id: id,
        title: title.trim(),
        review: content.trim()
      },
      cookies
    );

    const reviewId = String(result.id || '').trim();
    if (!/^\d+$/.test(reviewId)) {
      throw new Error('豆瓣接口未返回有效的长评 ID，无法确认发布成功');
    }
    return {
      id: reviewId,
      url: `${BASE}/review/${reviewId}/`
    };
  });
}

export async function unmarkSubject(movieId: string, cookies: string, existingCk?: string): Promise<void> {
  await removeSubjectInterest(SUBJECT_ACTIONS.movie, movieId, cookies, existingCk);
}

export async function followUser(userId: string, cookies: string, existingCk?: string): Promise<void> {
  const id = userId.trim();
  if (!id) throw new Error('用户 ID 不能为空');

  await withCkRetry(cookies, existingCk, undefined, async (ck) => {
    try {
      await postForm(
        {
          url: `https://www.douban.com/j/contact/follow/${encodeURIComponent(id)}`,
          referer: 'https://www.douban.com/',
          decode: decodeExplicitMutation
        },
        { ck },
        cookies
      );
      return;
    } catch (error) {
      if (isCkRelatedError(error)) throw error;
      if (!isUnsupportedEndpointError(error)) throw error;
      debug('mutations', 'follow endpoint unsupported; using add fallback');
      await postForm(
        {
          url: 'https://www.douban.com/j/contact/add',
          referer: 'https://www.douban.com/',
          decode: decodeExplicitMutation
        },
        { ck, people_id: id },
        cookies
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
        {
          url: `https://www.douban.com/j/contact/unfollow/${encodeURIComponent(id)}`,
          referer: 'https://www.douban.com/',
          decode: decodeExplicitMutation
        },
        { ck },
        cookies
      );
      return;
    } catch (error) {
      if (isCkRelatedError(error)) throw error;
      if (!isUnsupportedEndpointError(error)) throw error;
      debug('mutations', 'unfollow endpoint unsupported; using remove fallback');
      await postForm(
        {
          url: 'https://www.douban.com/j/contact/remove',
          referer: 'https://www.douban.com/',
          decode: decodeExplicitMutation
        },
        { ck, people_id: id },
        cookies
      );
    }
  });
}
