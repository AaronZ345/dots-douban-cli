import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliArgumentError } from './utils/error.js';

export const CHROMIUM_BROWSERS = ['chromium', 'chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera'] as const;
export const COOKIE_BROWSERS = [...CHROMIUM_BROWSERS, 'firefox', 'safari'] as const;
export const LAUNCH_BROWSERS = [...CHROMIUM_BROWSERS, 'firefox', 'webkit'] as const;
export type ChromiumBrowserName = typeof CHROMIUM_BROWSERS[number];
export type CookieBrowserName = typeof COOKIE_BROWSERS[number];
export type LaunchBrowserName = typeof LAUNCH_BROWSERS[number];

export interface BrowserEnvironment {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function browserEnvironment(): BrowserEnvironment {
  return { platform: process.platform, home: os.homedir(), env: process.env };
}

export function parseLaunchBrowser(value: string): LaunchBrowserName {
  const name = value.trim().toLowerCase();
  if (!LAUNCH_BROWSERS.includes(name as LaunchBrowserName)) {
    throw new CliArgumentError(`浏览器窗口支持 ${LAUNCH_BROWSERS.join('、')}`);
  }
  return name as LaunchBrowserName;
}

export function assertBrowserPlatform(name: CookieBrowserName | 'webkit', platform: NodeJS.Platform): void {
  if (name === 'safari' && platform !== 'darwin') throw new CliArgumentError('Safari 仅支持 macOS');
  if (name === 'arc' && platform === 'linux') throw new CliArgumentError('Arc 仅支持 macOS 和 Windows');
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new CliArgumentError('浏览器适配支持 macOS、Linux 和 Windows');
}

const commands: Record<ChromiumBrowserName | 'firefox', string[]> = {
  chromium: ['chromium', 'chromium-browser', 'org.chromium.Chromium'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chrome', 'com.google.Chrome'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge', 'com.microsoft.Edge'],
  brave: ['brave-browser', 'brave-browser-stable', 'brave', 'com.brave.Browser'],
  arc: ['Arc'],
  vivaldi: ['vivaldi', 'vivaldi-stable', 'com.vivaldi.Vivaldi'],
  opera: ['opera', 'com.opera.Opera'],
  firefox: ['firefox', 'org.mozilla.firefox']
};

export function browserExecutableCandidates(name: ChromiumBrowserName | 'firefox', target = browserEnvironment()): string[] {
  assertBrowserPlatform(name, target.platform);
  const p = target.platform === 'win32' ? path.win32 : path.posix;
  let candidates: string[];
  if (target.platform === 'darwin') {
    const apps = {
      chromium: ['Chromium', 'Chromium'], chrome: ['Google Chrome', 'Google Chrome'],
      edge: ['Microsoft Edge', 'Microsoft Edge'], brave: ['Brave Browser', 'Brave Browser'],
      arc: ['Arc', 'Arc'], vivaldi: ['Vivaldi', 'Vivaldi'], opera: ['Opera', 'Opera'], firefox: ['Firefox', 'firefox']
    };
    const [app, executable] = apps[name];
    candidates = ['/Applications', p.join(target.home, 'Applications')]
      .map(root => p.join(root, `${app}.app`, 'Contents', 'MacOS', executable));
  } else if (target.platform === 'win32') {
    const local = target.env.LOCALAPPDATA || p.join(target.home, 'AppData', 'Local');
    const systemRoots = [target.env.ProgramW6432, target.env.PROGRAMW6432, target.env.ProgramFiles,
      target.env.PROGRAMFILES, target.env['ProgramFiles(x86)'], target.env['PROGRAMFILES(X86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'];
    const relative = {
      chromium: ['Chromium', 'Application', 'chrome.exe'], chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
      edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      arc: ['Programs', 'Arc', 'Arc.exe'], vivaldi: ['Vivaldi', 'Application', 'vivaldi.exe'],
      opera: ['Opera', 'launcher.exe'], firefox: ['Mozilla Firefox', 'firefox.exe']
    };
    candidates = [local, ...systemRoots.filter((root): root is string => Boolean(root))]
      .map(root => p.join(root, ...relative[name]));
    if (name === 'opera') candidates.unshift(p.join(local, 'Programs', 'Opera', 'launcher.exe'));
    if (name === 'arc') candidates.unshift(p.join(local, 'Microsoft', 'WindowsApps', 'Arc.exe'));
  } else {
    candidates = ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin',
      p.join(target.home, '.local', 'share', 'flatpak', 'exports', 'bin'), '/var/lib/flatpak/exports/bin']
      .flatMap(root => commands[name].map(command => p.join(root, command)));
  }
  const executableNames = target.platform === 'win32'
    ? [p.basename(candidates[0]), ...commands[name].map(command => `${command}.exe`)] : commands[name];
  const searchPath = target.env.PATH || target.env.Path || '';
  candidates.push(...searchPath.split(target.platform === 'win32' ? ';' : ':')
    .map(root => root.replace(/^"|"$/g, ''))
    .filter(root => p.isAbsolute(root))
    .flatMap(root => executableNames.map(command => p.join(root, command))));
  return [...new Set(candidates)];
}

export function isBrowserExecutable(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export function findBrowserExecutable(name: ChromiumBrowserName | 'firefox', target = browserEnvironment(),
  check = isBrowserExecutable): string | undefined {
  return browserExecutableCandidates(name, target).find(candidate => check(candidate, target.platform));
}

export function chromiumProfileRoots(name: ChromiumBrowserName, target = browserEnvironment()): string[] {
  assertBrowserPlatform(name, target.platform);
  const p = target.platform === 'win32' ? path.win32 : path.posix;
  if (target.platform === 'darwin') {
    const relative = { chromium: 'Chromium', chrome: 'Google/Chrome', edge: 'Microsoft Edge',
      brave: 'BraveSoftware/Brave-Browser', arc: 'Arc/User Data', vivaldi: 'Vivaldi', opera: 'com.operasoftware.Opera' };
    return [p.join(target.home, 'Library', 'Application Support', relative[name])];
  }
  if (target.platform === 'win32') {
    const local = target.env.LOCALAPPDATA || p.join(target.home, 'AppData', 'Local');
    const roaming = target.env.APPDATA || p.join(target.home, 'AppData', 'Roaming');
    const relative = { chromium: 'Chromium/User Data', chrome: 'Google/Chrome/User Data', edge: 'Microsoft/Edge/User Data',
      brave: 'BraveSoftware/Brave-Browser/User Data', arc: 'Arc/User Data', vivaldi: 'Vivaldi/User Data', opera: 'Opera Software/Opera Stable' };
    const roots = [p.join(name === 'opera' ? roaming : local, relative[name])];
    if (name === 'arc') roots.push(p.join(local, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'User Data'));
    return roots;
  }
  const config = target.env.XDG_CONFIG_HOME || p.join(target.home, '.config');
  const relative = { chromium: 'chromium', chrome: 'google-chrome', edge: 'microsoft-edge',
    brave: 'BraveSoftware/Brave-Browser', arc: '', vivaldi: 'vivaldi', opera: 'opera' };
  const roots = [p.join(config, relative[name])];
  const flatpak = { chromium: 'org.chromium.Chromium', chrome: 'com.google.Chrome', edge: 'com.microsoft.Edge',
    brave: 'com.brave.Browser', arc: '', vivaldi: 'com.vivaldi.Vivaldi', opera: 'com.opera.Opera' };
  roots.push(p.join(target.home, '.var', 'app', flatpak[name], 'config', relative[name]));
  if (name === 'chromium') roots.push(p.join(target.home, 'snap', 'chromium', 'common', 'chromium'));
  if (name === 'brave') roots.push(p.join(target.home, 'snap', 'brave', 'current', '.config', relative[name]));
  return roots;
}
