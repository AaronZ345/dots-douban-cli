import path from 'node:path';
import { Command } from 'commander';
import {
  getUserCollectionPage,
  type CollectionStatus,
  type UserCollectionItem,
  type UserCollectionPage
} from '../api/collection.js';
import { secureAtomicWriteFile } from '../storage/secure-file.js';
import { withErrorHandler } from '../utils/error.js';
import { pageToOffset, parsePositiveInt } from '../utils/parsing.js';
import { withPagination } from '../utils/pagination.js';
import { withSpinner } from '../utils/spinner.js';

type BookCollectionOptions = {
  wish?: boolean;
  reading?: boolean;
};

type ExportFormat = 'json' | 'csv' | 'markdown';

type ExportResult = {
  items: UserCollectionItem[];
  total?: number;
  partial: boolean;
  warnings: string[];
};

const DEFAULT_PAGE_SIZE = 15;
const DEFAULT_EXPORT_LIMIT = 1000;
const MAX_EXPORT_ITEMS = 5000;
const EXPORT_BATCH_SIZE = 30;
const MAX_EXPORT_REQUESTS = 200;

function resolveBookCollectionStatus(opts: BookCollectionOptions): {
  status: CollectionStatus;
  label: string;
} {
  if (opts.wish && opts.reading) {
    throw new Error('--wish 和 --reading 不能同时使用');
  }
  if (opts.wish) return { status: 'wish', label: '想读' };
  if (opts.reading) return { status: 'do', label: '在读' };
  return { status: 'collect', label: '读过' };
}

function emitWarnings(result: Pick<UserCollectionPage, 'partial' | 'warnings'>): void {
  result.warnings.forEach((warning) => console.error(`⚠️ ${warning}`));
  if (result.partial && result.warnings.length === 0) {
    console.error('⚠️ 豆瓣返回了不完整的收藏结果');
  }
}

function formatRating(rating: number): string {
  return rating > 0 ? `${rating} 星` : '未评分';
}

function renderBookCollection(
  items: UserCollectionItem[],
  userId: string,
  statusLabel: string,
  page: number,
  limit: number,
  hasMore: boolean
): void {
  const start = pageToOffset(page, limit);
  console.log(`\n📚 用户 ${userId} · ${statusLabel}（第 ${page} 页）\n`);

  if (items.length === 0) {
    console.log('暂无记录');
    return;
  }

  items.forEach((item, index) => {
    console.log(`${(start + index + 1).toString().padStart(2)}. ${item.title}`);
    console.log(`    评分: ${formatRating(item.rating)} · 日期: ${item.date || '-'}`);
    console.log(`    短评: ${item.comment || '-'}`);
    console.log(`    ID: ${item.id}`);
  });

  if (!hasMore) console.log('\n已到最后一页');
}

function parseExportLimit(rawValue: string | undefined): number {
  const limit = parsePositiveInt(rawValue, '--limit', DEFAULT_EXPORT_LIMIT);
  if (limit > MAX_EXPORT_ITEMS) {
    throw new Error(`--limit 不能超过 ${MAX_EXPORT_ITEMS}`);
  }
  return limit;
}

function resolveExportFormat(rawFormat: string | undefined, outputPath: string): ExportFormat {
  if (rawFormat) {
    const format = rawFormat.trim().toLowerCase();
    if (format === 'json' || format === 'csv' || format === 'markdown') return format;
    throw new Error('--format 仅支持 json、csv、markdown');
  }

  const extension = path.extname(outputPath).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.csv') return 'csv';
  return 'markdown';
}

function neutralizeCsvFormula(value: string): string {
  const probe = value.replace(/^\uFEFF/, '').trimStart();
  return /^[=+\-@]/.test(probe) ? `'${value}` : value;
}

