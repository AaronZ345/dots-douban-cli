import path from 'node:path';
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { Command } from 'commander';
import { ensureAuth, type VerifiedAuthSession } from '../auth.js';
import { getUserCollectionPage, loadAuthenticatedUserCollectionPage } from '../api/collection.js';
import { withErrorHandler } from '../utils/error.js';
import { pageToOffset, parsePositiveInt } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';
import { withPagination } from '../utils/pagination.js';
import { resolveCliStoragePaths } from '../storage/paths.js';
import {
  ensurePrivateDirectory,
  migratePrivateFile,
  secureAtomicWriteFile
} from '../storage/secure-file.js';

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

function parseConfig(content: string): CliConfig {
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
}

function readConfig(): CliConfig {
  const { configPath, legacyConfigPath } = resolveCliStoragePaths();
  let selectedPath = configPath;
  let migrationFailed = false;

  try {
    migratePrivateFile(legacyConfigPath, configPath, (contents) => {
      parseConfig(contents);
    });
  } catch (error) {
    migrationFailed = true;
    selectedPath = legacyConfigPath;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[config] 迁移配置失败，继续使用旧配置: ${message}`);
  }

  try {
    const stat = lstatSync(selectedPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('配置文件不是普通文件');
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(selectedPath, 0o600);
    const config = parseConfig(readFileSync(selectedPath, 'utf8'));

    if (!migrationFailed && selectedPath !== legacyConfigPath) {
      try {
        unlinkSync(legacyConfigPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[config] 清理旧配置失败: ${message}`);
        }
      }
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取配置失败: ${message}`, { cause: error });
  }
}

function writeConfig(config: CliConfig): void {
  const { configPath } = resolveCliStoragePaths();
  ensurePrivateDirectory(path.dirname(configPath));
  secureAtomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function registerUserCommands(program: Command): void {
  program
    .command('user <userId>')
    .helpGroup('收藏与账号:')
    .description('获取指定用户的电影片单')
    .option('--wish', '查看"想看"列表（默认看过）')
    .option('--doing', '查看"在看"列表')
    .option('-p, --page <n>', '页码（从 1 开始）', '1')
    .option('-n, --limit <n>', '每页数量', '15')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler((args) => ({
      command: 'user',
      target: `用户ID: ${String(args[0] || '未指定')}`,
      suggestion: '可尝试：douban-cli user <userId> --wish'
    }), async (userId, opts) => {
      const { status, label: statusLabel } = resolveCollectionStatus(opts);
      const limit = parsePositiveInt(opts.limit, '--limit', 15);
      const page = parsePositiveInt(opts.page, '--page', 1);
      const startForPage = pageToOffset(page, limit);

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
        pageSize: limit,
        fetchPage: async (currentPage) => {
          const start = pageToOffset(currentPage, limit);
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
          const start = pageToOffset(currentPage, limit);
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
    .helpGroup('收藏与账号:')
    .description('设置本地 douban-cli 配置')
    .option('--user <id>', '设置 me 命令默认用户 ID')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'config',
      suggestion: '可尝试：douban-cli config --user <id>'
    }, async (opts) => {
      const current = readConfig();

      if (opts.user !== undefined) {
        const userId = String(opts.user).trim();
        if (!userId) throw new Error('用户 ID 不能为空');
        current.user = userId;
        writeConfig(current);
      }

      if (opts.json) {
        console.log(JSON.stringify(current, null, 2));
      } else {
        console.log(`\n⚙️  配置文件: ${resolveCliStoragePaths().configPath}`);
        if (current.user) {
          console.log(`默认用户 ID: ${current.user}`);
          console.log('可直接运行: douban-cli me');
        } else {
          console.log('默认用户 ID: 未设置');
          console.log('设置方式: douban-cli config --user <用户ID>');
          console.log('用户 ID 可从个人主页 URL /people/xxx/ 中获取');
        }
      }
    }));

  program
    .command('me')
    .helpGroup('收藏与账号:')
    .description('获取配置用户的个人片单')
    .option('--wish', '查看"想看"列表（默认看过）')
    .option('--doing', '查看"在看"列表')
    .option('-n, --limit <n>', '返回数量', '30')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'me',
      suggestion: '可先运行 douban-cli login 或 douban-cli config --user <id>'
    }, async (opts) => {
      const { status, label: statusLabel } = resolveCollectionStatus(opts);
      const config = readConfig();
      let userId = config.user?.trim();
      let auth: VerifiedAuthSession | undefined;

      if (!userId) {
        try {
          auth = await withSpinner('正在识别当前登录用户...', () => ensureAuth(), !opts.json);
          userId = auth.accountId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`本地登录态无法识别当前账号：${message}。请重新运行 douban-cli login 或配置 --user`, {
            cause: error
          });
        }
      }

      const limit = parsePositiveInt(opts.limit, '--limit', 30);
      if (!userId) {
        throw new Error('无法识别当前用户，请先运行 douban-cli login 或 douban-cli config --user <id>');
      }

      const result = await withSpinner(
        `正在获取我的${statusLabel}片单...`,
        () => {
          const options = { kind: 'movie' as const, userId, status, count: limit, pageDelayMs: 1000 };
          return auth ? loadAuthenticatedUserCollectionPage(options, auth.cookies) : getUserCollectionPage(options);
        },
        !opts.json
      );
      const items = result.items;
      result.warnings.forEach((warning) => console.error(warning));
      if (result.partial) process.exitCode = 2;

      if (opts.json) {
        console.log(JSON.stringify({ items, metadata: { userId, partial: result.partial, warnings: result.warnings, total: result.total, limited: result.nextStart !== null, nextStart: result.nextStart } }, null, 2));
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
