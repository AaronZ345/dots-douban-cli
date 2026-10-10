import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { browserEnvironment, chromiumProfileRoots, type BrowserEnvironment, type ChromiumBrowserName } from './browser-platform.js';

export interface CookieDatabase { path: string; profile: string }
export interface BrowserCookieResult {
  cookies: Array<{ name: string; value: string; source: { browser: 'chrome'; profile: string; storeId: string } }>;
  warnings: string[];
}

function isFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/** Resolve only the selected browser and profile; never fall back to Chrome. */
export function resolveCookieDatabases(name: ChromiumBrowserName, profile?: string, target = browserEnvironment()): CookieDatabase[] {
  const p = target.platform === 'win32' ? path.win32 : path.posix;
  const selected = profile?.trim();
  let directories: string[];
  if (selected && (p.isAbsolute(selected) || selected.startsWith('~/') || selected.includes('/') || selected.includes('\\'))) {
    const expanded = selected.startsWith('~/') ? p.join(target.home, selected.slice(2)) : p.resolve(selected);
    if (isFile(expanded)) return [{ path: expanded, profile: p.basename(p.dirname(expanded)) === 'Network'
      ? p.basename(p.dirname(p.dirname(expanded))) : p.basename(p.dirname(expanded)) }];
    directories = [expanded, p.join(expanded, 'Default')];
  } else {
    directories = chromiumProfileRoots(name, target).flatMap(root => {
      const names = new Set([selected || 'Default']);
      if (selected && !existsSync(p.join(root, selected))) {
        try {
          const state = JSON.parse(readFileSync(p.join(root, 'Local State'), 'utf8'));
          for (const [folder, info] of Object.entries(state.profile?.info_cache ?? {})) {
            if (typeof info === 'object' && info && 'name' in info && info.name === selected) names.add(folder);
          }
        } catch { /* A profile directory name works without Local State. */ }
      }
      return [...names].filter(folder => folder !== '.' && folder !== '..' && !folder.includes('/') && !folder.includes('\\'))
        .map(folder => p.join(root, folder)).concat(!selected ? [root] : []);
    });
  }
  const result: CookieDatabase[] = [];
  for (const directory of directories) {
    const found = [p.join(directory, 'Network', 'Cookies'), p.join(directory, 'Cookies')].find(isFile);
    if (found && !result.some(item => item.path === found)) result.push({ path: found, profile: p.basename(directory) });
  }
  return result;
}

export type StorageSecretReader = (command: string, args: string[], timeoutMs: number) => Promise<string | undefined>;
const readStorageSecret: StorageSecretReader = (command, args, timeoutMs) => new Promise(resolve => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    resolve(error ? undefined : stdout.trim() || undefined);
  });
});

export async function chromiumStoragePassword(name: ChromiumBrowserName, target: BrowserEnvironment,
  timeoutMs: number, reader: StorageSecretReader = readStorageSecret): Promise<string | undefined> {
  const brand = { chromium: 'Chromium', chrome: 'Chrome', edge: 'Microsoft Edge', brave: 'Brave',
    arc: 'Arc', vivaldi: 'Vivaldi', opera: 'Opera' }[name];
  const service = `${brand} Safe Storage`;
  if (target.platform === 'darwin') return reader('security', ['find-generic-password', '-w', '-s', service, '-a', brand], timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const read = (command: string, args: string[]) => reader(command, args, Math.max(1, Math.min(3000, deadline - Date.now())));
  const kde = target.env.XDG_CURRENT_DESKTOP?.toLowerCase().split(':').includes('kde') || target.env.KDE_FULL_SESSION === 'true';
  if (kde) {
    const version = target.env.KDE_SESSION_VERSION === '6' ? '6' : target.env.KDE_SESSION_VERSION === '5' ? '5' : '';
    const wallet = await read('dbus-send', ['--session', '--print-reply=literal', `--dest=org.kde.kwalletd${version}`,
      `/modules/kwalletd${version}`, 'org.kde.KWallet.networkWallet']);
    const password = await read('kwallet-query', ['--read-password', service, '--folder', `${brand} Keys`, wallet?.replaceAll('"', '') || 'kdewallet']);
    return password?.toLowerCase().startsWith('failed to read') ? undefined : password;
  }
  const password = await read('secret-tool', ['lookup', 'service', service, 'account', brand]);
  if (password || Date.now() >= deadline) return password;
  return read('secret-tool', ['lookup', 'application', name === 'edge' ? 'msedge' : name]);
}

/** Chromium CBC cookies: Linux v10/basic, Linux v11/keyring, macOS v10/keychain. */
export function decryptChromiumCookie(value: Uint8Array, host: string, schemaVersion: number,
  platform: NodeJS.Platform, password?: string): string | null {
  const data = Buffer.from(value);
  const prefix = data.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  if (platform === 'darwin' && prefix !== 'v10') return null;
  const passwords = platform === 'linux' && prefix === 'v10' ? ['peanuts', ''] : password ? [password] : [];
  for (const secret of passwords) {
    try {
      const key = pbkdf2Sync(secret, 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1');
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      let plaintext = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
      if (schemaVersion >= 24) {
        const hostHash = createHash('sha256').update(host).digest();
        if (!plaintext.subarray(0, 32).equals(hostHash)) continue;
        plaintext = plaintext.subarray(32);
      }
      return plaintext.toString('utf8');
    } catch { /* Try the other documented Linux basic-storage key. */ }
  }
  return null;
}

export async function readChromiumCookies(name: ChromiumBrowserName, profile?: string, timeoutMs = 60000,
  target = browserEnvironment(), secretReader?: StorageSecretReader): Promise<BrowserCookieResult> {
  const result: BrowserCookieResult = { cookies: [], warnings: [] };
  const databases = resolveCookieDatabases(name, profile, target);
  if (!databases.length) return { cookies: [], warnings: [`未找到 ${name} 的 Cookie 数据库；可用 --profile 指定目录，或使用 --launch 登录`] };
  const { DatabaseSync } = await import('node:sqlite');
  let password: string | undefined;
  let passwordRead = false;
  for (const selected of databases) {
    const database = new DatabaseSync(selected.path, { readOnly: true });
    try {
      const version = Number(database.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0);
      const statement = database.prepare("SELECT host_key, name, value, encrypted_value FROM cookies WHERE name IN ('dbcl2', 'ck') AND host_key IN ('.douban.com', 'douban.com', 'www.douban.com') AND path = '/' AND (expires_utc = 0 OR expires_utc > ?)");
      const now = BigInt(Date.now() + 11644473600000) * 1000n;
      for (const row of statement.all(now)) {
        let value = typeof row.value === 'string' && row.value ? row.value : null;
        if (!value && row.encrypted_value instanceof Uint8Array) {
          const prefix = Buffer.from(row.encrypted_value).subarray(0, 3).toString();
          if (!passwordRead && (target.platform === 'darwin' || prefix === 'v11')) {
            password = await chromiumStoragePassword(name, target, timeoutMs, secretReader);
            passwordRead = true;
          }
          value = decryptChromiumCookie(row.encrypted_value, String(row.host_key), version, target.platform, password);
        }
        if (!value) { result.warnings.push('部分豆瓣登录 Cookie 无法解密；请使用 --launch 登录'); continue; }
        result.cookies.push({ name: String(row.name), value,
          source: { browser: 'chrome', profile: selected.profile, storeId: selected.path } });
      }
    } finally { database.close(); }
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
