import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getCurrentUserProfile } from './api/authenticated.js';
import { resolveCliStoragePaths } from './storage/paths.js';
import {
  ensurePrivateDirectory,
  migratePrivateFile,
  secureAtomicWriteFile
} from './storage/secure-file.js';

export interface AuthSession {
  dbcl2: string;
  ck?: string;
  cookies: string;
  source: string;
  accountId?: string;
  accountName?: string;
  updatedAt: string;
}

interface EncryptedAuthCache {
  version: 1;
  source: string;
  updatedAt: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const DOUBAN_LOGIN_URL = 'https://accounts.douban.com/passport/login';
const AUTH_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari';

export interface LoginOptions {
  browser?: BrowserName;
  profile?: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseEncryptedAuthCache(raw: unknown): EncryptedAuthCache | null {
  const obj = asObject(raw);
  if (!obj) return null;

  if (obj.version !== 1) return null;

  const source = typeof obj.source === 'string' ? obj.source : '';
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';
  const salt = typeof obj.salt === 'string' ? obj.salt : '';
  const iv = typeof obj.iv === 'string' ? obj.iv : '';
  const tag = typeof obj.tag === 'string' ? obj.tag : '';
  const data = typeof obj.data === 'string' ? obj.data : '';

  if (!source || !updatedAt || !salt || !iv || !tag || !data) return null;

  return {
    version: 1,
    source,
    updatedAt,
    salt,
    iv,
    tag,
    data
  };
}

function parseAuthSession(raw: unknown): AuthSession | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const dbcl2 = typeof obj.dbcl2 === 'string' ? obj.dbcl2.trim() : '';
  if (!dbcl2) return null;

  const ck = typeof obj.ck === 'string' && obj.ck.trim() ? obj.ck.trim() : undefined;
  const source = typeof obj.source === 'string' && obj.source.trim() ? obj.source.trim() : 'Browser';
  const accountId = typeof obj.accountId === 'string' && obj.accountId.trim() ? obj.accountId.trim() : undefined;
  const accountName = typeof obj.accountName === 'string' && obj.accountName.trim() ? obj.accountName.trim() : undefined;
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt.trim() : '';
  if (!updatedAt) return null;
  const cookies = buildCookieHeader(dbcl2, ck);

