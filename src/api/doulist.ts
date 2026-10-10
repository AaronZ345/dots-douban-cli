import { load } from 'cheerio';
import { fetchHtml, cleanText, ResponseSchemaError } from './common.js';
import { sleep } from '../utils/timing.js';

export interface DoulistEntry {
  id: string;
  itemId: string;
  kind: 'movie' | 'book' | 'other';
  title: string;
  url: string;
  rating: number | null;
  description: string;
  note: string;
}
export interface DoulistPage {
  id: string;
  title: string;
  description: string;
  url: string;
  items: DoulistEntry[];
  total: number | null;
  nextStart: number | null;
}
export interface DoulistResult extends DoulistPage {
  partial: boolean;
  limited: boolean;
  warnings: string[];
}

export function doulistUrl(input: string): string {
  if (/^\d+$/.test(input)) return `https://www.douban.com/doulist/${input}/`;
  try {
    const url = new URL(input);
    const id = url.pathname.match(/^\/doulist\/(\d+)\/?$/)?.[1];
    if (url.protocol === 'https:' && url.hostname === 'www.douban.com' && !url.port && !url.username && !url.password && id) return `https://www.douban.com/doulist/${id}/`;
  } catch { /* The input is validated below. */ }
  throw new Error('豆列必须是数字 ID 或 https://www.douban.com/doulist/<id>/ 地址');
}

export function parseDoulistPage(html: string, url: string): DoulistPage {
  const $ = load(html);
  const title = $('h1').first().text().trim();
  if (!title) throw new ResponseSchemaError('豆列页面缺少标题', url);
  const items: DoulistEntry[] = [];
  $('.doulist-item').each((_, element) => {
    const block = $(element);
    const link = block.find('.title a').first();
    const href = link.attr('href');
    if (!href || !link.text().trim()) return;
    let target: URL;
    try { target = new URL(href, url); } catch { return; }
    if (target.protocol !== 'https:' || !(target.hostname === 'douban.com' || target.hostname.endsWith('.douban.com'))) return;
    const subjectId = target.pathname.match(/\/subject\/(\d+)/)?.[1] ?? '';
    const ratingText = block.find('.rating_nums').text().trim();
    const rating = ratingText ? Number(ratingText) : null;
    items.push({
      id: subjectId,
      itemId: block.attr('id')?.replace(/^item/, '') ?? subjectId,
      kind: target.hostname === 'movie.douban.com' ? 'movie' : target.hostname === 'book.douban.com' ? 'book' : 'other',
      title: cleanText(link.html() ?? ''), url: target.href,
      rating: rating !== null && Number.isFinite(rating) ? rating : null,
      description: cleanText(block.find('.abstract').html() ?? ''),
      note: block.find('.doulist-note .comment, .doulist-note .content').first().text().trim()
    });
  });
  const totalText = $('.paginator').attr('data-total-count') ?? $('.paginator').text().match(/共\s*(\d+)\s*(?:条|个)/)?.[1];
  const total = totalText && /^\d+$/.test(totalText) ? Number(totalText) : null;
  if (!items.length && total !== 0 && !/这个豆列还没有内容|暂无内容|豆列中没有|没有添加任何内容/.test(html)) throw new ResponseSchemaError('豆列页面未解析出内容，不能判断为空', url);
  if (items.length < $('.doulist-item').length) throw new ResponseSchemaError('豆列中存在无法解析的条目，已停止读取', url);
  const href = $('.paginator .next a, a[rel=next]').first().attr('href');
  let nextStart: number | null = null;
  if (href) {
    const next = new URL(href, url);
    if (doulistUrl(`${next.origin}${next.pathname}`) !== doulistUrl(url)) throw new ResponseSchemaError('豆列下一页地址不匹配', url);
    const rawStart = next.searchParams.get('start');
    if (rawStart === null || !/^\d+$/.test(rawStart)) throw new ResponseSchemaError('豆列下一页游标无效', url);
    nextStart = Number(rawStart);
  }
  return { id: new URL(url).pathname.split('/')[2], title, description: $('#doulist-desc, .doulist-desc').first().text().trim(), url: doulistUrl(url.split('?')[0]), items, total, nextStart };
}

export async function getDoulist(input: string, options: { start?: number; limit?: number; delayMs?: number; cookies?: string } = {}): Promise<DoulistResult> {
  const url = doulistUrl(input);
  const limit = options.limit ?? 100;
  let cursor = options.start ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000 || !Number.isInteger(cursor) || cursor < 0) throw new Error('limit 必须是 1-10000 的整数，start 必须非负');
  const delay = options.delayMs ?? 1000;
  if (!Number.isFinite(delay) || delay < 0) throw new Error('分页间隔必须非负');
  const items: DoulistEntry[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let last: DoulistPage | undefined;
  let partial = false;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    if (pageNumber) await sleep(delay);
    try {
      const page = parseDoulistPage(await fetchHtml(`${url}?start=${cursor}`, { Referer: url, ...(options.cookies ? { Cookie: options.cookies } : {}) }), url);
      last = page;
      let consumed = 0;
      for (const item of page.items) {
        consumed++;
        const key = `${item.kind}:${item.itemId || item.url}`;
        if (!seen.has(key)) { seen.add(key); items.push(item); }
        if (items.length >= limit) break;
      }
      if (consumed < page.items.length) last = { ...page, nextStart: cursor + consumed };
      if (items.length >= limit || last.nextStart === null) break;
      if (last.nextStart <= cursor) throw new Error('豆列分页游标没有前进');
      cursor = last.nextStart;
      if (pageNumber === 999) throw new Error('豆列读取达到页数上限');
    } catch (error) {
      if (!last) throw error;
      partial = true;
      warnings.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }
  if (!last) throw new Error('豆列读取失败');
  return { ...last, items, partial, warnings, limited: !partial && last.nextStart !== null };
}
