import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome = '';
let originalHome: string | undefined;
let originalCliHome: string | undefined;
const originalStdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function authCachePath(): string {
  return path.join(tempHome, 'storage', 'auth.json');
}

function legacyAuthCachePath(): string {
  return path.join(tempHome, '.douban-cli-auth.json');
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalCliHome = process.env.DOUBAN_CLI_HOME;
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-auth-'));
  process.env.HOME = tempHome;
  process.env.DOUBAN_CLI_HOME = path.join(tempHome, 'storage');
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCliHome === undefined) delete process.env.DOUBAN_CLI_HOME;
  else process.env.DOUBAN_CLI_HOME = originalCliHome;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('@steipete/sweet-cookie');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:readline/promises');
  if (originalStdinIsTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.resetModules();
  rmSync(tempHome, { recursive: true, force: true });
});

function profileHtml(id: string, name: string): string {
  return `<title>${name}</title><a class="lnk-mine" href="https://www.douban.com/people/${id}/">${name}</a>`;
}

describe.sequential('authentication safety', () => {
  it('ensureAuth uses only the local cache and never scans browsers implicitly', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    await expect(auth.ensureAuth()).rejects.toThrow('请先运行 douban login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads only auth cookies from one explicit browser profile and stores account identity privately', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'dbcl2', value: '"browser-secret"', source: { browser: 'chrome', profile: 'Profile 2' } },
        { name: 'ck', value: 'csrf-secret', source: { browser: 'chrome', profile: 'Profile 2' } },
        { name: 'bid', value: 'must-not-be-used', source: { browser: 'chrome', profile: 'Profile 2' } }
      ],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');

    const session = await auth.loginFromBrowserCookies(
      { browser: 'chrome', profile: 'Profile 2' },
      reader
    );

    expect(reader).toHaveBeenCalledWith(expect.objectContaining({
      names: ['dbcl2', 'ck'],
      browsers: ['chrome'],
      mode: 'first',
      timeoutMs: 60_000,
      chromiumBrowser: 'chrome',
      chromeProfile: 'Profile 2'
    }));
    expect(session).toMatchObject({
      source: 'Chrome (Profile 2)',
      accountId: 'alice',
      accountName: 'Alice'
    });

    const cachePath = authCachePath();
    const cacheText = readFileSync(cachePath, 'utf8');
    const cachePayload = JSON.parse(cacheText) as Record<string, unknown>;
    expect(cacheText).not.toContain('browser-secret');
    expect(cacheText).not.toContain('csrf-secret');
    expect(cachePayload).toMatchObject({ version: 2 });
    expect(cachePayload).not.toHaveProperty('source');
    expect(cachePayload).not.toHaveProperty('updatedAt');
    expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(cachePath)).mode & 0o777).toBe(0o700);
  });

  it('allows a longer browser cookie helper timeout', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'browser-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');

    await auth.loginFromBrowserCookies({ browser: 'chrome', cookieTimeoutMs: 120_000 }, reader);

    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it('opens a browser only when explicitly requested', async () => {
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });
    const question = vi.fn().mockResolvedValue('');
    const close = vi.fn();
    const getCookies = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'browser-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.doMock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
    vi.doMock('node:readline/promises', () => ({
      default: { createInterface: () => ({ question, close }) }
    }));
    vi.doMock('@steipete/sweet-cookie', () => ({ getCookies }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const auth = await import('../auth.ts');

    await auth.loginWithBrowser({ browser: 'chrome' });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(getCookies).toHaveBeenCalledOnce();
    expect(question).toHaveBeenCalledWith(expect.stringContaining('将从 Chrome 读取 Cookie 并验证豆瓣账号'));
    expect(question).toHaveBeenCalledWith(expect.stringContaining('douban login --open'));

    await auth.loginWithBrowser({ browser: 'chrome', open: true });

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(getCookies).toHaveBeenCalledTimes(2);
    expect(question.mock.calls[1]?.[0]).toContain('该窗口仅用于完成登录');
    expect(question.mock.calls[1]?.[0]).toContain('以验证到的豆瓣账号为准');
  });

  it('rejects browser opening with an explicit profile before any side effects', async () => {
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });
    const question = vi.fn().mockResolvedValue('');
    const close = vi.fn();
    const getCookies = vi.fn();
    vi.doMock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
    vi.doMock('node:readline/promises', () => ({
      default: { createInterface: () => ({ question, close }) }
    }));
    vi.doMock('@steipete/sweet-cookie', () => ({ getCookies }));
    const auth = await import('../auth.ts');

    await expect(auth.loginWithBrowser({
      browser: 'chrome',
      profile: 'Profile 2',
      open: true
    })).rejects.toThrow('--open 无法保证打开指定浏览器 profile');

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
    expect(getCookies).not.toHaveBeenCalled();
  });

  it('advertises browser opening as an opt-in login flag', async () => {
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    const login = program.commands.find((command) => command.name() === 'login');

    expect(login?.options.map((option) => option.long)).toContain('--open');
    expect(login?.options.find((option) => option.long === '--open')?.description)
      .toContain('不能与 --profile 同用');
    expect(login?.description()).toBe('从本机浏览器读取豆瓣登录态');
  });

  it('opens the current-account page in the selected browser', async () => {
    const auth = await import('../auth.ts');

    expect(auth.resolveLoginLaunchCommand('darwin', 'arc')).toEqual({
      command: 'open',
      args: ['-b', 'company.thebrowser.Browser', 'https://www.douban.com/mine/']
    });
    expect(auth.resolveLoginLaunchCommand('darwin', 'chrome')).toEqual({
      command: 'open',
      args: ['-b', 'com.google.Chrome', 'https://www.douban.com/mine/']
    });
  });

  it('limits Arc cookie extraction to macOS', async () => {
    const auth = await import('../auth.ts');

    expect(auth.resolveBrowserCookieTarget('arc', 'darwin')).toEqual({
      backend: 'chrome',
      chromiumBrowser: 'arc'
    });
    expect(() => auth.resolveBrowserCookieTarget('arc', 'win32'))
      .toThrow('Arc Cookie 提取目前仅支持 macOS');
    expect(() => auth.resolveBrowserCookieTarget('arc', 'linux'))
      .toThrow('Arc Cookie 提取目前仅支持 macOS');
    expect(() => auth.resolveBrowserCookieTarget('safari', 'win32'))
      .toThrow('Safari Cookie 提取目前仅支持 macOS');
  });

  it('rejects interactive login from a pipe or CI input', async () => {
    const auth = await import('../auth.ts');

    expect(() => auth.assertInteractiveLogin(false)).toThrow('douban login 需要交互式终端');
    expect(() => auth.assertInteractiveLogin(true)).not.toThrow();
    expect(() => auth.assertInteractiveLogin(undefined)).toThrow('douban login 需要交互式终端');
  });

  it('maps supported system browser identifiers to cookie backends', async () => {
    const auth = await import('../auth.ts');

    expect(auth.browserFromSystemIdentifier('company.thebrowser.browser')).toBe('arc');
    expect(auth.browserFromSystemIdentifier('com.google.Chrome')).toBe('chrome');
    expect(auth.browserFromSystemIdentifier('MSEdgeHTM')).toBe('edge');
    expect(auth.browserFromSystemIdentifier('FirefoxURL-308046B0AF4A39CB')).toBe('firefox');
    expect(auth.browserFromSystemIdentifier('com.apple.Safari')).toBe('safari');
    expect(auth.browserFromSystemIdentifier('org.example.unknown')).toBeUndefined();
  });

  it('reuses the identity returned by ensureAuth in whoami', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'browser-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    const fetchMock = vi.fn(async () => new Response(profileHtml('alice', 'Alice'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);
    fetchMock.mockClear();

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(['node', 'douban', 'whoami', '--json']);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      id: 'alice',
      name: 'Alice'
    });
  });

  it('prints provider warnings while redacting returned cookie values', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'dbcl2', value: 'browser-secret', source: { browser: 'chrome' } },
        { name: 'ck', value: 'csrf-secret', source: { browser: 'chrome' } }
      ],
      warnings: ['Keychain warning for browser-secret and csrf-secret']
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Keychain warning');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('browser-secret');
    expect(output).not.toContain('csrf-secret');
  });

  it('reports a broken sweet-cookie module instead of treating it as no cookies', async () => {
    vi.doMock('@steipete/sweet-cookie', () => ({}));
    const auth = await import('../auth.ts');

    await expect(auth.loginFromBrowserCookies({ browser: 'chrome' }))
      .rejects.toThrow('加载浏览器 Cookie 组件失败');
  });

  it.each([
    ['array result', []],
    ['invalid result shape', { cookies: 'not-an-array', warnings: [] }],
    ['non-string warning', {
      cookies: [{ name: 'dbcl2', value: 'must-not-be-used', source: { browser: 'chrome' } }],
      warnings: [{ message: 'unexpected' }]
    }]
  ])('fails closed for %s from the cookie provider', async (_label, result) => {
    const reader = vi.fn().mockResolvedValue(result);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromBrowserCookies({ browser: 'chrome' }, reader as never))
      .rejects.toThrow('未找到可验证的豆瓣登录态');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(authCachePath())).toBe(false);
    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n')).toContain('sweet-cookie 返回了无效');
  });

  it('does not combine dbcl2 and ck from different profiles', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'dbcl2', value: 'default-account', source: { browser: 'chrome', profile: 'Default' } },
        { name: 'ck', value: 'work-token', source: { browser: 'chrome', profile: 'Work' } }
      ],
      warnings: []
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromBrowserCookies({ browser: 'chrome' }, reader))
      .rejects.toThrow('未找到可验证的豆瓣登录态');
    expect(fetchMock).toHaveBeenCalledOnce();
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('Cookie')).toBe('dbcl2=default-account');
    }
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('rejects cookie values that could inject additional header fields', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'secret\r\nX-Test: injected', source: { browser: 'chrome' } }],
      warnings: []
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromBrowserCookies({ browser: 'chrome' }, reader))
      .rejects.toThrow('未找到可验证的豆瓣登录态');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('does not combine cookies from distinct stores with the same profile name', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        {
          name: 'dbcl2',
          value: 'account-secret',
          source: { browser: 'chrome', profile: 'Default', storeId: 'chrome-default' }
        },
        {
          name: 'ck',
          value: 'other-store-token',
          source: { browser: 'chrome', profile: 'Default', storeId: 'other-default' }
        }
      ],
      warnings: []
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie')).toBe('dbcl2=account-secret');
  });

  it('rejects ambiguous accounts instead of silently selecting the first browser', async () => {
    const reader = vi.fn(async (options: { browsers: string[] }) => {
      const browser = options.browsers[0];
      if (browser !== 'chrome' && browser !== 'firefox') return { cookies: [], warnings: [] };
      return {
        cookies: [
          { name: 'dbcl2', value: `${browser}-secret`, source: { browser } },
          { name: 'ck', value: `${browser}-ck`, source: { browser } }
        ],
        warnings: []
      };
    });
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      const cookie = new Headers(init?.headers).get('Cookie') || '';
      return new Response(
        cookie.includes('chrome-secret') ? profileHtml('alice', 'Alice') : profileHtml('bob', 'Bob'),
        { status: 200 }
      );
    }));
    const auth = await import('../auth.ts');

    await expect(auth.loginFromBrowserCookies({}, reader as never))
      .rejects.toThrow('检测到多个豆瓣账号');
    expect(reader).toHaveBeenCalledTimes(process.platform === 'darwin' ? 4 : 3);
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('blocks a cached session when the verified account identity changes', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'dbcl2', value: 'identity-secret', source: { browser: 'chrome' } },
        { name: 'ck', value: 'identity-ck', source: { browser: 'chrome' } }
      ],
      warnings: []
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    fetchMock.mockResolvedValue(new Response(profileHtml('bob', 'Bob'), { status: 200 }));
    await expect(auth.ensureAuth()).rejects.toThrow('登录账号校验失败');
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('migrates a valid legacy cache without refreshing its updatedAt age', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'dbcl2', value: 'legacy-secret', source: { browser: 'chrome' } },
        { name: 'ck', value: 'legacy-ck', source: { browser: 'chrome' } }
      ],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    renameSync(authCachePath(), legacyAuthCachePath());
    utimesSync(legacyAuthCachePath(), new Date('2000-01-01'), new Date('2000-01-01'));

    const migrated = await auth.detectAuthSession();

    expect(migrated).toMatchObject({ accountId: 'alice', accountName: 'Alice' });
    expect(existsSync(authCachePath())).toBe(true);
    expect(existsSync(legacyAuthCachePath())).toBe(false);
  });

  it('continues reading version 1 encrypted caches', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'legacy-schema-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    const cachePayload = JSON.parse(readFileSync(authCachePath(), 'utf8')) as Record<string, unknown>;
    cachePayload.version = 1;
    cachePayload.source = 'Chrome';
    cachePayload.updatedAt = new Date().toISOString();
    writeFileSync(authCachePath(), `${JSON.stringify(cachePayload)}\n`, { mode: 0o600 });

    await expect(auth.detectAuthSession()).resolves.toMatchObject({ accountId: 'alice' });
  });

  it('keeps using the legacy cache when migration cannot create the new path', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'legacy-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);
    renameSync(authCachePath(), legacyAuthCachePath());

    const blockedParent = path.join(tempHome, 'blocked-parent');
    writeFileSync(blockedParent, 'not a directory');
    process.env.DOUBAN_CLI_HOME = path.join(blockedParent, 'storage');

    await expect(auth.detectAuthSession()).resolves.toMatchObject({ accountId: 'alice' });
    expect(existsSync(legacyAuthCachePath())).toBe(true);
    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('迁移登录缓存失败，继续使用旧缓存');
  });

  it('removes a leftover legacy cache after validating the current cache', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'current-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);
    writeFileSync(legacyAuthCachePath(), '{leftover-legacy-cache', { mode: 0o600 });

    await expect(auth.detectAuthSession()).resolves.toMatchObject({ accountId: 'alice' });
    expect(existsSync(legacyAuthCachePath())).toBe(false);
  });

  it('recovers a valid legacy cache after removing an invalid current cache', async () => {
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'legacy-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);
    renameSync(authCachePath(), legacyAuthCachePath());
    mkdirSync(path.dirname(authCachePath()), { recursive: true });
    writeFileSync(authCachePath(), '{broken-current-cache', { mode: 0o600 });

    await expect(auth.detectAuthSession()).resolves.toMatchObject({ accountId: 'alice' });
    expect(existsSync(authCachePath())).toBe(true);
    expect(existsSync(legacyAuthCachePath())).toBe(false);
  });

  it('does not delete a cache path when the failure is not a cache-format error', async () => {
    mkdirSync(authCachePath(), { recursive: true });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await expect(auth.detectAuthSession()).resolves.toBeNull();
    expect(lstatSync(authCachePath()).isDirectory()).toBe(true);
    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('登录缓存不是普通文件');
  });

  it('expires auth from updatedAt even when the cache mtime is fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'old-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    vi.setSystemTime(new Date('2026-02-01T00:00:01.000Z'));
    utimesSync(authCachePath(), new Date(), new Date());

    await expect(auth.detectAuthSession()).resolves.toBeNull();
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('rejects an updatedAt value beyond the allowed future clock skew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:01.000Z'));
    const reader = vi.fn().mockResolvedValue({
      cookies: [{ name: 'dbcl2', value: 'future-secret', source: { browser: 'chrome' } }],
      warnings: []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 })));
    const auth = await import('../auth.ts');
    await auth.loginFromBrowserCookies({ browser: 'chrome' }, reader);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    await expect(auth.detectAuthSession()).resolves.toBeNull();
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('logout deletes both current and legacy cache files without parsing them', async () => {
    mkdirSync(path.dirname(authCachePath()), { recursive: true });
    writeFileSync(authCachePath(), '{broken-new-json', { mode: 0o600 });
    writeFileSync(legacyAuthCachePath(), '{broken-legacy-json', { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(['node', 'douban', 'logout', '--json']);

    expect(existsSync(authCachePath())).toBe(false);
    expect(existsSync(legacyAuthCachePath())).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
  });
});
