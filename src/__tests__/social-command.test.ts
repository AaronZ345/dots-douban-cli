import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  ensureAuth: vi.fn(),
  getCollectionRecords: vi.fn(),
  secureAtomicWriteFile: vi.fn()
}));

vi.mock('../auth.js', () => ({
  ensureAuth: mocks.ensureAuth
}));
vi.mock('../api/account.js', () => ({
  getCollectionRecords: mocks.getCollectionRecords,
  getFeed: vi.fn()
}));
vi.mock('../api/mutations.js', () => ({
  createReview: vi.fn(),
  followUser: vi.fn(),
  unfollowUser: vi.fn()
}));
vi.mock('../storage/secure-file.js', () => ({
  secureAtomicWriteFile: mocks.secureAtomicWriteFile
}));
vi.mock('../utils/spinner.js', () => ({
  withSpinner: vi.fn(async (_message: string, task: () => Promise<unknown>) => task())
}));
vi.mock('../utils/timing.js', () => ({
  parseDelaySeconds: vi.fn(() => 0),
  sleep: vi.fn()
}));

import { registerSocialCommands } from '../commands/social.ts';

function verifiedSession() {
  return {
    dbcl2: 'secret',
    cookies: 'dbcl2=secret',
    source: 'Chrome',
    accountId: 'alice',
    accountName: 'Alice',
    updatedAt: '2026-08-10T00:00:00.000Z'
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerSocialCommands(program);
  return program;
}

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('social commands', () => {
  it('uses the verified session identity for stats', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockResolvedValue([]);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'stats', '--year', '2026', '--json']);

    expect(mocks.ensureAuth).toHaveBeenCalledOnce();
    expect(mocks.getCollectionRecords).toHaveBeenCalledWith('alice', 'collect', 1000, 'dbcl2=secret');
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      user: {
        id: 'alice',
        name: 'Alice',
        url: 'https://www.douban.com/people/alice/'
      },
      year: 2026
    });
  });

  it('uses the verified session identity for all export collections', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'export',
      '--output',
      '/tmp/records.json',
      '--delay',
      '0'
    ]);

    expect(mocks.ensureAuth).toHaveBeenCalledOnce();
    expect(mocks.getCollectionRecords.mock.calls).toEqual([
      ['alice', 'collect', 1000, 'dbcl2=secret'],
      ['alice', 'wish', 1000, 'dbcl2=secret'],
      ['alice', 'do', 1000, 'dbcl2=secret']
    ]);
    expect(mocks.secureAtomicWriteFile).toHaveBeenCalledWith(
      '/tmp/records.json',
      expect.stringContaining('"id": "alice"')
    );
  });
});
