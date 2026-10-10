import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stderr as promptOutput } from 'node:process';
import { getCurrentUserProfile } from './api/account.js';
import { resolveCliStoragePaths } from './storage/paths.js';
import {
  ensurePrivateDirectory,
  migratePrivateFile,
  secureAtomicWriteFile
} from './storage/secure-file.js';
import { CliArgumentError } from './utils/error.js';
import { assertBrowserPlatform, browserEnvironment, CHROMIUM_BROWSERS, findBrowserExecutable, type CookieBrowserName } from './browser-platform.js';
import { readChromiumCookies, resolveCookieDatabases } from './browser-cookies.js';

export interface AuthSession {
  dbcl2: string;
  ck?: string;
  cookies: string;
  source: string;
  accountId?: string;
  accountName?: string;
  updatedAt: string;
}

export interface VerifiedAuthSession extends AuthSession {
  accountId: string;
  accountName: string;
}

interface EncryptedAuthCache {
  version: 1 | 2;
  source?: string;
  updatedAt?: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const DOUBAN_ACCOUNT_URL = 'https://www.douban.com/mine/';
const AUTH_CACHE_MAX_BYTES = 64 * 1024;
const AUTH_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_COOKIE_TIMEOUT_MS = 60_000;
const MAX_COOKIE_TIMEOUT_MS = 300_000;
const MAX_COOKIE_STDIN_BYTES = 16 * 1024;
const MAX_COOKIE_FILE_BYTES = 128 * 1024;

export type BrowserName = CookieBrowserName;
type CookieBackendName = 'chrome' | 'edge' | 'firefox' | 'safari';

export interface BrowserCookieTarget {
  backend: CookieBackendName;
  chromiumBrowser?: 'chrome' | 'arc' | 'brave' | 'chromium';
}

export interface LoginOptions {
  browser?: BrowserName;
  profile?: string;
  cookieTimeoutMs?: number;
  open?: boolean;
}

export interface ParsedAuthCookies {
  dbcl2: string;
  ck?: string;
}

export type CookieInputStream = AsyncIterable<Buffer | string> & {
  isTTY?: boolean;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class InvalidAuthCacheError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidAuthCacheError';
  }
}

function normalizeAuthCookieValue(value: string, stripQuotes = false): string | null {
  const trimmed = value.trim();
  const startsWithQuote = trimmed.startsWith('"');
  const endsWithQuote = trimmed.endsWith('"');
  if (stripQuotes && startsWithQuote !== endsWithQuote) return null;

  const normalized = stripQuotes && startsWithQuote
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  const hasInvalidCharacters = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === ';';
  });
  return normalized && !hasInvalidCharacters ? normalized : null;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function addParsedCookie(
  parsed: Partial<ParsedAuthCookies>,
  name: keyof ParsedAuthCookies,
  rawValue: string
): boolean {
  if (parsed[name] !== undefined) return false;
  const value = normalizeAuthCookieValue(rawValue, true);
  if (!value) return false;
  parsed[name] = value;
  return true;
}

/** Parse a Cookie request header and retain only the authentication cookies. */
export function parseCookieHeader(header: string): ParsedAuthCookies | null {
  if (!header || Buffer.byteLength(header, 'utf8') > MAX_COOKIE_STDIN_BYTES) return null;
  const withoutTrailingNewline = header.endsWith('\r\n')
    ? header.slice(0, -2)
    : header.endsWith('\n')
      ? header.slice(0, -1)
      : header;
  if (hasControlCharacters(withoutTrailingNewline)) return null;

  const cleaned = withoutTrailingNewline.trim().replace(/^cookie\s*:\s*/i, '');
  if (!cleaned) return null;

  const parsed: Partial<ParsedAuthCookies> = {};
  for (const rawSegment of cleaned.split(';')) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const separator = segment.indexOf('=');
    if (separator <= 0) return null;
    const name = segment.slice(0, separator).trim();
    if (name !== 'dbcl2' && name !== 'ck') continue;
    if (!addParsedCookie(parsed, name, segment.slice(separator + 1))) return null;
  }

  return parsed.dbcl2
    ? { dbcl2: parsed.dbcl2, ...(parsed.ck ? { ck: parsed.ck } : {}) }
    : null;
}

