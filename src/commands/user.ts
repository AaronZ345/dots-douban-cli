import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getCachedAuthSession } from '../auth.js';
import { getCurrentUserProfile, getUserCollection, getUserCollectionPage } from '../api/index.js';
import { withErrorHandler } from '../utils/error.js';
import { parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';
import { withPagination } from '../utils/pagination.js';
import { secureAtomicWriteFile } from '../storage/secure-file.js';

type CliConfig = {
  user?: string;
};

type CollectionStatus = 'collect' | 'wish' | 'do';

function resolveCollectionStatus(opts: { wish?: boolean; doing?: boolean }): {
  status: CollectionStatus;
  label: string;
} {
  if (opts.wish && opts.doing) {
    throw new Error('--wish 和 --doing 不能同时使用');
  }
  if (opts.wish) return { status: 'wish', label: '想看' };
  if (opts.doing) return { status: 'do', label: '在看' };
  return { status: 'collect', label: '看过' };
}

const CONFIG_PATH = path.join(os.homedir(), '.douban-cli.json');

function readConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const content = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件必须是 JSON 对象');
    }

    const maybeUser = (parsed as Record<string, unknown>).user;
    if (maybeUser !== undefined && typeof maybeUser !== 'string') {
      throw new Error('配置项 user 必须是字符串');
    }
    if (typeof maybeUser === 'string') {
      const user = maybeUser.trim();
      return user ? { user } : {};
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取配置失败: ${message}`);
  }
}

function writeConfig(config: CliConfig): void {
  secureAtomicWriteFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function registerUserCommands(program: Command): void {
  program
    .command('user <userId>')
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
      const { status, label: statusLabel } = resolveCollectionStatus(opts);
      const limit = parsePositiveInt(opts.limit, '--limit', 15);
      const page = parsePositiveInt(opts.page, '--page', 1);
      const startForPage = (page - 1) * limit;

      if (opts.json) {
        const result = await withSpinner(
          `正在获取用户 ${userId} 的${statusLabel}片单...`,
          () => getUserCollectionPage({
            kind: 'movie',
            userId,
            status,
            start: startForPage,
            count: limit
          }),
          false
        );
        result.warnings.forEach((warning) => console.error(`⚠️ ${warning}`));
        console.log(JSON.stringify(result.items, null, 2));
        return;
      }

      const warningsByPage = new Map<number, string[]>();

      await withPagination({
        startPage: page,
        fetchPage: async (currentPage) => {
          const start = (currentPage - 1) * limit;
          const result = await withSpinner(
            `正在获取用户 ${userId} 的${statusLabel}片单...`,
            () => getUserCollectionPage({
              kind: 'movie',
              userId,
              status,
              start,
              count: limit
            }),
            true
          );
          warningsByPage.set(currentPage, result.warnings);
          return {
            items: result.items,
            total: result.total,
            hasMore: result.nextStart !== null
          };
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

          const warnings = warningsByPage.get(currentPage) || [];
          warnings.forEach((warning) => console.error(`⚠️ ${warning}`));
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
      const { status, label: statusLabel } = resolveCollectionStatus(opts);
      const config = readConfig();
      let userId = config.user?.trim();

      if (!userId) {
        const cached = getCachedAuthSession();
        if (!cached) {
          throw new Error('未配置默认用户，也没有本地登录态。请先运行 douban login 或 douban config --user <id>');
        }
        try {
          const profile = await withSpinner('正在识别当前登录用户...', () => getCurrentUserProfile(cached.cookies), !opts.json);
          userId = profile.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`本地登录态无法识别当前账号：${message}。请重新运行 douban login 或配置 --user`);
        }
      }

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
