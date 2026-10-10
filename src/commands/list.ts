import { Command } from 'commander';
import { ensureAuth } from '../auth.js';
import { getHotLists } from '../api/list.js';
import { getDoulist, doulistUrl } from '../api/doulist.js';
import { withErrorHandler } from '../utils/error.js';
import { parsePositiveIntAtMost, parseNonNegativeInt } from '../utils/parsing.js';
import { parseDelaySeconds } from '../utils/timing.js';

export function registerListCommands(program: Command): void {
  program.command('list [id-or-url]').helpGroup('收藏与账号:').description('读取指定豆列；省略 ID 时查询公开热门豆列')
    .option('--start <n>', '起始位置', '0').option('--limit <n>', '最多读取数量，上限 10000', '100')
    .option('--all', '完整读取，最多 10000 条，可用 --limit 调整').option('--delay <seconds>', '分页间隔', '1')
    .option('--kind <kind>', '筛选 movie、book 或 other').option('--keyword <text>', '在已读取的标题、简介和备注中筛选')
    .option('--private', '使用当前登录态读取私有豆列').option('--json', '以 JSON 输出')
    .action(withErrorHandler({ command: 'list' }, async (input: string | undefined, opts, command: Command) => {
      const limit = parsePositiveIntAtMost(opts.all && command.getOptionValueSource('limit') === 'default' ? '10000' : opts.limit, '--limit', 100, 10000);
      const start = parseNonNegativeInt(opts.start, '--start', 0);
      const delayMs = parseDelaySeconds(opts.delay, 1) * 1000;
      if (opts.kind && !['movie', 'book', 'other'].includes(opts.kind)) throw new Error('--kind 必须是 movie、book 或 other');
      let result: unknown;
      if (!input) {
        const items = await getHotLists(Math.min(limit, 100));
        result = { items, metadata: { source: '公开热门豆列', partial: false } };
      } else {
        doulistUrl(input);
        const auth = opts.private ? await ensureAuth() : undefined;
        const page = await getDoulist(input, { start, limit, delayMs, cookies: auth?.cookies });
        const keyword = opts.keyword?.toLowerCase();
        const items = page.items.filter((item) => (!opts.kind || item.kind === opts.kind) && (!keyword || `${item.title} ${item.note} ${item.description}`.toLowerCase().includes(keyword)));
        result = { ...page, fetched: page.items.length, items };
        if (page.partial) process.exitCode = 2;
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.dir(result, { depth: null, colors: Boolean(process.stdout.isTTY) });
    }));
}
