import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { ensureAuth, type VerifiedAuthSession } from '../auth.js';
import { getCollectionRecords } from '../api/account.js';
import { createReview, followUser, unfollowUser } from '../api/mutations.js';
import { secureAtomicWriteFile } from '../storage/secure-file.js';
import { withErrorHandler } from '../utils/error.js';
import { isNumericId, parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';
import { parseDelaySeconds, sleep } from '../utils/timing.js';

type ExportFormat = 'json' | 'csv';

interface StatResult {
  year: number;
  total: number;
  byMonth: number[];
  avgScore: string;
}

function currentUserProfile(session: VerifiedAuthSession) {
  return {
    id: session.accountId,
    name: session.accountName,
    url: `https://www.douban.com/people/${session.accountId}/`
  };
}

function parseMovieId(value: string): string {
  const id = value.trim();
  if (!isNumericId(id)) throw new Error('电影 ID 必须是纯数字');
  return id;
}

function readReviewContent(content: string | undefined, filePath: string | undefined): string {
  if (filePath) {
    return readFileSync(filePath, 'utf8').trim();
  }
  return String(content || '').trim();
}

function monthIndex(dateText: string): number | null {
  const match = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return month - 1;
}

function calcStats(records: Array<{ date?: string; rating?: number }>, year: number): StatResult {
  const byMonth = new Array<number>(12).fill(0);
  let total = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const item of records) {
    if (!item.date || !item.date.startsWith(`${year}-`)) continue;
    total += 1;

    const idx = monthIndex(item.date);
    if (idx !== null) byMonth[idx] += 1;

    if (typeof item.rating === 'number' && item.rating > 0) {
      scoreSum += item.rating;
      scoreCount += 1;
    }
  }

  return {
    year,
    total,
    byMonth,
    avgScore: scoreCount > 0 ? (scoreSum / scoreCount).toFixed(2) : '-'
  };
}

function reportPartialWarnings(scope: string, warnings: string[]): void {
  warnings.forEach((warning) => {
    console.error(`⚠️ ${scope}可能不完整：${warning}`);
  });
}

function protectSpreadsheetCell(value: string): string {
  let candidate = value;
  while (candidate.startsWith('\uFEFF')) candidate = candidate.slice(1);
  candidate = candidate.trimStart();
  return ['=', '+', '-', '@'].includes(candidate.charAt(0)) ? `'${value}` : value;
}

