import { Command } from 'commander';
import { getHotLists } from '../api/list.js';
import { withErrorHandler } from '../utils/error.js';
import { parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';

export function registerListCommands(program: Command): void {
  program
    .command('list')
    .helpGroup('收藏与账号:')
    .description('获取热门豆列推荐')
    .option('-n, --limit <n>', '返回数量', '20')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'list',
      suggestion: '可尝试：douban list -n 10'
    }, async (opts) => {
      const limit = parsePositiveInt(opts.limit, '--limit', 20);
      const items = await withSpinner(
        '正在获取热门豆列...',
        () => getHotLists(limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log('\n🗂️  热门片单\n');
        items.forEach((item, i) => {
          console.log(`${(i + 1).toString().padStart(2)}. ${item.title}`);
          console.log(`    作者: ${item.author} | 关注: ${item.followers}`);
          console.log(`    最近更新: ${item.recent}`);
        });
      }
    }));
}