function csvCell(value: unknown): string {
  const safeValue = neutralizeCsvFormula(String(value ?? ''));
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function serializeBookCollectionCsv(
  items: UserCollectionItem[],
  statusLabel: string
): string {
  const rows = [
    ['序号', '书名', '状态', '星级', '日期', '短评', '豆瓣ID', '链接'],
    ...items.map((item, index) => [
      index + 1,
      item.title,
      statusLabel,
      item.rating > 0 ? item.rating : '',
      item.date,
      item.comment,
      item.id,
      item.url
    ])
  ];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#+.\-!|>])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function serializeBookCollectionMarkdown(
  items: UserCollectionItem[],
  statusLabel: string
): string {
  const lines = [
    '# 豆瓣读书清单',
    '',
    `- 状态：${statusLabel}`,
    `- 数量：${items.length}`,
    ''
  ];

  items.forEach((item, index) => {
    const title = escapeMarkdown(item.title) || '未命名书籍';
    const comment = escapeMarkdown(item.comment) || '-';
    const stars = item.rating > 0 ? '★'.repeat(item.rating) : '未评分';
    lines.push(`${index + 1}. **${title}**`);
    lines.push(`   - 星级：${stars}`);
    lines.push(`   - 日期：${item.date || '-'}`);
    lines.push(`   - 短评：${comment}`);
    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

async function fetchBookCollectionExport(
  userId: string,
  status: CollectionStatus,
  limit: number
): Promise<ExportResult> {
  const items: UserCollectionItem[] = [];
  const seenItems = new Set<string>();
  const seenStarts = new Set<number>();
  const warnings: string[] = [];
  let total: number | undefined;
  let partial = false;
  let nextStart: number | null = 0;
  let requestCount = 0;

  while (nextStart !== null && items.length < limit && requestCount < MAX_EXPORT_REQUESTS) {
    if (seenStarts.has(nextStart)) {
      partial = true;
      warnings.push(`导出在 start=${nextStart} 遇到重复游标，已停止继续请求`);
      break;
    }
    seenStarts.add(nextStart);
    requestCount += 1;

    let result: UserCollectionPage;
    try {
      result = await getUserCollectionPage({
        kind: 'book',
        userId,
        status,
        start: nextStart,
        count: Math.min(EXPORT_BATCH_SIZE, limit - items.length)
      });
    } catch (error) {
      if (items.length === 0) throw error;
      partial = true;
      warnings.push(`导出在 start=${nextStart} 中断: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (result.total !== undefined) total = result.total;
    partial = partial || result.partial;
    warnings.push(...result.warnings);

    result.items.forEach((item) => {
      const key = `${item.kind}:${item.id}`;
      if (items.length < limit && !seenItems.has(key)) {
        seenItems.add(key);
        items.push(item);
      }
    });

    nextStart = result.nextStart;
  }

  if (nextStart !== null && items.length < limit && requestCount >= MAX_EXPORT_REQUESTS) {
    partial = true;
    warnings.push(`导出达到 ${MAX_EXPORT_REQUESTS} 次请求上限，已停止继续请求`);
  }

  return { items, total, partial, warnings };
}

function serializeBookCollectionJson(
  result: ExportResult,
  userId: string,
  status: CollectionStatus,
  statusLabel: string
): string {
  return `${JSON.stringify({
    metadata: {
      userId,
      status,
      statusLabel,
      count: result.items.length,
      ...(result.total !== undefined ? { total: result.total } : {}),
      partial: result.partial,
      warnings: result.warnings
    },
    items: result.items
  }, null, 2)}\n`;
}

export function registerBookCollectionCommands(book: Command): void {
  book
    .command('user <userId>')
    .description('查看指定用户的图书收藏')
    .option('--wish', '查看“想读”列表（默认读过）')
    .option('--reading', '查看“在读”列表')
    .option('-p, --page <n>', '页码（从 1 开始）', String(1))
    .option('-n, --limit <n>', '每页数量', String(DEFAULT_PAGE_SIZE))
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'book user',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban book user <userId> --wish'
    }), async (userId, opts) => {
      const { status, label: statusLabel } = resolveBookCollectionStatus(opts);
      const page = parsePositiveInt(opts.page, '--page', 1);
      const limit = parsePositiveInt(opts.limit, '--limit', DEFAULT_PAGE_SIZE);
      const start = pageToOffset(page, limit);

      if (opts.json) {
        const result = await withSpinner(
          `正在获取用户 ${userId} 的${statusLabel}书单...`,
          () => getUserCollectionPage({ kind: 'book', userId, status, start, count: limit }),
          false
        );
        emitWarnings(result);
        console.log(JSON.stringify(result.items, null, 2));
        return;
      }

      await withPagination({
        startPage: page,
        pageSize: limit,
        fetchPage: async (currentPage) => {
          const currentStart = pageToOffset(currentPage, limit);
          const result = await withSpinner(
            `正在获取用户 ${userId} 的${statusLabel}书单...`,
            () => getUserCollectionPage({
              kind: 'book',
              userId,
              status,
              start: currentStart,
              count: limit
            }),
            true
          );
          emitWarnings(result);
          return {
            items: result.items,
            total: result.total,
            hasMore: result.nextStart !== null
          };
        },
        renderPage: (items, currentPage, _total, hasMore) => {
          renderBookCollection(items, userId, statusLabel, currentPage, limit, hasMore);
        }
      });
    }));

  book
    .command('export <userId>')
    .description('导出指定用户的图书收藏')
    .option('--wish', '导出“想读”列表（默认读过）')
    .option('--reading', '导出“在读”列表')
    .option('-n, --limit <n>', `最多导出数量（上限 ${MAX_EXPORT_ITEMS}）`, String(DEFAULT_EXPORT_LIMIT))
    .requiredOption('-o, --output <path>', '输出文件路径')
    .option('-f, --format <format>', '格式：json、csv、markdown（默认按扩展名推断）')
    .action(withErrorHandler((args) => ({
      command: 'book export',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban book export <userId> -o books.md'
    }), async (userId, opts) => {
      const { status, label: statusLabel } = resolveBookCollectionStatus(opts);
      const limit = parseExportLimit(opts.limit);
      const outputPath = path.resolve(String(opts.output));
      const format = resolveExportFormat(opts.format, outputPath);
      const result = await withSpinner(
        `正在导出用户 ${userId} 的${statusLabel}书单...`,
        () => fetchBookCollectionExport(userId, status, limit),
        true
      );
      emitWarnings(result);

      let contents: string;
      if (format === 'json') {
        contents = serializeBookCollectionJson(result, userId, status, statusLabel);
      } else if (format === 'csv') {
        contents = serializeBookCollectionCsv(result.items, statusLabel);
      } else {
        contents = serializeBookCollectionMarkdown(result.items, statusLabel);
      }

      secureAtomicWriteFile(outputPath, contents);
      console.log(`✅ 已导出 ${result.items.length} 本书到 ${outputPath}`);
    }));
}
