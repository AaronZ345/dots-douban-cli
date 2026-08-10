import { cleanText, extractNumericId, fetchHtml, isChallengePage, ResponseSchemaError } from './common.js';

export interface DoulistItem {
  id: string;
  title: string;
  author: string;
  followers: string;
  recent: string;
  url: string;
}

/**
 * Get hot doulist recommendations from https://www.douban.com/doulist/
 */
export async function getHotLists(limit = 20): Promise<DoulistItem[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const html = await fetchHtml('https://www.douban.com/doulist/', {
    Referer: 'https://www.douban.com/'
  });

  if (isChallengePage(html)) {
    throw new Error('豆列页面触发了反爬挑战，暂时无法解析');
  }

  const results: DoulistItem[] = [];
  const itemRegex = /<li[^>]*class=["'][^"']*\bdoulist-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;

  let match;
  while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
    const block = match[0];

    const linkMatch = block.match(/<div[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a[^>]*href=["'](https:\/\/www\.douban\.com\/doulist\/(\d+)\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>\s*<\/div>/i);
    if (!linkMatch) continue;

    const metaMatch = block.match(/<p class="meta">([\s\S]*?)<\/p>/);
    const recentMatch = block.match(/<div class="bd doulist-note">[\s\S]*?<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/);

    const metaText = metaMatch ? cleanText(metaMatch[1]) : '';
    const authorMatch = metaText.match(/^(.*?)创建/);
    const followersMatch = metaText.match(/(\d+)\s*关注/);

    results.push({
      id: linkMatch[2] || extractNumericId(linkMatch[1], 'doulist'),
      title: cleanText(linkMatch[3]),
      author: authorMatch ? cleanText(authorMatch[1]) : '-',
      followers: followersMatch ? followersMatch[1] : '-',
      recent: recentMatch ? cleanText(recentMatch[1]) : '-',
      url: linkMatch[1]
    });
  }

  if (results.length === 0) {
    throw new ResponseSchemaError('热门豆列页面未解析出预期条目', 'https://www.douban.com/doulist/');
  }

  return results;
}