  return {
    dbcl2,
    ck,
    cookies,
    source,
    accountId,
    accountName,
    updatedAt
  };
}

function machineSecret(): Buffer {
  const payload = `${os.userInfo().username}|${os.hostname()}|${os.homedir()}|douban-cli`;
  return createHash('sha256').update(payload).digest();
}

function encryptCache(auth: AuthSession): EncryptedAuthCache {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(machineSecret(), salt, 120000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(auth), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    source: auth.source,
    updatedAt: auth.updatedAt,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptCache(payload: EncryptedAuthCache): AuthSession | null {
  try {
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const data = Buffer.from(payload.data, 'base64');
    const key = pbkdf2Sync(machineSecret(), salt, 120000, 32, 'sha256');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
    return parseAuthSession(decoded);
  } catch (error) {
    reportRecoverableError('解密登录缓存失败', error);
    return null;
  }
}

function decodeAuthCache(contents: string): AuthSession {
  const raw = JSON.parse(contents) as unknown;
  const parsed = parseEncryptedAuthCache(raw);
  if (!parsed) throw new Error('登录缓存格式无效');

  const session = decryptCache(parsed);
  if (!session) throw new Error('登录缓存无法解密');
  return session;
}

function isExpiredAuthSession(session: AuthSession): boolean {
  const updatedAt = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  const age = Date.now() - updatedAt;
  return age > AUTH_CACHE_MAX_AGE_MS || age < -AUTH_CACHE_CLOCK_SKEW_MS;
}

function readAuthCache(): AuthSession | null {
  const storagePaths = resolveCliStoragePaths();
  let cachePath = storagePaths.authCachePath;
  let migrationFailed = false;

  try {
    migratePrivateFile(
      storagePaths.legacyAuthCachePath,
      storagePaths.authCachePath,
      (contents) => {
        decodeAuthCache(contents);
      }
    );
  } catch (error) {
    migrationFailed = true;
    cachePath = storagePaths.legacyAuthCachePath;
    reportRecoverableError('迁移登录缓存失败，继续使用旧缓存', error);
  }

  try {
    const stat = lstatSync(cachePath);
    if (stat.isSymbolicLink()) {
      throw new Error('登录缓存不能是符号链接');
    }
    if (!stat.isFile()) {
      throw new Error('登录缓存不是普通文件');
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(cachePath, 0o600);

    const session = decodeAuthCache(readFileSync(cachePath, 'utf8'));
    if (isExpiredAuthSession(session)) {
      clearAuthCache();
      return null;
    }
    if (!migrationFailed && cachePath !== storagePaths.legacyAuthCachePath) {
      try {
        unlinkSync(storagePaths.legacyAuthCachePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          reportRecoverableError('清理旧登录缓存失败', error);
        }
      }
    }
    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    reportRecoverableError('读取登录缓存失败', error);
    if (!migrationFailed) {
      try {
        clearAuthCache();
      } catch (clearError) {
        reportRecoverableError('清理无效登录缓存失败', clearError);
      }
    }
    return null;
  }
}

function saveAuthCache(auth: AuthSession): void {
  const { authCachePath } = resolveCliStoragePaths();
  const encrypted = encryptCache(auth);
  ensurePrivateDirectory(path.dirname(authCachePath));
  secureAtomicWriteFile(authCachePath, `${JSON.stringify(encrypted, null, 2)}\n`);
}

export function clearAuthCache(): void {
  const { authCachePath, legacyAuthCachePath } = resolveCliStoragePaths();
  let firstError: unknown;

  for (const cachePath of new Set([authCachePath, legacyAuthCachePath])) {
    try {
      unlinkSync(cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && firstError === undefined) {
        firstError = error;
      }
    }
  }

  if (firstError !== undefined) throw firstError;
}

export function getCachedAuthSession(clear = false): AuthSession | null {
  const cached = readAuthCache();
  if (clear) clearAuthCache();
  return cached;
}

function buildCookieHeader(dbcl2: string, ck?: string): string {
  const parts = [`dbcl2=${dbcl2}`];
  if (ck) parts.push(`ck=${ck}`);
  return parts.join('; ');
}

function createSession(dbcl2: string, ck: string | undefined, source: string): AuthSession {
  return {
    dbcl2,
    ck,
    cookies: buildCookieHeader(dbcl2, ck),
    source,
    updatedAt: new Date().toISOString()
  };
}

interface SweetCookieResult {
  cookies: Array<{
    name: string;
    value: string;
    source?: { browser?: BrowserName; profile?: string; storeId?: string };
  }>;
  warnings: string[];
}

interface SweetCookieOptions {
  url: string;
  names: string[];
  browsers: BrowserName[];
  mode: 'first';
  chromiumBrowser?: 'chrome';
  chromeProfile?: string;
  edgeProfile?: string;
  firefoxProfile?: string;
}

export type BrowserCookieReader = (options: SweetCookieOptions) => Promise<SweetCookieResult>;

interface BrowserCookieBucket {
  source: string;
  profile?: string;
  storeId?: string;
  dbcl2?: string;
  ck?: string;
}

function reportRecoverableError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth] ${context}: ${message}`);
}

function asBrowserName(value: unknown): BrowserName | undefined {
  return value === 'chrome' || value === 'edge' || value === 'firefox' || value === 'safari'
    ? value
    : undefined;
}

function parseSweetCookieResult(value: unknown): SweetCookieResult {
  const result = asObject(value);
  if (!result || !Array.isArray(result.cookies) || !Array.isArray(result.warnings)) {
    throw new Error('sweet-cookie 返回了无效结果');
  }

  const cookies: SweetCookieResult['cookies'] = result.cookies.map((value) => {
    const cookie = asObject(value);
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      throw new Error('sweet-cookie 返回了无效 Cookie');
    }

    const rawSource = asObject(cookie.source);
    const browser = asBrowserName(rawSource?.browser);
    const source = browser
      ? {
          browser,
          profile: typeof rawSource?.profile === 'string' ? rawSource.profile : undefined,
          storeId: typeof rawSource?.storeId === 'string' ? rawSource.storeId : undefined
        }
      : undefined;
    return { name: cookie.name, value: cookie.value, source };
  });

  const warnings = result.warnings.map((warning) => {
    if (typeof warning !== 'string') throw new Error('sweet-cookie 返回了无效警告');
    return warning;
  });
  return { cookies, warnings };
}

function sanitizeCookieWarning(warning: string, cookies: SweetCookieResult['cookies']): string {
  let sanitized = [...warning]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
  const secrets = new Set<string>();

  for (const cookie of cookies) {
    if (cookie.name !== 'dbcl2' && cookie.name !== 'ck') continue;
    if (cookie.value) secrets.add(cookie.value);
    const unquoted = cookie.value.replace(/^"|"$/g, '');
    if (unquoted) secrets.add(unquoted);
  }
  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized;
}

function reportCookieWarnings(result: SweetCookieResult, browser: BrowserName): void {
  for (const warning of result.warnings) {
    const sanitized = sanitizeCookieWarning(warning, result.cookies);
    if (sanitized) console.error(`[auth] ${normalizeBrowserSource(browser)} Cookie 提示: ${sanitized}`);
  }
}

function normalizeBrowserSource(source: string): string {
  const lower = source.trim().toLowerCase();
  if (!lower) return 'Browser';

  const mapping: Record<string, string> = {
    chrome: 'Chrome',
    edge: 'Edge',
    firefox: 'Firefox',
    safari: 'Safari'
  };

  return mapping[lower] || source.charAt(0).toUpperCase() + source.slice(1);
}

function sourceLabel(browser: BrowserName, profile?: string): string {
  const normalized = normalizeBrowserSource(browser);
  return profile?.trim() ? `${normalized} (${profile.trim()})` : normalized;
}

function profileOptions(browser: BrowserName, profile?: string): Partial<SweetCookieOptions> {
  const selected = profile?.trim();
  if (!selected) return {};
  if (browser === 'chrome') return { chromeProfile: selected };
  if (browser === 'edge') return { edgeProfile: selected };
  if (browser === 'firefox') return { firefoxProfile: selected };
  return {};
}

function sessionsFromCookies(
  result: SweetCookieResult,
  fallbackBrowser: BrowserName,
  fallbackProfile?: string
): AuthSession[] {
  const grouped = new Map<string, BrowserCookieBucket>();

  for (const cookie of result.cookies) {
    if (!cookie?.name || typeof cookie.value !== 'string') continue;
    if (cookie.name !== 'dbcl2' && cookie.name !== 'ck') continue;

    const browser = cookie.source?.browser || fallbackBrowser;
    const profile = cookie.source?.profile?.trim() || fallbackProfile?.trim() || undefined;
    const storeId = cookie.source?.storeId?.trim() || undefined;
    const key = `${browser}:${profile || ''}:${storeId || ''}`;
    const bucket = grouped.get(key) || {
      source: sourceLabel(browser, profile),
      profile,
      storeId
    };

    if (cookie.name === 'dbcl2' && !bucket.dbcl2) {
      bucket.dbcl2 = cookie.value.replace(/^"|"$/g, '').trim();
    }
    if (cookie.name === 'ck' && !bucket.ck) {
      bucket.ck = cookie.value.trim();
    }

    grouped.set(key, bucket);
  }

  return [...grouped.values()]
    .filter((bucket): bucket is BrowserCookieBucket & { dbcl2: string } => Boolean(bucket.dbcl2))
    .map((bucket) => createSession(bucket.dbcl2, bucket.ck, bucket.source));
}

async function loadBrowserCookieReader(): Promise<BrowserCookieReader> {
  try {
    const mod = await import('@steipete/sweet-cookie');
    if (typeof mod.getCookies !== 'function') {
      throw new Error('sweet-cookie 未导出 getCookies 函数');
    }
    return mod.getCookies as BrowserCookieReader;
  } catch (error) {
    throw new Error(`加载浏览器 Cookie 组件失败: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

async function extractFromBrowsers(
  options: LoginOptions = {},
  reader?: BrowserCookieReader
): Promise<AuthSession[]> {
  if (options.profile && !options.browser) {
    throw new Error('--profile 必须与 --browser 一起使用');
  }
  if (options.profile && options.browser === 'safari') {
    throw new Error('Safari 不支持 --profile');
  }

  const getCookies = reader || await loadBrowserCookieReader();

  const browsers: BrowserName[] = options.browser
    ? [options.browser]
    : ['chrome', 'edge', 'firefox', 'safari'];
  const sessions: AuthSession[] = [];

  for (const browser of browsers) {
    try {
      const result = parseSweetCookieResult(await getCookies({
        url: 'https://www.douban.com',
        names: ['dbcl2', 'ck'],
        browsers: [browser],
        mode: 'first',
        ...(browser === 'chrome' ? { chromiumBrowser: 'chrome' as const } : {}),
        ...profileOptions(browser, options.profile)
      }));
      reportCookieWarnings(result, browser);
      sessions.push(...sessionsFromCookies(result, browser, options.profile));
    } catch (error) {
      reportRecoverableError(`从 ${normalizeBrowserSource(browser)} 提取 Cookie 失败`, error);
    }
  }

  const deduped = new Map<string, AuthSession>();
  for (const session of sessions) {
    const key = `${session.source}:${session.dbcl2}`;
    if (!deduped.has(key)) deduped.set(key, session);
  }
  return [...deduped.values()];
}

function openLoginPage(): void {
  let command: string;
  let args: string[];

  if (process.platform === 'darwin') {
    command = 'open';
    args = [DOUBAN_LOGIN_URL];
  } else if (process.platform === 'linux') {
    command = 'xdg-open';
    args = [DOUBAN_LOGIN_URL];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', DOUBAN_LOGIN_URL];
  } else {
    throw new Error('当前平台暂不支持自动打开浏览器登录流程');
  }

  const opened = spawnSync(command, args, { stdio: 'ignore' });
  if (opened.error || opened.status !== 0) {
    const message = opened.error?.message || `exit code ${opened.status ?? 'unknown'}`;
    throw new Error(`打开浏览器失败: ${message}`);
  }
}

async function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('完成豆瓣登录后，按回车继续提取 Cookie...');
  } finally {
    rl.close();
  }
}

async function verifyAuthSession(session: AuthSession): Promise<AuthSession> {
  const profile = await getCurrentUserProfile(session.cookies);
  return {
    ...session,
    accountId: profile.id,
    accountName: profile.name
  };
}

async function selectVerifiedSession(candidates: AuthSession[]): Promise<AuthSession> {
  const verified: AuthSession[] = [];
  const failedSources: string[] = [];

  for (const candidate of candidates) {
    try {
      verified.push(await verifyAuthSession(candidate));
    } catch (error) {
      failedSources.push(candidate.source);
      reportRecoverableError(`验证 ${candidate.source} 登录态失败`, error);
    }
  }

  if (verified.length === 0) {
    throw new Error('未找到可验证的豆瓣登录态，请确认登录完成后重试');
  }

  if (candidates.length > 1 && failedSources.length > 0) {
    throw new Error(`部分浏览器登录态无法验证（${failedSources.join(', ')}），请使用 --browser 并按需配合 --profile 明确选择`);
  }

  const accounts = new Map<string, AuthSession[]>();
  for (const session of verified) {
    const accountId = session.accountId || '';
    const bucket = accounts.get(accountId) || [];
    bucket.push(session);
    accounts.set(accountId, bucket);
  }

  if (accounts.size > 1) {
    const choices = verified
      .map((session) => `${session.source}: ${session.accountId}`)
      .join(', ');
    throw new Error(`检测到多个豆瓣账号（${choices}），请使用 --browser 并按需配合 --profile 明确选择`);
  }

  return verified[0];
}

export async function loginFromBrowserCookies(
  options: LoginOptions = {},
  reader?: BrowserCookieReader
): Promise<AuthSession> {
  const candidates = await extractFromBrowsers(options, reader);
  const selected = await selectVerifiedSession(candidates);
  saveAuthCache(selected);
  return selected;
}

export async function loginWithBrowser(options: LoginOptions = {}): Promise<AuthSession> {
  if (options.profile && !options.browser) {
    throw new Error('--profile 必须与 --browser 一起使用');
  }
  if (options.profile && options.browser === 'safari') {
    throw new Error('Safari 不支持 --profile');
  }

  openLoginPage();
  await waitForEnter();
  return loginFromBrowserCookies(options);
}

export async function detectAuthSession(): Promise<AuthSession | null> {
  return readAuthCache();
}

export async function ensureAuth(): Promise<AuthSession> {
  const cached = readAuthCache();
  if (!cached) {
    throw new Error('未找到本地登录态，请先运行 douban login');
  }

  let verified: AuthSession;
  try {
    verified = await verifyAuthSession(cached);
  } catch (error) {
    throw new Error(`无法验证本地登录态，已阻止本次操作：${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }

  if (cached.accountId && cached.accountId !== verified.accountId) {
    clearAuthCache();
    throw new Error(`登录账号校验失败：缓存账号 ${cached.accountId}，当前账号 ${verified.accountId || 'unknown'}。请重新运行 douban login`);
  }

  if (cached.accountId !== verified.accountId || cached.accountName !== verified.accountName) {
    saveAuthCache(verified);
  }
  return verified;
}
