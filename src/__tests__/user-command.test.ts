import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const apiMocks = vi.hoisted(() => ({
  getUserCollection: vi.fn(),
  getUserCollectionPage: vi.fn()
}));
const authMocks = vi.hoisted(() => ({
  ensureAuth: vi.fn()
}));

vi.mock('../api/collection.js', () => ({
  getUserCollectionPage: apiMocks.getUserCollectionPage
}));
vi.mock('../api/user.js', () => ({
  getUserCollection: apiMocks.getUserCollection
}));
vi.mock('../auth.js', () => authMocks);
vi.mock('../utils/spinner.js', () => ({
  withSpinner: vi.fn(async (_message: string, task: () => Promise<unknown>) => task())
}));

import { registerUserCommands } from '../commands/user.ts';

const originalArgv = process.argv;
const originalHome = process.env.HOME;
const originalCliHome = process.env.DOUBAN_CLI_HOME;
const tempDirectories: string[] = [];

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCliHome === undefined) delete process.env.DOUBAN_CLI_HOME;
  else process.env.DOUBAN_CLI_HOME = originalCliHome;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerUserCommands(program);
  return program;
}

describe('user command', () => {
  it('uses --page to request the correct JSON result window', async () => {
    apiMocks.getUserCollectionPage.mockResolvedValue({
      items: [{ kind: 'movie', id: '42', title: 'Example' }],
      total: 100,
      nextStart: 30,
      partial: false,
      warnings: []
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'user',
      'alice',
      '--page',
      '3',
      '--limit',
      '10',
      '--json'
    ]);

    expect(apiMocks.getUserCollectionPage).toHaveBeenCalledWith({
      kind: 'movie',
      userId: 'alice',
      status: 'collect',
      start: 20,
      count: 10
    });
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual([
      { kind: 'movie', id: '42', title: 'Example' }
    ]);
  });

  it('fetches only the requested page in non-interactive mode', async () => {
    apiMocks.getUserCollectionPage.mockResolvedValue({
      items: [],
      total: 100,
      nextStart: 30,
      partial: false,
      warnings: []
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'user',
      'alice',
      '--page',
      '3',
      '--limit',
      '10'
    ]);

    expect(apiMocks.getUserCollectionPage).toHaveBeenCalledOnce();
    expect(apiMocks.getUserCollectionPage).toHaveBeenCalledWith({
      kind: 'movie',
      userId: 'alice',
      status: 'collect',
      start: 20,
      count: 10
    });
  });

  it('rejects conflicting collection status flags before fetching', async () => {
    process.argv = ['node', 'douban', 'user', 'alice', '--wish', '--doing', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync(process.argv);

    expect(apiMocks.getUserCollectionPage).not.toHaveBeenCalled();
    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(process.exitCode).toBe(1);
  });

  it('uses the verified session identity for me without another profile lookup', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-config-'));
    tempDirectories.push(tempHome);
    process.env.HOME = tempHome;
    process.env.DOUBAN_CLI_HOME = path.join(tempHome, 'storage');
    authMocks.ensureAuth.mockResolvedValue({
      dbcl2: 'secret',
      cookies: 'dbcl2=secret',
      source: 'Chrome',
      accountId: 'alice',
      accountName: 'Alice',
      updatedAt: '2026-08-10T00:00:00.000Z'
    });
    apiMocks.getUserCollection.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'me', '--json']);

    expect(authMocks.ensureAuth).toHaveBeenCalledOnce();
    expect(apiMocks.getUserCollection).toHaveBeenCalledWith('alice', 'collect', 30);
  });

  it('stores config in a private DOUBAN_CLI_HOME directory', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-config-'));
    tempDirectories.push(tempHome);
    const storageDirectory = path.join(tempHome, 'storage');
    process.env.HOME = tempHome;
    process.env.DOUBAN_CLI_HOME = storageDirectory;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'config',
      '--user',
      'alice',
      '--json'
    ]);

    const configPath = path.join(storageDirectory, 'config.json');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ user: 'alice' });
    expect(lstatSync(storageDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('rejects an empty configured user ID', async () => {
    process.argv = ['node', 'douban', 'config', '--user', ' ', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync(process.argv);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0])).error.code).toBe('INVALID_ARGUMENT');
  });

  it('migrates the legacy config after validating the new copy', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-config-'));
    tempDirectories.push(tempHome);
    const storageDirectory = path.join(tempHome, 'storage');
    const legacyPath = path.join(tempHome, '.douban-cli.json');
    const configPath = path.join(storageDirectory, 'config.json');
    process.env.HOME = tempHome;
    process.env.DOUBAN_CLI_HOME = storageDirectory;
    writeFileSync(legacyPath, '{"user":"legacy-user"}\n');
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'config', '--json']);

    expect(existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ user: 'legacy-user' });
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({ user: 'legacy-user' });
  });

  it('falls back to a valid legacy config when migration cannot create the new path', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-config-'));
    tempDirectories.push(tempHome);
    const legacyPath = path.join(tempHome, '.douban-cli.json');
    const blockedParent = path.join(tempHome, 'blocked-parent');
    process.env.HOME = tempHome;
    process.env.DOUBAN_CLI_HOME = path.join(blockedParent, 'storage');
    writeFileSync(legacyPath, '{"user":"legacy-user"}\n');
    writeFileSync(blockedParent, 'not a directory');
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'config', '--json']);

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({ user: 'legacy-user' });
    expect(existsSync(legacyPath)).toBe(true);
    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('迁移配置失败，继续使用旧配置');
  });

  it('removes leftover legacy config after validating the current config', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'douban-config-'));
    tempDirectories.push(tempHome);
    const storageDirectory = path.join(tempHome, 'storage');
    const legacyPath = path.join(tempHome, '.douban-cli.json');
    process.env.HOME = tempHome;
    process.env.DOUBAN_CLI_HOME = storageDirectory;
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(['node', 'douban', 'config', '--user', 'current-user', '--json']);
    writeFileSync(legacyPath, '{"user":"legacy-user"}\n');

    await createProgram().parseAsync(['node', 'douban', 'config', '--json']);

    expect(existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({ user: 'current-user' });
  });
});
