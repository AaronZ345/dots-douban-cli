import { BOOK_BASE, BASE, cleanText, fetchHtml, ResponseSchemaError } from './common.js';
import { sleep } from '../utils/timing.js';

export type CollectionKind = 'movie' | 'book';
export type CollectionStatus = 'collect' | 'wish' | 'do';

export interface UserCollectionItem {
  kind: CollectionKind;
  title: string;
  url: string;
  id: string;
  rating: number;
  date: string;
  comment: string;
  cover: string;
}

export interface UserCollectionPageOptions {
  kind: CollectionKind;
  userId: string;
  status: CollectionStatus;
  start?: number;
  count?: number;
  pageDelayMs?: number;
}

export interface UserCollectionPage {
  items: UserCollectionItem[];
  total?: number;
  nextStart: number | null;
  partial: boolean;
  warnings: string[];
}

interface ParsedCollectionPage {
  items: UserCollectionItem[];
  total?: number;
  expectedCount?: number;
  nextStart: number | null;
  explicitlyEmpty: boolean;
}

const UPSTREAM_COLLECTION_PAGE_SIZE = 15;
const MAX_COLLECTION_COUNT = 5000;

function normalizeRatingClass(block: string): number {
  const match = block.match(/rating(\d)-t/);
  if (!match) return 0;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : 0;
}

function parseDate(text: string): string {
  return text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
}

function readAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\s${name}\\s*=["']([^"']*)["']`, 'i'));
  return match?.[1] ? cleanText(match[1]) : '';
}

function hasClassToken(openingTag: string, className: string): boolean {
  return readAttribute(openingTag, 'class').split(/\s+/).includes(className);
}

interface HtmlElementBlock {
  html: string;
  end: number;
}

function readElementBlock(html: string, start: number, tagName: string): HtmlElementBlock | null {
  const tagRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagRegex.lastIndex = start;
  let depth = 0;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagRegex.exec(html)) !== null) {
    if (depth === 0 && tagMatch.index !== start) return null;
    const tag = tagMatch[0];
    if (/^<\//.test(tag)) {
      depth -= 1;
      if (depth === 0) {
        return { html: html.slice(start, tagRegex.lastIndex), end: tagRegex.lastIndex };
      }
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
  }

  return null;
}

function findClassElementBlocks(html: string, className: string, tagName: string): string[] {
  const blocks: string[] = [];
  const openingTagRegex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = openingTagRegex.exec(html)) !== null) {
    if (!hasClassToken(openingMatch[0], className)) continue;
    const element = readElementBlock(html, openingMatch.index, tagName);
    if (element) blocks.push(element.html);
  }

  return blocks;
}

function findFirstClassText(html: string, className: string, tagNames: string[]): string {
  for (const tagName of tagNames) {
    for (const block of findClassElementBlocks(html, className, tagName)) {
      const text = cleanText(block);
      if (text) return text;
    }
  }
  return '';
}

function extractCollectionItemBlocks(html: string): string[] {
  const blocks: string[] = [];
  const openingTagRegex = /<(li|div)\b[^>]*>/gi;
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = openingTagRegex.exec(html)) !== null) {
    const openingTag = openingMatch[0];
    if (!hasClassToken(openingTag, 'item') && !hasClassToken(openingTag, 'subject-item')) continue;
    const tagName = openingMatch[1];
    if (!tagName) continue;
    const element = readElementBlock(html, openingMatch.index, tagName);
    if (!element) continue;
    blocks.push(element.html);
    openingTagRegex.lastIndex = element.end;
  }

  return blocks;
}

interface SubjectLink {
  id: string;
  url: string;
  visibleTitle: string;
  linkTitle: string;
  imageAlt: string;
  cover: string;
}

function parseSubjectLinks(block: string, kind: CollectionKind): SubjectLink[] {
  const base = collectionBase(kind);
  const expectedHost = new URL(base).hostname;
  const links: SubjectLink[] = [];
  const anchorRegex = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;

  while ((anchorMatch = anchorRegex.exec(block)) !== null) {
    const anchor = anchorMatch[0];
    const openingTag = anchor.match(/^<a\b[^>]*>/i)?.[0] || '';
    const href = readAttribute(openingTag, 'href');
    if (!href) continue;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.hostname !== expectedHost) continue;
    const id = url.pathname.match(/^\/subject\/(\d+)\/?/)?.[1];
    if (!id) continue;

    const body = anchor.slice(openingTag.length, -'</a>'.length);
    const imageTag = body.match(/<img\b[^>]*>/i)?.[0] || '';
    const emphasizedTitle = body.match(/<em\b[^>]*>([\s\S]*?)<\/em>/i)?.[1];
    links.push({
      id,
      url: url.href,
      visibleTitle: cleanText(emphasizedTitle || body),
      linkTitle: readAttribute(openingTag, 'title'),
      imageAlt: readAttribute(imageTag, 'alt'),
      cover: readAttribute(imageTag, 'data-origin')
        || readAttribute(imageTag, 'data-src')
        || readAttribute(imageTag, 'src')
    });
  }

  return links;
}

function parseCollectionComment(block: string): string {
  const introTexts = ['span', 'p', 'div', 'li']
    .flatMap((tagName) => findClassElementBlocks(block, 'intro', tagName))
    .map((intro) => cleanText(intro))
    .filter(Boolean);

  for (const tagName of ['span', 'p', 'blockquote', 'div', 'li']) {
    for (const commentBlock of findClassElementBlocks(block, 'comment', tagName)) {
      if (['span', 'p', 'div', 'li'].some((introTag) => (
        findClassElementBlocks(commentBlock, 'intro', introTag).length > 0
      ))) continue;
      const text = cleanText(commentBlock).replace(/\s*\(\d+\s*有用\)\s*$/, '');
      if (text && !introTexts.includes(text)) return text;
    }
  }

  return '';
}

function collectionBase(kind: CollectionKind): string {
  return kind === 'book' ? BOOK_BASE : BASE;
}

function parseCollectionNextStart(html: string, baseUrl: string): number | null {
  const nextMatch = html.match(/<span[^>]*class=["'][^"']*\bnext\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i);
  if (!nextMatch?.[1]) return null;

  try {
    const nextStart = Number(new URL(nextMatch[1].replace(/&amp;/g, '&'), baseUrl).searchParams.get('start'));
    return Number.isInteger(nextStart) && nextStart >= 0 ? nextStart : null;
  } catch {
    return null;
  }
}

function parseCollectionTotal(html: string): { total?: number; expectedCount?: number } {
  const subjectNum = html.match(/<span[^>]*class=["'][^"']*\bsubject-num\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!subjectNum) return {};

  const text = cleanText(subjectNum[1]).replace(/[，,]/g, '');
  const totalMatch = text.match(/\/\s*(\d+)/);
  const rangeMatch = text.match(/(\d+)\s*-\s*(\d+)/);
  const total = totalMatch ? Number(totalMatch[1]) : undefined;
  const expectedCount = rangeMatch ? Math.max(0, Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1) : undefined;
  return {
    total: Number.isInteger(total) && (total ?? -1) >= 0 ? total : undefined,
    expectedCount: Number.isInteger(expectedCount) && (expectedCount ?? -1) >= 0 ? expectedCount : undefined
  };
}

export function parseUserCollectionPageHtml(
  html: string,
  kind: CollectionKind,
  pageUrl: string
): ParsedCollectionPage {
  const base = collectionBase(kind);
  const items: UserCollectionItem[] = [];
  for (const block of extractCollectionItemBlocks(html)) {
    const subjectLinks = parseSubjectLinks(block, kind);
    const subject = subjectLinks[0];
    if (!subject) continue;
    const matchingLinks = subjectLinks.filter((link) => link.id === subject.id);
    const titleLink = matchingLinks.find((link) => link.visibleTitle) || subject;
    const title = titleLink.visibleTitle || titleLink.linkTitle || titleLink.imageAlt;
    if (!title) continue;

    items.push({
      kind,
      id: subject.id,
      title,
      url: subject.url || `${base}/subject/${subject.id}/`,
      rating: normalizeRatingClass(block),
      date: parseDate(findFirstClassText(block, 'date', ['span', 'div', 'p', 'li'])),
      comment: parseCollectionComment(block),
      cover: matchingLinks.find((link) => link.cover)?.cover || ''
    });
  }

  const { total, expectedCount } = parseCollectionTotal(html);
  const explicitlyEmpty = total === 0 || /还没有(?:看过|读过|想看|想读|在看|在读)|暂无记录|没有任何条目/.test(html);
  if (items.length === 0 && !explicitlyEmpty) {
    throw new ResponseSchemaError('用户收藏页面未解析出条目，且页面未声明为空', pageUrl);
  }

  return {
    items,
    total,
    expectedCount,
    nextStart: parseCollectionNextStart(html, pageUrl),
    explicitlyEmpty
  };
}

async function loadUserCollectionPage(
  options: UserCollectionPageOptions,
  cookies?: string
): Promise<UserCollectionPage> {
  const userId = options.userId.trim();
  if (!userId) throw new Error('用户 ID 不能为空');
  const start = options.start ?? 0;
  const count = options.count ?? 15;
  const pageDelayMs = options.pageDelayMs ?? 0;
  if (!Number.isInteger(start) || start < 0) throw new Error('start 必须是非负整数');
  if (!Number.isInteger(count) || count <= 0 || count > MAX_COLLECTION_COUNT) {
    throw new Error(`count 必须是 1-${MAX_COLLECTION_COUNT} 的整数`);
  }
  if (!Number.isFinite(pageDelayMs) || pageDelayMs < 0) {
    throw new Error('pageDelayMs 必须是非负数字');
  }

  const base = collectionBase(options.kind);
  const encodedUserId = encodeURIComponent(userId);
  const results: UserCollectionItem[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let total: number | undefined;
  let cursor = start;
  let nextStart: number | null = start;
  let partial = false;
  const maxRequests = Math.min(200, Math.ceil(count / UPSTREAM_COLLECTION_PAGE_SIZE) + 2);

  for (let requestNumber = 0; requestNumber < maxRequests && results.length < count && nextStart !== null; requestNumber += 1) {
    if (requestNumber > 0 && pageDelayMs > 0) {
      await sleep(Math.round(pageDelayMs));
    }
    const pageUrl = `${base}/people/${encodedUserId}/${options.status}/?start=${cursor}&sort=time&rating=all&filter=all&mode=grid`;
    let page: ParsedCollectionPage;
    try {
      const html = await fetchHtml(pageUrl, {
        Referer: `${base}/people/${encodedUserId}/${options.status}/`,
        ...(cookies ? { Cookie: cookies } : {})
      });
      page = parseUserCollectionPageHtml(html, options.kind, pageUrl);
    } catch (error) {
      if (results.length === 0) throw error;
      partial = true;
      warnings.push(`start=${cursor} 页面获取失败: ${error instanceof Error ? error.message : String(error)}`);
      nextStart = cursor;
      break;
    }

    if (page.total !== undefined) total = page.total;
    if (page.expectedCount !== undefined && page.items.length < page.expectedCount) {
      partial = true;
      warnings.push(`start=${cursor} 页面预计 ${page.expectedCount} 条，实际解析 ${page.items.length} 条`);
    }

    let consumedFromPage = 0;
    for (const item of page.items) {
      consumedFromPage += 1;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      if (results.length >= count) break;
    }

    if (results.length >= count && consumedFromPage < page.items.length) {
      nextStart = cursor + consumedFromPage;
      break;
    }

    if (total !== undefined && cursor + (page.expectedCount ?? page.items.length) >= total) {
      nextStart = null;
      break;
    }
    if (page.nextStart === null) {
      if (total !== undefined && cursor + page.items.length < total) {
        partial = true;
        warnings.push(`start=${cursor} 页面缺少下一页链接`);
        nextStart = cursor + page.items.length;
      } else {
        nextStart = null;
      }
      break;
    }
    if (page.nextStart <= cursor) {
      partial = true;
      warnings.push(`start=${cursor} 页面返回了无效的下一页游标 ${page.nextStart}`);
      nextStart = null;
      break;
    }

    cursor = page.nextStart;
    nextStart = cursor;
  }

  if (results.length < count && nextStart !== null && warnings.length === 0) {
    partial = true;
    warnings.push(`达到请求页数上限，下一页从 start=${nextStart} 继续`);
  }

  return {
    items: results.slice(0, count),
    total,
    nextStart,
    partial,
    warnings
  };
}

export function getUserCollectionPage(options: UserCollectionPageOptions): Promise<UserCollectionPage> {
  return loadUserCollectionPage(options);
}

export function loadAuthenticatedUserCollectionPage(
  options: UserCollectionPageOptions,
  cookies: string
): Promise<UserCollectionPage> {
  const cookieHeader = cookies.trim();
  if (!cookieHeader) throw new Error('登录 Cookie 不能为空');
  return loadUserCollectionPage(options, cookieHeader);
}
