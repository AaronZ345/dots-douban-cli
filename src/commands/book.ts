import { Command } from 'commander';
import {
  BOOK_CHART_CATEGORIES,
  BOOK_LATEST_CATEGORIES,
  getBookChart,
  getBookComments,
  getBookHot,
  getBookInfo,
  getBookNotes,
  getBookRatingStats,
  getBookReviews,
  getBooksByTag,
  getBookTop250,
  getLatestBooks,
  searchBooks,
  type BookItem,
  type BookTagSort
} from '../api/book.js';
import { withErrorHandler } from '../utils/error.js';
import { isNumericId, parseNonNegativeInt, parsePositiveInt } from '../utils/parsing.js';
import { withPagination } from '../utils/pagination.js';
import { withSpinner } from '../utils/spinner.js';
import { registerBookCollectionCommands } from './book-collection.js';

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value >= 10000) {
    const scaled = Math.round((value / 10000) * 10) / 10;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}万`;
  }
  return value.toLocaleString();
}

function renderBookList(items: BookItem[], heading: string, offset = 0): void {
  console.log(`\n${heading}\n`);
  if (items.length === 0) {
    console.log('暂无结果。');
    return;
  }

  items.forEach((item, index) => {
    const ordinal = item.rank || offset + index + 1;
    const rating = item.rating && item.rating !== '-' ? ` ⭐${item.rating}` : '';
    const votes = item.votes && item.votes !== '-' ? ` (${item.votes})` : '';
    let trend = '';
    if (item.trend?.startsWith('up')) trend = ` 🔺${item.trend.replace('up', '').trim()}`;
    if (item.trend?.startsWith('down')) trend = ` 🔻${item.trend.replace('down', '').trim()}`;
    if (item.trend === 'stay') trend = ' —';

    console.log(`${ordinal.toString().padStart(2)}. ${item.title}${rating}${votes}${trend}`);
    console.log(`    ${item.meta || '-'}`);
    console.log(`    ID: ${item.id}`);
    if (item.tags && item.tags.length > 0) {
      console.log(`    标签: ${item.tags.join(' / ')}`);
    }
  });
}

function parseBookTagSort(value: string): BookTagSort {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, BookTagSort> = {
    't': 'T',
    '综合': 'T',
    'hot': 'T',
    'r': 'R',
    '出版': 'R',
    '出版日期': 'R',
    'new': 'R',
    'latest': 'R',
    's': 'S',
    '评价': 'S',
    '评分': 'S',
    'rating': 'S'
  };
  const sort = mapping[normalized];
  if (!sort) throw new Error('--sort 仅支持：综合、出版、评价');
  return sort;
}

async function resolveBookId(input: string, outputJson: boolean): Promise<string> {
  const query = input.trim();
  if (!query) throw new Error('书籍 ID、ISBN 或关键词不能为空');

  // Douban subject IDs are shorter than ISBN-10/ISBN-13. Long numeric input
  // should be searched as ISBN instead of being sent as a subject ID.
  if (isNumericId(query) && query.length < 10) return query;

  const candidates = await searchBooks(query, 0, 10);
  const normalizedQuery = query.toLocaleLowerCase();
  const matched = candidates.find((item) => {
    const title = item.title.toLocaleLowerCase();
    const primaryTitle = title.split(/\s*[:：]\s*/)[0];
    return title === normalizedQuery || primaryTitle === normalizedQuery;
  }) || candidates[0];
  if (!matched?.id) throw new Error(`未找到书籍：${query}`);
  if (!outputJson) {
    console.log(`\n🔎 已匹配为: ${matched.title} (${matched.id})`);
  }
  return matched.id;
}

function registerTop250Command(book: Command, name: 'hot' | 'top250'): void {
  const legacy = name === 'hot';
  book
    .command(name)
    .description(legacy ? '获取热门书籍（兼容旧版，等同 Top250）' : '获取豆瓣图书 Top250')
    .option('-s, --start <n>', '起始偏移', '0')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: `book ${name}`,
      suggestion: legacy
        ? '推荐改用：douban book top250 -n 30'
        : '可尝试：douban book top250 -n 30'
    }, async (opts) => {
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        '正在获取图书 Top250...',
        () => legacy ? getBookHot(start, limit) : getBookTop250(start, limit),
        !opts.json
      );

      if (opts.json) console.log(JSON.stringify(items, null, 2));
      else renderBookList(items, legacy ? '📚 热门书籍 · Top250' : '📚 豆瓣图书 Top250', start);
    }));
}

export function registerBookCommands(program: Command): void {
  const book = program
    .command('book')
    .description('豆瓣书籍：榜单、搜索、详情、评分与书评');

  registerTop250Command(book, 'hot');
  registerTop250Command(book, 'top250');
  registerBookCollectionCommands(book);

  book
    .command('chart [category]')
    .description('获取当前热门图书榜')
    .option('-n, --limit <n>', '返回数量（最多 20）', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book chart',
      target: `分类: ${String(args[0] || '全部')}`,
      options: `分类：${Object.keys(BOOK_CHART_CATEGORIES).join('、')}`,
      suggestion: '可尝试：douban book chart 小说'
    }), async (category = '全部', opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        `正在获取${category}热门图书...`,
        () => getBookChart(category, limit),
        !opts.json
      );

      if (opts.json) console.log(JSON.stringify(items, null, 2));
      else renderBookList(items, `🔥 热门图书榜 · ${category}`);
    }));

  book
    .command('new [category]')
    .alias('latest')
    .description('获取新书速递')
    .option('-n, --limit <n>', '返回数量（最多 20）', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book new',
      target: `分类: ${String(args[0] || '全部')}`,
      options: `分类：${BOOK_LATEST_CATEGORIES.join('、')}`,
      suggestion: '可尝试：douban book new 科学新知'
    }), async (category = '全部', opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        `正在获取${category}新书...`,
        () => getLatestBooks(category, limit),
        !opts.json
      );

      if (opts.json) console.log(JSON.stringify(items, null, 2));
      else renderBookList(items, `🆕 新书速递 · ${category}`);
    }));

  book
    .command('tag <tag>')
    .description('按标签浏览图书')
    .option('-s, --start <n>', '起始偏移', '0')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--sort <sort>', '排序：综合、出版、评价', '综合')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book tag',
      target: `标签: ${String(args[0])}`,
      suggestion: '可尝试：douban book tag 科幻 --sort 评价'
    }), async (tag, opts) => {
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const sort = parseBookTagSort(String(opts.sort));
      const items = await withSpinner(
        `正在获取“${tag}”标签图书...`,
        () => getBooksByTag(tag, start, limit, sort),
        !opts.json
      );

      if (opts.json) console.log(JSON.stringify(items, null, 2));
      else renderBookList(items, `🏷️ 图书标签 · ${tag}`, start);
    }));

  book
    .command('search <keyword>')
    .description('按书名、作者或 ISBN 搜索')
    .option('-s, --start <n>', '起始偏移', '0')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book search',
      target: `关键词: ${String(args[0])}`,
      suggestion: '可尝试：douban book search 三体 -n 20'
    }), async (keyword, opts) => {
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        `正在搜索书籍“${keyword}”...`,
        () => searchBooks(keyword, start, limit),
        !opts.json
      );

      if (opts.json) console.log(JSON.stringify(items, null, 2));
      else renderBookList(items, `🔍 搜索书籍 · ${keyword}`, start);
    }));

  book
    .command('info <query>')
    .description('按豆瓣 ID、ISBN 或关键词获取书籍详情')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book info',
      target: `书籍: ${String(args[0])}`,
      suggestion: '可尝试：douban book info 三体'
    }), async (query, opts) => {
      const id = await resolveBookId(query, Boolean(opts.json));
      const detail = await withSpinner(
        '正在获取书籍详情...',
        () => getBookInfo(id),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }

      console.log(`\n📘 ${detail.title}${detail.subtitle !== '-' ? `：${detail.subtitle}` : ''}`);
      console.log(`ID: ${detail.id}`);
      console.log(`评分: ${detail.rating} (${compactNumber(detail.rating_count)}人评价)`);
      console.log(`作者: ${detail.author}`);
      console.log(`译者: ${detail.translator.length > 0 ? detail.translator.join(' / ') : '-'}`);
      console.log(`出版社: ${detail.publisher}`);
      console.log(`出品方: ${detail.producer.length > 0 ? detail.producer.join(' / ') : '-'}`);
      console.log(`出版年: ${detail.pubdate}`);
      console.log(`页数: ${detail.pages}`);
      console.log(`装帧: ${detail.binding}`);
      console.log(`定价: ${detail.price}`);
      console.log(`ISBN: ${detail.isbn}`);
      console.log(`丛书: ${detail.series?.title || '-'}`);
      console.log(`短评: ${compactNumber(detail.comment_count)}`);
      console.log(`书评: ${compactNumber(detail.review_count)}`);
      console.log(`读书笔记: ${compactNumber(detail.annotation_count)}`);
      console.log(`标签: ${detail.tags.length > 0 ? detail.tags.join(' / ') : '-'}`);
      console.log(`电子书: ${detail.has_ebook ? '有' : '无/未知'}`);
      console.log(`\n简介:\n${detail.summary}`);
      if (detail.author_intro !== '-') console.log(`\n作者简介:\n${detail.author_intro}`);
      if (detail.catalog !== '-') console.log(`\n目录:\n${detail.catalog}`);
      console.log(`\n链接: ${detail.url}`);
    }));

  book
    .command('rating <query>')
    .description('获取书籍评分分布')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book rating',
      target: `书籍: ${String(args[0])}`,
      suggestion: '可尝试：douban book rating 三体'
    }), async (query, opts) => {
      const id = await resolveBookId(query, Boolean(opts.json));
      const stats = await withSpinner(
        '正在获取书籍评分分布...',
        () => getBookRatingStats(id),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`\n⭐ 评分分布 (${stats.value}分，${compactNumber(stats.count)}人评价)\n`);
      const labels = ['5星', '4星', '3星', '2星', '1星'];
      const maxPercent = Math.max(...stats.stars, 0);
      stats.stars.slice().reverse().forEach((percent, index) => {
        const barLength = maxPercent > 0 ? Math.round((percent / maxPercent) * 30) : 0;
        console.log(`${labels[index]} ${'█'.repeat(barLength)} ${percent}%`);
      });
      console.log(`\n想读: ${compactNumber(stats.wish_count)}`);
      console.log(`在读: ${compactNumber(stats.doing_count)}`);
      console.log(`读过: ${compactNumber(stats.done_count)}`);
    }));

  book
    .command('comments <query>')
    .description('获取书籍短评')
    .option('--latest', '按最新排序（默认按热门）')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '每页数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book comments',
      target: `书籍: ${String(args[0])}`,
      suggestion: '可尝试：douban book comments 三体 --latest'
    }), async (query, opts) => {
      const id = await resolveBookId(query, Boolean(opts.json));
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const page = parsePositiveInt(opts.page, '--page', 1);
      const order = opts.latest ? 'latest' : 'hot';

      if (opts.json) {
        const result = await getBookComments(id, order, (page - 1) * limit, limit);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const result = await withSpinner(
            `正在获取${opts.latest ? '最新' : '热门'}短评...`,
            () => getBookComments(id, order, start, limit),
            true
          );
          return { ...result, hasMore: start + result.items.length < result.total };
        },
        renderPage: (items, currentPage, total) => {
          const start = (currentPage - 1) * limit;
          console.log(`\n💬 ${opts.latest ? '最新' : '热门'}短评 (${id})`);
          console.log(`共 ${(total || 0).toLocaleString()} 条，当前第 ${start + 1}-${start + items.length} 条\n`);
          items.forEach((item, index) => {
            const stars = item.rating > 0 ? '⭐'.repeat(item.rating) : '';
            console.log(`${(start + index + 1).toString().padStart(2)}. ${item.user} ${stars} 👍${item.votes}`);
            console.log(`    ${item.content}`);
            console.log(`    ${item.time}\n`);
          });
        }
      });
    }));

  book
    .command('reviews <query>')
    .description('获取热门书评')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '每页数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book reviews',
      target: `书籍: ${String(args[0])}`,
      suggestion: '可尝试：douban book reviews 三体 -n 5'
    }), async (query, opts) => {
      const id = await resolveBookId(query, Boolean(opts.json));
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const page = parsePositiveInt(opts.page, '--page', 1);

      if (opts.json) {
        const result = await getBookReviews(id, (page - 1) * limit, limit);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const result = await withSpinner('正在获取热门书评...', () => getBookReviews(id, start, limit), true);
          return { ...result, hasMore: start + result.items.length < result.total };
        },
        renderPage: (items, currentPage, total) => {
          const start = (currentPage - 1) * limit;
          console.log(`\n📝 热门书评 (${id})`);
          console.log(`共 ${(total || 0).toLocaleString()} 条，当前第 ${start + 1}-${start + items.length} 条\n`);
          items.forEach((item, index) => {
            console.log(`${(start + index + 1).toString().padStart(2)}. ${item.user} ⭐${item.rating} 👍${item.votes} ${item.time}`);
            console.log(`    ${item.content}\n`);
          });
        }
      });
    }));

  book
    .command('notes <query>')
    .description('获取热门读书笔记')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '每页数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book notes',
      target: `书籍: ${String(args[0])}`,
      suggestion: '可尝试：douban book notes 三体 -n 5'
    }), async (query, opts) => {
      const id = await resolveBookId(query, Boolean(opts.json));
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const page = parsePositiveInt(opts.page, '--page', 1);

      if (opts.json) {
        const result = await getBookNotes(id, (page - 1) * limit, limit);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const result = await withSpinner('正在获取读书笔记...', () => getBookNotes(id, start, limit), true);
          return { ...result, hasMore: start + result.items.length < result.total };
        },
        renderPage: (items, currentPage, total) => {
          const start = (currentPage - 1) * limit;
          console.log(`\n📒 读书笔记 (${id})`);
          console.log(`共 ${(total || 0).toLocaleString()} 条，当前第 ${start + 1}-${start + items.length} 条\n`);
          items.forEach((item, index) => {
            console.log(`${(start + index + 1).toString().padStart(2)}. ${item.user} · ${item.chapter}`);
            console.log(`    ${item.content}`);
            console.log(`    ${item.time}\n`);
          });
        }
      });
    }));
}
