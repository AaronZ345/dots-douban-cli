import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureAuth } from '../auth.js';
import { getUserCollectionPage, loadAuthenticatedUserCollectionPage, type CollectionKind, type CollectionStatus, type UserCollectionItem, type UserCollectionPageOptions, type UserCollectionPage } from '../api/collection.js';
import { applyRecordPatch, editPersonalRecord, getPersonalRecord, type RecordPatch } from '../api/record.js';
import { secureAtomicWriteFile } from '../storage/secure-file.js';
import { CliArgumentError, withErrorHandler } from '../utils/error.js';
import { parsePositiveIntAtMost, parseNonNegativeInt } from '../utils/parsing.js';
import { parseDelaySeconds, sleep } from '../utils/timing.js';

export function parseKind(value: string): CollectionKind {
  if (value !== 'movie' && value !== 'book') throw new CliArgumentError('--kind 必须为 movie 或 book');
  return value;
}
function numericId(value: string): string {
  if (!/^\d+$/.test(value)) throw new CliArgumentError('单条记录必须使用数字豆瓣 ID');
  return value;
}
export function recordPatchFromOptions(opts: Record<string, unknown>): RecordPatch {
  if ([opts.comment !== undefined, opts.commentFile !== undefined, !!opts.clearComment].filter(Boolean).length > 1) throw new CliArgumentError('--comment、--comment-file、--clear-comment 只能选择一个');
  if (opts.rating !== undefined && opts.clearRating) throw new CliArgumentError('--rating 与 --clear-rating 不能同时使用');
  if (opts.tags !== undefined && opts.clearTags) throw new CliArgumentError('--tags 与 --clear-tags 不能同时使用');
  if (opts.private && opts.public) throw new CliArgumentError('--private 与 --public 不能同时使用');
  const patch: RecordPatch = {};
  if (opts.comment !== undefined) patch.comment = String(opts.comment);
  if (opts.commentFile !== undefined) {
    const contents = readFileSync(path.resolve(String(opts.commentFile)));
    if (contents.length > 64 * 1024) throw new CliArgumentError('短评文件不能超过 64 KiB');
    patch.comment = new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/\r?\n$/, '');
  }
  if (opts.clearComment) patch.comment = '';
  if (opts.rating !== undefined) {
    if (!/^[1-5]$/.test(String(opts.rating))) throw new CliArgumentError('--rating 必须为 1-5 的整数');
    patch.rating = Number(opts.rating);
  }
  if (opts.clearRating) patch.rating = null;
  if (opts.status !== undefined) {
    if (!['collect', 'wish', 'do'].includes(String(opts.status))) throw new CliArgumentError('--status 必须为 collect、wish 或 do');
    patch.status = opts.status as RecordPatch['status'];
  }
  if (opts.tags !== undefined) patch.tags = String(opts.tags).split(',').map((tag) => tag.trim());
  if (opts.clearTags) patch.tags = [];
  if (opts.private) patch.private = true;
  if (opts.public) patch.private = false;
  if (!Object.keys(patch).length) throw new CliArgumentError('至少指定一个需要修改的字段');
  applyRecordPatch({ kind: 'movie', id: '1', url: '', status: 'collect', rating: null, comment: '', tags: [], private: false }, patch);
  return patch;
}
function emit(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.dir(value, { depth: null, colors: Boolean(process.stdout.isTTY) });
}
function validateDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

