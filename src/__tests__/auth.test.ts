import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome = '';
let originalCliHome: string | undefined;
let originalExitCode: string | number | null | undefined;
const originalStdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function authCachePath(): string {
  return path.join(tempHome, 'storage', 'auth.json');
}

function legacyAuthCachePath(): string {
  return path.join(tempHome, '.douban-cli-local-auth.json');
}

beforeEach(() => {
  originalCliHome = process.env.DOUBAN_CLI_HOME;
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-auth-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  process.env.DOUBAN_CLI_HOME = path.join(tempHome, 'storage');
  vi.resetModules();
});

afterEach(() => {
  if (originalCliHome === undefined) delete process.env.DOUBAN_CLI_HOME;
  else process.env.DOUBAN_CLI_HOME = originalCliHome;
  process.exitCode = originalExitCode;
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

function cookieStdin(contents: string, isTTY = false): Readable & { isTTY?: boolean } {
  const stream = Readable.from([contents]) as Readable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream;
}

function netscapeCookieLine(name: string, value: string, options: {
  domain?: string;
  cookiePath?: string;
  expires?: number;
  httpOnly?: boolean;
  includeSubdomains?: boolean;
} = {}): string {
  const domain = options.domain ?? '.douban.com';
  const prefix = options.httpOnly ? '#HttpOnly_' : '';
  const expires = options.expires ?? Math.floor(Date.now() / 1000) + 3600;
  const includeSubdomains = options.includeSubdomains === false ? 'FALSE' : 'TRUE';
  return `${prefix}${domain}\t${includeSubdomains}\t${options.cookiePath ?? '/'}\tTRUE\t${expires}\t${name}\t${value}`;
}

describe.sequential('authentication safety', () => {
  it('ensureAuth uses only the local cache and never scans browsers implicitly', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    await expect(auth.ensureAuth()).rejects.toThrow('请先运行 douban login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a copied Cookie request header while discarding unrelated cookies', async () => {
    const auth = await import('../auth.ts');

    expect(auth.parseCookieHeader(
      'Cookie: bid=unused; ck=manual-csrf; dbcl2="manual-account"; ll="108288"'
    )).toEqual({ dbcl2: 'manual-account', ck: 'manual-csrf' });
    expect(auth.parseCookieHeader('dbcl2=manual-account')).toEqual({ dbcl2: 'manual-account' });
    expect(auth.parseCookieHeader('dbcl2=manual-account; ck=manual-csrf\r\n'))
      .toEqual({ dbcl2: 'manual-account', ck: 'manual-csrf' });
  });

  it.each([
    ['missing dbcl2', 'bid=unused; ck=manual-csrf'],
    ['duplicate dbcl2', 'dbcl2=first; dbcl2=second'],
    ['duplicate ck', 'dbcl2=manual-account; ck=first; ck=second'],
    ['unbalanced quotes', 'dbcl2="manual-account'],
    ['header injection', 'dbcl2=manual-account\r\nX-Test: injected'],
    ['multiple trailing lines', 'dbcl2=manual-account\n\n'],
    ['malformed segment', 'dbcl2=manual-account; invalid-segment'],
    ['oversized input', `dbcl2=${'x'.repeat(16 * 1024)}`]
  ])('rejects unsafe manual Cookie headers: %s', async (_label, header) => {
    const auth = await import('../auth.ts');

    expect(auth.parseCookieHeader(header)).toBeNull();
  });

  it('parses active Douban cookies from Netscape cookies.txt', async () => {
    const auth = await import('../auth.ts');
    const contents = [
      '# Netscape HTTP Cookie File',
      netscapeCookieLine('dbcl2', 'wrong-domain', { domain: '.example.com' }),
      netscapeCookieLine('dbcl2', '"manual-account"', { httpOnly: true }),
      netscapeCookieLine('ck', 'manual-csrf')
    ].join('\n');

    expect(auth.parseNetscapeCookies(contents)).toEqual({
      dbcl2: 'manual-account',
      ck: 'manual-csrf'
    });
    expect(auth.parseNetscapeCookies(
      netscapeCookieLine('dbcl2', 'www-account', {
        domain: 'www.douban.com',
        includeSubdomains: false
      })
    )).toEqual({ dbcl2: 'www-account' });
  });

  it.each([
    ['expired dbcl2', netscapeCookieLine('dbcl2', 'expired', { expires: 1 })],
    ['wrong domain', netscapeCookieLine('dbcl2', 'wrong-domain', { domain: '.example.com' })],
    ['unrelated Douban subdomain', netscapeCookieLine('dbcl2', 'wrong-scope', { domain: 'accounts.douban.com' })],
    ['root host-only cookie', netscapeCookieLine('dbcl2', 'wrong-scope', {
      domain: 'douban.com',
      includeSubdomains: false
    })],
    ['empty leading label', netscapeCookieLine('dbcl2', 'bad-domain', { domain: '..douban.com' })],
    ['double-dot domain', netscapeCookieLine('dbcl2', 'bad-domain', { domain: 'a..douban.com' })],
    ['control-character domain', netscapeCookieLine('dbcl2', 'bad-domain', { domain: '\0.douban.com' })],
    ['wrong path', netscapeCookieLine('dbcl2', 'wrong-path', { cookiePath: '/accounts' })],
    ['duplicate dbcl2', [
      netscapeCookieLine('dbcl2', 'first'),
      netscapeCookieLine('dbcl2', 'second')
    ].join('\n')]
  ])('rejects invalid Netscape auth cookies: %s', async (_label, contents) => {
    const auth = await import('../auth.ts');

    expect(auth.parseNetscapeCookies(contents)).toBeNull();
  });

  it('imports a Cookie header only from explicit non-TTY stdin and stores it privately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    const session = await auth.loginFromCookieStdin(cookieStdin(
      'Cookie: dbcl2="manual-account"; ck=manual-csrf; bid=discarded\n'
    ));

    expect(session).toMatchObject({
      source: 'Manual stdin',
      accountId: 'alice',
      accountName: 'Alice'
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie'))
      .toBe('dbcl2=manual-account; ck=manual-csrf');
    const cacheText = readFileSync(authCachePath(), 'utf8');
    expect(cacheText).not.toContain('manual-account');
    expect(cacheText).not.toContain('manual-csrf');
  });

  it('rejects TTY, empty, oversized, and injected stdin before verification', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromCookieStdin(cookieStdin('dbcl2=manual-account', true)))
      .rejects.toThrow('只接受管道或重定向输入');
    await expect(auth.loginFromCookieStdin(cookieStdin('')))
      .rejects.toThrow('标准输入为空');
    await expect(auth.loginFromCookieStdin(cookieStdin(`dbcl2=${'x'.repeat(16 * 1024)}`)))
      .rejects.toThrow('不能超过 16 KiB');
    await expect(auth.loginFromCookieStdin(cookieStdin('dbcl2=manual-account\nX-Test: injected')))
      .rejects.toThrow('标准输入无效');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('imports only a regular Netscape cookies.txt file', async () => {
    const cookieFile = path.join(tempHome, 'douban-cookies.txt');
    writeFileSync(cookieFile, [
      '# Netscape HTTP Cookie File',
      netscapeCookieLine('dbcl2', '"file-account"', { httpOnly: true }),
      netscapeCookieLine('ck', 'file-csrf')
    ].join('\n'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(profileHtml('alice', 'Alice'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    const session = await auth.loginFromCookieFile(cookieFile);

    expect(session).toMatchObject({ source: 'Manual file', accountId: 'alice' });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Cookie'))
      .toBe('dbcl2=file-account; ck=file-csrf');
    const cacheText = readFileSync(authCachePath(), 'utf8');
    expect(cacheText).not.toContain('file-account');
    expect(cacheText).not.toContain('file-csrf');
  });

  it('rejects non-regular and oversized Cookie files before verification', async () => {
    const cookieFile = path.join(tempHome, 'douban-cookies.txt');
    const linkedCookieFile = path.join(tempHome, 'linked-cookies.txt');
    const oversizedCookieFile = path.join(tempHome, 'oversized-cookies.txt');
    writeFileSync(cookieFile, netscapeCookieLine('dbcl2', 'file-account'));
    symlinkSync(cookieFile, linkedCookieFile);
    writeFileSync(oversizedCookieFile, 'x'.repeat(128 * 1024 + 1));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromCookieFile(tempHome))
      .rejects.toThrow('必须是普通文件');
    await expect(auth.loginFromCookieFile(linkedCookieFile))
      .rejects.toThrow('不能是符号链接');
    await expect(auth.loginFromCookieFile(oversizedCookieFile))
      .rejects.toThrow('不能超过 128 KiB');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(authCachePath())).toBe(false);
  });

  it('does not cache or print a manually supplied Cookie when account verification fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = await import('../auth.ts');

    await expect(auth.loginFromCookieStdin(cookieStdin(
      'dbcl2=must-not-leak; ck=must-also-not-leak'
    ))).rejects.toMatchObject({ code: 'HTTP_STATUS', status: 401 });

    expect(existsSync(authCachePath())).toBe(false);
    expect(stderr).not.toHaveBeenCalled();
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
    if (process.platform !== 'win32') expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect(lstatSync(path.dirname(cachePath)).mode & 0o777).toBe(0o700);
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

  it('does not inspect or open a browser for non-interactive browser login', async () => {
    const spawnSyncMock = vi.fn();
    const question = vi.fn();
    const close = vi.fn();
    const getCookies = vi.fn();
    vi.doMock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
    vi.doMock('node:readline/promises', () => ({
      default: { createInterface: () => ({ question, close }) }
    }));
    vi.doMock('@steipete/sweet-cookie', () => ({ getCookies }));
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const auth = await import('../auth.ts');

    await expect(auth.loginWithBrowser({ open: true }))
      .rejects.toThrow('douban login 需要交互式终端');

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
    expect(getCookies).not.toHaveBeenCalled();
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

  it('advertises browser and explicit manual login modes without a raw Cookie argument', async () => {
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    const login = program.commands.find((command) => command.name() === 'login');
    const optionNames = login?.options.map((option) => option.long) ?? [];

    expect(optionNames).toEqual(expect.arrayContaining([
      '--open',
      '--cookie-stdin',
      '--cookie-file'
    ]));
    expect(optionNames).not.toContain('--cookie');
    expect(login?.options.find((option) => option.long === '--open')?.description)
      .toContain('不能与 --profile 同用');
    expect(login?.description()).toBe('从浏览器读取，或显式导入豆瓣登录态');
  });

  it('omits all Cookie material from manual login JSON output', async () => {
    const cookieFile = path.join(tempHome, 'douban-cookies.txt');
    writeFileSync(cookieFile, [
      netscapeCookieLine('dbcl2', 'json-account'),
      netscapeCookieLine('ck', 'json-csrf')
    ].join('\n'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(profileHtml('alice', 'Alice'), { status: 200 })
    ));
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { registerAuthCommands } = await import('../commands/auth.ts');
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync([
      'node',
      'douban',
      'login',
      '--cookie-file',
      cookieFile,
      '--json'
    ]);

    const output = String(stdout.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      source: 'Manual file',
      accountId: 'alice',
      accountName: 'Alice'
    });
    expect(output).not.toContain('json-account');
    expect(output).not.toContain('json-csrf');
    expect(output).not.toContain('dbcl2');
    expect(output).not.toContain('cookies');
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

  it('routes Chromium browsers across systems and rejects unavailable platforms', async () => {
    const auth = await import('../auth.ts');

    expect(auth.resolveBrowserCookieTarget('arc', 'darwin')).toEqual({
      backend: 'chrome',
      chromiumBrowser: 'arc'
    });
    expect(auth.resolveBrowserCookieTarget('arc', 'win32')).toEqual({ backend: 'chrome' });
    for (const platform of ['linux', 'win32'] as const) {
      for (const browser of ['chromium', 'brave', 'vivaldi', 'opera'] as const) {
        expect(auth.resolveBrowserCookieTarget(browser, platform)).toEqual({ backend: 'chrome' });
      }
    }
    expect(() => auth.resolveBrowserCookieTarget('arc', 'linux'))
      .toThrow('Arc 仅支持 macOS 和 Windows');
    expect(() => auth.resolveBrowserCookieTarget('safari', 'win32'))
      .toThrow('Safari 仅支持 macOS');
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
    expect(auth.browserFromSystemIdentifier('google-chrome.desktop')).toBe('chrome');
    expect(auth.browserFromSystemIdentifier('chromium_chromium.desktop')).toBe('chromium');
    expect(auth.browserFromSystemIdentifier('vivaldi-stable.desktop')).toBe('vivaldi');
    expect(auth.browserFromSystemIdentifier('OperaStable')).toBe('opera');
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
      .rejects.toMatchObject({ code: 'HTTP_STATUS', status: 401 });
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

  it('refuses a legacy cache when its encryption key cannot be loaded from the selected storage', async () => {
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

    await expect(auth.detectAuthSession()).resolves.toBeNull();
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
