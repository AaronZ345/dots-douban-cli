import os from 'node:os';
import path from 'node:path';

export interface CliStoragePaths {
  authCachePath: string;
  configPath: string;
  legacyAuthCachePath: string;
  legacyConfigPath: string;
}

interface ResolveCliStoragePathsOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

function absoluteEnvironmentPath(
  value: string | undefined,
  pathApi: typeof path.posix
): string | undefined {
  const candidate = value?.trim();
  return candidate && pathApi.isAbsolute(candidate) ? pathApi.normalize(candidate) : undefined;
}

export function resolveCliStoragePaths(
  options: ResolveCliStoragePathsOptions = {}
): CliStoragePaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const override = env.DOUBAN_CLI_HOME?.trim();

  if (override && !pathApi.isAbsolute(override)) {
    throw new Error('DOUBAN_CLI_HOME 必须是绝对路径');
  }

  let authDirectory: string;
  let configDirectory: string;

  if (override) {
    authDirectory = pathApi.normalize(override);
    configDirectory = authDirectory;
  } else if (platform === 'darwin') {
    authDirectory = pathApi.join(homedir, 'Library', 'Application Support', 'douban-cli');
    configDirectory = authDirectory;
  } else if (platform === 'win32') {
    const localAppData = absoluteEnvironmentPath(env.LOCALAPPDATA, path.win32)
      ?? path.win32.join(homedir, 'AppData', 'Local');
    const appData = absoluteEnvironmentPath(env.APPDATA, path.win32)
      ?? path.win32.join(homedir, 'AppData', 'Roaming');
    authDirectory = path.win32.join(localAppData, 'douban-cli');
    configDirectory = path.win32.join(appData, 'douban-cli');
  } else {
    const stateHome = absoluteEnvironmentPath(env.XDG_STATE_HOME, path.posix)
      ?? path.posix.join(homedir, '.local', 'state');
    const configHome = absoluteEnvironmentPath(env.XDG_CONFIG_HOME, path.posix)
      ?? path.posix.join(homedir, '.config');
    authDirectory = path.posix.join(stateHome, 'douban-cli');
    configDirectory = path.posix.join(configHome, 'douban-cli');
  }

  return {
    authCachePath: pathApi.join(authDirectory, 'auth.json'),
    configPath: pathApi.join(configDirectory, 'config.json'),
    legacyAuthCachePath: pathApi.join(homedir, '.douban-cli-auth.json'),
    legacyConfigPath: pathApi.join(homedir, '.douban-cli.json')
  };
}