export function serializeExportCsv(records: Array<{
  id: string;
  title: string;
  status: string;
  date?: string;
  rating?: number;
  comment?: string;
  url: string;
}>): string {
  const header = 'id,title,status,date,rating,comment,url';
  const rows = records.map((row) => {
    const cells = [
      row.id,
      row.title,
      row.status,
      row.date || '',
      typeof row.rating === 'number' ? String(row.rating) : '',
      row.comment || '',
      row.url
    ];

    return cells
      .map((cell) => {
        const safe = protectSpreadsheetCell(String(cell)).replace(/"/g, '""');
        return `"${safe}"`;
      })
      .join(',');
  });

  return `${header}\n${rows.join('\n')}\n`;
}

function parseExportFormat(value: string | undefined): ExportFormat {
  const format = (value || 'json').toLowerCase();
  if (format === 'json' || format === 'csv') return format;
  throw new Error('--format 仅支持 json 或 csv');
}

export function registerSocialCommands(program: Command): void {
  program
    .command('review <movieId> <title> [content]')
    .helpGroup('写入操作:')
    .description('写长评 [需登录]')
    .option('--file <path>', '从文件读取长评内容')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'review',
      target: `电影ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban review 1292052 "标题" "正文"'
    }), async (movieId, title, content, opts) => {
      if (opts.file && content) {
        throw new Error('--file 不能与 [content] 同时使用');
      }
      const body = readReviewContent(content, opts.file);
      if (!body) throw new Error('长评内容不能为空，请传 [content] 或 --file');

      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), !opts.json);
      const result = await withSpinner(
        '正在发布长评...',
        () => createReview(parseMovieId(movieId), String(title), body, auth.cookies, auth.ck),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log('\n✅ 长评发布成功');
      console.log(`reviewId: ${result.id || '-'}`);
      console.log(`链接: ${result.url}`);
    }));

  program
    .command('stats')
    .helpGroup('收藏与账号:')
    .description('我的统计（今年看了多少片） [需登录]')
    .option('-y, --year <year>', '统计年份，默认今年')
    .option('-n, --limit <n>', '最多读取的看过记录数', '1000')
    .option('--delay <seconds>', '分页请求间隔（秒）', '1')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'stats',
      suggestion: '可尝试：douban stats --year 2026 --limit 30 --delay 2'
    }, async (opts) => {
      const year = typeof opts.year === 'string'
        ? parsePositiveInt(opts.year, '--year', new Date().getFullYear())
        : new Date().getFullYear();
      if (!Number.isInteger(year) || year < 1900 || year > 3000) {
        throw new Error('年份格式不正确');
      }
      const limit = parsePositiveInt(opts.limit, '--limit', 1000);
      const delaySeconds = parseDelaySeconds(opts.delay, 1);
      const pageDelayMs = Math.round(delaySeconds * 1000);

      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), !opts.json);
      const me = currentUserProfile(auth);
      const result = await withSpinner(
        `正在读取 ${me.id} 的看过记录...`,
        () => getCollectionRecords(me.id, 'collect', limit, auth.cookies, { pageDelayMs }),
        !opts.json
      );

      const stat = calcStats(result.records, year);
      const metadata = { partial: result.partial, warnings: result.warnings };
      reportPartialWarnings('统计数据', result.warnings);

      if (opts.json) {
        console.log(JSON.stringify({ user: me, ...stat, metadata }, null, 2));
        return;
      }

      console.log(`\n📊 ${me.name} 在 ${year} 年观影统计${metadata.partial ? '（结果可能不完整）' : ''}`);
      console.log(`总计: ${stat.total} 部`);
      console.log(`平均分: ${stat.avgScore}`);
      console.log('\n按月分布:');
      stat.byMonth.forEach((count, idx) => {
        console.log(`${String(idx + 1).padStart(2, '0')}月: ${count}`);
      });
    }));

  program
    .command('export')
    .helpGroup('收藏与账号:')
    .description('导出我的观影记录 [需登录]')
    .requiredOption('-o, --output <path>', '输出文件路径（包含个人数据，必须明确指定）')
    .option('-f, --format <format>', '导出格式：json/csv', 'json')
    .option('-n, --limit <n>', '导出数量上限', '1000')
    .option('--delay <seconds>', '批量请求间隔（秒）', '1')
    .action(withErrorHandler({
      command: 'export',
      suggestion: '可尝试：douban export --format csv -o records.csv'
    }, async (opts) => {
      const format = parseExportFormat(opts.format);
      const limit = parsePositiveInt(opts.limit, '--limit', 1000);
      const delaySeconds = parseDelaySeconds(opts.delay, 1);
      const delayMs = Math.round(delaySeconds * 1000);

      const rawOutputPath = String(opts.output || '').trim();
      if (!rawOutputPath) {
        throw new Error('输出文件路径不能为空');
      }
      const outputPath = path.resolve(rawOutputPath);

      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), true);
      const me = currentUserProfile(auth);

      const tasks: Array<{ status: 'collect' | 'wish' | 'do'; label: string; text: string }> = [
        { status: 'collect', label: '看过', text: '正在获取看过记录...' },
        { status: 'wish', label: '想看', text: '正在获取想看记录...' },
        { status: 'do', label: '在看', text: '正在获取在看记录...' }
      ];

      const bucket = new Map<'collect' | 'wish' | 'do', Awaited<ReturnType<typeof getCollectionRecords>>>();
      const warnings: string[] = [];
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        const result = await withSpinner(
          task.text,
          () => getCollectionRecords(me.id, task.status, limit, auth.cookies, { pageDelayMs: delayMs }),
          true
        );
        bucket.set(task.status, result);
        const scopedWarnings = result.warnings.map((warning) => `${task.label}：${warning}`);
        warnings.push(...scopedWarnings);
        reportPartialWarnings('导出数据', scopedWarnings);

        if (delayMs > 0 && i < tasks.length - 1) {
          await sleep(delayMs);
        }
      }

      const collect = bucket.get('collect')?.records || [];
      const wish = bucket.get('wish')?.records || [];
      const doing = bucket.get('do')?.records || [];

      const merged = [...collect, ...wish, ...doing];
      const metadata = {
        count: merged.length,
        partial: [...bucket.values()].some((result) => result.partial),
        warnings
      };

      if (format === 'json') {
        secureAtomicWriteFile(outputPath, `${JSON.stringify({ user: me, records: merged, metadata }, null, 2)}\n`);
      } else {
        secureAtomicWriteFile(outputPath, serializeExportCsv(merged));
      }

      if (metadata.partial) {
        console.log(`⚠️ 已写入 ${merged.length} 条记录到 ${outputPath}；结果可能不完整，请查看上方警告。`);
      } else {
        console.log(`✅ 已导出 ${merged.length} 条记录到 ${outputPath}`);
      }
    }));

  program
    .command('follow <userId>')
    .helpGroup('写入操作:')
    .description('关注用户 [需登录]')
    .option('--delay <seconds>', '请求前延迟（秒）', '0')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'follow',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban follow USER_ID'
    }), async (userId, opts) => {
      const id = String(userId).trim();
      if (!id) throw new Error('用户 ID 不能为空');
      const delaySeconds = parseDelaySeconds(opts.delay, 0);
      const delayMs = Math.round(delaySeconds * 1000);

      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), !opts.json);
      if (delayMs > 0) {
        await withSpinner(`等待 ${delaySeconds} 秒后提交...`, () => sleep(delayMs), !opts.json);
      }
      await withSpinner('正在关注用户...', () => followUser(id, auth.cookies, auth.ck), !opts.json);

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, userId: id }, null, 2));
      } else {
        console.log(`✅ 已关注 ${id}`);
      }
    }));

  program
    .command('unfollow <userId>')
    .helpGroup('写入操作:')
    .description('取消关注用户 [需登录]')
    .option('--delay <seconds>', '请求前延迟（秒）', '0')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'unfollow',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban unfollow USER_ID'
    }), async (userId, opts) => {
      const id = String(userId).trim();
      if (!id) throw new Error('用户 ID 不能为空');
      const delaySeconds = parseDelaySeconds(opts.delay, 0);
      const delayMs = Math.round(delaySeconds * 1000);

      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), !opts.json);
      if (delayMs > 0) {
        await withSpinner(`等待 ${delaySeconds} 秒后提交...`, () => sleep(delayMs), !opts.json);
      }
      await withSpinner('正在取消关注...', () => unfollowUser(id, auth.cookies, auth.ck), !opts.json);

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, userId: id }, null, 2));
      } else {
        console.log(`✅ 已取消关注 ${id}`);
      }
    }));
}
