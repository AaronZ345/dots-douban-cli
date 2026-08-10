import { cleanText, fetchJson, isRecord, ResponseSchemaError } from './common.js';
import { debug } from '../utils/debug.js';

export type SubjectKind = 'movie' | 'book';

export interface SubjectReviewItem {
  id: string;
  user: string;
  rating: string;
  votes: number;
  time: string;
  content: string;
  url: string;
}

export interface SubjectCommentItem {
  id: string;
  user: string;
  avatar: string;
  rating: number;
  votes: number;
  time: string;
  content: string;
  url: string;
}

export interface SubjectPaginatedResult<T> {
  items: T[];
  total: number;
}

export interface SubjectRatingStats {
  value: number;
  count: number;
  stars: number[];
  wish_count: number;
  done_count: number;
  doing_count: number;
  type_ranks: Array<{ type: string; rank: number }>;
}

function normalizeSubjectId(value: string, kind: SubjectKind): string {
  const id = value.trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`${kind === 'book' ? '书籍' : '电影'} ID 必须是纯数字`);
  }
  return id;
}

function mobileReferer(kind: SubjectKind, id: string): string {
  return `https://m.douban.com/${kind}/subject/${id}/`;
}

/**
 * Get long-form reviews for a movie or book from Douban's mobile API.
 */
export async function getSubjectReviews(
  kind: SubjectKind,
  subjectId: string,
  start = 0,
  limit = 20
): Promise<SubjectPaginatedResult<SubjectReviewItem>> {
  const id = normalizeSubjectId(subjectId, kind);
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(limit) || limit <= 0) return { items: [], total: 0 };

  interface ReviewResponse {
    total?: number;
    reviews: Array<{
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

  const url = `https://m.douban.com/rexxar/api/v2/${kind}/${id}/reviews?count=${limit}&start=${start}`;
  const rawData = await fetchJson<unknown>(
    url,
    { Referer: mobileReferer(kind, id) }
  );
  if (!isRecord(rawData) || !Array.isArray(rawData.reviews)) {
    throw new ResponseSchemaError('评论接口返回格式异常', url);
  }
  const reviews = rawData.reviews.filter(isRecord) as unknown as ReviewResponse['reviews'];
  if (rawData.reviews.length > 0 && reviews.length === 0) {
    throw new ResponseSchemaError('评论接口未返回有效条目', url);
  }

  const items = reviews.filter((item) => !!item.id).map((item) => ({
    id: item.id || '',
    user: cleanText(item.user?.name || '') || '匿名',
    rating: typeof item.rating?.value === 'number' && Number.isFinite(item.rating.value)
      ? String(item.rating.value)
      : '-',
    votes: typeof item.useful_count === 'number' && Number.isFinite(item.useful_count)
      ? Math.max(0, Math.trunc(item.useful_count))
      : 0,
    time: cleanText(item.create_time || ''),
    content: `【${cleanText(item.title || '') || '无标题'}】${cleanText(item.abstract || '')}`,
    url: item.url || `https://${kind}.douban.com/review/${item.id}/`
  }));

  const total = typeof rawData.total === 'number' && Number.isFinite(rawData.total) && rawData.total >= 0
    ? rawData.total
    : items.length;

  return { items, total };
}

/**
 * Get short comments for a movie or book from Douban's mobile API.
 * The order parameter remains for compatibility and only accepts hot sorting.
 */
export async function getSubjectComments(
  kind: SubjectKind,
  subjectId: string,
  orderBy: 'hot' = 'hot',
  start = 0,
  count = 20
): Promise<SubjectPaginatedResult<SubjectCommentItem>> {
  const id = normalizeSubjectId(subjectId, kind);
  if ((orderBy as string) !== 'hot') {
    throw new Error('短评目前仅支持热门排序');
  }
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(count) || count <= 0) return { items: [], total: 0 };

  interface Interest {
    id?: string;
    comment?: string;
    rating?: { value?: number };
    vote_count?: number;
    create_time?: string;
    user?: {
      name?: string;
      avatar?: string;
    };
  }

  const url = `https://m.douban.com/rexxar/api/v2/${kind}/${id}/interests?count=${count}&start=${start}&order_by=hot`;
  const rawData = await fetchJson<unknown>(
    url,
    { Referer: mobileReferer(kind, id) }
  );
  if (!isRecord(rawData) || !Array.isArray(rawData.interests)) {
    throw new ResponseSchemaError('短评接口返回格式异常', url);
  }
  const interests = rawData.interests.filter(isRecord) as unknown as Interest[];
  if (rawData.interests.length > 0 && interests.length === 0) {
    throw new ResponseSchemaError('短评接口未返回有效条目', url);
  }

  const items = interests
    .filter((item) => cleanText(item.comment || '').length > 0)
    .filter((item) => !!item.id)
    .map((item) => ({
      id: item.id || '',
      user: cleanText(item.user?.name || '') || '匿名',
      avatar: item.user?.avatar || '',
      rating: typeof item.rating?.value === 'number' && Number.isFinite(item.rating.value)
        ? item.rating.value
        : 0,
      votes: typeof item.vote_count === 'number' && Number.isFinite(item.vote_count)
        ? Math.max(0, Math.trunc(item.vote_count))
        : 0,
      time: cleanText(item.create_time || ''),
      content: cleanText(item.comment || ''),
      url: `https://www.douban.com/doubanapp/dispatch?uri=/${kind}/${id}/interest/${item.id || ''}`
    }));

  const total = typeof rawData.total === 'number' && Number.isFinite(rawData.total) && rawData.total >= 0
    ? rawData.total
    : items.length;

  return { items, total };
}