export function registerRecordCommands(program: Command): void {
  const record = program.command('record').helpGroup('写入操作:').description('查询或编辑自己的单条电影／图书记录');
  record.command('get <id>').description('读取自己的状态、评分、短评、标签和隐私')
    .option('--kind <kind>', 'movie 或 book', 'movie').option('--json', '以 JSON 输出')
    .action(withErrorHandler({ command: 'record get' }, async (id: string, opts) => {
      const kind = parseKind(opts.kind); numericId(id);
      const auth = await ensureAuth();
      emit(await getPersonalRecord(kind, id, auth.cookies), Boolean(opts.json));
    }));
  record.command('edit <id>').description('仅修改指定字段，提交后读回核验')
    .option('--kind <kind>', 'movie 或 book', 'movie')
    .option('--comment <text>', '短评内容').option('--comment-file <path>', '从 UTF-8 文件读取短评')
    .option('--clear-comment', '清空短评').option('--rating <score>', '星级：1-5').option('--clear-rating', '清空评分')
    .option('--status <status>', 'collect：看过／读过；wish：想看／想读；do：在看／在读')
    .option('--tags <tags>', '英文逗号分隔的标签').option('--clear-tags', '清空标签')
    .option('--private', '仅自己可见').option('--public', '公开记录')
    .option('--dry-run', '预览修改，不提交').option('--json', '以 JSON 输出')
    .action(withErrorHandler({ command: 'record edit' }, async (id: string, opts) => {
      const kind = parseKind(opts.kind); numericId(id);
      const patch = recordPatchFromOptions(opts);
      const auth = await ensureAuth();
      const result = await editPersonalRecord(kind, id, patch, auth.cookies, Boolean(opts.dryRun));
      emit({ ...result, accountId: auth.accountId }, Boolean(opts.json));
    }));
  program.command('records').helpGroup('收藏与账号:').description('查询自己的或指定用户的电影／图书记录')
    .option('--user <id>', '指定用户；省略时读取当前账号')
    .option('--kind <kind>', 'movie、book 或 all', 'all').option('--status <status>', 'collect、wish、do 或 all', 'collect')
    .option('--start <n>', '每类的起始位置', '0').option('--limit <n>', '每类最多读取数量，上限 10000', '30')
    .option('--all', '每类最多读取 10000 条，可用 --limit 调整')
    .option('--keyword <text>', '在已读取的标题与短评中筛选').option('--min-rating <score>', '最低个人星级（1-5）')
    .option('--from <date>', '起始日期 YYYY-MM-DD').option('--to <date>', '结束日期 YYYY-MM-DD')
    .option('--delay <seconds>', '分页和分类请求间隔', '1')
    .option('-o, --output <path>', '保存为 JSON 文件').option('--json', '以 JSON 输出')
    .action(withErrorHandler({ command: 'records' }, async (opts, command: Command) => {
      const kinds: CollectionKind[] = opts.kind === 'all' ? ['movie', 'book'] : [parseKind(opts.kind)];
      if (!['all', 'collect', 'wish', 'do'].includes(opts.status)) throw new CliArgumentError('--status 必须为 collect、wish、do 或 all');
      const statuses: CollectionStatus[] = opts.status === 'all' ? ['collect', 'wish', 'do'] : [opts.status];
      const limit = parsePositiveIntAtMost(opts.all && command.getOptionValueSource('limit') === 'default' ? '10000' : opts.limit, '--limit', 30, 10000);
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const delayMs = parseDelaySeconds(opts.delay, 1) * 1000;
      if (opts.minRating !== undefined && !/^[1-5]$/.test(opts.minRating)) throw new CliArgumentError('--min-rating 必须是 1-5 的整数');
      if ([opts.from, opts.to].filter(Boolean).some((date) => !validateDate(date))) throw new CliArgumentError('筛选日期必须是有效的 YYYY-MM-DD');
      if (opts.from && opts.to && opts.from > opts.to) throw new CliArgumentError('--from 不能晚于 --to');
      const auth = opts.user ? undefined : await ensureAuth();
      const userId = opts.user ?? auth!.accountId;
      const entries: Array<UserCollectionItem & { status: CollectionStatus }> = [];
      const groups: Array<{ kind: CollectionKind; status: CollectionStatus; total?: number; nextStart: number | null; limited: boolean }> = [];
      const warnings: string[] = [];
      let requests = 0, stop = false;
      for (const kind of kinds) {
        for (const status of statuses) {
          let cursor: number | null = start, total: number | undefined, count = 0;
          const seen = new Set<string>();
          let pages = 0;
          while (cursor !== null && count < limit && !stop) {
            if (++pages > 1000) { stop = true; warnings.push('收藏读取达到页数上限'); break; }
            if (requests++) await sleep(delayMs);
            try {
              const options: UserCollectionPageOptions = { kind, status, userId, start: cursor, count: Math.min(15, limit - count) };
              const page: UserCollectionPage = auth ? await loadAuthenticatedUserCollectionPage(options, auth.cookies) : await getUserCollectionPage(options);
              total = page.total ?? total;
              const beforeCount = count;
              for (const entry of page.items) if (!seen.has(entry.id)) { seen.add(entry.id); entries.push({ ...entry, status }); count++; }
              if (count === beforeCount && page.nextStart !== null) { stop = true; warnings.push('连续页没有新的收藏记录，已停止'); }
              warnings.push(...page.warnings);
              if (page.partial) { stop = true; if (!page.warnings.length) warnings.push('收藏读取不完整'); }
              if (page.nextStart !== null && page.nextStart <= cursor) { stop = true; warnings.push('收藏分页游标没有前进'); }
              cursor = page.nextStart;
            } catch (error) {
              if (!entries.length) throw error;
              warnings.push(error instanceof Error ? error.message : String(error)); stop = true;
            }
          }
          groups.push({ kind, status, total, nextStart: cursor, limited: !stop && cursor !== null });
          if (stop) break;
        }
        if (stop) break;
      }
      const keyword = opts.keyword?.toLowerCase();
      const filtered = entries.filter((item) => (!keyword || `${item.title} ${item.comment}`.toLowerCase().includes(keyword))
        && (opts.minRating === undefined || item.rating >= Number(opts.minRating))
        && (!opts.from || (item.date && item.date >= opts.from)) && (!opts.to || (item.date && item.date <= opts.to)));
      const result = { metadata: { userId, fetched: entries.length, count: filtered.length, partial: stop, warnings, groups }, items: filtered };
      if (opts.output) secureAtomicWriteFile(path.resolve(opts.output), JSON.stringify(result, null, 2) + '\n');
      emit(result, Boolean(opts.json));
      if (stop) process.exitCode = 2;
    }));
}
