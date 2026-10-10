import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type LaunchOptions } from 'playwright';
import type { BrowserName, VerifiedAuthSession } from './auth.js';
import { CliArgumentError } from './utils/error.js';

export type LaunchBrowserName = BrowserName | 'webkit';

export function browserLaunchOptions(name: LaunchBrowserName, executable?: string): LaunchOptions {
  if (name === 'safari') throw new CliArgumentError('Safari 请使用 login --browser safari 导入已有登录态；自动登录窗口可使用 --browser webkit');
  if (executable) {
    if (!path.isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) {
      throw new CliArgumentError('--executable 必须指向存在的浏览器可执行文件绝对路径');
    }
    if (name === 'firefox' || name === 'webkit') throw new CliArgumentError('--executable 仅支持 Chromium 系浏览器');
    return { executablePath: executable };
  }
  if (name === 'chrome') return { channel: 'chrome' };
  if (name === 'edge') return { channel: 'msedge' };
  if (name === 'firefox' || name === 'webkit') return {};
  const mac: Partial<Record<LaunchBrowserName, string>> = {
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    arc: '/Applications/Arc.app/Contents/MacOS/Arc'
  };
  const linux: Partial<Record<LaunchBrowserName, string[]>> = {
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave-browser-stable']
  };
  const windows: Partial<Record<LaunchBrowserName, string[]>> = {
    chromium: [path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Chromium', 'Application', 'chrome.exe')],
    brave: [path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
  };
  const candidates = process.platform === 'darwin' ? [mac[name]] : process.platform === 'win32' ? windows[name] ?? [] : linux[name] ?? [];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (found) return { executablePath: found };
  if (name === 'chromium') return {};
  throw new CliArgumentError(`未找到 ${name} 浏览器，请用 --executable 指定程序路径`);
}

export async function launchBrowser(name: LaunchBrowserName = 'chromium', executable?: string, headless = true): Promise<Browser> {
  const engine = name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;
  try {
    return await engine.launch({ ...browserLaunchOptions(name, executable), headless });
  } catch {
    throw new Error('浏览器启动失败；检查程序路径，或运行 npm run install:browsers 安装 Playwright 浏览器');
  }
}

export async function loginInBrowser(name: LaunchBrowserName, executable?: string, timeoutSeconds = 180): Promise<VerifiedAuthSession> {
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
