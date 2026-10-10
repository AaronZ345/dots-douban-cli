import { describe, expect, it } from 'vitest';
import { resolveCliStoragePaths } from '../storage/paths.ts';

describe('CLI storage paths', () => {
  it('uses one absolute DOUBAN_CLI_HOME override on every platform', () => {
    const paths = resolveCliStoragePaths({
      platform: 'linux',
      homedir: '/home/alice',
      env: { DOUBAN_CLI_HOME: '/var/lib/alice/douban' }
    });

    expect(paths.authCachePath).toBe('/var/lib/alice/douban/auth.json');
    expect(paths.configPath).toBe('/var/lib/alice/douban/config.json');
  });

  it('rejects a relative DOUBAN_CLI_HOME override', () => {
    expect(() => resolveCliStoragePaths({
      platform: 'linux',
      homedir: '/home/alice',
      env: { DOUBAN_CLI_HOME: './douban-data' }
    })).toThrow('DOUBAN_CLI_HOME 必须是绝对路径');
  });

  it('rejects a filesystem root as DOUBAN_CLI_HOME', () => {
    expect(() => resolveCliStoragePaths({
      platform: 'linux',
      homedir: '/home/alice',
      env: { DOUBAN_CLI_HOME: '/' }
    })).toThrow('不能指向文件系统根目录');
  });

  it('rejects an invalid home directory before constructing legacy paths', () => {
    expect(() => resolveCliStoragePaths({
      platform: 'linux',
      homedir: 'home/alice',
      env: {}
    })).toThrow('用户主目录必须是绝对路径');
  });

  it('uses Application Support on macOS', () => {
    const paths = resolveCliStoragePaths({
      platform: 'darwin',
      homedir: '/Users/alice',
      env: {}
    });

    expect(paths.authCachePath).toBe('/Users/alice/Library/Application Support/douban-cli-local/auth.json');
    expect(paths.configPath).toBe('/Users/alice/Library/Application Support/douban-cli-local/config.json');
  });

  it('uses absolute XDG directories on Linux', () => {
    const paths = resolveCliStoragePaths({
      platform: 'linux',
      homedir: '/home/alice',
      env: {
        XDG_STATE_HOME: '/data/alice/state',
        XDG_CONFIG_HOME: '/data/alice/config'
      }
    });

    expect(paths.authCachePath).toBe('/data/alice/state/douban-cli-local/auth.json');
    expect(paths.configPath).toBe('/data/alice/config/douban-cli-local/config.json');
  });

  it('ignores relative XDG values and uses standard Linux fallbacks', () => {
    const paths = resolveCliStoragePaths({
      platform: 'linux',
      homedir: '/home/alice',
      env: {
        XDG_STATE_HOME: 'state',
        XDG_CONFIG_HOME: 'config'
      }
    });

    expect(paths.authCachePath).toBe('/home/alice/.local/state/douban-cli-local/auth.json');
    expect(paths.configPath).toBe('/home/alice/.config/douban-cli-local/config.json');
  });

  it('separates local auth state from roaming config on Windows', () => {
    const paths = resolveCliStoragePaths({
      platform: 'win32',
      homedir: 'C:\\Users\\alice',
      env: {
        LOCALAPPDATA: 'D:\\Local',
        APPDATA: 'D:\\Roaming'
      }
    });

    expect(paths.authCachePath).toBe('D:\\Local\\douban-cli-local\\auth.json');
    expect(paths.configPath).toBe('D:\\Roaming\\douban-cli-local\\config.json');
  });
});
