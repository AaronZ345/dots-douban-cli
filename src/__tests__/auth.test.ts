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
    expect(cacheText).not.toContain('browser-secret');
    expect(cacheText).not.toContain('csrf-secret');
    expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(cachePath)).mode & 0o777).toBe(0o700);
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
    expect(reader).toHaveBeenCalledTimes(4);
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
