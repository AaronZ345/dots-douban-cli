import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliArgumentError, handleProgramError, withErrorHandler } from '../utils/error.ts';

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

  it('uses a structured invalid-argument code for sensitive input errors', async () => {
    process.argv = ['node', 'douban', 'login', '--cookie-stdin', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'login' }, async () => {
      throw new CliArgumentError('Cookie 标准输入为空');
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

  it('preserves structured transport metadata through an error cause', async () => {
    process.argv = ['node', 'douban', 'login', '--cookie-stdin', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'login' }, async () => {
      const cause = new Error('Network request failed') as Error & { code: string };
      cause.code = 'NETWORK';
      throw new Error('未找到可验证的豆瓣登录态', { cause });
    });

    await action();

    expect(stderr).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('NETWORK_ERROR');
  });

  it('does not treat an endpoint-specific 403 as a missing login', async () => {
    process.argv = ['node', 'douban', 'comments', '123', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({ command: 'comments' }, async () => {
      const error = new Error('HTTP 403 for an endpoint-specific request') as Error & { code: string; status: number };
      error.code = 'HTTP_STATUS';
      error.status = 403;
      throw error;
    });

    await action();

    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.code).toBe('HTTP_ERROR');
  });

  it.each([
    {
      label: 'unsupported Cookie assignment',
      argv: ['login', '--cookie=dbcl2=argv-account; ck=argv-csrf', '--json'],
      message: "error: unknown option '--cookie=dbcl2=argv-account; ck=argv-csrf'",
      expected: '--cookie=[REDACTED]'
    },
    {
      label: 'invalid stdin assignment',
      argv: ['login', '--cookie-stdin=dbcl2=stdin-account; ck=stdin-csrf', '--json'],
      message: "error: unknown option '--cookie-stdin=dbcl2=stdin-account; ck=stdin-csrf'",
      expected: '--cookie-stdin=[REDACTED]'
    },
    {
      label: 'extra Cookie header argument',
      argv: ['login', '--cookie-stdin', 'bid=tracking-value; dbcl2=extra-account; ck=extra-csrf', '--json'],
      message: "error: too many arguments for 'login'. Expected 0 arguments but got 1: bid=tracking-value; dbcl2=extra-account; ck=extra-csrf.",
      expected: 'got 1: [REDACTED].'
    },
    {
      label: 'separate unsupported Cookie value',
      argv: ['login', '--cookie', 'dbcl2=separate-account; ck=separate-csrf', '--json'],
      message: "error: invalid value after '--cookie': dbcl2=separate-account; ck=separate-csrf",
      expected: "after '--cookie': [REDACTED]"
    }
  ])('redacts $label echoed by Commander', ({ argv, message, expected }) => {
    process.argv = ['node', 'douban', ...argv];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error(message) as Error & { code: string; exitCode: number };
    error.code = 'commander.unknownOption';
    error.exitCode = 1;

    handleProgramError(error);

    const output = String(stderr.mock.calls[0]?.[0]);
    expect(JSON.parse(output).error.message).toContain(expected);
    expect(output).not.toMatch(/argv-account|argv-csrf|stdin-account|stdin-csrf/);
    expect(output).not.toMatch(/tracking-value|extra-account|extra-csrf/);
    expect(output).not.toMatch(/separate-account|separate-csrf/);
  });

  it('preserves ordinary arguments that merely mention cookies', () => {
    process.argv = ['node', 'douban', 'search', 'cookie cookbook', '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('未找到条目: cookie cookbook') as Error & {
      code: string;
      exitCode: number;
    };
    error.code = 'commander.invalidArgument';
    error.exitCode = 1;

    handleProgramError(error);

    const payload = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(payload.error.message).toBe('未找到条目: cookie cookbook');
  });

  it('redacts sensitive argv reused by error context fields', async () => {
    const cookieHeader = 'Cookie: bid=context-tracking; dbcl2=context-account; ck=context-csrf';
    process.argv = ['node', 'douban', 'search', cookieHeader, '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = withErrorHandler({
      command: 'search',
      target: cookieHeader,
      suggestion: `重试 ${cookieHeader}`
    }, async () => {
      throw new Error('查询失败');
    });

    await action();

    const output = String(stderr.mock.calls[0]?.[0]);
    const payload = JSON.parse(output);
    expect(payload.error.target).toBe('[REDACTED]');
    expect(payload.error.suggestion).toBe('重试 [REDACTED]');
    expect(output).not.toMatch(/context-tracking|context-account|context-csrf/);
  });
});
