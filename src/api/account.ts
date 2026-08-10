import { debug } from '../utils/debug.js';
import { cleanText, fetchHtml, fetchHtmlPage } from './common.js';
import {
  loadAuthenticatedUserCollectionPage,
  type CollectionStatus
} from './collection.js';

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
  status: CollectionStatus;
  date?: string;
  rating?: number;
  comment?: string;
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
    throw new Error('当前页面未提供可靠的登录账号标记');
  }

  return {
    id: mine.id,
    name: mine.name || mine.id,
    url: `https://www.douban.com/people/${mine.id}/`
  };
}

function profileIdFromUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.douban.com') return null;
    return url.pathname.match(/^\/people\/([^/]+)\/?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function profileNameFromHtml(html: string, fallback: string): string {
  const heading = cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    .replace(/\s*[（(]\s*(?:添加签名档|编辑)\s*[）)]\s*$/, '')
    .trim();
  if (heading) return heading;

  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s*的豆瓣\s*$/, '')
    .trim();
  return title || fallback;
}

function parseRedirectedProfile(html: string, pageUrl: string): CurrentUserProfile | null {
  const id = profileIdFromUrl(pageUrl);
  if (!id) return null;

  return {
    id,
    name: profileNameFromHtml(html, id),
    url: `https://www.douban.com/people/${id}/`
  };
}

export async function getCurrentUserProfile(cookies: string): Promise<CurrentUserProfile> {
  const minePage = await fetchHtmlPage('https://www.douban.com/mine/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  const redirectedProfile = parseRedirectedProfile(minePage.html, minePage.url);
  if (redirectedProfile) return redirectedProfile;

  try {
    return parseProfileFromHtml(minePage.html);
  } catch (error) {
    debug('account', `/mine/ 页面未提供可靠的当前账号标记: ${error instanceof Error ? error.message : String(error)}`);
  }

  const html = await fetchHtml('https://www.douban.com/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  try {
    return parseProfileFromHtml(html);
  } catch {
    throw new Error('无法识别当前登录用户，请重新登录后重试');
  }
}

export async function getFeed(cookies: string, limit = 20): Promise<FeedItem[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const html = await fetchHtml('https://www.douban.com/', {
    Referer: 'https://www.douban.com/',
    Cookie: cookies
  });

  const results: FeedItem[] = [];
  const blockRegex = /<div class="status-item[\s\S]*?<\/div>\s*<\/div>/g;

  let match: RegExpExecArray | null;
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

export async function getCollectionRecords(
  userId: string,
  status: CollectionStatus,
  limit: number,
  cookies: string
): Promise<CollectionRecord[]> {
  const id = userId.trim();
  if (!id) throw new Error('用户 ID 不能为空');
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const page = await loadAuthenticatedUserCollectionPage({
    kind: 'movie',
    userId: id,
    status,
    start: 0,
    count: limit
  }, cookies);
  if (page.partial) {
    debug('account', `用户收藏仅返回部分结果: ${page.warnings.join('; ')}`);
  }

  return page.items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    status,
    date: item.date || undefined,
    rating: item.rating > 0 ? item.rating : undefined,
    comment: item.comment || undefined
  }));
}
