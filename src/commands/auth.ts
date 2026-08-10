import { Command } from 'commander';
import {
  clearAuthCache,
  ensureAuth,
  loginWithBrowser,
  type AuthSession,
  type BrowserName
} from '../auth.js';
import { withErrorHandler } from '../utils/error.js';
import { withSpinner } from '../utils/spinner.js';

function maskToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function toSafeSessionJson(session: AuthSession): Record<string, string | undefined> {
  return {
    dbcl2: maskToken(session.dbcl2),
    ck: maskToken(session.ck),
    cookies: undefined,
    source: session.source,
    accountId: session.accountId,
    accountName: session.accountName,
    updatedAt: session.updatedAt
  };
}

function parseBrowserName(value: string | undefined): BrowserName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'chrome' || normalized === 'edge' || normalized === 'firefox' || normalized === 'safari') {
    return normalized;
  }
  throw new Error('--browser 仅支持 chrome、edge、firefox 或 safari');
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('打开浏览器登录豆瓣并保存 Cookie')
    .option('--browser <browser>', '明确从指定浏览器读取登录态')
    .option('--profile <profile>', '指定浏览器配置目录（需配合 --browser）')
    .option('--json', '以 JSON 输出')
    .action(withErrorHandler({
      command: 'login',
      suggestion: '可尝试：douban login'
    }, async (opts) => {
      const browser = parseBrowserName(opts.browser);
      const profile = typeof opts.profile === 'string' ? opts.profile.trim() : undefined;
      if (profile && !browser) throw new Error('--profile 必须与 --browser 一起使用');
      if (profile && browser === 'safari') throw new Error('Safari 不支持 --profile');

      const session = await withSpinner(
        '正在打开浏览器登录豆瓣...',
        () => loginWithBrowser({ browser, profile }),
        !opts.json
      );

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