function isSupportedDoubanCookieScope(value: string, includeSubdomainsValue: string): boolean {
  const rawDomain = value.trim().toLowerCase();
  const domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
  const validLabels = domain.length <= 253 && domain.split('.').every((label) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ));
  if (!validLabels) return false;

  const includeSubdomains = includeSubdomainsValue.trim().toUpperCase();
  if (includeSubdomains !== 'TRUE' && includeSubdomains !== 'FALSE') return false;
  if (domain === 'www.douban.com') return true;
  return domain === 'douban.com' && includeSubdomains === 'TRUE';
}

function isCurrentNetscapeCookie(expires: string): boolean {
  if (!/^\d+$/.test(expires)) return false;
  const timestamp = Number(expires);
  return Number.isSafeInteger(timestamp)
    && (timestamp === 0 || timestamp > Math.floor(Date.now() / 1000));
}

/** Parse a Netscape cookies.txt export and retain valid Douban authentication cookies. */
export function parseNetscapeCookies(contents: string): ParsedAuthCookies | null {
  if (!contents || Buffer.byteLength(contents, 'utf8') > MAX_COOKIE_FILE_BYTES) return null;

  const parsed: Partial<ParsedAuthCookies> = {};
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    const withoutHttpOnlyPrefix = rawLine.replace(/^#HttpOnly_/i, '');
    if (withoutHttpOnlyPrefix.trimStart().startsWith('#')) continue;

    const fields = withoutHttpOnlyPrefix.split('\t');
    if (fields.length !== 7) continue;

    const [domain, includeSubdomains, cookiePath, , expires, rawName, rawValue] = fields;
    const name = rawName?.trim();
    if (name !== 'dbcl2' && name !== 'ck') continue;
    if (!domain || !includeSubdomains || !isSupportedDoubanCookieScope(domain, includeSubdomains)) continue;
    if (cookiePath?.trim() !== '/') continue;
    if (!expires || !isCurrentNetscapeCookie(expires.trim())) continue;
    if (rawValue === undefined || !addParsedCookie(parsed, name, rawValue)) return null;
  }

  return parsed.dbcl2
    ? { dbcl2: parsed.dbcl2, ...(parsed.ck ? { ck: parsed.ck } : {}) }
    : null;
}

function normalizeDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return stripControlCharacters(value) || undefined;
}

function parseEncryptedAuthCache(raw: unknown): EncryptedAuthCache | null {
  const obj = asObject(raw);
  if (!obj) return null;

  if (obj.version !== 1 && obj.version !== 2) return null;

  const source = typeof obj.source === 'string' ? obj.source : '';
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';
  const salt = typeof obj.salt === 'string' ? obj.salt : '';
  const iv = typeof obj.iv === 'string' ? obj.iv : '';
  const tag = typeof obj.tag === 'string' ? obj.tag : '';
  const data = typeof obj.data === 'string' ? obj.data : '';

  if (obj.version === 1 && (!source || !updatedAt)) return null;
  if (!salt || !iv || !tag || !data) return null;

  return {
    version: obj.version,
    ...(obj.version === 1 ? { source, updatedAt } : {}),
    salt,
    iv,
    tag,
    data
  };
}

function parseAuthSession(raw: unknown): AuthSession | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const dbcl2 = typeof obj.dbcl2 === 'string'
    ? normalizeAuthCookieValue(obj.dbcl2, true)
    : null;
  if (!dbcl2) return null;

  const ck = typeof obj.ck === 'string'
    ? normalizeAuthCookieValue(obj.ck) ?? undefined
    : undefined;
  const source = normalizeDisplayText(obj.source) ?? 'Browser';
  const accountId = normalizeDisplayText(obj.accountId);
  const accountName = normalizeDisplayText(obj.accountName);
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

class AuthCacheKeyError extends Error {}

