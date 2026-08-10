import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome = '';
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-auth-'));
  process.env.HOME = tempHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      chromeProfile: 'Profile 2'
    }));
    expect(session).toMatchObject({
      source: 'Chrome (Profile 2)',
      accountId: 'alice',
      accountName: 'Alice'
    });

    const cachePath = path.join(tempHome, '.douban-cli-auth.json');
    const cacheText = readFileSync(cachePath, 'utf8');
    expect(cacheText).not.toContain('browser-secret');
    expect(cacheText).not.toContain('csrf-secret');
    expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
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
    expect(existsSync(path.join(tempHome, '.douban-cli-auth.json'))).toBe(false);
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
    expect(existsSync(path.join(tempHome, '.douban-cli-auth.json'))).toBe(false);
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
    expect(existsSync(path.join(tempHome, '.douban-cli-auth.json'))).toBe(false);
  });

  it('logout deletes malformed cache files without trying to parse them', async () => {
    const cachePath = path.join(tempHome, '.douban-cli-auth.json');
    writeFileSync(cachePath, '{broken-json', { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(['node', 'douban', 'logout', '--json']);

    expect(existsSync(cachePath)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
  });
});
