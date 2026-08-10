import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  ensureAuth: vi.fn(),
  getCollectionRecords: vi.fn(),
  secureAtomicWriteFile: vi.fn(),
  sleep: vi.fn()
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
  parseDelaySeconds: vi.fn((value: string | undefined, fallback = Number.NaN) => (
    typeof value === 'undefined' || value.trim() === '' ? fallback : Number(value)
  )),
  sleep: mocks.sleep
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
    mocks.getCollectionRecords.mockResolvedValue({ records: [], partial: false, warnings: [] });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'stats', '--year', '2026', '--json']);

    expect(mocks.ensureAuth).toHaveBeenCalledOnce();
    expect(mocks.getCollectionRecords).toHaveBeenCalledWith(
      'alice',
      'collect',
      1000,
      'dbcl2=secret',
      { pageDelayMs: 1000 }
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      user: {
        id: 'alice',
        name: 'Alice',
        url: 'https://www.douban.com/people/alice/'
      },
      year: 2026,
      metadata: {
        partial: false,
        warnings: []
      }
    });
  });

  it('accepts a smaller stats limit and a slower page interval', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockResolvedValue({ records: [], partial: false, warnings: [] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'stats',
      '--limit',
      '30',
      '--delay',
      '2',
      '--json'
    ]);

    expect(mocks.getCollectionRecords).toHaveBeenCalledWith(
      'alice',
      'collect',
      30,
      'dbcl2=secret',
      { pageDelayMs: 2000 }
    );
  });

  it('reports partial stats in stderr and JSON metadata', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockResolvedValue({
      records: [],
      partial: true,
      warnings: ['第二页获取失败']
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'douban', 'stats', '--year', '2026', '--json']);

    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(payload.metadata).toEqual({
      partial: true,
      warnings: ['第二页获取失败']
    });
    expect(stderr.mock.calls.flat().join('\n')).toContain('统计数据可能不完整：第二页获取失败');
  });

  it('uses the verified session identity for all export collections', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockResolvedValue({ records: [], partial: false, warnings: [] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'export',
      '--output',
      '/tmp/records.json',
      '--delay',
      '2'
    ]);

    expect(mocks.ensureAuth).toHaveBeenCalledOnce();
    expect(mocks.getCollectionRecords).toHaveBeenCalledTimes(3);
    expect(mocks.getCollectionRecords.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ['alice', 'collect', 1000, 'dbcl2=secret'],
      ['alice', 'wish', 1000, 'dbcl2=secret'],
      ['alice', 'do', 1000, 'dbcl2=secret']
    ]);
    mocks.getCollectionRecords.mock.calls.forEach((call) => {
      expect(call[4]).toEqual({ pageDelayMs: 2000 });
    });
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(mocks.sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(mocks.secureAtomicWriteFile).toHaveBeenCalledWith(
      '/tmp/records.json',
      expect.stringContaining('"id": "alice"')
    );
  });

  it('marks partial exports in stderr, metadata, and the completion message', async () => {
    mocks.ensureAuth.mockResolvedValue(verifiedSession());
    mocks.getCollectionRecords.mockImplementation(async (
      _userId: string,
      status: string
    ) => ({
      records: [],
      partial: status === 'wish',
      warnings: status === 'wish' ? ['第二页获取失败'] : []
    }));
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'douban',
      'export',
      '--output',
      '/tmp/partial-records.json',
      '--delay',
      '0'
    ]);

    const payload = JSON.parse(String(mocks.secureAtomicWriteFile.mock.calls[0]?.[1]));
    expect(payload.metadata).toEqual({
      count: 0,
      partial: true,
      warnings: ['想看：第二页获取失败']
    });
    expect(stderr.mock.calls.flat().join('\n')).toContain('导出数据可能不完整：想看：第二页获取失败');
    const completion = stdout.mock.calls.flat().join('\n');
    expect(completion).toContain('结果可能不完整');
    expect(completion).not.toContain('✅');
  });
});
