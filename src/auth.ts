import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getCurrentUserProfile } from './api/authenticated.js';
import { secureAtomicWriteFile } from './storage/secure-file.js';

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

const AUTH_CACHE_PATH = path.join(os.homedir(), '.douban-cli-auth.json');
const DOUBAN_LOGIN_URL = 'https://accounts.douban.com/passport/login';

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
  const updatedAt = typeof obj.updatedAt === 'string' && obj.updatedAt.trim() ? obj.updatedAt.trim() : new Date().toISOString();
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

function readAuthCache(): AuthSession | null {
  try {
    const stat = lstatSync(AUTH_CACHE_PATH);
    if (stat.isSymbolicLink()) {
      clearAuthCache();
      return null;
    }
    if (!stat.isFile()) {
      throw new Error('登录缓存不是普通文件');
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(AUTH_CACHE_PATH, 0o600);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 30 * 24 * 60 * 60 * 1000) {
      clearAuthCache();
      return null;
    }

    const raw = JSON.parse(readFileSync(AUTH_CACHE_PATH, 'utf8')) as unknown;
    const parsed = parseEncryptedAuthCache(raw);
    if (!parsed) {
      clearAuthCache();
      return null;
    }

    const session = decryptCache(parsed);
    if (!session) clearAuthCache();
    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    reportRecoverableError('读取登录缓存失败', error);
    try {
      clearAuthCache();
    } catch (clearError) {
      reportRecoverableError('清理无效登录缓存失败', clearError);
    }
    return null;
  }
}

function saveAuthCache(auth: AuthSession): void {
  const encrypted = encryptCache(auth);
  secureAtomicWriteFile(AUTH_CACHE_PATH, `${JSON.stringify(encrypted, null, 2)}\n`);
}

export function clearAuthCache(): void {
  try {
    unlinkSync(AUTH_CACHE_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
    source?: { browser?: BrowserName; profile?: string };
  }>;
  warnings: string[];
}

interface SweetCookieOptions {
  url: string;
  names: string[];
  browsers: BrowserName[];
  mode: 'first';
  chromeProfile?: string;
  edgeProfile?: string;
  firefoxProfile?: string;
}

export type BrowserCookieReader = (options: SweetCookieOptions) => Promise<SweetCookieResult>;

interface BrowserCookieBucket {
  source: string;
  profile?: string;
  dbcl2?: string;
  ck?: string;
}

function reportRecoverableError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth] ${context}: ${message}`);
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
    const key = `${browser}:${profile || ''}`;
    const bucket = grouped.get(key) || {
      source: sourceLabel(browser, profile),
      profile
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

async function loadBrowserCookieReader(): Promise<BrowserCookieReader | null> {
  try {
    const mod = await import('@steipete/sweet-cookie');
    return mod.getCookies as BrowserCookieReader;
  } catch (error) {
    reportRecoverableError('加载 sweet-cookie 失败', error);
    return null;
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
  if (!getCookies) return [];

  const browsers: BrowserName[] = options.browser
    ? [options.browser]
    : ['chrome', 'edge', 'firefox', 'safari'];
  const sessions: AuthSession[] = [];

  for (const browser of browsers) {
    try {
      const result = await getCookies({
        url: 'https://www.douban.com',
        names: ['dbcl2', 'ck'],
        browsers: [browser],
        mode: 'first',
        ...profileOptions(browser, options.profile)
      });
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
    throw new Error(`无法验证本地登录态，已阻止本次操作：${error instanceof Error ? error.message : String(error)}`);
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
