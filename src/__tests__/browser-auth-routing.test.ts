import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), databases: vi.fn(), reader: vi.fn(), platform: 'linux' as NodeJS.Platform }));
vi.mock('../browser-cookies.js', () => ({ readChromiumCookies: mocks.cookies, resolveCookieDatabases: mocks.databases }));
vi.mock('@steipete/sweet-cookie', () => ({ getCookies: mocks.reader }));
vi.mock('../browser-platform.js', async importOriginal => {
  const original = await importOriginal<typeof import('../browser-platform.js')>();
  return { ...original, browserEnvironment: () => ({ ...original.browserEnvironment(), platform: mocks.platform }) };
});
import { loginFromBrowserCookies } from '../auth.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'douban-browser-auth-'));
  vi.stubEnv('DOUBAN_CLI_HOME', directory);
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  const result = { cookies: [{ name: 'dbcl2', value: 'fixture-account', source: { browser: 'chrome', profile: 'Default' } }], warnings: [] };
  mocks.cookies.mockResolvedValue(result);
  mocks.reader.mockResolvedValue(result);
  mocks.databases.mockReturnValue([{ path: 'C:\\Fixture\\Profile\\Network\\Cookies', profile: 'Profile' }]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<a class="lnk-mine" href="https://www.douban.com/people/fixture-only/">Fixture</a>')));
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe.sequential('selected browser authentication routing', () => {
  it.each(['chromium', 'brave', 'vivaldi', 'opera'] as const)('uses the Linux %s reader instead of Chrome storage', async browser => {
    mocks.platform = 'linux';
    const result = await loginFromBrowserCookies({ browser, profile: 'Work' });
    expect(mocks.cookies).toHaveBeenCalledWith(browser, 'Work', undefined);
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(result.source.toLowerCase()).toContain(browser);
  });
  it.each(['chromium', 'brave', 'arc', 'vivaldi', 'opera'] as const)('uses only the Windows %s database', async browser => {
    mocks.platform = 'win32';
    await loginFromBrowserCookies({ browser });
    expect(mocks.databases).toHaveBeenCalledWith(browser, undefined);
    expect(mocks.reader).toHaveBeenCalledWith(expect.objectContaining({
      browsers: ['chrome'], chromeProfile: 'C:\\Fixture\\Profile\\Network\\Cookies', names: ['dbcl2', 'ck']
    }));
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it.each(['vivaldi', 'opera'] as const)('uses the macOS %s keychain reader', async browser => {
    mocks.platform = 'darwin';
    await loginFromBrowserCookies({ browser });
    expect(mocks.cookies).toHaveBeenCalledWith(browser, undefined, undefined);
    expect(mocks.reader).not.toHaveBeenCalled();
  });
});
