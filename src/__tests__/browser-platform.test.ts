import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserExecutableCandidates, chromiumProfileRoots, findBrowserExecutable, isBrowserExecutable, parseLaunchBrowser } from '../browser-platform.js';

const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('browser discovery across platforms', () => {
  it('covers Linux package, Snap, Flatpak and PATH executable locations', () => {
    const candidates = browserExecutableCandidates('chromium', { platform: 'linux', home: '/test-home', env: { PATH: '/custom/bin::relative:/another/bin' } });
    expect(candidates).toEqual(expect.arrayContaining(['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
      '/custom/bin/chromium', '/test-home/.local/share/flatpak/exports/bin/org.chromium.Chromium']));
    expect(candidates.every(candidate => candidate.startsWith('/'))).toBe(true);
  });
  it('finds a Chromium executable installed only on PATH and skips non-executable files', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'douban-browser-path-'));
    temporary.push(folder);
    const executable = path.join(folder, process.platform === 'win32' ? 'brave.exe' : 'brave-browser');
    writeFileSync(executable, 'synthetic browser executable');
    const target = { platform: process.platform, home: folder, env: { PATH: folder, LOCALAPPDATA: folder, PROGRAMFILES: folder } };
    const check = (candidate: string) => candidate === executable && isBrowserExecutable(candidate);
    if (process.platform !== 'win32') {
      chmodSync(executable, 0o600);
      expect(findBrowserExecutable('brave', target, check)).not.toBe(executable);
    }
    chmodSync(executable, 0o700);
    expect(findBrowserExecutable('brave', target, check)).toBe(executable);
  });
  it('detects Windows user, system and x86 installation paths with Windows separators', () => {
    const target = { platform: 'win32' as const, home: 'C:\\Users\\test', env: {
      LOCALAPPDATA: 'C:\\Local', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps32', Path: '"D:\\Browser Bin"' } };
    expect(browserExecutableCandidates('brave', target)).toEqual(expect.arrayContaining([
      'C:\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Apps32\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'D:\\Browser Bin\\brave.exe']));
    expect(browserExecutableCandidates('vivaldi', target)).toContain('C:\\Local\\Vivaldi\\Application\\vivaldi.exe');
    expect(browserExecutableCandidates('opera', target)).toContain('C:\\Local\\Programs\\Opera\\launcher.exe');
    expect(browserExecutableCandidates('arc', target)).toContain('C:\\Local\\Microsoft\\WindowsApps\\Arc.exe');
  });
  it('includes user Applications on macOS', () => {
    const target = { platform: 'darwin' as const, home: '/test-home', env: {} };
    expect(browserExecutableCandidates('chromium', target)).toContain('/test-home/Applications/Chromium.app/Contents/MacOS/Chromium');
    expect(browserExecutableCandidates('vivaldi', target)).toContain('/Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
  });
  it('uses each browser profile root without substituting Chrome', () => {
    const target = { platform: 'linux' as const, home: '/test-home', env: { XDG_CONFIG_HOME: '/custom-config' } };
    expect(chromiumProfileRoots('chromium', target)).toEqual(['/custom-config/chromium',
      '/test-home/.var/app/org.chromium.Chromium/config/chromium', '/test-home/snap/chromium/common/chromium']);
    expect(chromiumProfileRoots('brave', target)[0]).toBe('/custom-config/BraveSoftware/Brave-Browser');
    expect(chromiumProfileRoots('vivaldi', target)[0]).toBe('/custom-config/vivaldi');
    expect(chromiumProfileRoots('opera', { platform: 'win32', home: 'C:\\Users\\test', env: { APPDATA: 'D:\\Roaming' } })[0])
      .toBe('D:\\Roaming\\Opera Software\\Opera Stable');
  });
  it('rejects Arc on Linux and accepts additional CLI browser names', () => {
    expect(() => browserExecutableCandidates('arc', { platform: 'linux', home: '/test-home', env: {} })).toThrow('Arc');
    expect(parseLaunchBrowser(' VIVALDI ')).toBe('vivaldi');
    expect(parseLaunchBrowser('opera')).toBe('opera');
    expect(() => parseLaunchBrowser('safari')).toThrow('浏览器窗口');
  });
  it('does not accept a directory as an executable', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'douban-browser-directory-'));
    temporary.push(folder);
    mkdirSync(path.join(folder, process.platform === 'win32' ? 'brave.exe' : 'brave-browser'));
    const executable = path.join(folder, process.platform === 'win32' ? 'brave.exe' : 'brave-browser');
    expect(findBrowserExecutable('brave', { platform: process.platform, home: folder, env: { PATH: folder } },
      candidate => candidate === executable && isBrowserExecutable(candidate))).toBeUndefined();
  });
});
