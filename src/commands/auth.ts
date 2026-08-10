import { Command } from 'commander';
import {
  clearAuthCache,
  ensureAuth,
  loginFromCookieFile,
  loginFromCookieStdin,
  loginWithBrowser,
  type AuthSession,
  type BrowserName
} from '../auth.js';
import { CliArgumentError, withErrorHandler } from '../utils/error.js';
import { parsePositiveIntAtMost } from '../utils/parsing.js';
import { withSpinner } from '../utils/spinner.js';

function toSafeSessionJson(session: AuthSession): Record<string, string | undefined> {
  return {
    source: session.source,
    accountId: session.accountId,
    accountName: session.accountName,
    updatedAt: session.updatedAt
  };
}

function parseBrowserName(value: string | undefined): BrowserName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'chrome' || normalized === 'arc' || normalized === 'edge' || normalized === 'firefox' || normalized === 'safari') {
    return normalized;
  }
  throw new Error('--browser 仅支持 chrome、arc、edge、firefox 或 safari');
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .helpGroup('收藏与账号:')
    .description('从浏览器读取，或显式导入豆瓣登录态')
    .option('--browser <browser>', '明确从指定浏览器读取登录态（Arc 仅 macOS）')
    .option('--profile <profile>', '指定浏览器配置目录（需配合 --browser）')
    .option('--cookie-timeout <seconds>', '浏览器 Cookie/钥匙串读取超时（1-300 秒）')
    .option('--open', '打开浏览器的豆瓣当前账号页（不能与 --profile 同用）')
    .option('--cookie-stdin', '从非交互式标准输入读取单行 Cookie 请求头')
    .option('--cookie-file <path>', '从 Netscape cookies.txt 文件读取 Cookie')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'login',
      suggestion: '可尝试：douban login，或显式使用 --cookie-stdin / --cookie-file'
    }, async (opts) => {
      const cookieStdin = Boolean(opts.cookieStdin);
      const cookieFileProvided = typeof opts.cookieFile === 'string';
      const cookieFile = cookieFileProvided ? opts.cookieFile.trim() : undefined;
      if (cookieFileProvided && !cookieFile) throw new CliArgumentError('Cookie 文件路径不能为空');
      if (cookieStdin && cookieFileProvided) {
        throw new CliArgumentError('--cookie-stdin 与 --cookie-file 不能同时使用');
      }

      const manualCookieInput = cookieStdin || cookieFileProvided;
      if (manualCookieInput && (
        opts.browser !== undefined
        || opts.profile !== undefined
        || opts.open
        || opts.cookieTimeout !== undefined
      )) {
        throw new CliArgumentError('手动 Cookie 导入不能与 --browser、--profile、--open 或 --cookie-timeout 同时使用');
      }

      let session: AuthSession;
      if (cookieStdin) {
        session = await loginFromCookieStdin();
      } else if (cookieFile) {
        session = await loginFromCookieFile(cookieFile);
      } else {
        const browser = parseBrowserName(opts.browser);
        const profile = typeof opts.profile === 'string' ? opts.profile.trim() : undefined;
        const cookieTimeoutSeconds = parsePositiveIntAtMost(
          opts.cookieTimeout ?? '60',
          '--cookie-timeout',
          60,
          300
        );
        if (profile && !browser) throw new Error('--profile 必须与 --browser 一起使用');
        if (profile && browser === 'safari') throw new Error('Safari 不支持 --profile');

        session = await loginWithBrowser({
          browser,
          profile,
          cookieTimeoutMs: cookieTimeoutSeconds * 1000,
          open: Boolean(opts.open)
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(toSafeSessionJson(session), null, 2));
        return;
      }

      console.log('\n✅ 登录成功，已保存登录态');
      console.log(`来源: ${session.source}`);
      console.log(`账号: ${session.accountName} (${session.accountId})`);
      console.log(`更新时间: ${session.updatedAt}`);
    }));

  program
    .command('whoami')
    .helpGroup('收藏与账号:')
    .description('显示当前登录用户信息 [需登录]')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'whoami',
      suggestion: '可尝试：douban login 后再运行 douban whoami'
    }, async (opts) => {
      const auth = await withSpinner('正在检查登录状态...', () => ensureAuth(), !opts.json);
      const profile = {
        id: auth.accountId,
        name: auth.accountName,
        url: `https://www.douban.com/people/${auth.accountId}/`
      };

      if (opts.json) {
        console.log(JSON.stringify({
          ...profile,
          source: auth.source,
          updatedAt: auth.updatedAt
        }, null, 2));
        return;
      }

      console.log('\n👤 当前登录用户');
      console.log(`ID: ${profile.id}`);
      console.log(`昵称: ${profile.name}`);
      console.log(`主页: ${profile.url}`);
      console.log(`登录态来源: ${auth.source}`);
    }));

  program
    .command('logout')
    .helpGroup('收藏与账号:')
    .description('清除本地保存的登录态')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'logout',
      suggestion: '可尝试：douban logout'
    }, async (opts) => {
      await withSpinner('正在清理本地登录态...', async () => {
        clearAuthCache();
      }, !opts.json);

      if (opts.json) {
        console.log(JSON.stringify({ ok: true }, null, 2));
      } else {
        console.log('✅ 本地登录态已清除。');
      }
    }));
}
