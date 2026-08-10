import {
  cleanText,
  extractField,
  extractWindowJsonObject,
  isRecord,
  normalizeTitle,
  ResponseSchemaError
} from './common.js';

export interface ParsedBookListItem {
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

export interface ParsedBookSearchPage {
  items: Array<ParsedBookListItem & { year?: string }>;
  start: number;
  count: number;
  total: number;
}

export interface ParsedBookDetail {
  title?: string;
  original_title?: string;
  rating?: string;
  rating_count?: number;
  rating_distribution?: number[];
  author?: string;
  translator?: string[];
  publisher?: string;
  producer?: string[];
  pubdate?: string;
  subtitle?: string;
  pages?: string;
  price?: string;
  binding?: string;
  isbn?: string;
  series?: { title: string; url: string };
  tags?: string[];
  summary?: string;
  author_intro?: string;
  catalog?: string;
  cover?: string;
}

function parseCount(value: string): number {
  const normalized = cleanText(value).replace(/[，,]/g, '');
  const match = normalized.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function splitField(value: string): string[] {
  return value
    .split(/[/／]/)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function readAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return match ? cleanText(match[1]) : '';
}

function parseVotes(block: string): string {
  const match = block.match(/<span[^>]*class=["'][^"']*\bpl\b[^"']*["'][^>]*>\s*\(([\s\S]*?)\)\s*<\/span>/i)
    || block.match(/<span[^>]*class=["'][^"']*color-gray[^"']*["'][^>]*>\s*\(([\s\S]*?)\)\s*<\/span>/i);
  return match ? cleanText(match[1]) : '-';
}

export function parseBookTop250Page(html: string): ParsedBookListItem[] {
  const results: ParsedBookListItem[] = [];
  const tableRegex = /<table\b[^>]*width=["']100%["'][^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const block = tableMatch[1];
    const linkMatch = block.match(/<a[^>]*href=["'](https:\/\/book\.douban\.com\/subject\/(\d+)\/)["'][^>]*title=["']([^"']+)["'][^>]*>/i)
      || block.match(/<a[^>]*title=["']([^"']+)["'][^>]*href=["'](https:\/\/book\.douban\.com\/subject\/(\d+)\/)["'][^>]*>/i);
    if (!linkMatch) continue;

    const alternateOrder = /^https:/.test(linkMatch[1] || '');
    const url = alternateOrder ? linkMatch[1] : linkMatch[2];
    const id = alternateOrder ? linkMatch[2] : linkMatch[3];
    const title = alternateOrder ? linkMatch[3] : linkMatch[1];
    const ratingMatch = block.match(/<span[^>]*class=["'][^"']*rating_nums[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const metaMatch = block.match(/<p[^>]*class=["'][^"']*\bpl\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const coverMatch = block.match(/<img[^>]*src=["']([^"']+)["']/i);

    results.push({
      id,
      title: normalizeTitle(title),
      rating: ratingMatch ? cleanText(ratingMatch[1]) : '-',
      votes: parseVotes(block),
      meta: metaMatch ? cleanText(metaMatch[1]) : '-',
      url,
      cover: coverMatch?.[1]
    });
  }

  return results;
}

export function parseBookMediaList(html: string): ParsedBookListItem[] {
  const results: ParsedBookListItem[] = [];
  const itemRegex = /<li[^>]*class=["'][^"']*\bmedia\b[^"']*\bclearfix\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const block = itemMatch[1];
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href=["'](https:\/\/book\.douban\.com\/subject\/(\d+)\/)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const title = normalizeTitle(linkMatch[3]);
    if (!title) continue;

    const ratingMatch = block.match(/<span[^>]*class=["'][^"']*font-small[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const metaMatch = block.match(/<p[^>]*class=["'][^"']*subject-abstract[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const coverMatch = block.match(/<img[^>]*class=["'][^"']*subject-cover[^"']*["'][^>]*src=["']([^"']+)["']/i)
      || block.match(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*subject-cover[^"']*["']/i);
    const rankMatch = block.match(/<strong[^>]*class=["'][^"']*green-num-box[^"']*["'][^>]*>(\d+)<\/strong>/i);
    const trendClassMatch = block.match(/<span[^>]*class=["'][^"']*\btrend\s+(up|down|equal)[^"']*["'][^>]*>/i);
    const trendValueMatch = block.match(/<span[^>]*class=["'][^"']*rank-value[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const tags = Array.from(block.matchAll(/<span[^>]*class=["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi))
      .map((match) => cleanText(match[1]))
      .filter(Boolean);

    let trend: string | undefined;
    if (trendClassMatch) {
      const direction = trendClassMatch[1];
      const value = trendValueMatch ? cleanText(trendValueMatch[1]) : '';
      trend = direction === 'equal' ? 'stay' : `${direction}${value ? ` ${value}` : ''}`;
    }

    results.push({
      id: linkMatch[2],
      title,
      rating: ratingMatch && cleanText(ratingMatch[1]) ? cleanText(ratingMatch[1]) : '-',
      votes: parseVotes(block),
      meta: metaMatch ? cleanText(metaMatch[1]) : '-',
      url: linkMatch[1],
      cover: coverMatch?.[1],
      rank: rankMatch ? Number(rankMatch[1]) : undefined,
      trend,
      tags
    });
  }

  return results;
}

export function parseBookSubjectList(html: string): ParsedBookListItem[] {
  const results: ParsedBookListItem[] = [];
  const itemRegex = /<li[^>]*class=["'][^"']*subject-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const block = itemMatch[1];
    const linkMatch = block.match(/<a[^>]*href=["'](https:\/\/book\.douban\.com\/subject\/(\d+)\/)["'][^>]*title=["']([^"']+)["'][^>]*>/i)
      || block.match(/<a[^>]*href=["'](https:\/\/book\.douban\.com\/subject\/(\d+)\/)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const ratingMatch = block.match(/<span[^>]*class=["'][^"']*rating_nums[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const metaMatch = block.match(/<div[^>]*class=["'][^"']*\bpub\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const abstractMatch = block.match(/<div[^>]*class=["'][^"']*\binfo\b[^"']*["'][^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
    const coverTag = block.match(/<img\b[^>]*>/i)?.[0] || '';

    results.push({
      id: linkMatch[2],
      title: normalizeTitle(linkMatch[3]),
      rating: ratingMatch ? cleanText(ratingMatch[1]) : '-',
      votes: parseVotes(block),
      meta: metaMatch ? cleanText(metaMatch[1]) : '-',
      url: linkMatch[1],
      cover: readAttribute(coverTag, 'src') || undefined,
      abstract: abstractMatch ? cleanText(abstractMatch[1]) : undefined
    });
  }

  return results;
}

function readPaginationValue(
  data: Record<string, unknown>,
  field: 'start' | 'count' | 'total',
  url: string
): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ResponseSchemaError(`图书搜索页 __DATA__.${field} 不是非负整数`, url);
  }
  return value;
}

export function parseBookSearchPage(
  html: string,
  url = 'https://search.douban.com/book/subject_search'
): ParsedBookSearchPage {
  const rawData = extractWindowJsonObject(html, '__DATA__');
  if (!rawData) throw new ResponseSchemaError('图书搜索页未找到完整的 __DATA__ JSON 数据', url);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    throw new ResponseSchemaError(
      `图书搜索页 __DATA__ 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      url,
      rawData.slice(0, 240)
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new ResponseSchemaError('图书搜索页 __DATA__.items 不是数组', url, rawData.slice(0, 240));
  }

  const items = parsed.items
    .filter(isRecord)
    .filter((item) => item.tpl_name === 'search_subject' && typeof item.url === 'string')
    .map((item) => {
      const rating = isRecord(item.rating) ? item.rating.value : undefined;
      const ratingValue = typeof rating === 'number' && Number.isFinite(rating) ? rating.toFixed(1) : '-';
      const abstract = typeof item.abstract === 'string' ? item.abstract : '';
      const yearMatch = abstract.match(/(19|20)\d{2}/);
      return {
        id: typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '',
        title: normalizeTitle(typeof item.title === 'string' ? item.title : ''),
        rating: ratingValue,
        votes: '-',
        meta: cleanText(abstract) || '-',
        year: yearMatch?.[0],
        url: item.url as string,
        cover: typeof item.cover_url === 'string' ? item.cover_url : undefined,
        abstract: cleanText(abstract)
      };
    })
    .filter((item) => item.id && item.title);

  const start = readPaginationValue(parsed, 'start', url);
  const count = readPaginationValue(parsed, 'count', url);
  const total = readPaginationValue(parsed, 'total', url);
  if (count > 0 && items.length === 0 && start < total) {
    throw new ResponseSchemaError('图书搜索页声明有结果但未解析出任何书籍', url, rawData.slice(0, 240));
  }

  return { items, start, count, total };
}

function extractSection(html: string, heading: string): string {
  const pattern = new RegExp(
    `<h2[^>]*>[\\s\\S]*?${heading}[\\s\\S]*?<\\/h2>\\s*<div[^>]*class=["'][^"']*indent[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const match = html.match(pattern);
  return match ? cleanText(match[1]) : '';
}

export function parseBookDetailHtml(html: string): ParsedBookDetail {
  const titleMatch = html.match(/<span\s+property=["']v:itemreviewed["'][^>]*>([\s\S]*?)<\/span>/i);
  const ratingMatch = html.match(/<strong[^>]*property=["']v:average["'][^>]*>([\s\S]*?)<\/strong>/i)
    || html.match(/<strong[^>]*class=["'][^"']*rating_num[^"']*["'][^>]*>([\s\S]*?)<\/strong>/i);
  const ratingCountMatch = html.match(/property=["']v:votes["'][^>]*>([\s\S]*?)<\/span>/i);
  const infoMatch = html.match(/<div[^>]*id=["']info["'][^>]*>([\s\S]*?)<\/div>/i);
  const infoHtml = infoMatch ? infoMatch[1] : '';

  const hiddenSummaryMatch = html.match(/<div[^>]*class=["'][^"']*indent[^"']*["'][^>]*id=["']link-report["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*all hidden[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
    || html.match(/<div[^>]*id=["']link-report["'][^>]*class=["'][^"']*indent[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*all hidden[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  const normalSummaryMatch = html.match(/<div[^>]*id=["']link-report["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*intro[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const coverMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i);
  const seriesField = extractField(infoHtml, '丛书');
  const seriesLinkMatch = infoHtml.match(/<span[^>]*class=["'][^"']*\bpl\b[^"']*["'][^>]*>\s*丛书\s*<\/span>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const ratingDistribution = Array.from(html.matchAll(/<span[^>]*class=["'][^"']*rating_per[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi))
    .map((match) => Number(cleanText(match[1]).replace('%', '')))
    .filter((value) => Number.isFinite(value));
  const criteriaMatch = html.match(/\bcriteria\s*=\s*["']([^"']+)["']/i);
  const tags = criteriaMatch
    ? criteriaMatch[1]
      .split('|')
      .filter((item) => item.startsWith('7:'))
      .map((item) => cleanText(item.slice(2)))
      .filter(Boolean)
    : [];

  return {
    title: titleMatch ? normalizeTitle(titleMatch[1]) : undefined,
    original_title: extractField(infoHtml, '原作名') || undefined,
    rating: ratingMatch ? cleanText(ratingMatch[1]) : undefined,
    rating_count: ratingCountMatch ? parseCount(ratingCountMatch[1]) : undefined,
    rating_distribution: ratingDistribution.length === 5 ? ratingDistribution : undefined,
    author: extractField(infoHtml, '作者') || undefined,
    translator: splitField(extractField(infoHtml, '译者')),
    publisher: extractField(infoHtml, '出版社') || undefined,
    producer: splitField(extractField(infoHtml, '出品方')),
    pubdate: extractField(infoHtml, '出版年') || undefined,
    subtitle: extractField(infoHtml, '副标题') || undefined,
    pages: extractField(infoHtml, '页数') || undefined,
    price: extractField(infoHtml, '定价') || undefined,
    binding: extractField(infoHtml, '装帧') || undefined,
    isbn: extractField(infoHtml, 'ISBN') || undefined,
    series: seriesLinkMatch
      ? { title: cleanText(seriesLinkMatch[2]), url: seriesLinkMatch[1] }
      : seriesField
        ? { title: seriesField, url: '' }
        : undefined,
    tags,
    summary: hiddenSummaryMatch
      ? cleanText(hiddenSummaryMatch[1])
      : normalSummaryMatch
        ? cleanText(normalSummaryMatch[1])
        : undefined,
    author_intro: extractSection(html, '作者简介') || undefined,
    catalog: extractSection(html, '目录') || undefined,
    cover: coverMatch?.[1]
  };
}
