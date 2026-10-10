import { existsSync, lstatSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
import { resolveCliStoragePaths } from './storage/paths.js';
import { browserLaunchOptions } from './browser.js';

export interface DoctorCheck { name: string; status: 'pass' | 'warn' | 'fail'; message: string }
export interface DoctorReport { ok: boolean; platform: string; checks: DoctorCheck[] }

export async function doctor(options: { online?: boolean; verifyLogin?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'node', status: major > 22 || (major === 22 && minor >= 13) ? 'pass' : 'fail', message: `Node ${process.versions.node}；要求 >=22.13` });
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    checks.push({ name: `browser.${name}`, status: existsSync(engine.executablePath()) ? 'pass' : 'warn', message: existsSync(engine.executablePath()) ? '运行时已安装；启动与站点兼容性须单独验收' : '运行时未安装，可运行 npm run install:browsers' });
  }
  for (const name of ['chrome', 'edge', 'brave', 'arc'] as const) {
    try { browserLaunchOptions(name); checks.push({ name: `adapter.${name}`, status: 'pass', message: '适配入口可用；不代表已完成真实浏览器验收' }); }
    catch { checks.push({ name: `adapter.${name}`, status: 'warn', message: '未自动定位程序；可显式指定 --executable' }); }
  }
  const paths = resolveCliStoragePaths();
  for (const [name, selected] of [['auth-cache', paths.authCachePath], ['configuration', paths.configPath]] as const) {
    if (!existsSync(selected)) { checks.push({ name, status: 'warn', message: '本地文件尚未创建' }); continue; }
    const stat = lstatSync(selected);
    const valid = stat.isFile() && !stat.isSymbolicLink() && (process.platform === 'win32' || (stat.mode & 0o077) === 0);
    checks.push({ name, status: valid ? process.platform === 'win32' ? 'warn' : 'pass' : 'fail', message: valid ? process.platform === 'win32' ? '普通文件；Windows ACL 需在系统侧验证；未读取内容' : '文件类型和权限检查通过；未读取文件内容' : '文件类型或权限异常' });
  }
  if (options.verifyLogin) {
    try { const { ensureAuth } = await import('./auth.js'); await ensureAuth(); checks.push({ name: 'login', status: 'pass', message: '登录校验通过；未输出身份或凭据' }); }
    catch { checks.push({ name: 'login', status: 'fail', message: '登录校验失败，请显式运行 login' }); }
  }
  if (options.online) {
    try {
      const { getTop250 } = await import('./api/movie.js');
      const rows = await getTop250(0, 1);
      if (!rows.length || !rows[0].url || !rows[0].title) throw new Error('schema');
      checks.push({ name: 'public-connectivity', status: 'pass', message: '公开页面网络与解析检查通过' });
    } catch { checks.push({ name: 'public-connectivity', status: 'fail', message: '公开页面无法可靠读取；可使用 --transport browser 或检查站点验证提示' }); }
  }
  return { ok: checks.every((check) => check.status !== 'fail'), platform: process.platform, checks };
}
