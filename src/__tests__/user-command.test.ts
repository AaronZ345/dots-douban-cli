import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const apiMocks = vi.hoisted(() => ({
  getCurrentUserProfile: vi.fn(),
  getUserCollection: vi.fn(),
  getUserCollectionPage: vi.fn()
}));

vi.mock('../api/index.js', () => apiMocks);
vi.mock('../auth.js', () => ({
  detectAuthSession: vi.fn(),
  getCachedAuthSession: vi.fn()
}));
vi.mock('../utils/spinner.js', () => ({
  withSpinner: vi.fn(async (_message: string, task: () => Promise<unknown>) => task())
}));

import { registerUserCommands } from '../commands/user.ts';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
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
});
