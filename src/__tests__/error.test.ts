import { afterEach, describe, expect, it, vi } from 'vitest';
import { withErrorHandler } from '../utils/error.ts';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('utils/error', () => {
  it('writes a stable JSON error object to stderr when --json is requested', async () => {
    process.argv = ['node', 'douban', 'rank', '未知', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler(
      { command: 'rank', suggestion: 'douban rank 科幻' },
      async () => {
        throw new Error('未知类型: 未知');
      }
    );

    await action();

    expect(stderr).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: '未知类型: 未知',
        command: 'rank',
        suggestion: 'douban rank 科幻'
      }
    });
    expect(process.exitCode).toBe(1);
  });

  it('writes human-readable errors to stderr without --json', async () => {
    process.argv = ['node', 'douban', 'movie', 'bad-id'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'movie' }, async () => {
      throw new Error('电影 ID 必须是纯数字: bad-id');
    });

    await action();

    expect(stderr.mock.calls[0]?.[0]).toContain('[INVALID_ARGUMENT]');
    expect(process.exitCode).toBe(1);
  });

  it('classifies documented option bounds as invalid arguments', async () => {
    process.argv = ['node', 'douban', 'book', 'chart', '--limit', '21', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'book chart' }, async () => {
      throw new Error('--limit 不能超过 20');
    });

    await action();

    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
  });

  it('uses structured transport metadata instead of message matching', async () => {
    process.argv = ['node', 'douban', 'movie', '123', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'movie' }, async () => {
      const error = new Error('request failed') as Error & { code: string; status: number };
      error.code = 'HTTP_STATUS';
      error.status = 404;
      throw error;
    });

    await action();

    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('NOT_FOUND');
  });
});