function machineSecret(create: boolean): Buffer {
  const directory = path.dirname(resolveCliStoragePaths().authCachePath);
  const keyPath = path.join(directory, 'cache.key');
  if (create) {
    ensurePrivateDirectory(directory);
    try {
      const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, randomBytes(32)); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let stat;
  try { stat = lstatSync(keyPath); } catch { throw new AuthCacheKeyError('无法读取本地登录缓存密钥，已保留缓存文件'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new AuthCacheKeyError('本地登录缓存密钥文件无效或权限不安全');
  }
  return readFileSync(keyPath);
}

function deriveCacheKey(salt: Buffer, create = false): Buffer {
  const secret = machineSecret(create);
  try {
    return pbkdf2Sync(secret, salt, 120000, 32, 'sha256');
  } finally {
    secret.fill(0);
  }
}

function encryptCache(auth: AuthSession): EncryptedAuthCache {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveCacheKey(salt, true);
  const plaintext = Buffer.from(JSON.stringify(auth), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 2,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64')
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

function decryptCache(payload: EncryptedAuthCache): AuthSession {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = deriveCacheKey(salt);
  let plaintext: Buffer | undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
    const session = parseAuthSession(decoded);
    if (!session) throw new InvalidAuthCacheError('登录缓存内容无效');
    return session;
  } catch (error) {
    if (error instanceof InvalidAuthCacheError) throw error;
    throw new InvalidAuthCacheError('登录缓存无法解密', { cause: error });
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

function decodeAuthCache(contents: string): AuthSession {
  try {
    const raw = JSON.parse(contents) as unknown;
    const parsed = parseEncryptedAuthCache(raw);
    if (!parsed) throw new InvalidAuthCacheError('登录缓存格式无效');
    return decryptCache(parsed);
  } catch (error) {
    if (error instanceof AuthCacheKeyError) throw error;
    if (error instanceof InvalidAuthCacheError) throw error;
    throw new InvalidAuthCacheError('登录缓存不是有效的 JSON', { cause: error });
  }
}

function isExpiredAuthSession(session: AuthSession): boolean {
  const updatedAt = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  const age = Date.now() - updatedAt;
  return age > AUTH_CACHE_MAX_AGE_MS || age < -AUTH_CACHE_CLOCK_SKEW_MS;
}

function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
    if (error instanceof InvalidAuthCacheError) {
      reportRecoverableError('旧登录缓存无效，已忽略', error);
      try {
        unlinkIfExists(storagePaths.legacyAuthCachePath);
      } catch (unlinkError) {
        reportRecoverableError('清理无效旧登录缓存失败', unlinkError);
      }
      return null;
    }
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
    if (stat.size > AUTH_CACHE_MAX_BYTES) {
      throw new InvalidAuthCacheError('登录缓存文件过大');
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(cachePath, 0o600);

    const session = decodeAuthCache(readFileSync(cachePath, 'utf8'));
    if (isExpiredAuthSession(session)) {
      unlinkIfExists(cachePath);
      return null;
    }
    if (!migrationFailed && cachePath !== storagePaths.legacyAuthCachePath) {
      try {
        unlinkIfExists(storagePaths.legacyAuthCachePath);
      } catch (error) {
        reportRecoverableError('清理旧登录缓存失败', error);
      }
    }
    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    reportRecoverableError('读取登录缓存失败', error);
    if (!migrationFailed && error instanceof InvalidAuthCacheError) {
      try {
        unlinkIfExists(cachePath);
        return readAuthCache();
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
      unlinkIfExists(cachePath);
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }

  if (firstError !== undefined) throw firstError;
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

function decodeCookieInput(contents: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch (error) {
    throw new CliArgumentError('Cookie 输入必须是 UTF-8 文本', { cause: error });
  }
}

async function readCookieStdin(stream: CookieInputStream): Promise<Buffer> {
  if (stream.isTTY === true) {
    throw new CliArgumentError('--cookie-stdin 只接受管道或重定向输入；请勿把 Cookie 放在命令行参数或环境变量中');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8');
      totalBytes += buffer.length;
      if (totalBytes > MAX_COOKIE_STDIN_BYTES) {
        buffer.fill(0);
        throw new CliArgumentError(`Cookie 标准输入不能超过 ${MAX_COOKIE_STDIN_BYTES / 1024} KiB`);
      }
      chunks.push(buffer);
    }

    if (totalBytes === 0) throw new CliArgumentError('Cookie 标准输入为空');
    return Buffer.concat(chunks, totalBytes);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readCookieFile(filePath: string): Buffer {
  const selectedPath = filePath.trim();
  if (!selectedPath) throw new CliArgumentError('Cookie 文件路径不能为空');

  const resolvedPath = path.resolve(selectedPath);
  let stat;
  try {
    stat = lstatSync(resolvedPath);
  } catch (error) {
    throw new CliArgumentError('无法读取 Cookie 文件', { cause: error });
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CliArgumentError('Cookie 文件必须是普通文件，不能是符号链接');
  }
  if (stat.size === 0) throw new CliArgumentError('Cookie 文件为空');
  if (stat.size > MAX_COOKIE_FILE_BYTES) {
    throw new CliArgumentError(`Cookie 文件不能超过 ${MAX_COOKIE_FILE_BYTES / 1024} KiB`);
  }

  try {
    return readFileSync(resolvedPath);
  } catch (error) {
    throw new CliArgumentError('无法读取 Cookie 文件', { cause: error });
  }
}

async function verifyAndSaveManualCookies(
  parsed: ParsedAuthCookies,
  source: 'Manual stdin' | 'Manual file'
): Promise<VerifiedAuthSession> {
  const selected = await selectVerifiedSession([
    createSession(parsed.dbcl2, parsed.ck, source)
  ]);
  saveAuthCache(selected);
  return selected;
}

export async function loginFromCookieStdin(
  stream: CookieInputStream = input as CookieInputStream
): Promise<VerifiedAuthSession> {
  const contents = await readCookieStdin(stream);
  try {
    const parsed = parseCookieHeader(decodeCookieInput(contents));
    if (!parsed) {
      throw new CliArgumentError('Cookie 标准输入无效或缺少 dbcl2；请传入单行 Cookie 请求头');
    }
    return await verifyAndSaveManualCookies(parsed, 'Manual stdin');
  } finally {
    contents.fill(0);
  }
}

export function parseBrowserCookieJson(text: string): ParsedAuthCookies | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const entries = Array.isArray(parsed) ? parsed : asObject(parsed)?.cookies;
  if (!Array.isArray(entries)) return null;
  const values = new Map<string, Set<string>>();
  for (const entry of entries) {
    const cookie = asObject(entry);
    if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (cookie.domain.replace(/^\./, '') !== 'douban.com' && cookie.domain !== 'www.douban.com') continue;
    if (cookie.name !== 'dbcl2' && cookie.name !== 'ck') continue;
    if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= Date.now() / 1000) continue;
    const bucket = values.get(cookie.name) ?? new Set<string>();
    bucket.add(cookie.value);
    values.set(cookie.name, bucket);
  }
  if ([...values.values()].some((bucket) => bucket.size !== 1)) return null;
  return parseCookieHeader([...values].map(([name, bucket]) => `${name}=${[...bucket][0]}`).join('; '));
}

export async function loginFromSessionCookies(
  cookies: Array<{ name: string; value: string; domain: string; expires?: number }>,
  source: string
): Promise<VerifiedAuthSession> {
  const parsed = parseBrowserCookieJson(JSON.stringify(cookies));
  if (!parsed) throw new CliArgumentError('浏览器未提供唯一、有效的豆瓣登录态');
  const selected = await selectVerifiedSession([createSession(parsed.dbcl2, parsed.ck, source)]);
  saveAuthCache(selected);
  return selected;
}

export async function loginFromCookieFile(filePath: string): Promise<VerifiedAuthSession> {
  const contents = readCookieFile(filePath);
  try {
    const text = decodeCookieInput(contents);
    const parsed = parseNetscapeCookies(text) ?? parseBrowserCookieJson(text);
    if (!parsed) {
      throw new CliArgumentError('Cookie 文件无效或缺少有效的豆瓣 dbcl2；支持 Netscape cookies.txt、Cookie JSON 或 Playwright storage state');
    }
    return await verifyAndSaveManualCookies(parsed, 'Manual file');
  } finally {
    contents.fill(0);
  }
}

interface SweetCookieResult {
  cookies: Array<{
    name: string;
    value: string;
    source?: { browser?: CookieBackendName; profile?: string; storeId?: string };
  }>;
  warnings: string[];
}

interface SweetCookieOptions {
  url: string;
  names: string[];
  browsers: CookieBackendName[];
  mode: 'first';
  timeoutMs: number;
  chromiumBrowser?: 'chrome' | 'arc' | 'brave' | 'chromium';
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

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
}

function asCookieBackendName(value: unknown): CookieBackendName | undefined {
  return value === 'chrome' || value === 'edge' || value === 'firefox' || value === 'safari'
    ? value
    : undefined;
}

function browserFromStoreId(value: string | undefined): BrowserName | undefined {
  return value === 'arc' || value === 'brave' || value === 'chromium' ? value : undefined;
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
    const browser = asCookieBackendName(rawSource?.browser);
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
  let sanitized = stripControlCharacters(warning);
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
    chromium: 'Chromium',
    brave: 'Brave',
    arc: 'Arc',
    vivaldi: 'Vivaldi',
    opera: 'Opera',
    edge: 'Edge',
    firefox: 'Firefox',
    safari: 'Safari'
  };

  return mapping[lower] || source.charAt(0).toUpperCase() + source.slice(1);
}

function sourceLabel(browser: BrowserName, profile?: string): string {
  const normalized = normalizeBrowserSource(browser);
  const safeProfile = profile ? stripControlCharacters(profile) : '';
  return safeProfile ? `${normalized} (${safeProfile})` : normalized;
}

function validateLoginOptions(options: LoginOptions): void {
  if (options.profile && !options.browser) {
    throw new Error('--profile 必须与 --browser 一起使用');
  }
  if (options.profile && options.browser === 'safari') {
    throw new Error('Safari 不支持 --profile');
  }
  if (options.open && options.profile) {
    throw new Error('--open 无法保证打开指定浏览器 profile，不能与 --profile 一起使用；请先手动打开目标 profile，再不带 --open 重试');
  }
  if (options.cookieTimeoutMs !== undefined
    && (!Number.isInteger(options.cookieTimeoutMs)
      || options.cookieTimeoutMs < 1_000
      || options.cookieTimeoutMs > MAX_COOKIE_TIMEOUT_MS)) {
    throw new Error('Cookie 读取超时必须是 1-300 秒');
  }
}

function profileOptions(browser: BrowserName, profile?: string): Partial<SweetCookieOptions> {
  const selected = profile?.trim();
  if (!selected) return {};
  if (['chrome', 'arc', 'chromium', 'brave', 'vivaldi', 'opera'].includes(browser)) return { chromeProfile: selected };
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

    const browser = browserFromStoreId(cookie.source?.storeId)
      || (cookie.source?.browser === 'chrome' && CHROMIUM_BROWSERS.includes(fallbackBrowser as typeof CHROMIUM_BROWSERS[number]) ? fallbackBrowser : cookie.source?.browser)
      || fallbackBrowser;
    const profile = cookie.source?.profile?.trim() || fallbackProfile?.trim() || undefined;
    const storeId = cookie.source?.storeId?.trim() || undefined;
    const key = `${browser}:${profile || ''}:${storeId || ''}`;
    const bucket = grouped.get(key) || {
      source: sourceLabel(browser, profile),
      profile,
      storeId
    };

    if (cookie.name === 'dbcl2' && !bucket.dbcl2) {
      bucket.dbcl2 = normalizeAuthCookieValue(cookie.value, true) ?? undefined;
    }
    if (cookie.name === 'ck' && !bucket.ck) {
      bucket.ck = normalizeAuthCookieValue(cookie.value) ?? undefined;
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
  validateLoginOptions(options);
  const platform = browserEnvironment().platform;

  const browsers: BrowserName[] = options.browser
    ? [options.browser]
    : [
        'chrome',
        'edge',
        'firefox',
        ...(platform === 'darwin' ? ['safari' as const] : [])
      ];
  const targets = browsers.map((browser) => ({
    browser,
    ...resolveBrowserCookieTarget(browser, platform)
  }));
  const getCookies = reader || await loadBrowserCookieReader();
  const sessions: AuthSession[] = [];

  for (const { browser, backend, chromiumBrowser } of targets) {
    try {
      const chromiumName = CHROMIUM_BROWSERS.find(name => name === browser);
      if (!reader && chromiumName && (platform === 'linux' || (platform === 'darwin' && ['vivaldi', 'opera'].includes(browser)))) {
        const result = await readChromiumCookies(chromiumName, options.profile, options.cookieTimeoutMs);
        reportCookieWarnings(result, browser);
        sessions.push(...sessionsFromCookies(result, browser, options.profile));
        continue;
      }
      const customWindowsProfile = platform === 'win32' && chromiumName && !['chrome', 'edge'].includes(browser);
      const databases = customWindowsProfile ? resolveCookieDatabases(chromiumName, options.profile) : [];
      if (customWindowsProfile && databases.length === 0) throw new Error('未找到指定浏览器的 Cookie 数据库；请使用 --profile 或 --launch');
      for (const database of customWindowsProfile ? databases : [undefined]) {
        const result = parseSweetCookieResult(await getCookies({
          url: 'https://www.douban.com',
          names: ['dbcl2', 'ck'],
          browsers: [backend],
          mode: 'first',
          timeoutMs: options.cookieTimeoutMs ?? DEFAULT_COOKIE_TIMEOUT_MS,
          ...(chromiumBrowser ? { chromiumBrowser } : {}),
          ...profileOptions(browser, database?.path ?? options.profile)
        }));
        reportCookieWarnings(result, browser);
        sessions.push(...sessionsFromCookies(result, browser, options.profile));
      }
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

interface LoginLaunchCommand {
  command: string;
  args: string[];
}

const MAC_BROWSER_BUNDLE_IDS: Record<BrowserName, string> = {
  chrome: 'com.google.Chrome',
  chromium: 'org.chromium.Chromium',
  brave: 'com.brave.Browser',
  arc: 'company.thebrowser.Browser',
  vivaldi: 'com.vivaldi.Vivaldi',
  opera: 'com.operasoftware.Opera',
  edge: 'com.microsoft.edgemac',
  firefox: 'org.mozilla.firefox',
  safari: 'com.apple.Safari'
};

export function resolveBrowserCookieTarget(
  browser: BrowserName,
  platform: NodeJS.Platform
): BrowserCookieTarget {
  assertBrowserPlatform(browser, platform);
  if (browser === 'arc' || browser === 'brave' || browser === 'chromium' || browser === 'vivaldi' || browser === 'opera') {
    return { backend: 'chrome', ...(platform === 'darwin' && browser !== 'vivaldi' && browser !== 'opera' ? { chromiumBrowser: browser } : {}) };
  }

  return {
    backend: browser,
    ...(browser === 'chrome' ? { chromiumBrowser: 'chrome' as const } : {})
  };
}

export function assertInteractiveLogin(isTTY: boolean | undefined): void {
  if (isTTY !== true) {
    throw new Error('douban login 需要交互式终端；请在终端中直接运行，不要通过管道、CI 或后台输入启动');
  }
}

export function browserFromSystemIdentifier(identifier: string): BrowserName | undefined {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('chromium')) return 'chromium';
  if (normalized.includes('brave')) return 'brave';
  if (normalized.includes('vivaldi')) return 'vivaldi';
  if (normalized.includes('opera')) return 'opera';
  if (normalized.includes('company.thebrowser') || normalized.includes('thebrowsercompany.arc') || normalized.startsWith('arc')) return 'arc';
  if (normalized.includes('google.chrome') || normalized.includes('google-chrome') || normalized.includes('chromehtml') || normalized === 'chrome.desktop') return 'chrome';
  if (normalized.includes('microsoft.edge') || normalized.includes('msedge')) return 'edge';
  if (normalized.includes('mozilla.firefox') || normalized.includes('firefox')) return 'firefox';
  if (normalized.includes('apple.safari') || normalized.includes('safari')) return 'safari';
  return undefined;
}

function detectMacDefaultBrowser(): BrowserName {
  const exported = spawnSync(
    'defaults',
    ['export', 'com.apple.LaunchServices/com.apple.launchservices.secure', '-'],
    { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 }
  );
  if (exported.error || exported.status !== 0 || !exported.stdout) {
    throw new Error('无法读取 macOS 默认浏览器设置，请使用 --browser 明确指定');
  }

  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: exported.stdout,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  if (converted.error || converted.status !== 0 || !converted.stdout) {
    throw new Error('无法解析 macOS 默认浏览器设置，请使用 --browser 明确指定');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(converted.stdout) as unknown;
  } catch (error) {
    throw new Error('macOS 默认浏览器设置格式无效，请使用 --browser 明确指定', { cause: error });
  }

  const root = asObject(payload);
  const handlers = Array.isArray(root?.LSHandlers) ? root.LSHandlers : [];
  const httpsHandlers = handlers
    .map(asObject)
    .filter((handler): handler is Record<string, unknown> => handler?.LSHandlerURLScheme === 'https')
    .sort((left, right) => Number(right.LSHandlerModificationDate ?? 0) - Number(left.LSHandlerModificationDate ?? 0));
  const identifier = typeof httpsHandlers[0]?.LSHandlerRoleAll === 'string'
    ? httpsHandlers[0].LSHandlerRoleAll
    : '';
  const browser = browserFromSystemIdentifier(identifier);
  if (!browser) {
    throw new Error(`暂不支持默认浏览器 ${identifier || 'unknown'}，请使用 --browser 明确指定`);
  }
  return browser;
}

function detectDefaultBrowser(): BrowserName {
  if (process.platform === 'darwin') return detectMacDefaultBrowser();

  if (process.platform === 'linux') {
    const result = spawnSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' });
    const browser = !result.error && result.status === 0
      ? browserFromSystemIdentifier(result.stdout)
      : undefined;
    if (browser) return browser;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice").ProgId'
    ], { encoding: 'utf8' });
    const browser = !result.error && result.status === 0
      ? browserFromSystemIdentifier(result.stdout)
      : undefined;
    if (browser) return browser;
  }

  throw new Error('无法识别系统默认浏览器，请使用 --browser 明确指定');
}

export function resolveLoginLaunchCommand(
  platform: NodeJS.Platform,
  browser?: BrowserName
): LoginLaunchCommand {
  if (platform === 'darwin') {
    return {
      command: 'open',
      args: browser
        ? ['-b', MAC_BROWSER_BUNDLE_IDS[browser], DOUBAN_ACCOUNT_URL]
        : [DOUBAN_ACCOUNT_URL]
    };
  }

  if (platform === 'linux') {
    const commands: Partial<Record<BrowserName, string>> = {
      chrome: 'google-chrome',
      chromium: 'chromium',
      brave: 'brave-browser',
      vivaldi: 'vivaldi',
      opera: 'opera',
      edge: 'microsoft-edge',
      firefox: 'firefox'
    };
    const command = browser && browser !== 'safari' ? findBrowserExecutable(browser, { ...browserEnvironment(), platform }) ?? commands[browser] : undefined;
    if (browser && !command) {
      throw new Error(`当前平台暂不支持自动打开 ${normalizeBrowserSource(browser)}`);
    }
    return command
      ? { command, args: [DOUBAN_ACCOUNT_URL] }
      : { command: 'xdg-open', args: [DOUBAN_ACCOUNT_URL] };
  }

  if (platform === 'win32') {
    const commands: Partial<Record<BrowserName, string>> = {
      chrome: 'chrome',
      chromium: 'chromium',
      brave: 'brave',
      arc: 'Arc',
      vivaldi: 'vivaldi',
      opera: 'opera',
      edge: 'msedge',
      firefox: 'firefox'
    };
    const command = browser && browser !== 'safari' ? findBrowserExecutable(browser, { ...browserEnvironment(), platform }) ?? commands[browser] : undefined;
    if (browser && !command) {
      throw new Error(`当前平台暂不支持自动打开 ${normalizeBrowserSource(browser)}`);
    }
    return command ? { command, args: [DOUBAN_ACCOUNT_URL] }
      : { command: 'cmd', args: ['/c', 'start', '', DOUBAN_ACCOUNT_URL] };
  }

  throw new Error('当前平台暂不支持自动打开浏览器登录流程');
}

function openLoginPage(options: LoginOptions): void {
  const { command, args } = resolveLoginLaunchCommand(process.platform, options.browser);

  const opened = spawnSync(command, args, { stdio: 'ignore' });
  if (opened.error || opened.status !== 0) {
    const message = opened.error?.message || `exit code ${opened.status ?? 'unknown'}`;
    throw new Error(`打开浏览器失败: ${message}`);
  }
}

async function waitForEnter(browser: BrowserName, profile: string | undefined, opened: boolean): Promise<void> {
  assertInteractiveLogin(input.isTTY);
  const rl = readline.createInterface({ input, output: promptOutput });
  const source = sourceLabel(browser, profile);
  const preparation = opened
    ? `已打开 ${source} 的豆瓣当前账号页；该窗口仅用于完成登录。CLI 将从 ${source} 读取 Cookie，并以验证到的豆瓣账号为准。`
    : `将从 ${source} 读取 Cookie 并验证豆瓣账号；本命令默认不启动浏览器，如需打开账号页请按 Ctrl+C 后运行 douban login --open。`;
  try {
    await rl.question(`${preparation}确认已登录后按回车；若 macOS 随后请求访问浏览器 Safe Storage，请选择允许...`);
  } finally {
    rl.close();
  }
}

async function verifyAuthSession(session: AuthSession): Promise<VerifiedAuthSession> {
  const profile = await getCurrentUserProfile(session.cookies);
  const accountId = stripControlCharacters(profile.id);
  const accountName = stripControlCharacters(profile.name);
  if (!accountId || !accountName) {
    throw new Error('豆瓣账号信息无效');
  }
  return {
    ...session,
    accountId,
    accountName
  };
}

async function selectVerifiedSession(candidates: AuthSession[]): Promise<VerifiedAuthSession> {
  const verified: VerifiedAuthSession[] = [];
  const failures: Array<{ source: string; error: unknown }> = [];

  for (const candidate of candidates) {
    try {
      verified.push(await verifyAuthSession(candidate));
    } catch (error) {
      failures.push({ source: candidate.source, error });
    }
  }

  if (verified.length === 0) {
    const firstFailure = failures[0]?.error;
    if (failures.length === 1) {
      throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure));
    }
    throw new Error('未找到可验证的豆瓣登录态，请确认登录完成后重试', {
      cause: firstFailure instanceof Error ? firstFailure : undefined
    });
  }

  if (candidates.length > 1 && failures.length > 0) {
    throw new Error(`部分浏览器登录态无法验证（${failures.map(({ source }) => source).join(', ')}），请使用 --browser 并按需配合 --profile 明确选择`, {
      cause: failures[0]?.error instanceof Error ? failures[0].error : undefined
    });
  }

  const accounts = new Map<string, VerifiedAuthSession[]>();
  for (const session of verified) {
    const accountId = session.accountId;
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
): Promise<VerifiedAuthSession> {
  const candidates = await extractFromBrowsers(options, reader);
  const selected = await selectVerifiedSession(candidates);
  saveAuthCache(selected);
  return selected;
}

export async function loginWithBrowser(options: LoginOptions = {}): Promise<VerifiedAuthSession> {
  validateLoginOptions(options);
  assertInteractiveLogin(input.isTTY);

  const selectedBrowser = options.browser ?? detectDefaultBrowser();
  if (options.open) openLoginPage(options);
  await waitForEnter(selectedBrowser, options.profile, Boolean(options.open));
  return loginFromBrowserCookies({ ...options, browser: selectedBrowser });
}

export async function detectAuthSession(): Promise<AuthSession | null> {
  return readAuthCache();
}

export async function ensureAuth(): Promise<VerifiedAuthSession> {
  const cached = readAuthCache();
  if (!cached) {
    throw new Error('未找到本地登录态，请先运行 douban login');
  }

  let verified: VerifiedAuthSession;
  try {
    verified = await verifyAuthSession(cached);
  } catch (error) {
    throw new Error(`无法验证本地登录态，已阻止本次操作：${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }

  if (cached.accountId && cached.accountId !== verified.accountId) {
    clearAuthCache();
    throw new Error(`登录账号校验失败：缓存账号 ${cached.accountId}，当前账号 ${verified.accountId}。请重新运行 douban login`);
  }

  if (cached.accountId !== verified.accountId || cached.accountName !== verified.accountName) {
    saveAuthCache(verified);
  }
  return verified;
}
