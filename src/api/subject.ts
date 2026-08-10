import { cleanText, fetchJson } from './common.js';

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

  const data = await fetchJson<ReviewResponse>(
    `https://m.douban.com/rexxar/api/v2/${kind}/${id}/reviews?count=${limit}&start=${start}`,
    { Referer: mobileReferer(kind, id) }
  );

  const items = Array.isArray(data.reviews)
    ? data.reviews.map((item) => ({
      id: item.id || '',
      user: cleanText(item.user?.name || '') || '匿名',
      rating: typeof item.rating?.value === 'number' ? String(item.rating.value) : '-',
      votes: typeof item.useful_count === 'number' ? item.useful_count : 0,
      time: cleanText(item.create_time || ''),
      content: `【${cleanText(item.title || '') || '无标题'}】${cleanText(item.abstract || '')}`,
      url: item.url || `https://${kind}.douban.com/review/${item.id}/`
    }))
    : [];

  const total = typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
    ? data.total
    : items.length;

  return { items, total };
}

/**
 * Get short comments for a movie or book from Douban's mobile API.
 */
export async function getSubjectComments(
  kind: SubjectKind,
  subjectId: string,
  orderBy: 'hot' | 'latest' = 'hot',
  start = 0,
  count = 20
): Promise<SubjectPaginatedResult<SubjectCommentItem>> {
  const id = normalizeSubjectId(subjectId, kind);
  if (!Number.isFinite(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isFinite(count) || count <= 0) return { items: [], total: 0 };

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

  const data = await fetchJson<{ total?: number; interests?: Interest[] }>(
    `https://m.douban.com/rexxar/api/v2/${kind}/${id}/interests?count=${count}&start=${start}&order_by=${orderBy}`,
    { Referer: mobileReferer(kind, id) }
  );

  const items = Array.isArray(data.interests)
    ? data.interests
      .filter((item) => cleanText(item.comment || '').length > 0)
      .map((item) => ({
        id: item.id || '',
        user: cleanText(item.user?.name || '') || '匿名',
        avatar: item.user?.avatar || '',
        rating: typeof item.rating?.value === 'number' ? item.rating.value : 0,
        votes: typeof item.vote_count === 'number' ? item.vote_count : 0,
        time: cleanText(item.create_time || ''),
        content: cleanText(item.comment || ''),
        url: `https://www.douban.com/doubanapp/dispatch?uri=/${kind}/${id}/interest/${item.id || ''}`
      }))
    : [];

  const total = typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
    ? data.total
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
    stats?: number[];
    wish_count?: number;
    done_count?: number;
    doing_count?: number;
    type_ranks?: Array<{ type: string; rank: number }>;
  }

  interface SubjectResponse {
    rating?: { value?: number; count?: number };
  }

  const [ratingData, subjectData] = await Promise.all([
    fetchJson<RatingResponse>(
      `https://m.douban.com/rexxar/api/v2/${kind}/${id}/rating?for_mobile=1`,
      { Referer: mobileReferer(kind, id) }
    ),
    fetchJson<SubjectResponse>(
      `https://m.douban.com/rexxar/api/v2/${kind}/${id}?for_mobile=1`,
      { Referer: mobileReferer(kind, id) }
    )
  ]);

  const rawStats = Array.isArray(ratingData.stats) ? ratingData.stats : [];
  const stars = new Array<number>(5).fill(0).map((_, index) => {
    const value = rawStats[index];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value * 1000) / 10
      : 0;
  });

  return {
    value: typeof subjectData.rating?.value === 'number' ? subjectData.rating.value : 0,
    count: typeof subjectData.rating?.count === 'number' ? subjectData.rating.count : 0,
    stars,
    wish_count: typeof ratingData.wish_count === 'number' ? ratingData.wish_count : 0,
    done_count: typeof ratingData.done_count === 'number' ? ratingData.done_count : 0,
    doing_count: typeof ratingData.doing_count === 'number' ? ratingData.doing_count : 0,
    type_ranks: Array.isArray(ratingData.type_ranks) ? ratingData.type_ranks : []
  };
}
