import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { detectAuthSession, getCachedAuthSession } from '../auth.js';
import { getCurrentUserProfile, getUserCollection } from '../api/index.js';
import { withErrorHandler } from '../utils/error.js';
import { parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';
import { withPagination } from '../utils/pagination.js';

type CliConfig = {
  user?: string;
};

const CONFIG_PATH = path.join(os.homedir(), '.douban-cli.json');

function readConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const content = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};

    const maybeUser = (parsed as Record<string, unknown>).user;
    if (typeof maybeUser === 'string') {
      const user = maybeUser.trim();
      return user ? { user } : {};
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[config] 读取配置失败: ${message}`);
    return {};
  }
}

function writeConfig(config: CliConfig): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function registerUserCommands(program: Command): void {
  program
    .command('user [userId]')
    .description('获取指定用户的电影片单')
    .option('--wish', '查看"想看"列表（默认看过）')
    .option('--doing', '查看"在看"列表')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '每页数量', '15')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'user',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban user <userId> --wish'
    }), async (userId, opts) => {
      if (!userId) {
        console.log('\n👤 用户片单 - 请指定用户 ID\n');
        console.log('用法: douban user <用户ID>\n');
        console.log('如何找到用户 ID:');
        console.log('  打开豆瓣个人主页 URL，例如 https://www.douban.com/people/xxx/');
        console.log('  其中 /people/ 后面的 xxx 就是用户 ID\n');
        console.log('选项:');
        console.log('  --wish   想看列表');
        console.log('  --doing  在看列表');
        console.log('  (默认)   看过列表\n');
        console.log('示例: douban user USER_ID --wish');
        return;
      }
      const status = opts.wish ? 'wish' : opts.doing ? 'do' : 'collect';
      const statusLabel = opts.wish ? '想看' : opts.doing ? '在看' : '看过';
      const limit = parsePositiveInt(opts.limit, '--limit', 15);

      if (opts.json) {
        const items = await withSpinner(
          `正在获取用户 ${userId} 的${statusLabel}片单...`,
          () => getUserCollection(userId, status, limit),
          false
        );
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      const page = parsePositiveInt(opts.page, '--page', 1);

      await withPagination({
        startPage: page,
        prompt: '\n按回车加载下一页，输入 q 退出: ',
        fetchPage: async (currentPage) => {
          // 获取比需要的多一条，用于判断是否有下一页
          const fetchLimit = (currentPage - 1) * limit + limit + 1;
          const allItems = await withSpinner(
            `正在获取用户 ${userId} 的${statusLabel}片单...`,
            () => getUserCollection(userId, status, fetchLimit),
            true
          );

          const start = (currentPage - 1) * limit;
          const items = allItems.slice(start, start + limit);
          const hasMore = allItems.length > start + limit;

          return { items, hasMore };
        },
        renderPage: (items, currentPage, _total, hasMore) => {
          const start = (currentPage - 1) * limit;
          console.log(`
👤 用户 ${userId} ${statusLabel}（第 ${currentPage} 页）
`);

          if (items.length === 0) {
            console.log('暂无更多记录');
            return;
          }

          items.forEach((item, i) => {
            const rating = item.rating > 0 ? `⭐${item.rating}` : '⭐-';
            const date = item.date || '-';
            console.log(`${(start + i + 1).toString().padStart(2)}. ${item.title} ${rating} ${date}`);
          });

          if (!hasMore) {
            console.log('\n已到最后一页');
          }
        }
      });
    }));

  program
    .command('config')
    .description('设置本地 douban-cli 配置')
    .option('--user <id>', '设置 me 命令默认用户 ID')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'config',
      suggestion: '可尝试：douban config --user <id>'
    }, async (opts) => {
      const current = readConfig();

      if (opts.user) {
        current.user = String(opts.user).trim();
        writeConfig(current);
      }

      if (opts.json) {
        console.log(JSON.stringify(current, null, 2));
      } else {
        console.log(`\n⚙️  配置文件: ${CONFIG_PATH}`);
        if (current.user) {
          console.log(`默认用户 ID: ${current.user}`);
          console.log('可直接运行: douban me');
        } else {
          console.log('默认用户 ID: 未设置');
          console.log('设置方式: douban config --user <用户ID>');
          console.log('用户 ID 可从个人主页 URL /people/xxx/ 中获取');
        }
      }
    }));

  program
    .command('me')
    .description('获取配置用户的个人片单')
    .option('--wish', '查看"想看"列表（默认看过）')
    .option('--doing', '查看"在看"列表')
    .option('-n, --limit <n>', '返回数量', '30')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'me',
      suggestion: '可先运行 douban login 或 douban config --user <id>'
    }, async (opts) => {
      const config = readConfig();
      let userId = config.user?.trim();

      if (!userId) {
        const cached = getCachedAuthSession();
        if (cached) {
          try {
            const profile = await withSpinner('正在识别当前登录用户...', () => getCurrentUserProfile(cached.cookies), !opts.json);
            userId = profile.id;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[me] 读取缓存登录用户失败: ${message}`);
          }
        }
      }

      if (!userId) {
        try {
          const auth = await detectAuthSession();
          if (!auth) {
            throw new Error('未检测到登录态');
          }
          const profile = await withSpinner('正在识别当前登录用户...', () => getCurrentUserProfile(auth.cookies), !opts.json);
          userId = profile.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[me] 检测登录用户失败: ${message}`);
          throw new Error('未配置默认用户，也未检测到登录 Cookie。请先运行 douban login 或 douban config --user <id>');
        }
      }

      const status = opts.wish ? 'wish' : opts.doing ? 'do' : 'collect';
      const statusLabel = opts.wish ? '想看' : opts.doing ? '在看' : '看过';
      const limit = parsePositiveInt(opts.limit, '--limit', 30);
      if (!userId) {
        throw new Error('无法识别当前用户，请先运行 douban login 或 douban config --user <id>');
      }

      const items = await withSpinner(
        `正在获取我的${statusLabel}片单...`,
        () => getUserCollection(userId, status, limit),
        !opts.json
      );

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`\n🙋 我的片单 (${userId}) ${statusLabel}\n`);
        items.forEach((item, i) => {
          const rating = item.rating > 0 ? `⭐${item.rating}` : '⭐-';
          const date = item.date || '-';
          console.log(`${(i + 1).toString().padStart(2)}. ${item.title} ${rating} ${date}`);
        });
      }
    }));
}