/**
 * Get rating distribution and collection counts for a movie or book.
 */
export async function getSubjectRatingStats(
  kind: SubjectKind,
  subjectId: string
): Promise<SubjectRatingStats> {
  const id = normalizeSubjectId(subjectId, kind);

  interface RatingResponse {
    stats: number[];
    wish_count?: number;
    done_count?: number;
    doing_count?: number;
    type_ranks?: Array<{ type: string; rank: number }>;
  }

  interface SubjectResponse {
    rating?: { value?: number; count?: number };
  }

  const ratingUrl = `https://m.douban.com/rexxar/api/v2/${kind}/${id}/rating?for_mobile=1`;
  const subjectUrl = `https://m.douban.com/rexxar/api/v2/${kind}/${id}?for_mobile=1`;
  const [ratingResult, subjectResult] = await Promise.allSettled([
    fetchJson<unknown>(ratingUrl, { Referer: mobileReferer(kind, id) }).then((data) => {
      if (!isRecord(data) || !Array.isArray(data.stats)) {
        throw new ResponseSchemaError('评分分布接口返回格式异常', ratingUrl);
      }
      return data as unknown as RatingResponse;
    }),
    fetchJson<unknown>(subjectUrl, { Referer: mobileReferer(kind, id) }).then((data) => {
      if (!isRecord(data)) throw new ResponseSchemaError('详情评分接口返回格式异常', subjectUrl);
      return data as SubjectResponse;
    })
  ]);

  if (ratingResult.status === 'rejected' && subjectResult.status === 'rejected') {
    throw new AggregateError(
      [ratingResult.reason, subjectResult.reason],
      `获取${kind === 'book' ? '书籍' : '电影'}评分统计失败`
    );
  }
  if (ratingResult.status === 'rejected') {
    debug('subject', `评分分布接口失败，保留详情评分: ${ratingResult.reason instanceof Error ? ratingResult.reason.message : String(ratingResult.reason)}`);
  }
  if (subjectResult.status === 'rejected') {
    debug('subject', `详情评分接口失败，保留评分分布: ${subjectResult.reason instanceof Error ? subjectResult.reason.message : String(subjectResult.reason)}`);
  }

  const ratingData: Partial<RatingResponse> = ratingResult.status === 'fulfilled' ? ratingResult.value : {};
  const subjectData: SubjectResponse = subjectResult.status === 'fulfilled' ? subjectResult.value : {};
  const rawStats = Array.isArray(ratingData.stats) ? ratingData.stats : [];
  const stars = new Array<number>(5).fill(0).map((_, index) => {
    const value = rawStats[index];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value * 1000) / 10
      : 0;
  });

  return {
    value: typeof subjectData.rating?.value === 'number' && Number.isFinite(subjectData.rating.value)
      ? subjectData.rating.value
      : 0,
    count: typeof subjectData.rating?.count === 'number' && Number.isFinite(subjectData.rating.count)
      ? Math.max(0, Math.trunc(subjectData.rating.count))
      : 0,
    stars,
    wish_count: typeof ratingData.wish_count === 'number' && Number.isFinite(ratingData.wish_count)
      ? Math.max(0, Math.trunc(ratingData.wish_count))
      : 0,
    done_count: typeof ratingData.done_count === 'number' && Number.isFinite(ratingData.done_count)
      ? Math.max(0, Math.trunc(ratingData.done_count))
      : 0,
    doing_count: typeof ratingData.doing_count === 'number' && Number.isFinite(ratingData.doing_count)
      ? Math.max(0, Math.trunc(ratingData.doing_count))
      : 0,
    type_ranks: Array.isArray(ratingData.type_ranks)
      ? ratingData.type_ranks.filter(isRecord).filter((item) => (
        typeof item.type === 'string'
        && typeof item.rank === 'number'
        && Number.isFinite(item.rank)
      )) as Array<{ type: string; rank: number }>
      : []
  };
}
