import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ chromium: vi.fn(), firefox: vi.fn(), webkit: vi.fn(), find: vi.fn(), valid: vi.fn(() => true) }));
vi.mock('playwright', () => ({ chromium: { launch: mocks.chromium }, firefox: { launch: mocks.firefox }, webkit: { launch: mocks.webkit } }));
vi.mock('../browser-platform.js', async importOriginal => ({ ...await importOriginal<typeof import('../browser-platform.js')>(),
  findBrowserExecutable: mocks.find, isBrowserExecutable: mocks.valid }));
import { browserLaunchOptions, launchBrowser } from '../browser.js';

afterEach(() => { vi.resetAllMocks(); mocks.valid.mockReturnValue(true); });
describe('browser launch adapters', () => {
  it('launches installed Chromium rather than requiring a Playwright download', async () => {
    const executable = process.platform === 'win32' ? 'C:\\Browser\\chrome.exe' : '/custom/bin/chromium';
    mocks.find.mockReturnValue(executable);
    mocks.chromium.mockResolvedValue({});
    await launchBrowser('chromium');
    expect(mocks.chromium).toHaveBeenCalledWith({ executablePath: executable, headless: true });
  });
  it.each(['brave', 'vivaldi', 'opera'] as const)('supports an explicit %s binary without changing its profile', async name => {
    const executable = process.platform === 'win32' ? 'C:\\Browser\\browser.exe' : '/custom/bin/browser';
    mocks.chromium.mockResolvedValue({});
    await launchBrowser(name, executable, false);
    expect(mocks.chromium).toHaveBeenCalledWith({ executablePath: executable, headless: false });
  });
  it('uses Playwright Firefox and WebKit instead of native binaries', async () => {
    await launchBrowser('firefox');
    await launchBrowser('webkit');
    expect(mocks.firefox).toHaveBeenCalledWith({ headless: true });
    expect(mocks.webkit).toHaveBeenCalledWith({ headless: true });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('retains the branded channels when a Chrome or Edge path is not found', () => {
    mocks.find.mockReturnValue(undefined);
    expect(browserLaunchOptions('chrome')).toEqual({ channel: 'chrome' });
    expect(browserLaunchOptions('edge')).toEqual({ channel: 'msedge' });
  });
  it('rejects a bad executable before starting a browser', async () => {
    mocks.valid.mockReturnValue(false);
    await expect(launchBrowser('chromium', 'relative-path')).rejects.toThrow('绝对路径');
    expect(mocks.chromium).not.toHaveBeenCalled();
  });
});
