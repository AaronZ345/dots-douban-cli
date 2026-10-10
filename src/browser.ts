import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type LaunchOptions } from 'playwright';
import type { VerifiedAuthSession } from './auth.js';
import { CliArgumentError } from './utils/error.js';
import { assertBrowserPlatform, findBrowserExecutable, isBrowserExecutable, type LaunchBrowserName } from './browser-platform.js';

export type { LaunchBrowserName } from './browser-platform.js';

export function browserLaunchOptions(name: LaunchBrowserName | 'safari', executable?: string): LaunchOptions {
  assertBrowserPlatform(name, process.platform);
  if (name === 'safari') throw new CliArgumentError('Safari 请使用 login --browser safari 导入已有登录态；自动登录窗口可使用 --browser webkit');
  if (executable) {
    if (!path.isAbsolute(executable) || !isBrowserExecutable(executable)) {
      throw new CliArgumentError('--executable 必须指向存在的浏览器可执行文件绝对路径');
    }
    if (name === 'firefox' || name === 'webkit') throw new CliArgumentError('--executable 仅支持 Chromium 系浏览器');
    return { executablePath: executable };
  }
  if (name === 'firefox' || name === 'webkit') return {};
  const found = findBrowserExecutable(name);
  if (found) return { executablePath: found };
  if (name === 'chrome') return { channel: 'chrome' };
  if (name === 'edge') return { channel: 'msedge' };
  if (name === 'chromium') return {};
  throw new CliArgumentError(`未找到 ${name} 浏览器，请用 --executable 指定程序路径`);
}

export async function launchBrowser(name: LaunchBrowserName | 'safari' = 'chromium', executable?: string, headless = true): Promise<Browser> {
  const engine = name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;
  const launchOptions = browserLaunchOptions(name, executable);
  try {
    return await engine.launch({ ...launchOptions, headless });
  } catch {
    throw new Error('浏览器启动失败；检查程序路径，或运行 npm run install:browsers 安装 Playwright 浏览器');
  }
}

export async function loginInBrowser(name: LaunchBrowserName | 'safari', executable?: string, timeoutSeconds = 180): Promise<VerifiedAuthSession> {
  const browser = await launchBrowser(name, executable, false);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://accounts.douban.com/passport/login', { waitUntil: 'domcontentloaded' });
    console.error(`请在打开的 ${name} 窗口中完成豆瓣登录（${timeoutSeconds} 秒内）。`);
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline && browser.isConnected()) {
      const cookies = await context.cookies('https://www.douban.com/');
      if (cookies.some((cookie) => cookie.name === 'dbcl2' && cookie.value)) {
        const { loginFromSessionCookies } = await import('./auth.js');
        return await loginFromSessionCookies(cookies, `${name} 登录窗口`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('豆瓣登录未完成：窗口已关闭或等待超时');
  } finally {
    await browser.close();
  }
}
